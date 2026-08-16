// Module tests for the host-run CodeRabbit review: the NDJSON outcome
// classifier's terminal-completion guard, and the spawn-streamed host commit
// gates (secure per-run log directory).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyCoderabbitOutcome,
  createHostGateLogNamespace,
  csCheckMetrics,
  hostGateLogPath,
  makeHostReview,
  parseCoderabbitAgentOutput,
} from '../../src/workflows/df12-build-odw/host-review.ts'
import type { GateLogStream } from '../../src/workflows/df12-build-odw/host-review.ts'

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

function hostReview(
  overrides: Partial<Parameters<typeof makeHostReview>[0]> = {},
  deps: Parameters<typeof makeHostReview>[1] = {},
) {
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
  }, deps)
}

describe('runCodeSceneCheck', () => {
  const junk: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    junk.push(dir)
    return dir
  }
  beforeEach(() => {
    csCheckMetrics.runs = 0
    csCheckMetrics.failures = 0
    csCheckMetrics.probeFailures = 0
    csCheckMetrics.skipped = 0
  })
  afterEach(() => {
    g.log = () => {}
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  test('a clean check reports clean and not skipped', async () => {
    const dir = tmp('cs-clean-')
    // A command that exists and exits 0 stands in for a clean cs-check-changed.
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'true' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    expect(csCheckMetrics).toEqual({ runs: 1, failures: 0, probeFailures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('a quoted executable path is probed and executed intact', async () => {
    const dir = tmp('cs-quoted-')
    const executable = path.join(dir, 'code scene check')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: `"${executable}"` })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'quoted')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    expect(csCheckMetrics).toEqual({ runs: 1, failures: 0, probeFailures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('a leading environment assignment does not hide the executable', async () => {
    const dir = tmp('cs-environment-')
    const executable = path.join(dir, 'check-environment')
    writeFileSync(executable, '#!/bin/sh\ntest "$DF12_CS_MARKER" = expected\n')
    chmodSync(executable, 0o755)
    const command = `DF12_CS_MARKER=expected "${executable}"`
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: command })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'environment')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    expect(csCheckMetrics).toEqual({ runs: 1, failures: 0, probeFailures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('a bare env invocation does not hide its assigned executable', async () => {
    const dir = tmp('cs-env-')
    const executable = path.join(dir, 'check-env')
    writeFileSync(executable, '#!/bin/sh\ntest "$TOKEN" = expected\n')
    chmodSync(executable, 0o755)
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: `env TOKEN=expected "${executable}"` })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'env')

    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    junk.push(result.logFile)
  })

  test('an unparsable command fails the availability probe without running a fallback', async () => {
    const dir = tmp('cs-unparsable-')
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'TOKEN=`untrusted` true' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'unparsable')

    expect(result).toMatchObject({ clean: false, skipped: false, logFile: '' })
    expect(result.detail).toContain('could not be parsed safely')
    expect(result.detail).toContain('<redacted command>')
    expect(csCheckMetrics).toEqual({ runs: 0, failures: 0, probeFailures: 1, skipped: 0 })
  })

  test('redacts assignment values from CodeScene logs and failure detail', async () => {
    const dir = tmp('cs-redacted-command-')
    const secret = 'never-log-this-token'
    const messages: string[] = []
    g.log = (message: unknown) => messages.push(String(message))
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: `env TOKEN=${secret} sh -c "exit 1"` })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'redacted')

    expect(result.clean).toBe(false)
    expect(result.detail).not.toContain(secret)
    expect(messages.join('\n')).not.toContain(secret)
    expect(result.detail).toContain('TOKEN=<redacted>')
    expect(messages.join('\n')).toContain('TOKEN=<redacted>')
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
    expect(csCheckMetrics).toEqual({ runs: 1, failures: 1, probeFailures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('an absent binary skips gracefully (clean, skipped) instead of failing', async () => {
    const dir = tmp('cs-absent-')
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'df12-cs-not-installed-xyz' })
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.detail).toMatch(/not on PATH/)
    expect(csCheckMetrics).toEqual({ runs: 0, failures: 0, probeFailures: 0, skipped: 1 })
  })

  test('a probe infrastructure fault fails instead of masquerading as absence', async () => {
    const missingWorktree = path.join(tmp('cs-probe-parent-'), 'absent')
    const { runCodeSceneCheck } = hostReview({ csCheck: true, csCheckCommand: 'true' })
    const result = await runCodeSceneCheck(missingWorktree, '1.2.3', 'r1')
    expect(result.clean).toBe(false)
    expect(result.skipped).toBe(false)
    expect(result.detail).toMatch(/availability probe.*failed/i)
    expect(csCheckMetrics).toEqual({ runs: 0, failures: 0, probeFailures: 1, skipped: 0 })
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
    const { runHostCommitGates } = hostReview({
      commitGates: ['yes x | head -c 40000000; echo; echo DONE-OK'],
      commitGateTimeoutSeconds: 30,
    })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(result.results[0]?.logFile)
    expect(result.green).toBe(true)
    expect(result.results[0].ok).toBe(true)
    // The log file holds the full stream, not a truncated buffer.
    expect(readFileSync(result.results[0].logFile, 'utf8').length).toBeGreaterThan(40000000)
  }, 45_000)

  test('a red gate carries the streamed tail and the log path', async () => {
    const dir = tmp('gate-stream-red-')
    const { runHostCommitGates } = hostReview({ commitGates: ['echo working; echo boom; exit 2'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(result.results[0]?.logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/boom/)
    expect(result.detail).toContain(result.results[0].logFile)
  })

  test('repeated gate executions allocate distinct logs for the same tag and round', async () => {
    const dir = tmp('gate-stream-repeated-')
    const { runHostCommitGates } = hostReview({ commitGates: ['echo repeated-gate-output'] })
    const first = await runHostCommitGates(dir, '1.2.3', 'r1')
    const second = await runHostCommitGates(dir, '1.2.3', 'r1')
    const firstLog = first.results[0]?.logFile
    const secondLog = second.results[0]?.logFile
    if (firstLog) junk.push(firstLog)
    if (secondLog) junk.push(secondLog)
    expect(first.green).toBe(true)
    expect(second.green).toBe(true)
    expect(first.results).toHaveLength(1)
    expect(second.results).toHaveLength(1)
    expect(firstLog).not.toBe(secondLog)
    expect(readFileSync(firstLog as string, 'utf8')).toContain('repeated-gate-output')
    expect(readFileSync(secondLog as string, 'utf8')).toContain('repeated-gate-output')
  })

  test('a planted symlink reaps its spawned gate without clobbering the target', async () => {
    const dir = tmp('gate-stream-symlink-')
    const victim = path.join(tmp('gate-victim-'), 'victim.txt')
    const sideEffect = path.join(dir, 'must-not-exist.txt')
    writeFileSync(victim, 'original\n')
    // Plant a symlink where the gate will write; the exclusive no-follow open
    // must refuse it (fail the gate) rather than following it and clobbering
    // the target, and must not crash the run.
    const logNamespace = await createHostGateLogNamespace()
    const logPath = hostGateLogPath(logNamespace, '1.2.3', 'r1', 0)
    junk.push(logNamespace)
    symlinkSync(victim, logPath)
    const { runHostCommitGates } = hostReview(
      { commitGates: [`sleep 1; printf delayed > ${JSON.stringify(sideEffect)}`] },
      { createGateLogNamespace: async () => logNamespace },
    )
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/gate log write failed/)
    expect(readFileSync(victim, 'utf8')).toBe('original\n')
    // The open fails after the detached shell has been spawned. Waiting beyond
    // the command's delayed write proves its whole process group was reaped.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(existsSync(sideEffect)).toBe(false)
  }, 10_000)

  test('a final log flush failure turns a completed gate red', async () => {
    const dir = tmp('gate-stream-final-flush-')
    let reportError: ((error: Error) => void) | undefined
    const stream: GateLogStream = {
      destroyed: false,
      write: () => true,
      end: () => {
        queueMicrotask(() => reportError?.(new Error('final flush failed')))
      },
      on: (event, listener) => {
        if (event === 'error') reportError = listener
        return stream
      },
    }
    const { runHostCommitGates } = hostReview(
      { commitGates: ['printf completed-gate-output'] },
      { createGateLogStream: () => stream },
    )

    const result = await runHostCommitGates(dir, '1.2.3', 'flush')

    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/gate log write failed: final flush failed/)
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

  test('a gate timeout kills descendant processes before their delayed write', async () => {
    const dir = tmp('gate-stream-descendant-timeout-')
    const sideEffect = path.join(dir, 'descendant-survived.txt')
    // The shell waits for a background descendant. Killing only the shell
    // leaves the child holding the pipes and eventually writing this file.
    const { runHostCommitGates } = hostReview({
      commitGates: [`(sleep 2; printf survived > ${JSON.stringify(sideEffect)}) & wait`],
      commitGateTimeoutSeconds: 1,
    })
    const result = await runHostCommitGates(dir, '1.2.3', 'descendant')

    if (result.results[0]?.logFile) junk.push(result.results[0].logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 1s gate timeout/)
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    expect(existsSync(sideEffect)).toBe(false)
  }, 10_000)
})
