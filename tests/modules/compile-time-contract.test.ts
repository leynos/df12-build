// Compile-time contract tests: the src tree is TypeScript restricted to
// ERASABLE syntax (no enums, parameter properties, namespaces, etc.), enforced
// by tsc's `erasableSyntaxOnly` at `make typecheck`. These tests prove the
// restriction is both CONFIGURED in tsconfig.json and ACTUALLY ENFORCED by the
// compiler — a compile-fail check (the odw-testing skill's sanctioned
// substitute for a runtime assertion of a compile-time invariant), so a future
// tsconfig regression that drops the flag fails loudly here rather than
// silently letting non-erasable syntax into the artefact.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = new URL('../../', import.meta.url).pathname
const TSC = path.join(REPO, 'node_modules', '.bin', 'tsc')
// The restriction flags mirror tsconfig.json; the config-shape test below pins
// them to the committed config so the two cannot drift.
const FLAGS = ['--noEmit', '--strict', '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler', '--erasableSyntaxOnly', '--verbatimModuleSyntax', '--isolatedModules']

function typecheck(source: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-compile-'))
  writeFileSync(path.join(dir, 'probe.ts'), source)
  try {
    // Run from the temp dir (which has no tsconfig.json) so tsc accepts the
    // command-line file instead of erroring TS5112 against the repo config.
    execFileSync(TSC, [...FLAGS, 'probe.ts'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, output: '' }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('compile-time contract', () => {
  test('tsconfig.json keeps the erasable-syntax restriction flags on', async () => {
    const tsconfig = JSON.parse(await Bun.file(path.join(REPO, 'tsconfig.json')).text())
    expect(tsconfig.compilerOptions.erasableSyntaxOnly).toBe(true)
    expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true)
    expect(tsconfig.compilerOptions.isolatedModules).toBe(true)
  })

  test('a non-erasable enum is REJECTED by the restriction flags', () => {
    const result = typecheck('export enum Colour { Red, Green }\n')
    expect(result.ok).toBe(false)
    // TS1294: "This syntax is not allowed when 'erasableSyntaxOnly' is enabled."
    expect(result.output).toMatch(/1294|erasableSyntaxOnly/)
  })

  test('erasable type-only syntax compiles cleanly under the same flags', () => {
    const result = typecheck('export type Id = string\nexport const make = (id: Id): Id => id\n')
    expect(result.ok).toBe(true)
  })
})
