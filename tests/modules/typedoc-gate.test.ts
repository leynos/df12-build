/**
 * @file Regression tests for the zero-tolerance TypeDoc gate. Each isolated
 * fixture proves TypeDoc validation behaviour rather than repository content.
 *
 * The behavioural cases run TypeDoc over a throwaway fixture tree with the
 * repository's own `typedoc.json`, overriding only the entry point, the
 * tsconfig and the project name. They therefore fail when a setting is
 * dropped from the committed configuration. That linkage was proved by
 * mutation on 2026-09-07 against typedoc 0.28.20:
 *
 * - `validation.notDocumented: false` makes the undocumented-declaration and
 *   the undocumented-module cases pass, so both fail (one case per diagnostic
 *   site: a declaration and an entry-point module).
 * - `validation.invalidLink: false` makes the broken-link case pass, so
 *   exactly that one fails.
 * - `validation.invalidPath: false` makes the unresolvable-relative-path case
 *   pass, so exactly that one fails. That validation covers relative links in
 *   comments; an unreadable `@document` target is a plain warning, so the
 *   `@document` case below depends on `treatWarningsAsErrors` instead.
 * - removing `treatWarningsAsErrors` makes the unknown-block-tag and
 *   unresolvable-`@document` cases pass, so both fail. TypeDoc exits 0 for an
 *   unknown block tag while still printing the warning,
 *   which is the hole this configuration closes:
 *   `treatValidationWarningsAsErrors` promotes validation findings only, so it
 *   never covers an unknown block tag.
 *
 * Each mutation additionally fails the configuration case below, which
 * compares the whole `validation` object and both promotion flags.
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
const MAKEFILE = readFileSync(path.join(REPO, 'Makefile'), 'utf8')
const TYPEDOC_TEST_TIMEOUT_MS = TYPEDOC_SPAWN_TIMEOUT_MS + 10_000

interface TypeDocRun {
  status: number
  exitedDueToTimeout: boolean
  output: string
  entries: string[]
}

/**
 * Run TypeDoc over a throwaway fixture tree using the repository's own
 * `typedoc.json`.
 *
 * The fixture directory holds the given `source` as `src/fixture.ts` plus a
 * documented `src/support.ts`, so a case can fail on the fixture alone rather
 * than on an empty project. Only the entry point, the tsconfig and the project
 * name are overridden; every validation and promotion setting comes from the
 * committed configuration, which is what makes these cases sensitive to it.
 *
 * @param source TypeScript source written to the fixture module.
 * @returns The exit status, combined output, and the directory's file list
 * after the run, which proves the gate emitted no documentation artefacts.
 */
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
        // Without an explicit name TypeDoc warns that it found no package.json
        // and defaults the project name; under `treatWarningsAsErrors` that
        // warning alone would fail every fixture.
        name: 'df12-typedoc-fixture',
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
    expect(TYPEDOC_OPTIONS.treatWarningsAsErrors).toBe(true)
    expect(TYPEDOC_OPTIONS.validation).toEqual({
      notDocumented: true,
      notExported: false,
      invalidLink: true,
      invalidPath: true,
      rewrittenLink: false,
      unusedMergeModuleWith: false,
    })
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

  test('the docs-check recipe runs the gate without ignoring its exit status', () => {
    const body = /^docs-check:\n((?:\t.*\n)+)/m.exec(MAKEFILE)?.[1]

    expect(body, 'Makefile has no docs-check recipe').toBeDefined()
    const lines = (body ?? '').split('\n').filter((line) => line.length > 0)
    expect(lines.map((line) => line.replace(/^\t/, ''))).toEqual(['bun run docs:check'])
  })

  test('a documented module and exported function pass without emitting artefacts', () => {
    const result = runTypeDocFixture(DOCUMENTED_MODULE)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status, result.output).toBe(0)
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

  test('a link to a non-existent symbol fails the gate', () => {
    const source = DOCUMENTED_MODULE.replace(
      '/** Return a stable fixture value. */',
      '/** Return a stable fixture value. See {@link nonExistentSymbol}. */',
    )
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/Failed to resolve link to "nonExistentSymbol"/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an unresolvable relative path in a comment fails the gate', () => {
    const source = DOCUMENTED_MODULE.replace(
      '/** Return a stable fixture value. */',
      '/** Return a stable fixture value. See [the note](./missing-note.md). */',
    )
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(
      /The relative path \.\/missing-note\.md is not a file/i,
    )
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an unreadable @document target fails the gate', () => {
    const source = DOCUMENTED_MODULE.replace(
      ' * @module\n',
      ' * @document ./missing-document.md\n * @module\n',
    )
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(
      /Failed to read file \.\/missing-document\.md when processing @document tag/i,
    )
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an unknown block tag fails the gate rather than warning silently', () => {
    const source = DOCUMENTED_MODULE.replace(
      ' * @module\n',
      ' * @file src/fixture.ts\n * @module\n',
    )
    const result = runTypeDocFixture(source)

    expect(result.exitedDueToTimeout).toBe(false)
    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/Encountered an unknown block tag @file/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)
})
