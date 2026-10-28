/** @file Tests CodeRabbit event validation at the host-review boundary. */
import { describe, expect, test } from 'bun:test'

import {
  classifyCoderabbitOutcome,
  makeCoderabbitAttempt,
  parseCoderabbitAgentOutput,
} from '../../src/workflows/df12-build-odw/coderabbit-review.ts'

const successfulCompletion = { type: 'complete', status: 'review_completed', findings: 0 }

describe('CodeRabbit event validation', () => {
  test('retains valid finding fields and additional JSON metadata', () => {
    const finding = {
      type: 'finding',
      severity: 'major',
      fileName: 'src/example.ts',
      comment: 'A concrete defect',
      codegenInstructions: 'Fix the boundary',
      suggestions: [{ replacement: 'fixed' }],
      metadata: { source: 'review' },
    }
    const stdout = [finding, successfulCompletion].map((event) => JSON.stringify(event)).join('\n')
    const parsed = parseCoderabbitAgentOutput(stdout)

    expect(parsed.events).toEqual([finding, successfulCompletion])
    expect(parsed.findings).toEqual([finding])
    expect(parsed.complete).toEqual(successfulCompletion)
    expect(parsed.error).toBeNull()
    expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('findings')
  })

  const malformedEvents = [
    ['event type', { type: 1 }],
    ['missing event type', { severity: 'major' }],
    ['finding severity', { type: 'finding', severity: 3 }],
    ['finding file name', { type: 'finding', fileName: false }],
    ['finding comment', { type: 'finding', comment: { text: 'bad' } }],
    ['finding instructions', { type: 'finding', codegenInstructions: 4 }],
    ['finding suggestions', { type: 'finding', suggestions: 'not an array' }],
    ['error type', { type: 'error', errorType: 7 }],
    ['error message', { type: 'error', message: ['not prose'] }],
    ['completion status', { type: 'complete', status: false }],
    ['completion count', { type: 'complete', status: 'reviewed', findings: '0' }],
  ] as const

  for (const [description, malformed] of malformedEvents) {
    test(`rejects an invalid ${description} even with a successful completion`, () => {
      const stdout = [malformed, successfulCompletion].map((event) => JSON.stringify(event)).join('\n')
      const parsed = parseCoderabbitAgentOutput(stdout)

      expect(parsed.error?.errorType).toBe('invalid_output')
      expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('error')
    })
  }

  test('rejects a non-finite completion count', () => {
    const parsed = parseCoderabbitAgentOutput('{"type":"complete","status":"reviewed","findings":1e400}')
    expect(parsed.error?.errorType).toBe('invalid_output')
    expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('error')
  })

  test('retains an actual rate-limit error when another event is invalid', () => {
    const stdout = [
      '{"type":"finding","severity":4}',
      '{"type":"error","errorType":"rate_limit","message":"Review limit reached"}',
      JSON.stringify(successfulCompletion),
    ].join('\n')
    const parsed = parseCoderabbitAgentOutput(stdout)

    expect(parsed.error?.errorType).toBe('rate_limit')
    expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('rate-limited')
  })

  test('retains malformed authentication evidence regardless of event order', async () => {
    const malformed = { type: 'error', errorType: 7, message: 'Run coderabbit auth login' }
    const otherError = { type: 'error', errorType: 'execution', message: 'Review failed' }
    const attempt = makeCoderabbitAttempt({ base: 'main', reviewTimeoutSeconds: 60 })
    for (const events of [[malformed, otherError], [otherError, malformed], [malformed]]) {
      const stdout = events.map((event) => JSON.stringify(event)).join('\n')
      const parsed = parseCoderabbitAgentOutput(stdout)
      const result = await attempt('/worktree', async () => ({ ok: true, stdout, stderr: '' }))

      expect(parsed.error?.errorType).toBe(events.length === 1 ? 'invalid_output' : 'execution')
      expect(result.outcome).toBe('auth')
      expect(result.errorCategory).toBe('auth')
      expect(result.detail).toContain('Run coderabbit auth login')
    }
  })

  test('retains validated findings in order when other events are malformed', () => {
    const first = { type: 'finding', severity: 'major', comment: 'First' }
    const second = { type: 'finding', severity: 'critical', comment: 'Second' }
    const malformed = { type: 'finding', severity: 3 }
    for (const events of [[first, malformed, second], [malformed, first, second], [first, second, malformed]]) {
      const parsed = parseCoderabbitAgentOutput(events.map((event) => JSON.stringify(event)).join('\n'))
      expect(parsed.error?.errorType).toBe('invalid_output')
      expect(parsed.findings).toEqual([first, second])
      expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('error')
    }
  })

  test('retains non-object JSON and non-JSON lines as diagnostics', () => {
    const stdout = ['[]', '42', 'noise', JSON.stringify(successfulCompletion)].join('\n')
    const parsed = parseCoderabbitAgentOutput(stdout)

    expect(parsed.rawLines).toEqual(['[]', '42', 'noise'])
    expect(classifyCoderabbitOutcome({ ok: true }, parsed)).toBe('clean')
  })

  test('reports malformed events as invalid output at the adapter boundary', async () => {
    const stdout = ['{"type":"finding","severity":4}', JSON.stringify(successfulCompletion)].join('\n')
    const attempt = makeCoderabbitAttempt({ base: 'main', reviewTimeoutSeconds: 60 })
    const result = await attempt('/worktree', async () => ({ ok: true, stdout, stderr: '' }))

    expect(result.outcome).toBe('error')
    expect(result.errorCategory).toBe('invalid-output')
    expect(result.detail).toContain('Invalid CodeRabbit finding event')
  })
})
