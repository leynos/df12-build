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

// A src-import probe type-checks a body against the REAL exported types from the
// src tree (not a hand-copied shape, which could silently drift from the
// contract), so a change that breaks a public shape fails here. Importing the
// real modules pulls in their ambient ODW globals (`log`, `agent`, …) and
// Node/Bun builtins, so the probe adds `odw-globals.d.ts` and points type
// resolution at the repo's `@types`; `allowImportingTsExtensions` lets it name
// the `.ts` files directly.
const ODW_SRC = path.join(REPO, 'src', 'workflows', 'df12-build-odw')
const ODW_GLOBALS = path.join(ODW_SRC, 'odw-globals.d.ts')
const REPO_TYPE_ROOTS = path.join(REPO, 'node_modules', '@types')
const SALVAGE_FLAGS = [...FLAGS, '--allowImportingTsExtensions', '--types', 'bun', '--typeRoots', REPO_TYPE_ROOTS]

function typecheckWithPrelude(prelude: string, body: string, tmpPrefix: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), tmpPrefix))
  writeFileSync(path.join(dir, 'probe.ts'), `${prelude}\n${body}\n`)
  try {
    execFileSync(TSC, [...SALVAGE_FLAGS, ODW_GLOBALS, 'probe.ts'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, output: '' }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SALVAGE_PRELUDE = [
  `import type { SalvageOutcome } from '${path.join(ODW_SRC, 'execplan-durability.ts')}'`,
  `import type { SalvageRecord, SalvageSummaryEntry } from '${path.join(ODW_SRC, 'assessment.ts')}'`,
].join('\n')

function typecheckSalvage(body: string): { ok: boolean; output: string } {
  return typecheckWithPrelude(SALVAGE_PRELUDE, body, 'cs-salvage-')
}

// The synthetic recovery implementation report (recovery-discovery.ts) carries
// advisory residualRisk forward into the resumed review/integration prompts
// (#23). Pin its public signature against the REAL export with the same
// isolated-probe mechanism, so a parameter- or return-type regression fails
// here rather than silently changing the carry-forward contract.
const RECOVERY_PRELUDE = `import type { syntheticRecoveryImpl } from '${path.join(ODW_SRC, 'recovery-discovery.ts')}'`

function typecheckRecovery(body: string): { ok: boolean; output: string } {
  return typecheckWithPrelude(RECOVERY_PRELUDE, body, 'cs-recovery-')
}

// The fault/backoff public surface (#39): the bounded FaultMetrics counter set
// (types.ts) and the makeWithInfraRetry factory signature (faults.ts). Pin them
// against the REAL exports so a dropped counter key or a changed argument shape
// fails at compile time, not only in the runtime Bun suites.
const FAULTS_PRELUDE = [
  `import type { FaultMetrics } from '${path.join(ODW_SRC, 'types.ts')}'`,
  `import type { makeWithInfraRetry } from '${path.join(ODW_SRC, 'faults.ts')}'`,
].join('\n')

function typecheckFaults(body: string): { ok: boolean; output: string } {
  return typecheckWithPrelude(FAULTS_PRELUDE, body, 'cs-faults-')
}

// The resolved run configuration (config.ts): used to pin the
// INFRA_RETRY_BACKOFF_SECONDS [low, high] tuple shape against widening.
const CONFIG_PRELUDE = `import type { WorkflowConfig } from '${path.join(ODW_SRC, 'config.ts')}'`

function typecheckConfig(body: string): { ok: boolean; output: string } {
  return typecheckWithPrelude(CONFIG_PRELUDE, body, 'cs-config-')
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

// The salvage public shapes (SalvageOutcome, SalvageRecord, SalvageSummaryEntry)
// are the externally visible contract for host-committed artefact salvage and
// its run-summary rows. These compile-fail probes pin that contract against the
// REAL exported types, so a shape regression (a widened field, a dropped
// required property) fails loudly here. Each probe runs a full type-check of the
// imported module graph, so allow generous timeouts.
describe('salvage public type contract', () => {
  test('valid SalvageOutcome, SalvageRecord, and SalvageSummaryEntry values type-check', () => {
    const result = typecheckSalvage([
      `const outcome: SalvageOutcome = { committed: ['docs/execplans/x.md'], skipped: [{ path: 'src/x.ts', reason: 'not a task artefact' }], sha: 'abc0', detail: '' }`,
      `const record: SalvageRecord = { classification: 'continue-manual', committed: [], skipped: [], sha: '', detail: 'salvage skipped: no worktree path' }`,
      `const row: SalvageSummaryEntry = { id: '1.2.3', classification: 'infra-fault', committed: [], skipped: 0, sha: '', detail: '' }`,
      `void outcome; void record; void row`,
    ].join('\n'))
    expect(result.ok).toBe(true)
  }, 30_000)

  test('SalvageOutcome.committed must be string[]', () => {
    const result = typecheckSalvage(`const x: SalvageOutcome = { committed: [1], skipped: [], sha: '', detail: '' }; void x`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|not assignable/)
  }, 30_000)

  test('SalvageRecord requires the classification field', () => {
    const result = typecheckSalvage(`const x: SalvageRecord = { committed: [], skipped: [], sha: '', detail: '' }; void x`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2741|classification/)
  }, 30_000)

  test('a salvage skipped entry requires both path and reason', () => {
    const missingReason = typecheckSalvage(`const x: SalvageOutcome = { committed: [], skipped: [{ path: 'p' }], sha: '', detail: '' }; void x`)
    expect(missingReason.ok).toBe(false)
    expect(missingReason.output).toMatch(/TS2741|reason/)
    const missingPath = typecheckSalvage(`const x: SalvageOutcome = { committed: [], skipped: [{ reason: 'r' }], sha: '', detail: '' }; void x`)
    expect(missingPath.ok).toBe(false)
    expect(missingPath.output).toMatch(/TS2741|path/)
  }, 30_000)

  test('SalvageSummaryEntry.skipped is a number count, not a list', () => {
    const result = typecheckSalvage(`const x: SalvageSummaryEntry = { id: 'i', classification: 'c', committed: [], skipped: [], sha: '', detail: '' }; void x`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|not assignable/)
  }, 30_000)
})

// The synthetic recovery implementation report's advisory-risk surface (#23):
// residualRisk is the third argument (nullable readonly string array) and the
// returned report re-exposes it as a mutable string[] for the review/integration
// prompts. These probes pin that against the real export.
describe('recovery synthetic-impl type contract', () => {
  test('residualRisk accepts the declared nullable readonly-string forms', () => {
    const result = typecheckRecovery([
      `type P = Parameters<typeof syntheticRecoveryImpl>[2]`,
      `const a: P = ['advisory caveat'] as readonly string[]`,
      `const b: P = ['advisory caveat']`,
      `const c: P = null`,
      `const d: P = undefined`,
      `void a; void b; void c; void d`,
    ].join('\n'))
    expect(result.ok).toBe(true)
  }, 30_000)

  test('the returned report exposes residualRisk as string[]', () => {
    const result = typecheckRecovery([
      `type R = Awaited<ReturnType<typeof syntheticRecoveryImpl>>`,
      `const rr: string[] = ({} as R).residualRisk`,
      `void rr`,
    ].join('\n'))
    expect(result.ok).toBe(true)
  }, 30_000)

  test('residualRisk rejects non-string items', () => {
    const result = typecheckRecovery(`type P = Parameters<typeof syntheticRecoveryImpl>[2]; const bad: P = [1]; void bad`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|TS2769|not assignable/)
  }, 30_000)
})

// The provider-rate-limit backoff surface (#39): FaultMetrics gained the bounded
// `providerRetries` counter and makeWithInfraRetry became a three-arg factory
// (attempts, an optional [low, high] range, and an optional injected sleep). The
// config carries the range as INFRA_RETRY_BACKOFF_SECONDS: [number, number].
// These compile-fail probes pin those shapes against the REAL exports.
describe('fault and config public type contract', () => {
  test('a FaultMetrics with all five bounded counters type-checks', () => {
    const result = typecheckFaults([
      `const m: FaultMetrics = { infraRetries: 0, providerRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }`,
      `void m`,
    ].join('\n'))
    expect(result.ok).toBe(true)
  }, 30_000)

  test('FaultMetrics requires the providerRetries counter', () => {
    const result = typecheckFaults(`const m: FaultMetrics = { infraRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }; void m`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2741|providerRetries/)
  }, 30_000)

  test('FaultMetrics counters are numbers, not strings', () => {
    const result = typecheckFaults(`const m: FaultMetrics = { infraRetries: '0', providerRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }; void m`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|not assignable/)
  }, 30_000)

  test('makeWithInfraRetry accepts (attempts), (attempts, range), and (attempts, range, sleep)', () => {
    const result = typecheckFaults([
      `type P = Parameters<typeof makeWithInfraRetry>`,
      `const a: P = [2]`,
      `const b: P = [2, [5, 30]]`,
      `const c: P = [2, [5, 30], async (s: number) => { void s }]`,
      `void a; void b; void c`,
    ].join('\n'))
    expect(result.ok).toBe(true)
  }, 30_000)

  test('makeWithInfraRetry backoff range is a two-number tuple, not a wider array', () => {
    const result = typecheckFaults(`type P = Parameters<typeof makeWithInfraRetry>; const bad: P = [2, [5, 30, 45]]; void bad`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|TS2769|not assignable/)
  }, 30_000)

  test('makeWithInfraRetry sleep must return a Promise', () => {
    const result = typecheckFaults(`type P = Parameters<typeof makeWithInfraRetry>; const bad: P = [2, [5, 30], (s: number) => s]; void bad`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|TS2769|not assignable/)
  }, 30_000)

  test('WorkflowConfig.INFRA_RETRY_BACKOFF_SECONDS is a two-number tuple', () => {
    const result = typecheckConfig(`const ok: WorkflowConfig['INFRA_RETRY_BACKOFF_SECONDS'] = [5, 30]; void ok`)
    expect(result.ok).toBe(true)
  }, 30_000)

  test('INFRA_RETRY_BACKOFF_SECONDS rejects a wrong-arity tuple', () => {
    const result = typecheckConfig(`const bad: WorkflowConfig['INFRA_RETRY_BACKOFF_SECONDS'] = [5, 30, 45]; void bad`)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/TS2322|not assignable/)
  }, 30_000)
})
