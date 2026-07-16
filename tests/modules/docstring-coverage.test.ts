/**
 * @file Regression guard for the docstring-coverage gate
 * (scripts/docstring-coverage.mjs and the `make docstring-coverage` target). It
 * pins two things: the allow-listed modules stay documented at/above threshold,
 * and the checker actually enforces the rule — a missing `@file` docblock fails,
 * a `//` comment does NOT count as a docstring, an undocumented export drops
 * coverage below threshold, and a module with no exports is vacuously covered
 * (but still needs `@file`).
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = new URL('../../', import.meta.url).pathname
const SCRIPT = path.join(REPO, 'scripts', 'docstring-coverage.mjs')
const MODULES = [
  path.join(REPO, 'src', 'workflows', 'df12-build-odw', 'assessment.ts'),
  path.join(REPO, 'src', 'workflows', 'df12-build-odw', 'execplan-durability.ts'),
  path.join(REPO, 'src', 'workflows', 'df12-build-odw', 'main.ts'),
]

function runChecker(args: string[]): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, output: stdout }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` }
  }
}

function withProbe(source: string, run: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'docstring-cov-'))
  const file = path.join(dir, 'mod.ts')
  writeFileSync(file, source)
  try {
    run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('docstring-coverage gate', () => {
  test('the allow-listed modules meet the 80% threshold', () => {
    const result = runChecker(['--min', '80', ...MODULES])
    expect(result.ok).toBe(true)
  })

  test('a module missing the @file block fails', () => {
    withProbe('/** doc */\nexport const value = 1\n', (file) => {
      const result = runChecker(['--min', '80', file])
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/@file/)
    })
  })

  test('a `//` comment does NOT count as an export docstring', () => {
    withProbe('/** @file probe */\n// a plain line comment, not JSDoc\nexport const value = 1\n', (file) => {
      const result = runChecker(['--min', '80', file])
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/coverage|threshold/)
    })
  })

  test('an undocumented export drops coverage below threshold', () => {
    withProbe('/** @file probe */\n/** documented */\nexport const a = 1\nexport const b = 2\n', (file) => {
      const result = runChecker(['--min', '80', file])
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/50\.00%|below the 80%/)
      expect(result.output).toMatch(/\bb\b/)
    })
  })

  test('a fully documented module passes', () => {
    withProbe('/** @file probe */\n/** doc a */\nexport const a = 1\n/** doc b */\nexport interface B { x: string }\n', (file) => {
      const result = runChecker(['--min', '80', file])
      expect(result.ok).toBe(true)
      expect(result.output).toMatch(/100\.00%/)
    })
  })

  test('a module with no exports is vacuously covered but still needs @file', () => {
    withProbe('/** @file probe */\nconst internal = 1\nvoid internal\n', (file) => {
      expect(runChecker(['--min', '80', file]).ok).toBe(true)
    })
    withProbe('const internal = 1\nvoid internal\n', (file) => {
      expect(runChecker(['--min', '80', file]).ok).toBe(false)
    })
  })
})
