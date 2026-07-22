// Module tests for the host-run CodeRabbit review: the NDJSON outcome
// classifier's terminal-completion guard, and the spawn-streamed host commit
// gates (secure per-run log directory).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyCoderabbitOutcome,
  hostGateLogPath,
  makeHostReview,
  parseCoderabbitAgentOutput,
} from '../../src/workflows/df12-build-odw/host-review.ts'

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

  test('a login-timeout error classifies as auth', () => {
    const parsed = parseCoderabbitAgentOutput(
      '{"type":"error","errorType":"unknown","message":"Automatic login timed out. Please finish authentication."}',
    )
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('auth')
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
    ...overrides,
  })
}

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
