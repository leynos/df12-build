/** @file Tests Dakar outcome mapping, validation, and retry behaviour. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'

import { hostReview, recordingExec, required } from '../fixtures/host-review.ts'
import type { ReviewOutcome } from '../../src/workflows/df12-build-odw/host-review.ts'

describe('Dakar outcome mapping', () => {
  const junk: string[] = []
  afterEach(() => {
    for (const target of junk.splice(0)) rmSync(target, { recursive: true, force: true })
  })

  const dakarJson = (doc: Record<string, unknown>) => `noise before json\n${JSON.stringify(doc)}\n`

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
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe(scenario.outcome)
    })
  }

  test('a killed Dakar process with no document is a timeout error', async () => {
    const { exec } = recordingExec({ ok: false, killed: true, stdout: '', message: 'review timed out' })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.errorCategory).toBe('timeout')
  })

  test('unparsable stdout is an error carrying a bounded detail', async () => {
    // An oversized stderr payload must be tail-bounded, not passed through
    // whole: the detail travels into halt records and operator logs.
    const oversized = 'x'.repeat(50_000)
    const { exec } = recordingExec({ ok: false, stdout: 'total garbage, no brace', stderr: oversized, message: 'spawn failed' })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.errorCategory).toBe('invalid-output')
    expect(review.detail.length).toBeGreaterThan(0)
    expect(review.detail.length).toBeLessThanOrEqual(2_000)
  })

  test('changes-requested without findings is an error, never a silent pass', async () => {
    // A reviewer rejection with no findings would otherwise yield zero
    // blocking items and sail through the fix-round gate as if clean.
    const { exec } = recordingExec({ ok: true, stdout: '{"ok":true,"verdict":"changes-requested","findings":[]}', stderr: '' })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    const review = await runCoderabbitHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('error')
    expect(review.detail).toContain('changes-requested')
  })

  test('normalizes an uppercase Dakar severity before validating it', async () => {
    const { exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'changes-requested', findings: [{ severity: 'HIGH', path: 'a.ts', title: 't', detail: 'd', evidence: 'e' }] }) })
    const review = await hostReview({ reviewTool: 'dakar', reviewAttempts: 1 }).runHostReview('/w', 'l', { exec })
    expect(review.outcome).toBe('findings')
    expect(review.findings[0]?.severity).toBe('major')
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
        reviewAttempts: 1,
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
      reviewAttempts: 1,
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
      const stateRoot = required(args[args.indexOf('--state-root') + 1])
      stateRoots.push(stateRoot)
      junk.push(stateRoot)
      expect(existsSync(stateRoot)).toBe(true)
      return { ok: false, stdout: `{"ok":false,"stage":"deferred","error":"quota"}`, stderr: '' }
    }
    const sleeps: number[] = []
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 3 })
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
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
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
      const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
      const review = await runCoderabbitHostReview('/w', 'l', { exec })
      expect(review.outcome).toBe('error')
      expect(review.findings).toEqual([])
      expect(review.detail).toContain('finding at index 0')
    })
  }
})
