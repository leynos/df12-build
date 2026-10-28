/**
 * Property tests for host-review protocol adapters, including CodeRabbit event
 * ordering and Dakar severity translation.
 *
 * @module
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  DAKAR_SEVERITY_MAP,
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

const dakarSeverityEntries = Object.entries(DAKAR_SEVERITY_MAP)
const dakarSeverity = fc.constantFrom(
  ...dakarSeverityEntries,
) as fc.Arbitrary<readonly [string, string]>

const findingText = fc.string({ maxLength: 80 })

type CodeRabbitStreamItem =
  | { kind: 'finding'; event: { type: 'finding'; severity: string; fileName: string; comment: string } }
  | { kind: 'completion'; event: { type: 'complete'; status: string; sequence: number; findings: number } }
  | { kind: 'error'; event: { type: 'error'; errorType: 'rate_limit' | 'execution'; message: string; sequence: number } }
  | { kind: 'progress'; event: { type: 'progress'; sequence: number } }
  | { kind: 'invalid'; event: Record<string, string | number | boolean>; reason: string }
  | { kind: 'diagnostic'; line: string }

type FindingItem = Extract<CodeRabbitStreamItem, { kind: 'finding' }>
type CompletionItem = Extract<CodeRabbitStreamItem, { kind: 'completion' }>
type ErrorItem = Extract<CodeRabbitStreamItem, { kind: 'error' }>
type InvalidItem = Extract<CodeRabbitStreamItem, { kind: 'invalid' }>
type DiagnosticItem = Extract<CodeRabbitStreamItem, { kind: 'diagnostic' }>

const codeRabbitFinding: fc.Arbitrary<FindingItem> = fc.tuple(fc.integer(), findingText)
  .map(([id, comment]): FindingItem => ({
    kind: 'finding',
    event: { type: 'finding', severity: 'major', fileName: `src/file-${id}.ts`, comment },
  }))

const codeRabbitCompletion: fc.Arbitrary<CompletionItem> = fc.tuple(
  fc.integer(),
  fc.constantFrom('review_completed', 'reviewed', 'cancelled'),
).map(([sequence, status]): CompletionItem => ({
  kind: 'completion',
  event: { type: 'complete', status, sequence, findings: 0 },
}))

const codeRabbitError: fc.Arbitrary<ErrorItem> = fc.tuple(fc.integer(), fc.boolean())
  .map(([sequence, rateLimited]): ErrorItem => ({
    kind: 'error',
    event: {
      type: 'error',
      errorType: rateLimited ? 'rate_limit' : 'execution',
      message: 'review failed',
      sequence,
    },
  }))

const invalidCodeRabbitEvent: fc.Arbitrary<InvalidItem> = fc.constantFrom<InvalidItem>(
  { kind: 'invalid', event: { type: 'finding', severity: 3 }, reason: 'Invalid CodeRabbit finding event' },
  { kind: 'invalid', event: { type: 'complete', status: false }, reason: 'Invalid CodeRabbit completion event' },
  { kind: 'invalid', event: { type: 'error', errorType: 3 }, reason: 'Invalid CodeRabbit error event' },
  { kind: 'invalid', event: { type: 3 }, reason: 'Invalid CodeRabbit event type' },
)

const codeRabbitDiagnostic: fc.Arbitrary<DiagnosticItem> = fc.oneof(
  fc.integer().map((value) => JSON.stringify(value)),
  fc.boolean().map((value) => JSON.stringify(value)),
  findingText.map((value) => JSON.stringify(value)),
  fc.integer().map((value) => JSON.stringify([value])),
  fc.constant('null'),
  fc.integer().map((value) => `not-json-${value}`),
).map((line): DiagnosticItem => ({ kind: 'diagnostic', line }))

const codeRabbitStreamItem: fc.Arbitrary<CodeRabbitStreamItem> = fc.oneof(
  codeRabbitFinding,
  codeRabbitCompletion,
  codeRabbitError,
  invalidCodeRabbitEvent,
  codeRabbitDiagnostic,
  fc.integer().map((sequence) => ({
    kind: 'progress' as const,
    event: { type: 'progress' as const, sequence },
  })),
)

function codeRabbitLine(item: CodeRabbitStreamItem): string {
  return item.kind === 'diagnostic' ? item.line : JSON.stringify(item.event)
}

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
            evidence: `Evidence ${index}`,
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
  test('retains emitted objects, findings, first terminals and diagnostic lines in order', () => {
    fc.assert(
      fc.property(fc.array(codeRabbitStreamItem, { maxLength: 30 }), (items) => {
        const parsed = parseCoderabbitAgentOutput(items.map(codeRabbitLine).join('\n'))
        const objects = items.filter((item) => item.kind !== 'diagnostic').map((item) => item.event)
        const findings = items.filter((item) => item.kind === 'finding').map((item) => item.event)
        const diagnostics = items.filter((item) => item.kind === 'diagnostic').map((item) => item.line)
        const firstCompletion = items.find((item) => item.kind === 'completion')
        const firstError = items.find((item) => item.kind === 'error')
        const firstInvalid = items.find((item) => item.kind === 'invalid')

        expect(parsed.events).toEqual(objects)
        expect(parsed.findings).toEqual(findings)
        expect(parsed.rawLines).toEqual(diagnostics)
        expect(parsed.complete).toEqual(firstCompletion?.event ?? null)
        if (firstError) {
          expect(parsed.error).toEqual(firstError.event)
        } else if (firstInvalid) {
          expect(parsed.error).toEqual({
            type: 'error',
            errorType: 'invalid_output',
            message: firstInvalid.reason,
          })
        } else {
          expect(parsed.error).toBeNull()
        }

        const expectedOutcome = firstError
          ? (firstError.event.errorType === 'rate_limit' ? 'rate-limited' : 'error')
          : firstInvalid
            ? 'error'
            : findings.length > 0
              ? 'findings'
              : firstCompletion && ['review_completed', 'reviewed'].includes(firstCompletion.event.status)
                ? 'clean'
                : 'error'
        expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe(expectedOutcome)
      }),
    )
  })

  test('an invalid event cannot be hidden by a clean terminal in either order', () => {
    fc.assert(
      fc.property(
        invalidCodeRabbitEvent,
        fc.boolean(),
        fc.array(codeRabbitFinding, { maxLength: 8 }),
        (invalid, invalidFirst, findings) => {
          const complete: CompletionItem = {
            kind: 'completion',
            event: { type: 'complete', status: 'review_completed', sequence: 0, findings: 0 },
          }
          const terminals = invalidFirst ? [invalid, complete] : [complete, invalid]
          const parsed = parseCoderabbitAgentOutput([...findings, ...terminals].map(codeRabbitLine).join('\n'))

          expect(parsed.findings).toEqual(findings.map((finding) => finding.event))
          expect(parsed.complete).toEqual(complete.event)
          expect(parsed.error?.errorType).toBe('invalid_output')
          expect(parsed.error?.message).toBe(invalid.reason)
          expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('error')
        },
      ),
    )
  })

  test('the first valid terminal of each kind survives later terminals and invalid events', () => {
    fc.assert(
      fc.property(
        invalidCodeRabbitEvent,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (invalid, successFirst, rateLimitFirst, invalidFirst) => {
          const success: CompletionItem = {
            kind: 'completion',
            event: { type: 'complete', status: 'reviewed', sequence: 1, findings: 0 },
          }
          const cancelled: CompletionItem = {
            kind: 'completion',
            event: { type: 'complete', status: 'cancelled', sequence: 2, findings: 0 },
          }
          const rateLimit: ErrorItem = {
            kind: 'error',
            event: { type: 'error', errorType: 'rate_limit', message: 'review failed', sequence: 3 },
          }
          const execution: ErrorItem = {
            kind: 'error',
            event: { type: 'error', errorType: 'execution', message: 'review failed', sequence: 4 },
          }
          const firstCompletion = successFirst ? success : cancelled
          const laterCompletion = successFirst ? cancelled : success
          const firstError = rateLimitFirst ? rateLimit : execution
          const laterError = rateLimitFirst ? execution : rateLimit
          const events = invalidFirst
            ? [invalid, firstCompletion, firstError, laterCompletion, laterError]
            : [firstCompletion, firstError, invalid, laterCompletion, laterError]
          const parsed = parseCoderabbitAgentOutput(events.map(codeRabbitLine).join('\n'))

          expect(parsed.complete).toEqual(firstCompletion.event)
          expect(parsed.error).toEqual(firstError.event)
          expect(classifyCoderabbitOutcome({ ok: true }, parsed))
            .toBe(rateLimitFirst ? 'rate-limited' : 'error')
        },
      ),
    )
  })

  test('retains scalar, array and malformed diagnostics without changing a clean outcome', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer(), { maxLength: 8 }),
        fc.integer(),
        fc.boolean(),
        (scalar, array, noise, reverse) => {
          const diagnostics = [JSON.stringify(scalar), JSON.stringify(array), `not-json-${noise}`]
          const ordered = reverse ? diagnostics.toReversed() : diagnostics
          const completion = { type: 'complete', status: 'reviewed', findings: 0 }
          const lines = [...ordered.map((line) => `  ${line}  `), JSON.stringify(completion)]
          const parsed = parseCoderabbitAgentOutput(lines.join('\n'))

          expect(parsed.rawLines).toEqual(ordered)
          expect(parsed.events).toEqual([completion])
          expect(parsed.complete).toEqual(completion)
          expect(parsed.error).toBeNull()
          expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('clean')
        },
      ),
    )
  })

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
