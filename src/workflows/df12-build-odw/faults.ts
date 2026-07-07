// Failure classification and the bounded infrastructure retry. A failure's
// class decides the pool's response: fatal-auth halts new work, a provider
// fault defers the task, an infrastructure fault may be retried warm (the
// committed-ExecPlan durability contract makes re-runs cheap), and anything
// else flows through the ordinary product-failure paths.
import type { FaultMetrics } from './types.ts'

// Bounded-cardinality fault counters, surfaced verbatim in the run result so
// operators can see retry pressure and terminal fault classes without
// scraping logs. Fixed keys only — never keyed by task id or error text.
export const faultMetrics: FaultMetrics = { infraRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }

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
    // CodeRabbit's non-interactive login abandonment: "Automatic login timed
    // out. Use the printed fallback URL to finish authentication." Anchored on
    // the login/authentication context so unrelated "timeout" prose is not
    // misclassified as an auth failure.
    /\blogin tim(?:ed out|eout)\b/i,
    /\bfinish authentication\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

export function providerFailureDetail(value: unknown): string {
  const text = String(value || '')
  const patterns = [
    /\bAPI Error:\s*(?:429|500|502|503|504|529)\b/i,
    /\b(?:429|500|502|503|504|529)\b.*\b(?:gateway|overload|rate limit|server-side|temporar|timeout|unavailable)\b/i,
    /\b(?:gateway timeout|model overloaded|overloaded|rate limited|server-side issue|service unavailable|temporarily unavailable|try again in a moment)\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

// ODW-level infrastructure faults: the agent process died or its reply
// channel failed, so the error carries no evidence about the task branch.
// The patterns pin ODW's own stable error strings (bridge.ts
// cliFailureMessage and the schema-retry exhaustion message).
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

// Bounded in-run retry for stage agents. An infrastructure fault (a hung or
// killed adapter stream, schema-retry exhaustion) says nothing about the task
// branch, and the committed-ExecPlan durability contract makes a warm re-run
// cheap — the retried agent finds the committed plan and any committed work
// already on disk. Product failures (review verdicts, gate failures) are
// never retried here; they flow through the ordinary failure paths. The
// attempt budget is bound once by the caller (run configuration), so call
// sites keep the two-argument shape.
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

export interface UnhandledAgentErrorResult extends Record<string, unknown> {
  id: string
  status: 'fatal-auth' | 'provider-fault' | 'infra-fault' | 'failed'
  stage: string
  detail: string
  proposals: unknown[]
}

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
