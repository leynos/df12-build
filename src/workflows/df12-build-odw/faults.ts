/**
 * Failure classification and the bounded infrastructure retry. A
 * failure's class decides the pool's response: fatal-auth halts new work, a
 * provider fault defers the task, an infrastructure fault may be retried warm
 * (the committed-ExecPlan durability contract makes re-runs cheap), and
 * anything else flows through the ordinary product-failure paths.
 *
 * @module
 */
import type { FaultMetrics } from './types.ts'

/**
 * Bounded-cardinality fault counters, surfaced verbatim in the run result so
 * operators can see retry pressure and terminal fault classes without
 * scraping logs. Fixed keys only — never keyed by task id or error text.
 * Mutated in place by `makeWithInfraRetry` and
 * `resultFromUnhandledAgentError`; this module holds the one live instance.
 */
export const faultMetrics: FaultMetrics = { infraRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }

/**
 * Detect an authentication/authorization failure from an agent's error text.
 * Matches known Codex/CodeRabbit login and token phrasing; returns the
 * trimmed original text (truthy) on a match, or `''` when the value does not
 * look like an auth failure. Callers treat a non-empty result as fatal —
 * classification is deliberately conservative to avoid halting the run on an
 * ambiguous error.
 */
export function authFailureDetail(value: unknown): string {
  const text = String(value || '')
  const patterns = [
    /401 Unauthorized/i,
    /Missing bearer or basic authentication/i,
    /no Codex credentials/i,
    /\bNot logged in\b/i,
    /\bsigned out\b/i,
    /no token is available/i,
    /\bauth(?:entication)? failed\b/i,
    /\bbrowser login required\b/i,
    /\btoken missing\b/i,
    /\bmissing token\b/i,
    /\btoken expired\b/i,
    /\bnot authenticated\b/i,
    /"loggedIn"\s*:\s*false/i,
    /Run `?coderabbit auth login`?/i,
    /Run codex login/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

/**
 * Detect an upstream model/provider failure (rate limiting, gateway or
 * server-side errors) from an agent's error text. Returns the trimmed
 * original text on a match, or `''` otherwise. Distinct from
 * `infrastructureFailureDetail`: this classifies faults reported by the
 * provider itself, not ODW's own adapter/schema plumbing.
 */
export function providerFailureDetail(value: unknown): string {
  const text = String(value || '')
  const patterns = [
    /\bAPI Error:\s*(?:429|500|502|503|504|529)\b/i,
    /\b(?:429|500|502|503|504|529)\b.*\b(?:gateway|overload|rate limit|server-side|temporar|timeout|unavailable)\b/i,
    /\b(?:gateway timeout|model overloaded|overloaded|rate limited|server-side issue|service unavailable|temporarily unavailable|try again in a moment)\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

/**
 * Detect an ODW-level infrastructure fault from an agent's error text: the
 * agent process died or its reply channel failed, so the error carries no
 * evidence about the task branch. The patterns pin ODW's own stable error
 * strings (bridge.ts `cliFailureMessage` and the schema-retry exhaustion
 * message) rather than provider or auth wording. Returns the trimmed
 * original text on a match, or `''` otherwise.
 */
export function infrastructureFailureDetail(value: unknown): string {
  const text = String(value || '')
  const patterns = [
    /\badapter '[^']*' timed out\b/i,
    /\badapter '[^']*' exited with code \d+/i,
    /\bAdapterExecutionError\b/,
    /\bSchemaValidationError\b/,
    /did not satisfy the schema after \d+ attempt/i,
    /\bno JSON value found in the reply\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

/**
 * Build a bounded in-run retry wrapper for stage agents. An infrastructure
 * fault (a hung or killed adapter stream, schema-retry exhaustion) says
 * nothing about the task branch, and the committed-ExecPlan durability
 * contract makes a warm re-run cheap — the retried agent finds the committed
 * plan and any committed work already on disk. Product failures (review
 * verdicts, gate failures) are never retried here; they flow through the
 * ordinary failure paths. The attempt budget is bound once by the caller
 * (run configuration), so call sites keep the two-argument `(run, label)`
 * shape of the returned function.
 *
 * @param attempts Maximum number of attempts (not extra retries) before the
 *   wrapper gives up and rethrows.
 */
export function makeWithInfraRetry(attempts: number) {
  return async function withInfraRetry<T>(run: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run()
      } catch (error) {
        const message = ((error as Error | null) && (error as Error).message) || String(error)
        if (attempt >= attempts || !infrastructureFailureDetail(message)) {
          // Log the terminal boundary distinctly from the retry path so
          // operators can see where the retry budget actually gave up.
          if (infrastructureFailureDetail(message)) {
            log(`[${label}] infrastructure fault persisted after ${attempt} of ${attempts} attempt(s); giving up: ${message}`)
          } else {
            log(`[${label}] non-infrastructure failure; not retried: ${message}`)
          }
          throw error
        }
        faultMetrics.infraRetries += 1
        log(`[${label}] infrastructure fault (${message}); retrying the stage agent (attempt ${attempt + 1} of ${attempts})`)
      }
    }
  }
}

/**
 * Task-result shape produced when an agent call fails outside the ordinary
 * product-review flow. `extends Record<string, unknown>` lets callers splice
 * in extra caller-specific fields (`extra`) without narrowing the type.
 */
export interface UnhandledAgentErrorResult extends Record<string, unknown> {
  /** Id of the task the failed agent call was working on. */
  id: string
  /** Fault classification, as decided by `resultFromUnhandledAgentError`. */
  status: 'fatal-auth' | 'provider-fault' | 'infra-fault' | 'failed'
  /** Pipeline stage the classification maps to, used for operator-facing grouping. */
  stage: string
  /** Original error text, unmodified, for operator diagnosis. */
  detail: string
  /** Always empty here: an unhandled agent error yields no proposals for review. */
  proposals: unknown[]
}

/**
 * Classify an unhandled agent error into a task result, checking
 * authentication, then provider, then infrastructure patterns in that order
 * (auth failures are the most actionable and must not be masked by a
 * coincidental provider/infra pattern match) and falling back to a generic
 * `'failed'` status. Increments the matching counter in `faultMetrics` as a
 * side effect so operators can see fault pressure without scraping logs.
 */
export function resultFromUnhandledAgentError(
  id: string,
  detail: string,
  extra: Record<string, unknown> = {},
): UnhandledAgentErrorResult {
  const authDetail = authFailureDetail(detail)
  if (authDetail) {
    faultMetrics.authFaults += 1
    return {
      id,
      status: 'fatal-auth',
      stage: 'auth',
      detail,
      proposals: [],
      ...extra,
    }
  }
  const providerDetail = providerFailureDetail(detail)
  if (providerDetail) {
    faultMetrics.providerFaults += 1
    return {
      id,
      status: 'provider-fault',
      stage: 'provider',
      detail,
      proposals: [],
      ...extra,
    }
  }
  const infraDetail = infrastructureFailureDetail(detail)
  if (infraDetail) {
    faultMetrics.infraFaults += 1
    return {
      id,
      status: 'infra-fault',
      stage: 'infrastructure',
      detail,
      proposals: [],
      ...extra,
    }
  }
  return {
    id,
    status: 'failed',
    stage: 'error',
    detail,
    proposals: [],
    ...extra,
  }
}
