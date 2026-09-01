/**
 * Shared, vendor-neutral contracts and bounded helpers for host review.
 *
 * The adapter modules depend on these definitions without importing the
 * composition facade, which keeps the ODW module graph acyclic.
 *
 * @module
 */
import type { ExecOptions, ExecStatus } from './exec.ts'

/** Normalized finding shape produced by every host-review adapter. */
export interface ReviewFinding extends Record<string, unknown> {
  /** Wire discriminator retained for compatibility with the findings sink. */
  type?: string
  /** Normalized severity; critical and major findings block integration. */
  severity?: string
  /** Repository-relative file associated with the finding. */
  fileName?: string
  /** Bounded human-readable explanation of the finding. */
  comment?: string
  /** Bounded machine-oriented remediation guidance. */
  codegenInstructions?: string
  /** Suggested edits retained from the reviewer protocol. */
  suggestions?: unknown[]
}

/** Tool-neutral terminal outcome vocabulary. */
export type ReviewOutcome = 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'

/** Bounded reason attached to terminal host-review telemetry. */
export type ReviewErrorCategory = 'none' | 'deferred' | 'timeout' | 'auth' | 'invalid-output' | 'execution'

/** Validated result produced by exactly one reviewer adapter attempt. */
export interface HostReviewAttempt {
  /** Tool-neutral terminal outcome. */
  outcome: ReviewOutcome
  /** Validated and normalized findings. */
  findings: ReviewFinding[]
  /** Bounded operator-facing diagnostic. */
  detail: string
  /** Bounded telemetry category. */
  errorCategory: ReviewErrorCategory
}

/** One completed host-review result after bounded retries. */
export interface HostReviewResult {
  /** Bounded machine identifier for the adapter that ran. */
  reviewer: 'dakar' | 'coderabbit'
  /** Tool-neutral terminal classification consumed by workflow policy. */
  outcome: ReviewOutcome
  /** Number of attempts made, including the terminal attempt. */
  attempts: number
  /** Host-side elapsed duration across attempts and backoff. */
  elapsedMs: number
  /** Bounded diagnostic category for metrics and terminal events. */
  errorCategory: ReviewErrorCategory
  /** Normalized findings from the terminal attempt. */
  findings: ReviewFinding[]
  /** Bounded operator-facing detail; empty for successful outcomes. */
  detail: string
}

/** Structured recovery record for a host review that could not complete. */
export interface HostReviewDeferral {
  /** Stable discriminator for addendum recovery policy. */
  kind: 'host-review-deferral'
  /** Adapter that deferred or failed. */
  reviewer: HostReviewResult['reviewer']
  /** Terminal result that prevented a definitive review. */
  outcome: Extract<ReviewOutcome, 'rate-limited' | 'error'>
  /** Bounded error category for recovery decisions. */
  errorCategory: ReviewErrorCategory
  /** Attempt count retained for operator context. */
  attempts: number
  /** Bounded diagnostic retained without parsing vendor wire text. */
  detail: string
}

/** One deterministic host-gate execution result. */
export interface HostGateResult {
  /** Configured gate command. */
  command: string
  /** Whether the gate exited successfully. */
  ok: boolean
  /** Secure log file containing complete gate output. */
  logFile: string
}

/** Aggregate result from the configured deterministic host gates. */
export interface HostGateRun {
  /** True only when every configured host gate passed. */
  green: boolean
  /** Per-gate results in execution order. */
  results: HostGateResult[]
  /** Bounded failure detail, empty when all gates pass. */
  detail: string
}

/** Result of the optional CodeScene host check. */
export interface CodeSceneCheckResult {
  /** Whether CodeScene accepted the committed change. */
  clean: boolean
  /** Whether the check was skipped because its executable was unavailable. */
  skipped: boolean
  /** Bounded operator-facing result detail. */
  detail: string
  /** Secure log path containing the complete command output. */
  logFile: string
}

/** Injectable execution, sleep, and clock seams shared by all reviewer adapters. */
export interface HostReviewDeps {
  /** Process runner used by both reviewer adapters. */
  exec?: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  /** Host-side backoff seam measured in minutes. */
  sleep?: (minutes: number) => Promise<void>
  /** Monotonic-enough millisecond clock used only for bounded telemetry. */
  nowMs?: () => number
}

/** Injectable persistence seams for the serialized findings sink. */
export interface HostReviewRecordingDeps {
  /** Produce the UTC timestamp written with persisted findings. */
  timestamp?: () => Promise<string>
  /** Append one already-formatted JSONL batch to the configured sink. */
  append?: (path: string, data: string) => Promise<void>
}

/** Run-scoped gate-log root lifecycle, injected where filesystem ownership matters. */
export interface HostGateLogRoot {
  /** Allocate the private directory used for this workflow's gate logs. */
  create: () => string
  /** Recursively remove the allocated private directory when the workflow ends. */
  remove: (root: string, options: { recursive: true; force: true }) => void
}

/** Bound configuration shared by reviewer adapters and host gates. */
export interface HostReviewConfig {
  /** Base branch used for committed-diff reviews. */
  base: string
  /** Reviewer adapter; Dakar is the default and CodeRabbit is opt-in. */
  reviewTool: HostReviewResult['reviewer']
  /** Dakar executable plus optional fixed prefix arguments. */
  dakarCommand: string
  /** Parsed Dakar invocation shared with preflight when the entrypoint binds it. */
  dakarInvocation?: readonly string[]
  /** Values that review diagnostics must redact before they leave the adapter. */
  dakarSensitiveValues?: readonly string[]
  /** Parent execution timeout shared by both reviewer adapters. */
  reviewTimeoutSeconds: number
  /** Dakar budget in GBP; zero omits the argument and uses Dakar's default. */
  dakarBudgetGbp: number
  /** Maximum host-review attempts before a deferral becomes terminal. */
  reviewAttempts: number
  /** @deprecated Use {@link reviewAttempts}. */
  coderabbitAttempts?: number
  /** Inclusive deterministic retry-backoff range in minutes. */
  reviewBackoffMinutes: [number, number]
  /** @deprecated Use {@link reviewBackoffMinutes}. */
  coderabbitBackoffMinutes?: [number, number]
  /** Durable JSONL findings sink; an empty path disables recording. */
  reviewFindingsFile: string
  /** @deprecated Use {@link reviewFindingsFile}. */
  coderabbitFindingsFile?: string
  /** Deterministic host gate commands run against committed work. */
  commitGates: readonly string[]
  /** Per-command host-gate timeout in seconds. */
  commitGateTimeoutSeconds: number
  /** Whether the CodeScene health gate is enabled. */
  csCheck: boolean
  /** Configured CodeScene command line. */
  csCheckCommand: string
  /** Optional per-surface secure gate-log naming seam for deterministic tests. */
  gateLogPath?: (tag: string, roundLabel: string, index: number) => string
  /** Optional gate-log allocation lifecycle used by host-gate boundaries. */
  gateLogRoot?: HostGateLogRoot
}

/** Metric aggregate maintained per composed host-review surface. */
export interface HostReviewMetrics {
  /** Terminal host-review runs. */
  runs: number
  /** Findings recorded across terminal runs. */
  findings: number
  /** Non-terminal retry attempts. */
  retries: number
  /** Terminal deferred outcomes. */
  deferred: number
  /** Terminal timeout outcomes. */
  timeouts: number
  /** Terminal non-auth error outcomes. */
  errors: number
  /** Authentication and preflight failures. */
  authFailures: number
  /** Findings-sink write failures. */
  sinkFailures: number
  /** Findings grouped by a fixed severity vocabulary. */
  bySeverity: Record<'critical' | 'major' | 'minor' | 'trivial' | 'info' | 'unknown', number>
  /** Last bounded sink error, empty when healthy. */
  sinkError: string
}

/** Metric aggregate maintained for deterministic host gates. */
export interface HostGateMetrics {
  /** Host-gate executions attempted. */
  runs: number
  /** Host-gate executions that failed. */
  failures: number
}

/** Metric aggregate maintained for optional CodeScene checks. */
export interface CodeSceneMetrics {
  /** CodeScene checks attempted. */
  runs: number
  /** Checks that reported unhealthy code. */
  failures: number
  /** Availability probes that failed unexpectedly. */
  probeFailures: number
  /** Checks skipped because the executable was unavailable. */
  skipped: number
}

/** Immutable copy of the counters accumulated by one host-review surface. */
export interface HostReviewMetricsSnapshot {
  /** Host-review adapter counters. */
  hostReview: HostReviewMetrics
  /** Deterministic host-gate counters. */
  hostGates: HostGateMetrics
  /** Optional CodeScene counters. */
  codeScene: CodeSceneMetrics
}

/** Bound untrusted text before retaining it in output, logs, or a sink. */
export function boundedTail(text: unknown, limit = 2000): string {
  const value = String(text || '')
  return value.length > limit ? value.slice(-limit) : value
}

/** Return the capitalized reviewer name used in operator-facing prose. */
export function reviewerDisplayName(reviewer: HostReviewResult['reviewer']): string {
  switch (reviewer) {
    case 'dakar': return 'Dakar'
    case 'coderabbit': return 'CodeRabbit'
    default: {
      const unmatched: never = reviewer
      throw new Error(`Unknown host reviewer: ${unmatched}`)
    }
  }
}

/** Project a terminal deferred host-review result into recovery policy data. */
export function hostReviewDeferral(review: HostReviewResult): HostReviewDeferral | null {
  if (review.outcome !== 'rate-limited' && review.outcome !== 'error') return null
  return { kind: 'host-review-deferral', reviewer: review.reviewer, outcome: review.outcome, errorCategory: review.errorCategory, attempts: review.attempts, detail: boundedTail(review.detail) }
}

/** Severities that enter the shared blocking-items gate. */
/** Normalized severities that block the host-review integration gate. */
export const HOST_REVIEW_BLOCKING_SEVERITIES = new Set(['critical', 'major'])
/** @deprecated Use {@link HOST_REVIEW_BLOCKING_SEVERITIES}. */
export const CODERABBIT_BLOCKING_SEVERITIES = HOST_REVIEW_BLOCKING_SEVERITIES

/** Convert blocking normalized findings into bounded fix-round items. */
export function reviewBlockingItems(reviewer: string, findings: readonly ReviewFinding[] | null | undefined): string[] {
  const name = boundedTail(reviewer, 40) || 'host reviewer'
  return (findings || [])
    .filter((finding) => HOST_REVIEW_BLOCKING_SEVERITIES.has(String(finding.severity || '').toLowerCase()))
    .map((finding) => `${name} (${finding.severity}) ${finding.fileName || 'unknown file'}: ${String(finding.comment || finding.codegenInstructions || 'see the recorded suggestions').slice(0, 500)}`)
}

/** Construct a zeroed, run-scoped host-review metric aggregate. */
export function makeHostReviewMetrics(): HostReviewMetrics {
  return { runs: 0, findings: 0, retries: 0, deferred: 0, timeouts: 0, errors: 0, authFailures: 0, sinkFailures: 0, bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, info: 0, unknown: 0 }, sinkError: '' }
}
