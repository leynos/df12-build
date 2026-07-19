// Module tests for the host-run CodeRabbit review: the NDJSON outcome
// classifier's terminal-completion guard, and the spawn-streamed host commit
// gates (secure per-run log directory).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyCoderabbitOutcome,
  coderabbitBlockingItems,
  hostGateLogPath,
  makeHostReview,
  parseCoderabbitAgentOutput,
} from '../../src/workflows/df12-build-odw/host-review.ts'
import type { CoderabbitOutcome } from '../../src/workflows/df12-build-odw/host-review.ts'

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
    dakarTimeoutSeconds: 3600,
    dakarBudgetGbp: 0,
    ...overrides,
  })
}

// A recording exec mock: it captures every invocation's argv and returns a
// scripted ExecStatus, so the Dakar/CodeRabbit dispatch and the exact command
// line can be asserted without ever running a real reviewer CLI.
function recordingExec(result: Partial<import('../../src/workflows/df12-build-odw/exec.ts').ExecStatus>) {
  const calls: Array<{ command: string; args: string[] }> = []
  const exec = async (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    return { ok: true, stdout: '', stderr: '', ...result }
  }
  return { calls, exec }
}

describe('runDakarHostReview', () => {
  const junk: string[] = []
  afterEach(() => {
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  // The dispatcher keys on config.reviewTool; only the Dakar branch is under
  // test here. A single JSON document on stdout (from the first '{') carries the
  // verdict, findings, and deferral stage.
  const dakarJson = (doc: Record<string, unknown>) => `noise before json\n${JSON.stringify(doc)}\n`

  test('the argv names the state root under tmpdir and omits the budget flag by default', async () => {
    const { calls, exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }) })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    const review = await runCoderabbitHostReview('/work/tree', 'label', { exec })
    expect(review.outcome).toBe('clean')
    const { command, args } = calls[0]
    expect(command).toBe('dakar-review')
    expect(args[args.indexOf('--repo-root') + 1]).toBe('/work/tree')
    expect(args[args.indexOf('--base') + 1]).toBe('main')
    expect(args[args.indexOf('--timeout') + 1]).toBe('3600')
    const stateRoot = args[args.indexOf('--state-root') + 1]
    expect(stateRoot.startsWith(path.join(tmpdir(), 'df12-dakar-state-'))).toBe(true)
    junk.push(stateRoot)
    expect(args).not.toContain('--budget-gbp')
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
  const cases: Array<{ name: string; doc?: Record<string, unknown>; stdout?: string; outcome: CoderabbitOutcome }> = [
    { name: 'a passing verdict is clean', doc: { ok: true, verdict: 'pass', findings: [] }, outcome: 'clean' },
    { name: 'a skipped run (nothing unreviewed) is clean', doc: { ok: true, skipped: true }, outcome: 'clean' },
    { name: 'changes-requested is findings', doc: { ok: true, verdict: 'changes-requested', findings: [{ severity: 'high', path: 'a.ts', title: 't', detail: 'd' }] }, outcome: 'findings' },
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

  test('a deferred stage backs off and retries like a CodeRabbit rate limit', async () => {
    let attempts = 0
    const exec = async (_command: string, args: readonly string[]) => {
      attempts += 1
      junk.push(args[args.indexOf('--state-root') + 1])
      return { ok: false, stdout: `{"ok":false,"stage":"deferred","error":"quota"}`, stderr: '' }
    }
    const sleeps: number[] = []
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 3 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec, sleep: async (m: number) => { sleeps.push(m) } })
    expect(review.outcome).toBe('rate-limited')
    expect(attempts).toBe(3)
    expect(sleeps.length).toBe(2)
  })

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
        { severity: 'nebulous', path: 'unk.ts', title: 'Unk', detail: 'huh', evidence: 'e5' },
      ],
    }
    const { exec } = recordingExec({ stdout: dakarJson(doc) })
    const { runCoderabbitHostReview, recordCoderabbitReview } = hostReview({ reviewTool: 'dakar', coderabbitAttempts: 1, coderabbitFindingsFile: findingsFile })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    // critical + high map onto CodeRabbit's blocking critical + major.
    const blocking = coderabbitBlockingItems(review.findings)
    expect(blocking.length).toBe(2)
    expect(blocking.join('\n')).toMatch(/critical/)
    expect(blocking.join('\n')).toMatch(/major/)
    // The comment carries the path:line locator when a line is present.
    const crit = review.findings.find((f) => f.fileName === 'crit.ts')
    expect(crit?.severity).toBe('critical')
    expect(String(crit?.comment)).toContain('crit.ts:3')
    await recordCoderabbitReview('l', review)
    const sunk = readFileSync(findingsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(sunk.map((entry) => entry.severity).sort()).toEqual(['critical', 'info', 'major', 'minor', 'trivial'])
  })
})

describe('reviewTool dispatch', () => {
  test('the coderabbit tool still routes to the NDJSON classifier', async () => {
    const ndjson = [
      '{"type":"status","message":"reviewing"}',
      '{"type":"complete","status":"review_completed","findings":0}',
    ].join('\n')
    const calls: string[] = []
    const exec = async (command: string) => {
      calls.push(command)
      return { ok: true, stdout: ndjson, stderr: '' }
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'coderabbit' })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('clean')
    expect(calls[0]).toBe('coderabbit')
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
