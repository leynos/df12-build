/**
 * @file Regression tests for the zero-tolerance TypeDoc gate. Each isolated
 * fixture proves TypeDoc validation behaviour rather than repository content.
 */
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TYPEDOC = path.join(REPO, 'node_modules', '.bin', 'typedoc')
const TYPEDOC_SPAWN_TIMEOUT_MS = 30_000
const TYPEDOC_OPTIONS = JSON.parse(readFileSync(path.join(REPO, 'typedoc.json'), 'utf8')) as Record<string, unknown>
const TYPEDOC_TEST_TIMEOUT_MS = TYPEDOC_SPAWN_TIMEOUT_MS + 10_000

interface TypeDocRun {
  status: number
  exitedDueToTimeout: boolean
  output: string
  entries: string[]
}

function runTypeDocFixture(source: string): TypeDocRun {
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-typedoc-'))
  try {
    const sourceDir = path.join(dir, 'src')
    const fixture = path.join(sourceDir, 'fixture.ts')
    const support = path.join(sourceDir, 'support.ts')
    const options = path.join(dir, 'typedoc.json')
    const tsconfig = path.join(dir, 'tsconfig.json')
    mkdirSync(sourceDir)
    writeFileSync(fixture, source)
    writeFileSync(
      support,
      `/** A documented support module. @module */\n\n/** Return support. */\nexport function supportFunction(): string { return 'support' }\n`,
    )
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ['src/**/*.ts'],
      }),
    )
    writeFileSync(
      options,
      JSON.stringify({
        ...TYPEDOC_OPTIONS,
        tsconfig,
        entryPoints: [sourceDir],
        entryPointStrategy: 'expand',
      }),
    )

    const result = Bun.spawnSync([TYPEDOC, '--options', options], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TYPEDOC_SPAWN_TIMEOUT_MS,
    })
    return {
      status: result.exitCode,
      exitedDueToTimeout: result.exitedDueToTimeout ?? false,
      output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
      entries: readdirSync(dir, { recursive: true }).map(String).sort(),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const DOCUMENTED_MODULE = `/**
 * A fully documented fixture module.
 *
 * @module
 */

/** Return a stable fixture value. */
export function documentedFunction(): string {
  return 'documented'
}
`

describe('zero-tolerance TypeDoc gate', () => {
  test('repository docs:check invokes the committed TypeDoc configuration', () => {
    const result = Bun.spawnSync(['bun', 'run', 'docs:check'], {
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TYPEDOC_SPAWN_TIMEOUT_MS,
    })

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0)
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('the committed configuration requires module and declaration documentation', () => {
    expect(TYPEDOC_OPTIONS.treatValidationWarningsAsErrors).toBe(true)
    expect(TYPEDOC_OPTIONS.validation).toMatchObject({ notDocumented: true })
    expect(TYPEDOC_OPTIONS.requiredToBeDocumented).toEqual(expect.arrayContaining([
      'Module',
      'Function',
      'Class',
      'Interface',
      'Method',
      'Property',
      'TypeAlias',
      'Variable',
    ]))
  })

  test('a documented module and exported function pass without emitting artefacts', () => {
    const result = runTypeDocFixture(DOCUMENTED_MODULE)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).toBe(0)
    expect(result.entries).toEqual([
      'src',
      path.join('src', 'fixture.ts'),
      path.join('src', 'support.ts'),
      'tsconfig.json',
      'typedoc.json',
    ])
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an undocumented exported function promotes a TypeDoc warning to failure', () => {
    const source = DOCUMENTED_MODULE.replace(
      '/** Return a stable fixture value. */\n',
      '',
    ).replace('documentedFunction', 'undocumentedFunction')
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/undocumentedFunction.*does not have any documentation/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an undocumented module fails with its entry-point diagnostic', () => {
    const source = DOCUMENTED_MODULE.replace(
      /\/\*\*[\s\S]*?@module\n \*\/\n\n/,
      '',
    )
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/fixture.*\(Module\).*does not have any documentation/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)
})
