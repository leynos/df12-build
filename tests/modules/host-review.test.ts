/** @file Module tests for neutral host-review adapters, telemetry, and gates. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyCoderabbitOutcome,
  reviewBlockingItems,
  hostReviewMetrics,
  hostGateLogPath,
  makeHostReview,
  parseCoderabbitAgentOutput,
  parseDakarDocument,
} from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ReviewOutcome } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ExecOptions } from '../../src/workflows/df12-build-odw/exec.ts'

describe('classifyCoderabbitOutcome terminal completion', () => {
  test('both observed success statuses (review_completed, reviewed) are clean', () => {
    for (const status of ['review_completed', 'reviewed']) {
      const parsed = parseCoderabbitAgentOutput(`{"type":"complete","status":"${status}","findings":0}`)
      expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('clean')
    }
  })

  test('a non-success terminal completion is an error, not clean', () => {
    const parsed = parseCoderabbitAgentOutput('{"type":"complete","status":"review_cancelled","findings":0}')
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('error')
  })

  test('findings still classify as findings regardless of completion status', () => {
    const parsed = parseCoderabbitAgentOutput(
      ['{"type":"finding","severity":"major","fileName":"a.ts"}', '{"type":"complete","status":"review_completed","findings":1}'].join('\n'),
    )
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('findings')
  })

  test('a rate_limit error still classifies as rate-limited', () => {
    const parsed = parseCoderabbitAgentOutput('{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded"}')
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('rate-limited')
  })
})

describe('parseDakarDocument', () => {
  test('locates the terminal verdict after noise containing stray braces', () => {
    expect(
      parseDakarDocument('finder {warming cache}\n{"ok":true,"verdict":"pass","findings":[]}\n'),
    ).toEqual({ ok: true, verdict: 'pass', findings: [] })
  })

  test('returns null when no valid terminal object exists', () => {
    expect(parseDakarDocument('no document')).toBeNull()
    expect(parseDakarDocument('{not json}')).toBeNull()
    expect(parseDakarDocument('[{"ok":true}]')).toBeNull()
  })
})


const g = globalThis as Record<string, unknown>
g.log = () => {}

function hostReview(overrides: Partial<Parameters<typeof makeHostReview>[0]> = {}) {
  return makeHostReview({
    base: 'main',
    coderabbitAttempts: 3,
    coderabbitBackoffMinutes: [45, 90],
    coderabbitFindingsFile: '',
    commitGates: ['make all'],
    commitGateTimeoutSeconds: 5,
    csCheck: false,
    csCheckCommand: 'cs-check-changed',
    reviewTool: 'coderabbit',
    dakarCommand: 'dakar-review',
    reviewTimeoutSeconds: 3600,
    dakarBudgetGbp: 0,
    ...overrides,
  })
}

// A recording exec mock: it captures every invocation's argv and returns a
// scripted ExecStatus, so the Dakar/CodeRabbit dispatch and the exact command
// line can be asserted without ever running a real reviewer CLI.
function recordingExec(result: Partial<import('../../src/workflows/df12-build-odw/exec.ts').ExecStatus>) {
  const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = []
  const exec = async (command: string, args: readonly string[], options: ExecOptions = {}) => {
    calls.push({ command, args: [...args], options })
    return { ok: true, stdout: '', stderr: '', ...result }
  }
  return { calls, exec }
}

describe('runDakarHostReview', () => {
  const junk: string[] = []
  afterEach(() => {
    g.log = () => {}
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  // The dispatcher keys on config.reviewTool; only the Dakar branch is under
  // test here. A single JSON document on stdout (from the first '{') carries the
  // verdict, findings, and deferral stage.
  const dakarJson = (doc: Record<string, unknown>) => `noise before json\n${JSON.stringify(doc)}\n`

  test('the argv names the state root under tmpdir and omits the budget flag by default', async () => {
    const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = []
    const cleanupCalls: Array<{ stateRoot: string; options: { recursive: true; force: true } }> = []
    let stateRoot = ''
    const exec = async (command: string, args: readonly string[], options: ExecOptions = {}) => {
      calls.push({ command, args: [...args], options })
      stateRoot = args[args.indexOf('--state-root') + 1]
      expect(existsSync(stateRoot)).toBe(true)
      return { ok: true, stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }), stderr: '' }
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    const review = await runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (target, options) => {
        cleanupCalls.push({ stateRoot: target, options })
        rmSync(target, options)
      },
    })
    expect(review.outcome).toBe('clean')
    const { command, args, options } = calls[0]
    expect(command).toBe('dakar-review')
    expect(args[args.indexOf('--repo-root') + 1]).toBe('/work/tree')
    expect(args[args.indexOf('--base') + 1]).toBe('main')
    expect(args[args.indexOf('--timeout') + 1]).toBe('3600')
    expect(options).toEqual({ cwd: '/work/tree', timeoutMs: 3_600_000 })
    expect(stateRoot.startsWith(path.join(tmpdir(), 'df12-dakar-state-'))).toBe(true)
    expect(existsSync(stateRoot)).toBe(false)
    expect(cleanupCalls).toEqual([{ stateRoot, options: { recursive: true, force: true } }])
    expect(args).not.toContain('--budget-gbp')
  })

  test('a multi-word command separates its executable and prefix arguments', async () => {
    const { calls, exec } = recordingExec({
      stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }),
    })
    const { runCoderabbitHostReview } = hostReview({
      reviewTool: 'dakar',
      dakarCommand: 'uv run dakar-review',
      reviewTimeoutSeconds: 120,
    })
    await runCoderabbitHostReview('/work/tree', 'label', { exec })
    expect(calls[0].command).toBe('uv')
    expect(calls[0].args.slice(0, 2)).toEqual(['run', 'dakar-review'])
    expect(calls[0].options.timeoutMs).toBe(120_000)
  })

  test('the state root is removed when reviewer execution throws', async () => {
    const cleanupCalls: Array<{ stateRoot: string; options: { recursive: true; force: true } }> = []
    let stateRoot = ''
    const exec = async (_command: string, args: readonly string[]) => {
      stateRoot = args[args.indexOf('--state-root') + 1]
      expect(existsSync(stateRoot)).toBe(true)
      throw new Error('Dakar execution failed')
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    await expect(runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (target, options) => {
        cleanupCalls.push({ stateRoot: target, options })
        rmSync(target, options)
        throw new Error('cleanup failed')
      },
    })).rejects.toThrow('Dakar execution failed')
    expect(existsSync(stateRoot)).toBe(false)
    expect(cleanupCalls).toEqual([{ stateRoot, options: { recursive: true, force: true } }])
  })

  test('a cleanup failure does not replace a successful review result', async () => {
    const logs: string[] = []
    g.log = (message: unknown) => logs.push(String(message))
    const { exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }) })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    const review = await runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (stateRoot, options) => {
        rmSync(stateRoot, options)
        throw new Error(`cleanup failed ${'x'.repeat(1000)}`)
      },
    })
    expect(review.outcome).toBe('clean')
    const cleanupLog = logs.find((line) => line.startsWith('[Dakar] could not remove temporary state root: ')) as string
    expect(cleanupLog).toStartWith('[Dakar] could not remove temporary state root: ')
    expect(cleanupLog.length).toBeLessThanOrEqual(550)
  })

  test('a configured budget adds the --budget-gbp flag', async () => {
    const { calls, exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }) })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', dakarBudgetGbp: 3 })
    await runCoderabbitHostReview('/work/tree', 'label', { exec })
    const { args } = calls[0]
    expect(args[args.indexOf('--budget-gbp') + 1]).toBe('3')
    junk.push(args[args.indexOf('--state-root') + 1])
  })

  // The outcome-mapping table: each Dakar document maps to exactly one
  // CoderabbitOutcome, so every run-task deferral/blocking path keeps working.
  const cases: Array<{ name: string; doc?: Record<string, unknown>; stdout?: string; outcome: ReviewOutcome }> = [
    { name: 'a passing verdict is clean', doc: { ok: true, verdict: 'pass', findings: [] }, outcome: 'clean' },
    { name: 'a skipped run (nothing unreviewed) is clean', doc: { ok: true, skipped: true }, outcome: 'clean' },
    { name: 'changes-requested is findings', doc: { ok: true, verdict: 'changes-requested', findings: [{ severity: 'high', path: 'a.ts', title: 't', detail: 'd', evidence: 'e' }] }, outcome: 'findings' },
    { name: 'a deferred stage is rate-limited', doc: { ok: false, stage: 'deferred', error: 'budget exhausted' }, outcome: 'rate-limited' },
    { name: 'a non-deferred failure is an error', doc: { ok: false, stage: 'plan', error: 'pi crashed' }, outcome: 'error' },
  ]
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const { exec } = recordingExec({ stdout: scenario.stdout ?? dakarJson(scenario.doc as Record<string, unknown>) })
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe(scenario.outcome)
    })
  }

  test('unparsable stdout is an error carrying a bounded detail', async () => {
    // An oversized stderr payload must be tail-bounded, not passed through
    // whole: the detail travels into halt records and operator logs.
    const oversized = 'x'.repeat(50_000)
    const { exec } = recordingExec({ ok: false, stdout: 'total garbage, no brace', stderr: oversized, message: 'spawn failed' })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.detail.length).toBeGreaterThan(0)
    expect(review.detail.length).toBeLessThanOrEqual(2_000)
  })

  test('changes-requested without findings is an error, never a silent pass', async () => {
    // A reviewer rejection with no findings would otherwise yield zero
    // blocking items and sail through the fix-round gate as if clean.
    const { exec } = recordingExec({ ok: true, stdout: '{"ok":true,"verdict":"changes-requested","findings":[]}', stderr: '' })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.detail).toContain('changes-requested')
  })

  for (const [name, malformed] of [
    ['null', null],
    ['a scalar', 42],
    ['a string', 'finding'],
    ['an array', []],
  ] as const) {
    test(`changes-requested rejects ${name} finding entry`, async () => {
      const { exec } = recordingExec({
        stdout: dakarJson({
          ok: true,
          verdict: 'changes-requested',
          findings: [{ severity: 'high', path: 'a.ts', title: 'valid', detail: 'd', evidence: 'e' }, malformed],
        }),
      })
      const { runCoderabbitHostReview } = hostReview({
        reviewTool: 'dakar',
        coderabbitAttempts: 1,
      })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe('error')
      expect(review.findings).toEqual([])
      expect(review.detail).toContain('malformed finding at index 1')
      expect(review.detail.length).toBeLessThanOrEqual(2000)
    })
  }

  test('an oversized failure stage is bounded before entering the detail', async () => {
    const stage = `discarded-prefix-${'x'.repeat(50_000)}-kept-tail`
    const { exec } = recordingExec({
      stdout: dakarJson({ ok: false, stage, error: 'review failed' }),
    })
    const { runCoderabbitHostReview } = hostReview({
      reviewTool: 'dakar',
      coderabbitAttempts: 1,
    })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.findings).toEqual([])
    expect(review.detail).not.toContain('discarded-prefix')
    expect(review.detail).toContain('kept-tail')
    expect(review.detail.length).toBeLessThanOrEqual(2000)
  })

  test('a deferred stage backs off and retries like a CodeRabbit rate limit', async () => {
    let attempts = 0
    const stateRoots: string[] = []
    const exec = async (_command: string, args: readonly string[]) => {
      attempts += 1
      const stateRoot = args[args.indexOf('--state-root') + 1]
      stateRoots.push(stateRoot)
      junk.push(stateRoot)
      expect(existsSync(stateRoot)).toBe(true)
      return { ok: false, stdout: `{"ok":false,"stage":"deferred","error":"quota"}`, stderr: '' }
    }
    const sleeps: number[] = []
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 3 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec, sleep: async (m: number) => { sleeps.push(m) } })
    expect(review.outcome).toBe('rate-limited')
    expect(attempts).toBe(3)
    expect(sleeps.length).toBe(2)
    expect(new Set(stateRoots).size).toBe(3)
    for (const stateRoot of stateRoots) expect(existsSync(stateRoot)).toBe(false)
  })

  for (const [name, doc] of [
    ['pass', { ok: true, verdict: 'pass', findings: [{ severity: 'critical', path: 'a.ts', title: 'hidden', detail: 'issue', evidence: 'proof' }] }],
    ['skipped', { ok: true, skipped: true, findings: [{ severity: 'high', path: 'a.ts', title: 'hidden', detail: 'issue', evidence: 'proof' }] }],
  ] as const) {
    test(`${name} fails closed when Dakar also returns findings`, async () => {
      const { exec } = recordingExec({ stdout: dakarJson(doc) })
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe('error')
      expect(review.findings).toEqual([])
      expect(review.detail).toContain('findings')
    })
  }

  for (const [name, finding] of [
    ['unknown severity', { severity: 'nebulous', path: 'a.ts', title: 't', detail: 'd', evidence: 'e' }],
    ['missing path', { severity: 'high', title: 't', detail: 'd', evidence: 'e' }],
    ['non-string detail', { severity: 'high', path: 'a.ts', title: 't', detail: 42, evidence: 'e' }],
  ] as const) {
    test(`changes-requested rejects a finding with ${name}`, async () => {
      const { exec } = recordingExec({
        stdout: dakarJson({ ok: true, verdict: 'changes-requested', findings: [finding] }),
      })
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe('error')
      expect(review.findings).toEqual([])
      expect(review.detail).toContain('finding at index 0')
    })
  }

  test('findings map Dakar severities onto the CodeRabbit blocking set and sink', async () => {
    const findingsFile = path.join(mkdtempSync(path.join(tmpdir(), 'dakar-sink-')), 'findings.jsonl')
    junk.push(path.dirname(findingsFile))
    const doc = {
      ok: true,
      verdict: 'changes-requested',
      findings: [
        { severity: 'critical', path: 'crit.ts', line: 3, title: 'Crit', detail: 'boom', evidence: 'e1' },
        { severity: 'high', path: 'high.ts', title: 'High', detail: 'risky', evidence: 'e2' },
        { severity: 'medium', path: 'med.ts', title: 'Med', detail: 'meh', evidence: 'e3' },
        { severity: 'low', path: 'low.ts', title: 'Low', detail: 'minor', evidence: 'e4' },
      ],
    }
    const { exec } = recordingExec({ stdout: dakarJson(doc) })
    const { runCoderabbitHostReview, recordCoderabbitReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1, coderabbitFindingsFile: findingsFile })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    // critical + high map onto CodeRabbit's blocking critical + major.
    const blocking = reviewBlockingItems(review.reviewer, review.findings)
    expect(blocking.length).toBe(2)
    expect(blocking.join('\n')).toMatch(/critical/)
    expect(blocking.join('\n')).toMatch(/major/)
    // The comment carries the path:line locator when a line is present.
    const crit = review.findings.find((f) => f.fileName === 'crit.ts')
    expect(crit?.severity).toBe('critical')
    expect(String(crit?.comment)).toContain('crit.ts:3')
    await recordCoderabbitReview('l', review)
    const sunk = readFileSync(findingsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(sunk.map((entry) => entry.severity).sort()).toEqual(['critical', 'major', 'minor', 'trivial'])
  })

  test('concurrent findings records keep exact counters and complete JSONL', async () => {
    const findingsFile = path.join(mkdtempSync(path.join(tmpdir(), 'dakar-concurrent-sink-')), 'findings.jsonl')
    junk.push(path.dirname(findingsFile))
    const before = {
      findings: hostReviewMetrics.findings,
      major: hostReviewMetrics.bySeverity.major,
    }
    const { recordHostReview } = hostReview({ coderabbitFindingsFile: findingsFile })
    const records = Array.from({ length: 12 }, (_, index) => recordHostReview(`parallel-${index}`, {
      reviewer: 'dakar',
      outcome: 'findings',
      attempts: 1,
      elapsedMs: 1,
      errorCategory: 'none',
      findings: [{ severity: 'major', fileName: `src/${index}.ts`, comment: `finding ${index}` }],
      detail: '',
    }))

    await Promise.all(records)

    expect(hostReviewMetrics.findings - before.findings).toBe(12)
    expect(hostReviewMetrics.bySeverity.major - before.major).toBe(12)
    const lines = readFileSync(findingsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(12)
    expect(new Set(lines.map((entry) => entry.label)).size).toBe(12)
  })

  test('a sink failure increments the bounded neutral metric', async () => {
    const sinkDirectory = mkdtempSync(path.join(tmpdir(), 'dakar-failing-sink-'))
    junk.push(sinkDirectory)
    const before = hostReviewMetrics.sinkFailures
    const { recordHostReview } = hostReview({ coderabbitFindingsFile: sinkDirectory })
    await recordHostReview('sink-failure', {
      reviewer: 'dakar',
      outcome: 'findings',
      attempts: 1,
      elapsedMs: 1,
      errorCategory: 'none',
      findings: [{ severity: 'major', fileName: 'src/a.ts', comment: 'finding' }],
      detail: '',
    })
    expect(hostReviewMetrics.sinkFailures - before).toBe(1)
    expect(hostReviewMetrics.sinkError.length).toBeLessThanOrEqual(500)
  })
})

describe('reviewTool dispatch', () => {
  test('the coderabbit tool still routes to the NDJSON classifier', async () => {
    const ndjson = [
      '{"type":"status","message":"reviewing"}',
      '{"type":"complete","status":"review_completed","findings":0}',
    ].join('\n')
    const calls: Array<{ command: string; options: ExecOptions }> = []
    const exec = async (command: string, _args: readonly string[], options: ExecOptions = {}) => {
      calls.push({ command, options })
      return { ok: true, stdout: ndjson, stderr: '' }
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'coderabbit' })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('clean')
    expect(calls[0]).toEqual({
      command: 'coderabbit',
      options: { cwd: '/w', timeoutMs: 3_600_000 },
    })
  })

  test('both adapters return the neutral result contract', async () => {
    const dakar = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
    const dakarResult = await dakar.runHostReview('/w', 'dakar-contract', {
      exec: recordingExec({ stdout: '{"ok":true,"verdict":"pass","findings":[]}' }).exec,
      nowMs: (() => { const values = [10, 25]; return () => values.shift() as number })(),
    })
    const coderabbit = hostReview({ reviewTool: 'coderabbit', coderabbitAttempts: 1 })
    const coderabbitResult = await coderabbit.runHostReview('/w', 'coderabbit-contract', {
      exec: recordingExec({ stdout: '{"type":"complete","status":"review_completed"}' }).exec,
      nowMs: (() => { const values = [20, 45]; return () => values.shift() as number })(),
    })
    expect(dakarResult).toMatchObject({ reviewer: 'dakar', outcome: 'clean', attempts: 1, elapsedMs: 15, errorCategory: 'none' })
    expect(coderabbitResult).toMatchObject({ reviewer: 'coderabbit', outcome: 'clean', attempts: 1, elapsedMs: 25, errorCategory: 'none' })
  })

  test('terminal telemetry classifies timeout metadata and bounds identifiers', async () => {
    const logs: string[] = []
    g.log = (message: unknown) => logs.push(String(message))
    const before = { runs: hostReviewMetrics.runs, timeouts: hostReviewMetrics.timeouts, errors: hostReviewMetrics.errors }
    const { runHostReview } = hostReview({ reviewTool: 'coderabbit', coderabbitAttempts: 1 })
    const values = [100, 145]
    const review = await runHostReview('/w', 'x'.repeat(500), {
      exec: recordingExec({ ok: false, killed: true, message: 'review timed out' }).exec,
      nowMs: () => values.shift() as number,
    })
    expect(review).toMatchObject({ reviewer: 'coderabbit', outcome: 'error', attempts: 1, elapsedMs: 45, errorCategory: 'timeout' })
    expect(hostReviewMetrics.runs - before.runs).toBe(1)
    expect(hostReviewMetrics.timeouts - before.timeouts).toBe(1)
    expect(hostReviewMetrics.errors - before.errors).toBe(1)
    const terminal = logs.find((line) => line.startsWith('[host-review] terminal ')) as string
    const event = JSON.parse(terminal.slice('[host-review] terminal '.length))
    expect(event).toEqual({ reviewer: 'coderabbit', label: 'x'.repeat(120), attempts: 1, elapsedMs: 45, outcome: 'error', errorCategory: 'timeout' })
  })

  test('neutral metrics count deferred and authentication outcomes', async () => {
    const before = {
      runs: hostReviewMetrics.runs,
      deferred: hostReviewMetrics.deferred,
      authFailures: hostReviewMetrics.authFailures,
      retries: hostReviewMetrics.retries,
    }
    const deferred = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1 })
    await deferred.runHostReview('/w', 'deferred', {
      exec: recordingExec({ stdout: '{"ok":false,"stage":"deferred","error":"budget"}' }).exec,
    })
    const auth = hostReview({ reviewTool: 'coderabbit', coderabbitAttempts: 1 })
    await auth.runHostReview('/w', 'auth', {
      exec: recordingExec({ ok: false, stderr: 'not authenticated; run coderabbit auth login' }).exec,
    })
    expect(hostReviewMetrics.runs - before.runs).toBe(2)
    expect(hostReviewMetrics.deferred - before.deferred).toBe(1)
    expect(hostReviewMetrics.authFailures - before.authFailures).toBe(1)
    expect(hostReviewMetrics.retries - before.retries).toBe(0)
  })
})

describe('runCodeSceneCheck', () => {
  const junk: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    junk.push(dir)
    return dir
  }
  afterEach(() => {
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  test('a clean check reports clean and not skipped', async () => {
    const dir = tmp('cs-clean-')
    // A command that exists and exits 0 stands in for a clean cs-check-changed.
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'true' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    junk.push(result.logFile)
  })

  test('a non-zero exit reports a code-health regression with the log tail', async () => {
    const dir = tmp('cs-dirty-')
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'sh -c "echo Complex Method in foo; exit 1"' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(false)
    expect(result.skipped).toBe(false)
    expect(result.detail).toMatch(/Complex Method/)
    expect(result.detail).toContain(result.logFile)
    junk.push(result.logFile)
  })

  test('an absent binary skips gracefully (clean, skipped) instead of failing', async () => {
    const dir = tmp('cs-absent-')
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'df12-cs-not-installed-xyz' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.detail).toMatch(/not on PATH/)
  })

  test('csCheck disabled skips without probing', async () => {
    const dir = tmp('cs-off-')
    const { runCodeSceneCheck } = hostReview({ csCheck: false })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result).toEqual({ clean: true, skipped: true, detail: '', logFile: '' })
  })
})

describe('runHostCommitGates streaming', () => {
  // Track every temp dir and gate log so nothing leaks across repeated runs.
  const junk: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    junk.push(dir)
    return dir
  }
  afterEach(() => {
    for (const target of junk.splice(0)) {
      if (target) rmSync(target, { recursive: true, force: true })
    }
  })

  test('handles output far larger than the old 16MB execFile ceiling', async () => {
    const dir = tmp('gate-stream-')
    // ~40MB of stdout would have tripped maxBuffer under execFile; streaming
    // must pass it through and still report green.
    const { runHostCommitGates } = hostReview({ commitGates: ['yes x | head -c 40000000; echo; echo DONE-OK'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(result.results[0]?.logFile)
    expect(result.green).toBe(true)
    expect(result.results[0].ok).toBe(true)
    // The log file holds the full stream, not a truncated buffer.
    expect(readFileSync(result.results[0].logFile, 'utf8').length).toBeGreaterThan(40000000)
  })

  test('a red gate carries the streamed tail and the log path', async () => {
    const dir = tmp('gate-stream-red-')
    const { runHostCommitGates } = hostReview({ commitGates: ['echo working; echo boom; exit 2'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(result.results[0]?.logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/boom/)
    expect(result.detail).toContain(result.results[0].logFile)
  })

  test('a planted symlink at the log path cannot clobber its target (O_NOFOLLOW|O_EXCL)', async () => {
    const dir = tmp('gate-stream-symlink-')
    const victim = path.join(tmp('gate-victim-'), 'victim.txt')
    writeFileSync(victim, 'original\n')
    // Plant a symlink where the gate will write; the exclusive no-follow open
    // must refuse it (fail the gate) rather than following it and clobbering
    // the target, and must not crash the run.
    const logPath = hostGateLogPath('1.2.3', 'r1', 0)
    junk.push(logPath)
    symlinkSync(victim, logPath)
    const { runHostCommitGates } = hostReview({ commitGates: ['echo hi'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/gate log write failed|failed/)
    expect(readFileSync(victim, 'utf8')).toBe('original\n')
  })

  test('a backpressured gate that times out still settles instead of hanging', async () => {
    const dir = tmp('gate-stream-bp-timeout-')
    // `yes` produces output faster than the log stream can drain, so the child
    // pipes are paused by backpressure at the moment the timeout kills the
    // gate. The kill path must resume them so the child's 'close' fires and the
    // gate settles; if it regresses, this await never resolves and the test's
    // own timeout fails it.
    const { runHostCommitGates } = hostReview({ commitGates: ['yes really-long-line-of-gate-output-xxxxxxxxxxxxxxxxxxxx'], commitGateTimeoutSeconds: 1 })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    if (result.results[0]?.logFile) junk.push(result.results[0].logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 1s gate timeout/)
  }, 20000)

  test('a hung gate is killed at the timeout', async () => {
    const dir = tmp('gate-stream-hang-')
    const { runHostCommitGates } = hostReview({ commitGates: [`${process.execPath} -e "setInterval(()=>{},50)"`], commitGateTimeoutSeconds: 2 })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(result.results[0]?.logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 2s gate timeout/)
  })
})
