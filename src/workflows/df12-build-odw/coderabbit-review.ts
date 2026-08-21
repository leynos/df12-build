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
  type HostReviewConfig,
  type HostReviewDeps,
  type HostReviewAttempt,
  type ReviewErrorCategory,
  type ReviewFinding,
  type ReviewOutcome,
} from './host-review-contracts.ts'

/** Terminal CodeRabbit error event retained for outcome classification. */
export interface CoderabbitError extends Record<string, unknown> {
  /** CodeRabbit error discriminator such as `rate_limit`. */
  errorType?: string
  /** Reviewer-supplied error description. */
  message?: string
}

/** Parsed CodeRabbit NDJSON events and terminal records. */
export interface CoderabbitParsedOutput {
  /** Parsed NDJSON events in emission order. */
  events: Array<Record<string, unknown>>
  /** Non-JSON lines retained as bounded diagnostic evidence. */
  rawLines: string[]
  /** Finding events narrowed to the neutral finding shape. */
  findings: ReviewFinding[]
  /** Terminal completion event, or null when no completion was emitted. */
  complete: Record<string, unknown> | null
  /** First terminal error event, or null when none was emitted. */
  error: CoderabbitError | null
}

/** Success sentinels observed in CodeRabbit terminal completion events. */
export const CODERABBIT_SUCCESS_STATUSES = new Set(['review_completed', 'reviewed'])

/** Parse CodeRabbit's NDJSON event stream; exit status is not its verdict. */
export function parseCoderabbitAgentOutput(stdout: unknown): CoderabbitParsedOutput {
  const events: Array<Record<string, unknown>> = []
  const rawLines: string[] = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event === 'object') { events.push(event); continue }
    } catch {
      // Keep malformed lines as bounded diagnostic evidence.
    }
    rawLines.push(trimmed)
  }
  return { events, rawLines, findings: events.filter((event) => event.type === 'finding') as ReviewFinding[], complete: events.find((event) => event.type === 'complete') || null, error: (events.find((event) => event.type === 'error') as CoderabbitParsedOutput['error']) || null }
}

/** Classify parsed CodeRabbit events into the shared outcome vocabulary. */
export function classifyCoderabbitOutcome(execResult: { ok?: boolean; stderr?: string; message?: string }, parsed: CoderabbitParsedOutput): ReviewOutcome {
  const errorText = [parsed.error?.message || '', execResult.stderr || '', execResult.message || ''].join('\n')
  if (parsed.error?.errorType === 'rate_limit' || /\brate.?limit|review limit reached/i.test(errorText)) return 'rate-limited'
  if (authFailureDetail(errorText)) return 'auth'
  if (parsed.error || (!execResult.ok && !parsed.complete)) return 'error'
  if (parsed.findings.length) return 'findings'
  return parsed.complete && CODERABBIT_SUCCESS_STATUSES.has(String(parsed.complete.status)) ? 'clean' : 'error'
}

/** Bind one CodeRabbit attempt to the shared timeout and base-branch config. */
export function makeCoderabbitAttempt(config: Pick<HostReviewConfig, 'base' | 'reviewTimeoutSeconds'>): (worktree: string, exec: NonNullable<HostReviewDeps['exec']>) => Promise<HostReviewAttempt> {
  return async function runCoderabbitAttempt(worktree, exec) {
    const result: ExecStatus = await exec('coderabbit', ['review', '--agent', '--type', 'committed', '--base', config.base], { cwd: worktree, timeoutMs: config.reviewTimeoutSeconds * 1000 })
    const parsed = parseCoderabbitAgentOutput(result.stdout)
    const outcome = classifyCoderabbitOutcome(result, parsed)
    const detail = outcome === 'clean' || outcome === 'findings' ? '' : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join('; ') || 'coderabbit produced no parsable outcome').trim()
    const errorCategory: ReviewErrorCategory = result.killed ? 'timeout' : outcome === 'rate-limited' ? 'deferred' : outcome === 'auth' ? 'auth' : outcome === 'error' ? (parsed.error || parsed.complete ? 'execution' : 'invalid-output') : 'none'
    return { outcome, findings: parsed.findings, detail: boundedTail(detail), errorCategory }
  }
}
