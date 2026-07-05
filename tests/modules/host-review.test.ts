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
