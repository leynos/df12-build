// Regression tests for the zero-tolerance TypeDoc documentation gate. Each
// case runs the repository-pinned executable against an isolated fixture so
// failures prove TypeDoc validation behaviour rather than repository content.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = new URL('../../', import.meta.url).pathname
const TYPEDOC = path.join(REPO, 'node_modules', '.bin', 'typedoc')
// Each case starts the TypeScript compiler through TypeDoc. Allow enough headroom
// for a loaded CI host while still bounding a genuinely hung subprocess.
const TYPEDOC_TEST_TIMEOUT_MS = 15_000

interface TypeDocRun {
  status: number
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
        tsconfig,
        entryPoints: [sourceDir],
        entryPointStrategy: 'expand',
        commentStyle: 'jsdoc',
        emit: 'none',
        validation: { notDocumented: true },
        treatValidationWarningsAsErrors: true,
        requiredToBeDocumented: ['Module', 'Function'],
      }),
    )

    const result = Bun.spawnSync([TYPEDOC, '--options', options], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      status: result.exitCode,
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
  test('a documented module and exported function pass without emitting artefacts', () => {
    const result = runTypeDocFixture(DOCUMENTED_MODULE)

    expect(result.status).toBe(0)
    expect(result.entries).toEqual([
      'src',
      path.join('src', 'fixture.ts'),
      path.join('src', 'support.ts'),
      'tsconfig.json',
      'typedoc.json',
    ])
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an undocumented exported function fails with its qualified diagnostic', () => {
    const source = DOCUMENTED_MODULE.replace(
      '/** Return a stable fixture value. */\n',
      '',
    ).replace('documentedFunction', 'undocumentedFunction')
    const result = runTypeDocFixture(source)

    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/undocumentedFunction.*does not have any documentation/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)

  test('an undocumented module fails with its entry-point diagnostic', () => {
    const source = DOCUMENTED_MODULE.replace(
      /\/\*\*[\s\S]*?@module\n \*\/\n\n/,
      '',
    )
    const result = runTypeDocFixture(source)

    expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/fixture.*\(Module\).*does not have any documentation/i)
  }, TYPEDOC_TEST_TIMEOUT_MS)
})
