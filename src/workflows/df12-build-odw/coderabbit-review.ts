/**
 * CodeRabbit NDJSON adapter for host-side committed-diff reviews.
 *
 * This module owns only protocol parsing and one execution attempt. Retry,
 * persistence, and workflow policy remain in the neutral host-review facade.
 *
 * @module
 */
import { authFailureDetail } from './faults.ts'
import type { ExecStatus } from './exec.ts'
import {
  boundedTail,
  NOOP_HOST_REVIEW_TRACER,
  type HostReviewConfig,
  type HostReviewDeps,
  type HostReviewAttempt,
  type HostReviewTraceContext,
  type ReviewErrorCategory,
  type ReviewFinding,
  type ReviewOutcome,
} from './host-review-contracts.ts'

/** A value decoded from CodeRabbit's JSON event stream. */
export type CoderabbitJsonValue = string | number | boolean | null | CoderabbitJsonValue[] | CoderabbitJsonObject

/** An event object retains additional JSON fields from newer CodeRabbit versions. */
export interface CoderabbitJsonObject {
  [key: string]: CoderabbitJsonValue | undefined
}

/** Terminal CodeRabbit error event retained for outcome classification. */
export interface CoderabbitError extends CoderabbitJsonObject {
  /** CodeRabbit error discriminator such as `rate_limit`. */
  errorType?: string
  /** Reviewer-supplied error description. */
  message?: string
}

/** Parsed CodeRabbit NDJSON events and terminal records. */
export interface CoderabbitParsedOutput {
  /** Parsed NDJSON events in emission order. */
  events: CoderabbitJsonObject[]
  /** Non-JSON lines retained as bounded diagnostic evidence. */
  rawLines: string[]
  /** Finding events narrowed to the neutral finding shape. */
  findings: ReviewFinding[]
  /** Terminal completion event, or null when no completion was emitted. */
  complete: CoderabbitJsonObject | null
  /** First terminal error event, or null when none was emitted. */
  error: CoderabbitError | null
}

/** Success sentinels observed in CodeRabbit terminal completion events. */
export const CODERABBIT_SUCCESS_STATUSES = new Set(['review_completed', 'reviewed'])

/** JSON arrays and scalar values are not NDJSON event objects. */
function isCoderabbitJsonObject(value: CoderabbitJsonValue): value is CoderabbitJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An absent optional field is valid; a present one must be a string. */
function isOptionalCoderabbitString(value: CoderabbitJsonValue | undefined): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Check the finding fields consumed by the shared host-review surface. */
function isCoderabbitFinding(event: CoderabbitJsonObject): event is CoderabbitJsonObject & ReviewFinding {
  return event.type === 'finding'
    && isOptionalCoderabbitString(event.severity)
    && isOptionalCoderabbitString(event.fileName)
    && isOptionalCoderabbitString(event.comment)
    && isOptionalCoderabbitString(event.codegenInstructions)
    && (event.suggestions === undefined || Array.isArray(event.suggestions))
}

/** Validate the error fields consumed by outcome classification. */
function isCoderabbitError(event: CoderabbitJsonObject): event is CoderabbitError {
  return event.type === 'error'
    && isOptionalCoderabbitString(event.errorType)
    && isOptionalCoderabbitString(event.message)
}

/** A terminal completion has a status and, when present, a numeric count. */
function isCoderabbitCompletion(event: CoderabbitJsonObject): boolean {
  return event.type === 'complete'
    && typeof event.status === 'string'
    && (event.findings === undefined || (typeof event.findings === 'number' && Number.isFinite(event.findings)))
}

/** Parse CodeRabbit's NDJSON event stream; exit status is not its verdict. */
export function parseCoderabbitAgentOutput(stdout: string): CoderabbitParsedOutput {
  const events: CoderabbitJsonObject[] = []
  const rawLines: string[] = []
  const findings: ReviewFinding[] = []
  let complete: CoderabbitJsonObject | null = null
  let error: CoderabbitError | null = null
  let invalidReason = ''
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event: CoderabbitJsonValue = JSON.parse(trimmed)
      if (isCoderabbitJsonObject(event)) {
        events.push(event)
        if (typeof event.type !== 'string') {
          invalidReason ||= 'Invalid CodeRabbit event type'
        } else if (event.type === 'finding') {
          if (isCoderabbitFinding(event)) findings.push(event)
          else invalidReason ||= 'Invalid CodeRabbit finding event'
        } else if (event.type === 'complete') {
          if (isCoderabbitCompletion(event)) complete ||= event
          else invalidReason ||= 'Invalid CodeRabbit completion event'
        } else if (event.type === 'error') {
          if (isCoderabbitError(event)) error ||= event
          else invalidReason ||= 'Invalid CodeRabbit error event'
        }
        continue
      }
    } catch {
      // Keep malformed lines as bounded diagnostic evidence.
    }
    rawLines.push(trimmed)
  }
  if (invalidReason && !error) error = { type: 'error', errorType: 'invalid_output', message: invalidReason }
  return { events, rawLines, findings, complete, error }
}

/** Classify parsed CodeRabbit events into the shared outcome vocabulary. */
export function classifyCoderabbitOutcome(execResult: { ok?: boolean; stderr?: string; message?: string }, parsed: CoderabbitParsedOutput): ReviewOutcome {
  const errorText = [parsed.error?.message || '', execResult.stderr || '', execResult.message || ''].join('\n')
  if (parsed.error?.errorType === 'rate_limit' || /\brate.?limit|review limit reached/i.test(errorText)) return 'rate-limited'
  if (authFailureDetail(errorText)) return 'auth'
  if (parsed.error || (!execResult.ok && !parsed.complete)) return 'error'
  if (parsed.findings.length > 0) return 'findings'
  return parsed.complete && CODERABBIT_SUCCESS_STATUSES.has(String(parsed.complete.status)) ? 'clean' : 'error'
}

/** Classify execution failures without changing the review outcome. */
function coderabbitErrorCategory(result: ExecStatus, outcome: ReviewOutcome, parsed: CoderabbitParsedOutput): ReviewErrorCategory {
  if (result.killed) return 'timeout'
  if (outcome === 'rate-limited') return 'deferred'
  if (outcome === 'auth') return 'auth'
  if (parsed.error?.errorType === 'invalid_output') return 'invalid-output'
  if (outcome === 'error') return parsed.error || parsed.complete ? 'execution' : 'invalid-output'
  return 'none'
}

/** Read a bounded elapsed duration from the monotonic clock. */
function elapsedSince(startedMs: number): number {
  const nowMs = Number(process.hrtime.bigint() / 1_000_000n)
  return Math.max(0, nowMs - startedMs)
}

/** Bind one CodeRabbit attempt to the shared timeout and base-branch config. */
export function makeCoderabbitAttempt(config: Pick<HostReviewConfig, 'base' | 'reviewTimeoutSeconds'>): (worktree: string, exec: NonNullable<HostReviewDeps['exec']>, deps?: HostReviewDeps) => Promise<HostReviewAttempt> {
  return async function runCoderabbitAttempt(worktree, exec, deps = {}) {
    const tracer = deps.tracer || NOOP_HOST_REVIEW_TRACER
    const traceContext = deps.traceContext || { runId: 'host-review' }
    const startedMs = Number(process.hrtime.bigint() / 1_000_000n)
    const spanContext: HostReviewTraceContext = { runId: boundedTail(traceContext.runId || 'host-review', 120) }
    if (traceContext.taskId) spanContext.taskId = boundedTail(traceContext.taskId, 120)
    const span = tracer.startSpan('host-review.coderabbit.subprocess', spanContext, { reviewer: 'coderabbit', attempt: deps.attempt || 1 })
    let result: ExecStatus
    try {
      result = await exec('coderabbit', ['review', '--agent', '--type', 'committed', '--base', config.base], { cwd: worktree, timeoutMs: config.reviewTimeoutSeconds * 1000 })
    } catch (error) {
      span.end({ reviewer: 'coderabbit', attempt: deps.attempt || 1, outcome: 'error', errorCategory: 'execution', timeout: false, elapsedMs: elapsedSince(startedMs) })
      throw error
    }
    const parsed = parseCoderabbitAgentOutput(result.stdout)
    const outcome = classifyCoderabbitOutcome(result, parsed)
    const detail = outcome === 'clean' || outcome === 'findings' ? '' : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join('; ') || 'coderabbit produced no parsable outcome').trim()
    const errorCategory = coderabbitErrorCategory(result, outcome, parsed)
    span.end({ reviewer: 'coderabbit', attempt: deps.attempt || 1, outcome, errorCategory, timeout: errorCategory === 'timeout', elapsedMs: elapsedSince(startedMs) })
    return { outcome, findings: parsed.findings, detail: boundedTail(detail), errorCategory }
  }
}
