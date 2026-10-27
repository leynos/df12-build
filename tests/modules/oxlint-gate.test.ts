/**
 * Exercise the committed Oxlint profiles and generated-workflow exclusion.
 *
 * @module
 */
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const OXLINT = path.join(REPO, 'node_modules', '.bin', 'oxlint')
const CONFIG = path.join(REPO, 'oxlint.config.mjs')

describe('Oxlint gate', () => {
  test('runs Unicorn, deslop and type-aware TypeScript rules', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'df12-oxlint-'))
    try {
      writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'esnext' },
        include: ['fixture.ts'],
      }))
      writeFileSync(path.join(fixture, 'fixture.ts'), `
export async function example(value: string, enabled: boolean): Promise<string> {
  Promise.resolve(1)
  const options = { ...(enabled ? { enabled } : {}) }
  const nested = JSON.stringify(String(Number(value.trim())))
  return value.replace(/x/g, String(options.enabled)) + nested
}
`)
      const result = Bun.spawnSync(
        [OXLINT, '--config', CONFIG, '--format', 'unix', path.join(fixture, 'fixture.ts')],
        { cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
      )
      const output = `${result.stdout.toString()}\n${result.stderr.toString()}`

      expect(result.exitedDueToTimeout).toBe(false)
      expect(result.exitCode, output).not.toBe(0)
      expect(output).toContain('unicorn(prefer-string-replace-all)')
      expect(output).toContain('unicorn(max-nested-calls)')
      expect(output).toContain('deslop(no-conditional-empty-object-spread)')
      expect(output).toContain('typescript(no-floating-promises)')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 40_000)

  test('includes authored source and excludes workflow object code', () => {
    const result = Bun.spawnSync(
      [OXLINT, '--config', CONFIG, '--debug', 'files', 'src', 'workflows'],
      { cwd: REPO, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    )
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
    const files = result.stdout.toString().split('\n')

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.exitCode, output).toBe(0)
    expect(files).toContain('src/workflows/df12-build-odw/main.ts')
    expect(files.some((file) => file.startsWith('workflows/'))).toBe(false)
  }, 40_000)

  test('limits ODW boundary exceptions to the workflow source tree', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'df12-oxlint-scope-'))
    try {
      const workflowSource = path.join(fixture, 'src', 'workflows', 'df12-build-odw')
      const otherSource = path.join(fixture, 'src', 'other')
      mkdirSync(workflowSource, { recursive: true })
      mkdirSync(otherSource, { recursive: true })
      symlinkSync(path.join(REPO, 'node_modules'), path.join(fixture, 'node_modules'), 'dir')
      const fixtureConfig = path.join(fixture, 'oxlint.config.mjs')
      copyFileSync(CONFIG, fixtureConfig)
      writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'esnext' },
        include: ['src/**/*.ts'],
      }))
      const source = `
export function inspect(value: unknown, fields: Record<string, unknown>): unknown {
  if (typeof value === 'string') return value as string
  return fields.fallback ?? null
}
`
      const workflowFile = path.join(workflowSource, 'contract.ts')
      const otherFile = path.join(otherSource, 'contract.ts')
      writeFileSync(workflowFile, source)
      writeFileSync(otherFile, source)

      function lint(file: string) {
        return Bun.spawnSync(
          [OXLINT, '--config', fixtureConfig, '--format', 'unix', file],
          { cwd: fixture, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
        )
      }
      const workflow = lint(workflowFile)
      const other = lint(otherFile)
      const workflowOutput = `${workflow.stdout.toString()}\n${workflow.stderr.toString()}`
      const otherOutput = `${other.stdout.toString()}\n${other.stderr.toString()}`
      const boundaryRules = [
        'unicorn(no-null)',
        'deslop(no-unknown-parameters)',
        'deslop(no-unknown-returns)',
        'deslop(no-unsafe-dictionary-type)',
        'deslop(no-runtime-typeof)',
      ]

      expect(workflow.exitedDueToTimeout).toBe(false)
      expect(other.exitedDueToTimeout).toBe(false)
      expect(workflow.exitCode, workflowOutput).not.toBe(0)
      expect(other.exitCode, otherOutput).not.toBe(0)
      for (const rule of boundaryRules) {
        expect(workflowOutput).not.toContain(rule)
        expect(otherOutput).toContain(rule)
      }
      expect(workflowOutput).toContain('deslop(require-safety-comment-for-type-assertion)')
      expect(otherOutput).toContain('deslop(require-safety-comment-for-type-assertion)')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 70_000)
})
