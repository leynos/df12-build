/**
 * @file Module tests for the run-configuration record (decomposition milestone
 * 5). `makeConfig` owns every `args` default, clamp, and derivation; the entry
 * destructures the record once, so these tests are the contract for the whole
 * `args` surface — including the shared `parseBoundedRange` clamp behind
 * `infraRetryBackoffSeconds` and `coderabbitBackoffMinutes`.
 */
import { describe, expect, test } from 'bun:test'

import { makeConfig } from '../../src/workflows/df12-build-odw/config.ts'

describe('makeConfig defaults', () => {
  const config = makeConfig({})

  test('core run shape', () => {
    expect(config.BASE).toBe('main')
    expect(config.ROADMAP).toBe('docs/roadmap.md')
    expect(config.ONLY_TASK).toBeNull()
    expect(config.MAX_TASKS).toBe(12)
    expect(config.MAX_PARALLEL).toBe(16)
    expect(config.MAX_PLANNING_PARALLEL).toBe(8)
    expect(config.MAX_BUILD_PARALLEL).toBe(8)
    expect(config.MAX_DESIGN_ROUNDS).toBe(4)
    expect(config.MAX_REVIEW_ROUNDS).toBe(3)
    expect(config.STAGE_ATTEMPTS).toBe(2)
    expect(config.BUDGET_RESERVE).toBe(80_000)
  })

  test('behaviour toggles', () => {
    expect(config.AUTO_MERGE).toBe(true)
    expect(config.DOCUMENT_AUDIT).toBe(true)
    expect(config.DRY_RUN).toBe(false)
    expect(config.AUTH_PREFLIGHT).toBe(true)
    expect(config.REQUIRE_CODERABBIT_AUTH).toBe(true)
    expect(config.CODERABBIT_HOST_REVIEW).toBe(true)
    expect(config.CODERABBIT_BETWEEN_WORK_ITEMS).toBe(true)
    expect(config.HOST_COMMIT_GATES).toBe(true)
    expect(config.HOST_GATES_BETWEEN_WORK_ITEMS).toBe(true)
    expect(config.CS_CHECK).toBe(true)
    expect(config.CS_CHECK_COMMAND).toBe('cs-check-changed')
    expect(config.ASSESS_PARTIAL_BRANCHES).toBe(true)
    expect(config.RESUME_PARTIAL_BRANCHES).toBe(false)
    expect(config.RESUME_MODE).toBe('assess')
    expect(config.WORKTREE_WRITE_PREFLIGHT).toBe(true)
    // The write probe is right-sized: minimal effort, no reasoning-model map.
    expect(config.WRITE_PROBE_EFFORT).toBe('minimal')
    expect(config.WRITE_PROBE_MODEL_BY_ADAPTER).toEqual({})
  })

  test('adapter and model routing', () => {
    expect(config.BUILD_ADAPTER).toBe('codex-medium')
    expect(config.PLAN_ADAPTER).toBe('claude')
    expect(config.REVIEW_ADAPTER).toBe('claude')
    expect(config.TRIAGE_ADAPTER).toBe('codex')
    expect(config.ASSESSMENT_ADAPTER).toBe('claude')
    expect(config.BUILD_MODEL).toBe('gpt-5.5')
    // Assessment gets its own MEDIUM default and does not inherit the Opus
    // review model; escalation is the Opus-class model.
    expect(config.ASSESSMENT_MODEL).toBe('claude-sonnet-5')
    expect(config.ASSESSMENT_ESCALATION_MODEL).toBe(config.REVIEW_MODEL)
    // Triage runs at a MEDIUM default, escalating to high only for complex sets.
    expect(config.TRIAGE_MODEL).toBe('gpt-5.5')
    expect(config.TRIAGE_ESCALATION_MODEL).toBe('gpt-5.5@high')
    expect([...config.AUTH_REQUIRED_ADAPTERS].sort()).toEqual(['claude', 'codex', 'codex-medium'])
  })

  test('commit gates and guidance derivation', () => {
    expect(config.COMMIT_GATES).toEqual(['make all'])
    expect(config.COMMIT_GATE_TEXT).toBe('`make all`')
    expect(config.SCRUTINEER_DELEGATION_GUIDANCE).toContain('coderabbit review --agent')
  })

  test('search backend defaults to grepai', () => {
    expect(config.SEARCH_BACKEND).toBe('grepai')
    expect(config.GREPAI_WORKSPACE).toBe('Projects')
    expect(config.GREPAI_PROJECT).toBeNull()
    expect(config.MEMTRACE_REPO_ID).toBeNull()
  })
})

describe('makeConfig overrides and clamps', () => {
  test('taskId forces single-task, single-lane operation', () => {
    const config = makeConfig({ taskId: '1.2.1', maxTasks: 30, maxParallel: 9 })
    expect(config.ONLY_TASK).toBe('1.2.1')
    expect(config.MAX_TASKS).toBe(1)
    expect(config.MAX_PARALLEL).toBe(1)
  })

  test('resumeMaxCandidates clamps to a sane positive bound', () => {
    expect(makeConfig({ resumeMaxCandidates: 0 }).RESUME_MAX_CANDIDATES).toBe(1)
    expect(makeConfig({ resumeMaxCandidates: -3 }).RESUME_MAX_CANDIDATES).toBe(1)
    expect(makeConfig({ resumeMaxCandidates: 2.9 }).RESUME_MAX_CANDIDATES).toBe(2)
    expect(makeConfig({ resumeMaxCandidates: 'many' }).RESUME_MAX_CANDIDATES).toBe(4)
  })

  test('resumeMode accepts all three modes, normalizes case, and rejects junk', () => {
    expect(makeConfig({ resumeMode: 'REVIEW' }).RESUME_MODE).toBe('review')
    expect(makeConfig({ resumeMode: 'continue' }).RESUME_MODE).toBe('continue')
    expect(makeConfig({ resumeMode: 'assess' }).RESUME_MODE).toBe('assess')
    expect(() => makeConfig({ resumeMode: 'yolo' })).toThrow(/Unsupported resumeMode/)
  })

  test('the CodeScene check guidance carries the suppression syntax and smell glossary', () => {
    const g = makeConfig({}).CS_CHECK_GUIDANCE
    expect(g).toContain('@codescene(disable:')
    expect(g).toContain('Bumpy Road')
    expect(g).toContain('Complex Method')
    expect(g).toContain('Brain Class')
    expect(g).toContain('Primitive Obsession')
    // Disabling the check empties the guidance and command stays overridable.
    expect(makeConfig({ csCheck: false }).CS_CHECK_GUIDANCE).toBe('')
    expect(makeConfig({ csCheckCommand: 'cs check --changed --base main' }).CS_CHECK_COMMAND).toBe('cs check --changed --base main')
  })

  test('the between-work-items host gates can be disabled independently', () => {
    expect(makeConfig({ hostGatesBetweenWorkItems: false }).HOST_GATES_BETWEEN_WORK_ITEMS).toBe(false)
    expect(makeConfig({ hostCommitGates: true }).HOST_GATES_BETWEEN_WORK_ITEMS).toBe(true)
  })

  test('the between-work-items host review can be disabled independently', () => {
    expect(makeConfig({ coderabbitBetweenWorkItems: false }).CODERABBIT_BETWEEN_WORK_ITEMS).toBe(false)
    // Still defaults on when host review is on.
    expect(makeConfig({ coderabbitHostReview: true }).CODERABBIT_BETWEEN_WORK_ITEMS).toBe(true)
  })

  test('dryRun waives the CodeRabbit auth requirement', () => {
    expect(makeConfig({ dryRun: true }).REQUIRE_CODERABBIT_AUTH).toBe(false)
    expect(makeConfig({ dryRun: true, requireCoderabbitAuth: true }).REQUIRE_CODERABBIT_AUTH).toBe(false)
  })

  test('memtraceRepoId flips the search backend and maps project ids per backend', () => {
    const memtrace = makeConfig({ memtraceRepoId: 'repo-1' })
    expect(memtrace.SEARCH_BACKEND).toBe('memtrace')
    expect(memtrace.MEMTRACE_REPO_ID).toBe('repo-1')

    expect(makeConfig({ project: 'df12' }).GREPAI_PROJECT).toBe('df12')
    expect(makeConfig({ searchBackend: 'memtrace', project: 'df12' }).MEMTRACE_REPO_ID).toBe('df12')
  })

  test('custom commit gates join into the gate text', () => {
    const config = makeConfig({ commitGates: ['make lint', 'make test'] })
    expect(config.COMMIT_GATE_TEXT).toBe('`make lint` then `make test`')
    expect(config.COMMIT_GATE_GUIDANCE).toContain('`make lint` then `make test`')
  })

  test('adapter overrides propagate into the auth-required set, lowercased', () => {
    const config = makeConfig({ buildAdapter: 'Kimi', planAdapter: 'gemini' })
    expect(config.AUTH_REQUIRED_ADAPTERS.has('kimi')).toBe(true)
    expect(config.AUTH_REQUIRED_ADAPTERS.has('gemini')).toBe(true)
  })

  test('infraRetryBackoffSeconds defaults, truncates, and clamps low<=high', () => {
    expect(makeConfig({}).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    // An explicit range is coerced, truncated, and honoured.
    expect(makeConfig({ infraRetryBackoffSeconds: [10, 40] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([10, 40])
    expect(makeConfig({ infraRetryBackoffSeconds: [2.9, 8.9] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([2, 8])
    // low floors at the default (0 is falsy), and a high below low is lifted to low.
    expect(makeConfig({ infraRetryBackoffSeconds: [0, 0] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    expect(makeConfig({ infraRetryBackoffSeconds: [20, 3] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([20, 20])
    // Non-array or malformed input falls back to the defaults.
    expect(makeConfig({ infraRetryBackoffSeconds: 'nope' }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    expect(makeConfig({ infraRetryBackoffSeconds: [] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
  })

  test('infraRetryBackoffSeconds treats non-finite bounds (Infinity, -Infinity, NaN, overflow) as defaults', () => {
    // Number.isFinite gates each bound: Infinity is truthy and would leak
    // through a plain `Number(x) || default`, so pin that each non-finite bound
    // falls back to its own default rather than propagating Infinity into the
    // shell-facing backoff guidance.
    expect(makeConfig({ infraRetryBackoffSeconds: [Infinity, Infinity] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    expect(makeConfig({ infraRetryBackoffSeconds: [5, Infinity] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    expect(makeConfig({ infraRetryBackoffSeconds: [Infinity, 40] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 40])
    expect(makeConfig({ infraRetryBackoffSeconds: [-Infinity, 30] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    expect(makeConfig({ infraRetryBackoffSeconds: [NaN, NaN] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
    // 1e400 overflows to Infinity in JS, so it must fall back, not leak: low
    // defaults to 5 and the honoured high (2) is then lifted to low.
    expect(makeConfig({ infraRetryBackoffSeconds: [1e400, 2] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 5])
  })

  test('infraRetryBackoffSeconds clamps finite-but-huge bounds to the setTimeout ceiling', () => {
    // A finite value beyond setTimeout's ~2^31-1 ms limit would overflow the
    // timer and fire immediately, defeating the backoff; the upper clamp caps
    // each bound at 2_147_483 seconds while preserving low <= high.
    expect(makeConfig({ infraRetryBackoffSeconds: [1, 5_000_000] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([1, 2_147_483])
    expect(makeConfig({ infraRetryBackoffSeconds: [9_000_000, 9_000_000] }).INFRA_RETRY_BACKOFF_SECONDS).toEqual([2_147_483, 2_147_483])
    // The default range is well under the ceiling and unaffected.
    expect(makeConfig({}).INFRA_RETRY_BACKOFF_SECONDS).toEqual([5, 30])
  })

  test('coderabbitBackoffMinutes shares the same range parsing with its own defaults', () => {
    // Guards the shared parseBoundedRange helper at its second call site: same
    // clamp/fallback behaviour, different default bounds.
    expect(makeConfig({}).CODERABBIT_BACKOFF_MINUTES).toEqual([45, 90])
    expect(makeConfig({ coderabbitBackoffMinutes: [60, 30] }).CODERABBIT_BACKOFF_MINUTES).toEqual([60, 60])
    expect(makeConfig({ coderabbitBackoffMinutes: 'x' }).CODERABBIT_BACKOFF_MINUTES).toEqual([45, 90])
    // The finite-bound guard applies here too (second call site).
    expect(makeConfig({ coderabbitBackoffMinutes: [Infinity, 90] }).CODERABBIT_BACKOFF_MINUTES).toEqual([45, 90])
  })
})
