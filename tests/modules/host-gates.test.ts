/** @file Tests CodeScene and streaming host commit gates. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { hostGateLogPath } from '../../src/workflows/df12-build-odw/host-review.ts'
import { hostReview, required } from '../fixtures/host-review.ts'

const g = globalThis as Record<string, unknown>
g.log = () => {}

describe('runCodeSceneCheck', () => {
  const junk: string[] = []
  let previousLog: unknown
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    junk.push(dir)
    return dir
  }
  beforeEach(() => {
    previousLog = g.log
    g.log = () => {}
  })
  afterEach(() => {
    g.log = previousLog
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  const expectCodeSceneDeltas = (
    surface: ReturnType<typeof hostReview>,
    before: ReturnType<ReturnType<typeof hostReview>['metrics']>['codeScene'],
    expected: { readonly runs: number; readonly failures: number; readonly skipped: number },
  ) => {
    const after = surface.metrics().codeScene
    expect(after.runs - before.runs).toBe(expected.runs)
    expect(after.failures - before.failures).toBe(expected.failures)
    expect(after.skipped - before.skipped).toBe(expected.skipped)
  }

  test('a clean check reports clean and not skipped', async () => {
    const dir = tmp('cs-clean-')
    // A command that exists and exits 0 stands in for a clean cs-check-changed.
    const surface = hostReview({ csCheck: true, csCheckCommand: 'true' })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    expectCodeSceneDeltas(surface, before, { runs: 1, failures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('a bare env invocation does not hide its assigned executable', async () => {
    const dir = tmp('cs-env-')
    const executable = path.join(dir, 'check-env')
    writeFileSync(executable, '#!/bin/sh\ntest "$TOKEN" = expected\n')
    chmodSync(executable, 0o755)
    const surface = hostReview({ csCheck: true, csCheckCommand: `env TOKEN=expected "${executable}"` })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'env')

    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(false)
    expectCodeSceneDeltas(surface, before, { runs: 1, failures: 0, skipped: 0 })
    junk.push(result.logFile)
  })

  test('an unparsable command fails the availability probe without running a fallback', async () => {
    const dir = tmp('cs-unparsable-')
    const surface = hostReview({ csCheck: true, csCheckCommand: 'TOKEN=`untrusted` true' })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'unparsable')

    expect(result).toMatchObject({ clean: false, skipped: false, logFile: '' })
    expect(result.detail).toContain('could not be parsed safely')
    expect(result.detail).toContain('<redacted command>')
    expectCodeSceneDeltas(surface, before, { runs: 0, failures: 0, skipped: 0 })
  })

  test('redacts assignment values from CodeScene logs and failure detail', async () => {
    const dir = tmp('cs-redacted-command-')
    const secret = 'never-log-this-token'
    const messages: string[] = []
    g.log = (message: unknown) => messages.push(String(message))
    const surface = hostReview({ csCheck: true, csCheckCommand: `env TOKEN=${secret} sh -c "exit 1"` })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'redacted')

    expect(result.clean).toBe(false)
    expect(result.detail).not.toContain(secret)
    expect(messages.join('\n')).not.toContain(secret)
    expect(result.detail).toContain('TOKEN=<redacted>')
    expect(messages.join('\n')).toContain('TOKEN=<redacted>')
    expectCodeSceneDeltas(surface, before, { runs: 1, failures: 1, skipped: 0 })
    junk.push(result.logFile)
  })

  test('a non-zero exit reports a code-health regression with the log tail', async () => {
    const dir = tmp('cs-dirty-')
    const surface = hostReview({ csCheck: true, csCheckCommand: 'sh -c "echo Complex Method in foo; exit 1"' })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(false)
    expect(result.skipped).toBe(false)
    expect(result.detail).toMatch(/Complex Method/)
    expect(result.detail).toContain(result.logFile)
    expectCodeSceneDeltas(surface, before, { runs: 1, failures: 1, skipped: 0 })
    junk.push(result.logFile)
  })

  test('an absent binary skips gracefully (clean, skipped) instead of failing', async () => {
    const dir = tmp('cs-absent-')
    const surface = hostReview({ csCheck: true, csCheckCommand: 'df12-cs-not-installed-xyz' })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result.clean).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.detail).toMatch(/not on PATH/)
    expectCodeSceneDeltas(surface, before, { runs: 0, failures: 0, skipped: 1 })
  })

  test('csCheck disabled skips without probing', async () => {
    const dir = tmp('cs-off-')
    const surface = hostReview({ csCheck: false })
    const before = surface.metrics().codeScene
    const { runCodeSceneCheck } = surface
    const result = await runCodeSceneCheck(dir, '1.2.3', 'r1')
    expect(result).toEqual({ clean: true, skipped: true, detail: '', logFile: '' })
    expectCodeSceneDeltas(surface, before, { runs: 0, failures: 0, skipped: 0 })
  })
})

describe('runHostCommitGates streaming', () => {
  // Track every temp dir and gate log so nothing leaks across repeated runs.
  const junk: string[] = []
  let previousLog: unknown
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    junk.push(dir)
    return dir
  }
  beforeEach(() => {
    previousLog = g.log
    g.log = () => {}
  })
  afterEach(() => {
    g.log = previousLog
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
      commitGateTimeoutSeconds: 60,
    })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(required(result.results[0]).logFile)
    expect(result.green).toBe(true)
    expect(required(result.results[0]).ok).toBe(true)
    // The log file holds the full stream, not a truncated buffer.
    expect(readFileSync(required(result.results[0]).logFile, 'utf8').length).toBeGreaterThan(40000000)
  })

  test('a red gate carries the streamed tail and the log path', async () => {
    const dir = tmp('gate-stream-red-')
    const { runHostCommitGates } = hostReview({ commitGates: ['echo working; echo boom; exit 2'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(required(result.results[0]).logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/boom/)
    expect(result.detail).toContain(required(result.results[0]).logFile)
  })

  test('redacts host-gate environment assignments from results and logs', async () => {
    const dir = tmp('gate-redacted-command-')
    const secret = 'never-persist-this-gate-token'
    const messages: string[] = []
    g.log = (message: unknown) => messages.push(String(message))
    const { runHostCommitGates } = hostReview({ commitGates: [`TOKEN=${secret} sh -c "exit 1"`] })
    const result = await runHostCommitGates(dir, '1.2.3', 'redacted')
    junk.push(required(result.results[0]).logFile)
    expect(result.green).toBe(false)
    expect(result.results[0]?.command).toBe('TOKEN=<redacted> sh -c "exit 1"')
    expect(result.detail).not.toContain(secret)
    expect(messages.join('\n')).not.toContain(secret)
  })

  test('a planted symlink at the log path cannot clobber its target (O_NOFOLLOW|O_EXCL)', async () => {
    const dir = tmp('gate-stream-symlink-')
    const victim = path.join(tmp('gate-victim-'), 'victim.txt')
    writeFileSync(victim, 'original\n')
    // Plant a symlink where the gate will write; the exclusive no-follow open
    // must refuse it (fail the gate) rather than following it and clobbering
    // the target, and must not crash the run.
    const logPath = hostGateLogPath(tmp('gate-log-root-'), '1.2.3', 'r1', 0)
    junk.push(logPath)
    symlinkSync(victim, logPath)
    const { runHostCommitGates } = hostReview({
      commitGates: ['echo hi'],
      gateLogPath: () => logPath,
    })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toContain('gate log write failed')
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
    const backpressuredGate = required(result.results[0])
    if (backpressuredGate.logFile) junk.push(backpressuredGate.logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 1s gate timeout/)
  }, 20000)

  test('caps an unterminated output segment while preserving the complete secure log', async () => {
    const dir = tmp('gate-stream-single-line-')
    const { runHostCommitGates } = hostReview({
      commitGates: [`${process.execPath} -e "process.stdout.write('x'.repeat(65536)); process.exit(1)"`],
      commitGateTimeoutSeconds: 10,
    })

    const result = await runHostCommitGates(dir, '1.2.3', 'single-line')
    junk.push(required(result.results[0]).logFile)

    expect(result.green).toBe(false)
    expect(readFileSync(required(result.results[0]).logFile, 'utf8')).toHaveLength(65536)
    expect(result.detail.length).toBeLessThan(20_000)
  })

  test('allocates gate-log roots lazily and releases them after the workflow boundary', async () => {
    const dir = tmp('gate-log-lifecycle-')
    const root = path.join(dir, 'gate-logs')
    let allocations = 0
    let removals = 0
    const surface = hostReview({
      commitGates: ['echo green'],
      gateLogRoot: {
        create: () => { allocations += 1; mkdirSync(root); return root },
        remove: (target, options) => { removals += 1; rmSync(target, options) },
      },
    })

    expect(allocations).toBe(0)
    const result = await surface.runHostCommitGates(dir, '1.2.3', 'lifecycle')
    expect(result.green).toBe(true)
    expect(allocations).toBe(1)
    expect(existsSync(root)).toBe(true)

    surface.disposeHostGateLogs()
    expect(removals).toBe(1)
    expect(existsSync(root)).toBe(false)
  })

  test('a hung gate is killed at the timeout', async () => {
    const dir = tmp('gate-stream-hang-')
    const { runHostCommitGates } = hostReview({ commitGates: [`${process.execPath} -e "setInterval(()=>{},50)"`], commitGateTimeoutSeconds: 2 })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    junk.push(required(result.results[0]).logFile)
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 2s gate timeout/)
  }, 10000)

  test('a timed-out gate kills a background writer in its process group', async () => {
    const dir = tmp('gate-stream-descendant-')
    const marker = path.join(dir, 'survived.txt')
    const command = `(sleep 3; printf survived > ${JSON.stringify(marker)}) & while :; do :; done`
    const { runHostCommitGates } = hostReview({ commitGates: [command], commitGateTimeoutSeconds: 1 })

    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    const descendantGate = required(result.results[0])
    if (descendantGate.logFile) junk.push(descendantGate.logFile)

    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 1s gate timeout/)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker)).toBe(false)
  }, 10000)
})
