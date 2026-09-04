/** @file Tests reviewer dispatch and neutral terminal telemetry. */
import { describe, expect, test } from 'bun:test'

import { reviewerDisplayName } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ExecOptions } from '../../src/workflows/df12-build-odw/exec.ts'
import type { HostReviewSpanAttributes, HostReviewTraceContext } from '../../src/workflows/df12-build-odw/host-review-contracts.ts'
import { hostReview, recordingExec, required } from '../fixtures/host-review.ts'

const g = globalThis as Record<string, unknown>
g.log = () => {}

describe('reviewTool dispatch', () => {
  /** Capture bounded host-review spans without depending on a telemetry SDK. */
  const traceRecorder = () => {
    const spans: Array<{ name: string; context: HostReviewTraceContext; attributes: HostReviewSpanAttributes; end?: HostReviewSpanAttributes }> = []
    return {
      spans,
      tracer: {
        startSpan: (name: string, context: HostReviewTraceContext, attributes: HostReviewSpanAttributes = {}) => {
          const entry: { name: string; context: HostReviewTraceContext; attributes: HostReviewSpanAttributes; end?: HostReviewSpanAttributes } = { name, context, attributes }
          spans.push(entry)
          return { end: (end: HostReviewSpanAttributes = {}) => { entry.end = end } }
        },
      },
    }
  }

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
    expect(calls.at(0)).toEqual({
      command: 'coderabbit',
      options: { cwd: '/w', timeoutMs: 3_600_000 },
    })
  })

  test('both adapters return the neutral result contract', async () => {
    const dakar = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    const dakarResult = await dakar.runHostReview('/w', 'dakar-contract', {
      exec: recordingExec({ stdout: '{"ok":true,"verdict":"pass","findings":[]}' }).exec,
      nowMs: (() => { const values = [10, 25]; return () => values.shift() as number })(),
    })
    const coderabbit = hostReview({ reviewTool: 'coderabbit', reviewAttempts: 1 })
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
    const surface = hostReview({ reviewTool: 'coderabbit', reviewAttempts: 1 })
    const before = surface.metrics().hostReview
    const { runHostReview } = surface
    const values = [100, 145]
    const review = await runHostReview('/w', 'x'.repeat(500), {
      exec: recordingExec({ ok: false, killed: true, message: 'review timed out' }).exec,
      nowMs: () => values.shift() as number,
    })
    expect(review).toMatchObject({ reviewer: 'coderabbit', outcome: 'error', attempts: 1, elapsedMs: 45, errorCategory: 'timeout' })
    expect(surface.metrics().hostReview.runs - before.runs).toBe(1)
    expect(surface.metrics().hostReview.timeouts - before.timeouts).toBe(1)
    expect(surface.metrics().hostReview.errors - before.errors).toBe(1)
    const terminal = required(logs.find((line) => line.startsWith('[host-review] terminal ')))
    const event = JSON.parse(terminal.slice('[host-review] terminal '.length))
    expect(event).toEqual({ reviewer: 'coderabbit', label: 'x'.repeat(120), attempts: 1, elapsedMs: 45, outcome: 'error', errorCategory: 'timeout' })
  })

  test('neutral metrics count deferred and authentication outcomes', async () => {
    const deferred = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    await deferred.runHostReview('/w', 'deferred', {
      exec: recordingExec({ stdout: '{"ok":false,"stage":"deferred","error":"budget"}' }).exec,
    })
    const auth = hostReview({ reviewTool: 'coderabbit', reviewAttempts: 1 })
    await auth.runHostReview('/w', 'auth', {
      exec: recordingExec({ ok: false, stderr: 'not authenticated; run coderabbit auth login' }).exec,
    })
    expect(deferred.metrics().hostReview).toMatchObject({ runs: 1, deferred: 1, authFailures: 0, retries: 0 })
    expect(auth.metrics().hostReview).toMatchObject({ runs: 1, deferred: 0, authFailures: 1, retries: 0 })
  })

  test('closes secret-free correlated spans for success, retry, timeout, and sink failure', async () => {
    const trace = traceRecorder()
    let attempt = 0
    const surface = hostReview({
      reviewTool: 'dakar',
      reviewAttempts: 2,
      reviewFindingsFile: '/untrusted/secret-path',
      tracer: trace.tracer,
      traceContext: { runId: 'run-123' },
    })
    const retry = await surface.runHostReview('/w', 'task-42', {
      exec: async () => {
        attempt += 1
        return attempt === 1
          ? { ok: true, stdout: '{"ok":false,"stage":"deferred","error":"retry"}', stderr: '' }
          : { ok: true, stdout: '{"ok":true,"verdict":"changes-requested","findings":[{"severity":"high","path":"a.ts","title":"fix","detail":"secret-finding","evidence":"e"}]}', stderr: '' }
      },
      sleep: async () => {},
    })
    await surface.recordHostReview('task-42', retry, { append: async () => { throw new Error('disk full secret-finding') } })
    const timedOut = await hostReview({ reviewTool: 'coderabbit', tracer: trace.tracer, traceContext: { runId: 'run-123' } })
      .runHostReview('/w', 'task-42', { exec: recordingExec({ ok: false, killed: true, message: 'secret-finding' }).exec })

    expect(retry.outcome).toBe('findings')
    expect(timedOut.errorCategory).toBe('timeout')
    expect(trace.spans.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'host-review.operation',
      'host-review.attempt',
      'host-review.dakar.subprocess',
      'host-review.dakar.state-root.create',
      'host-review.dakar.state-root.remove',
      'host-review.findings-sink',
      'host-review.coderabbit.subprocess',
    ]))
    expect(trace.spans.every((entry) => entry.context.runId === 'run-123' && entry.context.taskId === 'task-42' && entry.end !== undefined)).toBe(true)
    expect(trace.spans.some((entry) => entry.end?.errorCategory === 'timeout')).toBe(true)
    expect(JSON.stringify(trace.spans)).not.toContain('secret-finding')
    expect(surface.metrics().hostReview.durationBuckets.underOneSecond).toBe(1)
  })
})
