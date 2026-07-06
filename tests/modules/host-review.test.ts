// Module tests for the host-run CodeRabbit review (batch-2 remediation):
// the NDJSON outcome classifier's terminal-completion guard.
import { describe, expect, test } from 'bun:test'

import {
  classifyCoderabbitOutcome,
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
})

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hostGateLogPath, makeHostReview } from '../../src/workflows/df12-build-odw/host-review.ts'

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
    ...overrides,
  })
}

describe('runHostCommitGates streaming', () => {
  test('handles output far larger than the old 16MB execFile ceiling', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-stream-'))
    // ~40MB of stdout would have tripped maxBuffer under execFile; streaming
    // must pass it through and still report green.
    const { runHostCommitGates } = hostReview({ commitGates: ['yes x | head -c 40000000; echo; echo DONE-OK'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(true)
    expect(result.results[0].ok).toBe(true)
    // The log file holds the full stream, not a truncated buffer.
    expect(readFileSync(result.results[0].logFile, 'utf8').length).toBeGreaterThan(40000000)
  })

  test('a red gate carries the streamed tail and the log path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-stream-red-'))
    const { runHostCommitGates } = hostReview({ commitGates: ['echo working; echo boom; exit 2'] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/boom/)
    expect(result.detail).toContain(result.results[0].logFile)
  })

  test('a log-write fault settles the gate as failed instead of crashing', async () => {
    // Pre-create a DIRECTORY at the exact log path the gate will use, so
    // createWriteStream faults with EISDIR. The stream 'error' listener must
    // route that into a failed gate result rather than an uncaught crash.
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-stream-logfault-'))
    const command = 'echo hi'
    const logPath = hostGateLogPath('1.2.3', 'r1', 0, command)
    mkdirSync(logPath, { recursive: true })
    const { runHostCommitGates } = hostReview({ commitGates: [command] })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/gate log write failed|failed/)
  })

  test('a hung gate is killed at the timeout', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-stream-hang-'))
    const { runHostCommitGates } = hostReview({ commitGates: [`${process.execPath} -e "setInterval(()=>{},50)"`], commitGateTimeoutSeconds: 2 })
    const result = await runHostCommitGates(dir, '1.2.3', 'r1')
    expect(result.green).toBe(false)
    expect(result.detail).toMatch(/killed after the 2s gate timeout/)
  })
})
