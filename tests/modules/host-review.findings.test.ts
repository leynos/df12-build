/** @file Tests host-review finding persistence and metrics. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { reviewBlockingItems } from '../../src/workflows/df12-build-odw/host-review.ts'
import { hostReview, recordingExec, required } from '../fixtures/host-review.ts'

describe('host-review findings sink', () => {
  const junk: string[] = []
  afterEach(() => {
    for (const target of junk.splice(0)) rmSync(target, { recursive: true, force: true })
  })

  const dakarJson = (doc: Record<string, unknown>) => `noise before json\n${JSON.stringify(doc)}\n`

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
    const { runCoderabbitHostReview, recordCoderabbitReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1, reviewFindingsFile: findingsFile })
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
    const surface = hostReview({ reviewFindingsFile: findingsFile })
    const before = surface.metrics().hostReview
    const { recordHostReview } = surface
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

    expect(surface.metrics().hostReview.findings - before.findings).toBe(12)
    expect(surface.metrics().hostReview.bySeverity.major - before.bySeverity.major).toBe(12)
    const lines = readFileSync(findingsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(12)
    expect(new Set(lines.map((entry) => entry.label)).size).toBe(12)
  })

  test('a sink failure increments the bounded neutral metric', async () => {
    const sinkDirectory = mkdtempSync(path.join(tmpdir(), 'dakar-failing-sink-'))
    junk.push(sinkDirectory)
    const surface = hostReview({ reviewFindingsFile: sinkDirectory })
    const before = surface.metrics().hostReview.sinkFailures
    const { recordHostReview } = surface
    await recordHostReview('sink-failure', {
      reviewer: 'dakar',
      outcome: 'findings',
      attempts: 1,
      elapsedMs: 1,
      errorCategory: 'none',
      findings: [{ severity: 'major', fileName: 'src/a.ts', comment: 'finding' }],
      detail: '',
    })
    expect(surface.metrics().hostReview.sinkFailures - before).toBe(1)
    expect(surface.metrics().hostReview.sinkError.length).toBeLessThanOrEqual(500)
  })

  test('the findings sink accepts injected timestamp and append seams', async () => {
    const calls: Array<{ path: string; data: string }> = []
    const surface = hostReview({ reviewFindingsFile: '/virtual/findings.jsonl' })
    await surface.recordHostReview('injected sink', {
      reviewer: 'dakar', outcome: 'findings', attempts: 1, elapsedMs: 1,
      errorCategory: 'none', findings: [{ severity: 'major', fileName: 'src/a.ts', comment: 'finding' }], detail: '',
    }, {
      timestamp: async () => '2026-08-22T00:00:00Z',
      append: async (path, data) => { calls.push({ path, data }) },
    })
    expect(calls).toHaveLength(1)
    expect(required(calls[0]).path).toBe('/virtual/findings.jsonl')
    expect(required(calls[0]).data).toContain('2026-08-22T00:00:00Z')
  })

  test('prototype-named severities count as unknown', async () => {
    const surface = hostReview()
    const before = surface.metrics().hostReview.bySeverity.unknown
    const { recordHostReview } = surface
    await recordHostReview('prototype severity', {
      reviewer: 'dakar',
      outcome: 'findings',
      attempts: 1,
      elapsedMs: 1,
      errorCategory: 'none',
      findings: [{ severity: 'constructor' }],
      detail: '',
    })
    expect(surface.metrics().hostReview.bySeverity.unknown - before).toBe(1)
  })
})
