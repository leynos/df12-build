// Failure classification and the bounded infrastructure retry. A failure's
// class decides the pool's response: fatal-auth halts new work, a provider
// fault defers the task, an infrastructure fault may be retried warm (the
// committed-ExecPlan durability contract makes re-runs cheap), and anything
// else flows through the ordinary product-failure paths.
import type { FaultMetrics } from './types.ts'

// Bounded-cardinality fault counters, surfaced verbatim in the run result so
// operators can see retry pressure and terminal fault classes without
// scraping logs. Fixed keys only — never keyed by task id or error text.
export const faultMetrics: FaultMetrics = { infraRetries: 0, providerRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }

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

// Thin setTimeout-backed sleep in seconds, injectable so the retry loop can
// pause between provider-fault attempts while tests substitute an instant
// stub. Seconds (not minutes) because provider rate-limits recover fast; the
// CodeRabbit host review uses the minute-scale sibling in host-review.ts.
export async function hostSleepSeconds(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

// Deterministic jitter in [low, high] seconds: Math.random() is banned for
// Claude Code workflow dual-compatibility (ODW scanDualCompat), and a seeded
// spread keeps sibling tasks that hit the same provider limit from retrying in
// lockstep. Mirrors coderabbitBackoffMinutes in host-review.ts.
export function infraRetryBackoffSeconds(seed: unknown, range: [number, number]): number {
  let hash = 5381
  for (const ch of String(seed)) hash = ((hash * 33) ^ (ch.codePointAt(0) as number)) >>> 0
  const [low, high] = range
  return low + (hash % (high - low + 1))
}

// Best-effort parse of an advertised retry-after wait, in seconds, from an
// error message. Provider faults are free text (adapter stderr/exception
// strings), never HTTP header objects, so this scans for the common shapes
// (`retry-after: N`, `try again in N second(s)/minute(s)`). Returns 0 when no
// wait is advertised; the caller clamps any hit into the configured range so a
// hostile or huge value cannot stall the run.
export function parseRetryAfterSeconds(value: unknown): number {
  const text = String(value || '')
  const header = text.match(/retry[-\s]?after[:\s]+(\d+(?:\.\d+)?)/i)
  if (header) return Number(header[1])
  const phrase = text.match(/try again in (\d+(?:\.\d+)?)\s*(second|minute)/i)
  if (phrase) {
    const amount = Number(phrase[1])
    return /^minute/i.test(phrase[2]) ? amount * 60 : amount
  }
  return 0
}

// Bounded in-run retry for stage agents. An infrastructure fault (a hung or
// killed adapter stream, schema-retry exhaustion) says nothing about the task
// branch, and the committed-ExecPlan durability contract makes a warm re-run
// cheap — the retried agent finds the committed plan and any committed work
// already on disk, so infra faults retry immediately. A provider rate-limit is
// transient too, but retrying it instantly just burns the attempt budget
// against the same closed window, so provider faults now retry with a bounded
// backoff (honouring an advertised retry-after when present, else deterministic
// seeded jitter) before each re-run. Product failures (review verdicts, gate
// failures) are never retried here; they flow through the ordinary failure
// paths. The attempt budget, backoff range, and sleep primitive are bound once
// by the caller (run configuration), so call sites keep the two-argument shape.
export function makeWithInfraRetry(
  attempts: number,
  backoffRange: [number, number] = [5, 30],
  sleep: (seconds: number) => Promise<void> = hostSleepSeconds,
) {
  const [low, high] = backoffRange
  const clampToRange = (seconds: number) => Math.min(high, Math.max(low, seconds))
  return async function withInfraRetry<T>(run: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run()
      } catch (error) {
        const message = ((error as Error | null) && (error as Error).message) || String(error)
        // Classify with the same precedence as resultFromUnhandledAgentError
        // (auth > provider > infra). An adapter can wrap a provider rate-limit
        // or an auth failure inside its own "adapter '…' exited with code N"
        // string, which infrastructureFailureDetail also matches. Checking auth
        // and provider first keeps a wrapped rate-limit on the backoff path
        // (rather than an immediate infra re-run against the same closed window)
        // and stops a wrapped auth failure from burning the retry budget —
        // matching how the terminal classifier reports the identical message.
        const isAuth = authFailureDetail(message) !== ''
        const isProvider = !isAuth && providerFailureDetail(message) !== ''
        const isInfra = !isAuth && !isProvider && infrastructureFailureDetail(message) !== ''
        if (attempt >= attempts || (!isInfra && !isProvider)) {
          // Log the terminal boundary distinctly from the retry path so
          // operators can see where the retry budget actually gave up.
          if (isInfra) {
            log(`[${label}] infrastructure fault persisted after ${attempt} of ${attempts} attempt(s); giving up: ${message}`)
          } else if (isProvider) {
            log(`[${label}] provider rate-limit persisted after ${attempt} of ${attempts} attempt(s); giving up: ${message}`)
          } else if (isAuth) {
            log(`[${label}] authentication failure; not retried (fatal): ${message}`)
          } else {
            log(`[${label}] non-infrastructure failure; not retried: ${message}`)
          }
          throw error
        }
        if (isProvider) {
          faultMetrics.providerRetries += 1
          const advertised = parseRetryAfterSeconds(message)
          const wait = advertised > 0 ? clampToRange(advertised) : infraRetryBackoffSeconds(`${label}#${attempt}`, backoffRange)
          const source = advertised > 0 ? 'retry-after' : 'jitter'
          log(`[${label}] provider rate-limit (${message}); backing off ${wait}s (${source}) before retrying the stage agent (attempt ${attempt + 1} of ${attempts})`)
          await sleep(wait)
        } else {
          faultMetrics.infraRetries += 1
          log(`[${label}] infrastructure fault (${message}); retrying the stage agent (attempt ${attempt + 1} of ${attempts})`)
        }
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
