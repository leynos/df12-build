// Property tests for the host-review protocol adapters. Generated terminal
// documents pin classifier precedence and Dakar severity translation.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  classifyCoderabbitOutcome,
  classifyDakarReview,
  parseCoderabbitAgentOutput,
} from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ExecStatus } from '../../src/workflows/df12-build-odw/exec.ts'

function dakarResult(doc: Record<string, unknown>): ExecStatus {
  return {
    ok: true,
    stdout: JSON.stringify(doc),
    stderr: '',
  }
}

const dakarSeverity = fc.constantFrom(
  ['critical', 'critical'],
  ['high', 'major'],
  ['medium', 'minor'],
  ['low', 'trivial'],
  ['unknown', 'info'],
) as fc.Arbitrary<readonly [string, string]>

const findingText = fc.string({ maxLength: 80 })

describe('Dakar outcome properties', () => {
  test('every deferred failure maps to the shared rate-limited state', () => {
    fc.assert(
      fc.property(findingText, (error) => {
        const review = classifyDakarReview(dakarResult({
          ok: false,
          stage: 'deferred',
          error,
        }))
        expect(review.outcome).toBe('rate-limited')
        expect(review.findings).toEqual([])
      }),
    )
  })

  test('non-empty rejections preserve findings and map every severity', () => {
    fc.assert(
      fc.property(
        fc.array(dakarSeverity, { minLength: 1, maxLength: 12 }),
        (severities) => {
          const findings = severities.map(([severity], index) => ({
            severity,
            path: `src/file-${index}.ts`,
            title: `Finding ${index}`,
            detail: `Detail ${index}`,
          }))
          const review = classifyDakarReview(dakarResult({
            ok: true,
            verdict: 'changes-requested',
            findings,
          }))
          expect(review.outcome).toBe('findings')
          expect(review.findings.map((finding) => finding.severity))
            .toEqual(severities.map(([, expected]) => expected))
        },
      ),
    )
  })
})

describe('CodeRabbit outcome properties', () => {
  test('successful terminal states are clean exactly when findings are absent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('review_completed', 'reviewed'),
        fc.array(findingText, { maxLength: 12 }),
        (status, comments) => {
          const events: Array<Record<string, unknown>> = comments.map((comment, index) => ({
            type: 'finding',
            severity: 'major',
            fileName: `src/file-${index}.ts`,
            comment,
          }))
          events.push({
            type: 'complete',
            severity: 'info',
            fileName: '',
            comment: '',
            status,
          })
          const parsed = parseCoderabbitAgentOutput(
            events.map((event) => JSON.stringify(event)).join('\n'),
          )
          const outcome = classifyCoderabbitOutcome(
            { ok: true, stderr: '', message: '' },
            parsed,
          )
          expect(outcome).toBe(comments.length > 0 ? 'findings' : 'clean')
        },
      ),
    )
  })

  test('rate-limit errors dominate arbitrary process diagnostics', () => {
    fc.assert(
      fc.property(findingText, findingText, (stderr, message) => {
        const parsed = parseCoderabbitAgentOutput(JSON.stringify({
          type: 'error',
          errorType: 'rate_limit',
          message: 'deferred',
        }))
        expect(classifyCoderabbitOutcome({ ok: false, stderr, message }, parsed))
          .toBe('rate-limited')
      }),
    )
  })
})
