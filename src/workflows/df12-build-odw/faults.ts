/**
 * @file Failure classification and the bounded in-run stage-agent retry for the
 * ODW workflow. A failure's class decides the pool's response: fatal-auth halts
 * new work, a provider fault is retried with a bounded backoff, an
 * infrastructure fault is retried warm (the committed-ExecPlan durability
 * contract makes re-runs cheap), and anything else flows through the ordinary
 * product-failure paths. Classification precedence is auth > provider > infra,
 * so an adapter that wraps a provider or auth failure inside its own
 * process-exit string is still routed by the underlying cause.
 */
import type { FaultMetrics } from './types.ts'

/**
 * Bounded-cardinality fault counters, surfaced verbatim in the run result so
 * operators can read retry pressure and terminal fault classes without scraping
 * logs. The keys are fixed — never keyed by task id or error text — so the
 * metric cardinality stays constant: `infraRetries`/`providerRetries` count
 * re-run attempts made by {@link makeWithInfraRetry}, while
 * `infraFaults`/`providerFaults`/`authFaults` count terminal classifications
 * recorded by {@link resultFromUnhandledAgentError}. Mutated in place by both.
 */
export const faultMetrics: FaultMetrics = { infraRetries: 0, providerRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 }

/**
 * Detect a fatal authentication/credential failure in an error message. Matches
 * the stable auth-failure strings the adapters and CodeRabbit emit (a 401,
 * "not logged in", signed-out, expired/missing tokens, `loggedIn: false`, and
 * login-required hints). Auth is the highest-precedence class: it halts new work
 * and is never retried.
 *
 * @param value The error or message to classify (coerced to a string).
 * @returns The trimmed matched detail when the text looks like an auth failure,
 *   otherwise an empty string — the falsy "not an auth failure" signal callers
 *   test with `!== ''`.
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
 * Detect a transient provider-side limit in an error message: an `API Error`
 * carrying a 429/500/502/503/504/529 status, or free-text overload / rate-limit
 * / gateway-timeout / service-unavailable phrasing. A provider fault carries no
 * verdict about the task branch, so the retry loop backs off and retries it in
 * place rather than halting the task. Ranks below auth but above infrastructure.
 *
 * @param value The error or message to classify (coerced to a string).
 * @returns The trimmed matched detail when the text looks like a provider fault,
 *   otherwise an empty string.
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
 * Detect an ODW-level infrastructure fault: the agent process died or its reply
 * channel failed (an adapter timeout, a non-zero adapter exit, an
 * `AdapterExecutionError`, a `SchemaValidationError`, schema-retry exhaustion,
 * or an empty reply), so the error carries no evidence about the task branch.
 * The patterns pin ODW's own stable error strings (bridge.ts `cliFailureMessage`
 * and the schema-retry exhaustion message). This is the lowest-precedence class,
 * so a message that also matches auth or provider is routed by those first.
 *
 * @param value The error or message to classify (coerced to a string).
 * @returns The trimmed matched detail when the text looks like an infrastructure
 *   fault, otherwise an empty string.
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
 * The production backoff sleep: a thin `setTimeout`-backed pause measured in
 * seconds. It is the default `sleep` injected into {@link makeWithInfraRetry},
 * so the retry loop actually waits between provider-fault attempts, while tests
 * substitute an instant stub that records the requested durations instead of
 * pausing. Seconds (not minutes) because provider rate-limits recover fast; the
 * CodeRabbit host review uses the minute-scale sibling in host-review.ts.
 *
 * @param seconds How long to pause, in seconds.
 * @returns A promise that resolves once the pause has elapsed.
 */
export async function hostSleepSeconds(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

/**
 * Deterministic backoff jitter, in whole seconds, spread across `[low, high]`. A
 * DJB2 hash of the seed picks a point in the range, so `Math.random()` (banned
 * for Claude Code workflow dual-compatibility — ODW scanDualCompat) is never
 * called, yet distinct seeds still de-synchronise sibling tasks that hit the
 * same provider limit at once. The result is stable for a given seed and range.
 * Mirrors `coderabbitBackoffMinutes` in host-review.ts.
 *
 * @param seed A stable per-attempt key; the retry loop passes `${label}#${attempt}`.
 * @param range The inclusive `[low, high]` bounds; callers pass an already-clamped
 *   range (low >= 1, high >= low).
 * @returns An integer wait within `[low, high]` seconds.
 */
export function infraRetryBackoffSeconds(seed: unknown, range: [number, number]): number {
  let hash = 5381
  for (const ch of String(seed)) hash = ((hash * 33) ^ (ch.codePointAt(0) as number)) >>> 0
  const [low, high] = range
  return low + (hash % (high - low + 1))
}

/**
 * Best-effort parse of an advertised retry-after wait, in seconds, from an error
 * message. Provider faults arrive as free text (adapter stderr/exception
 * strings), never HTTP header objects, so this scans for the two common shapes —
 * `retry-after: N` and `try again in N second(s)/minute(s)`, converting minutes
 * to seconds. The advertised value is returned at face value; the caller clamps
 * any hit into the configured range so a hostile or huge wait cannot stall the
 * run.
 *
 * @param value The error or message to scan (coerced to a string).
 * @returns The advertised wait in seconds, or 0 when none is advertised.
 */
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

/**
 * Build the bounded in-run retry wrapper for stage agents. The attempt budget,
 * backoff range, and sleep primitive are bound once by the caller (run
 * configuration), so call sites keep the two-argument
 * `withInfraRetry(run, label)` shape.
 *
 * The returned wrapper re-runs `run` until it resolves or the budget is spent,
 * classifying each failure with the same precedence as
 * {@link resultFromUnhandledAgentError} (auth > provider > infra):
 * - Infrastructure faults retry immediately, with no backoff: the
 *   committed-ExecPlan durability contract makes a warm re-run cheap — the
 *   retried agent finds the committed plan and any committed work already on
 *   disk — and an adapter death is not a quota window a pause would clear. Each
 *   retry increments `faultMetrics.infraRetries`.
 * - Provider rate-limits retry after a bounded backoff, because retrying a
 *   still-closed window instantly just burns the budget. The wait honours an
 *   advertised `retry-after` clamped into `backoffRange` when present, else a
 *   deterministic seeded jitter over `${label}#${attempt}`. Each retry
 *   increments `faultMetrics.providerRetries` and awaits the injected `sleep`.
 * - Auth failures and product failures (review verdicts, gate failures) are
 *   never retried; they rethrow at once for the ordinary failure paths.
 * When the budget is exhausted the last error is rethrown.
 *
 * @param attempts Total attempts per stage agent, counting the first try.
 * @param backoffRange Inclusive `[low, high]` seconds for the provider-fault
 *   backoff; also the clamp bounds for an advertised `retry-after`. Defaults to
 *   `[5, 30]`.
 * @param sleep Injected async pause awaited before each provider retry; defaults
 *   to {@link hostSleepSeconds} and is replaced by an instant stub in tests.
 * @returns `withInfraRetry(run, label)`, which resolves with `run`'s value or
 *   rethrows the terminal error once the budget or classification says stop.
 */
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

/**
 * The synthetic task result {@link resultFromUnhandledAgentError} returns for an
 * error that escaped a stage's own handling. `status` carries the classified
 * fault class and `stage` the phase it maps to; `proposals` defaults empty and
 * caller-supplied `extra` fields are spread on top, so the object stays
 * assignable to the general task-result record the pool consumes.
 */
export interface UnhandledAgentErrorResult extends Record<string, unknown> {
  id: string
  status: 'fatal-auth' | 'provider-fault' | 'infra-fault' | 'failed'
  stage: string
  detail: string
  proposals: unknown[]
}

/**
 * Turn an unhandled agent error into a typed, terminal task result, classifying
 * it with auth > provider > infra precedence (matching {@link makeWithInfraRetry})
 * and falling back to a plain `failed`. Increments the matching terminal
 * `faultMetrics` counter (`authFaults`/`providerFaults`/`infraFaults`) for the
 * chosen class. This is the terminal reporter, distinct from the retry loop: it
 * records the class the run result should carry once retries are exhausted or a
 * fault is non-retryable.
 *
 * @param id The task id the failing stage belongs to.
 * @param detail The raw error text to classify and surface to the operator.
 * @param extra Additional fields spread onto the result (e.g. the worktree path).
 * @returns The typed result with `status` and `stage` set from the classification.
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
