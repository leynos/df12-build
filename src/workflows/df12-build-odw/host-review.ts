/**
 * Compose neutral host-review adapters, retry policy, sink, and metrics.
 *
 * Dakar and CodeRabbit protocol handling live in dedicated siblings; secure
 * gates live in `host-gates.ts`. This facade preserves the public workflow
 * surface and compatibility aliases while keeping workflow policy neutral.
 *
 * @module
 */
import { execFileStatus } from './exec.ts'
import { makeCoderabbitAttempt, parseCoderabbitAgentOutput, classifyCoderabbitOutcome, type CoderabbitError, type CoderabbitParsedOutput, CODERABBIT_SUCCESS_STATUSES } from './coderabbit-review.ts'
import { makeDakarAttempt, parseDakarDocument, mapDakarFinding, validateChangesRequestedFindings, validateCleanDakarFindings, classifyDakarReview, DAKAR_SEVERITY_MAP, type DakarAttemptDeps, type DakarDocument, type DakarFinding, type DakarFindingValidation, type DakarFindingValidationFailure, type DakarStateRoots } from './dakar-review.ts'
import { makeHostGates, hostGateLogPath, codeSceneExecutable } from './host-gates.ts'
import { tokenizeShellCommand } from './shell-command.ts'
import {
  boundedTail,
  HOST_REVIEW_BLOCKING_SEVERITIES,
  hostReviewDeferral,
  makeHostReviewMetrics,
  reviewBlockingItems,
  reviewerDisplayName,
  type CodeSceneCheckResult,
  type CodeSceneMetrics,
  type HostReviewAttempt,
  type HostGateMetrics,
  type HostGateResult,
  type HostGateRun,
  type HostReviewConfig,
  type HostReviewDeferral,
  type HostReviewDeps,
  type HostReviewMetrics,
  type HostReviewMetricsSnapshot,
  type HostReviewRecordingDeps,
  type HostReviewResult,
  type ReviewErrorCategory,
  type ReviewFinding,
  type ReviewOutcome,
} from './host-review-contracts.ts'

export {
  boundedTail,
  HOST_REVIEW_BLOCKING_SEVERITIES,
  hostGateLogPath,
  codeSceneExecutable,
  hostReviewDeferral,
  mapDakarFinding,
  parseCoderabbitAgentOutput,
  parseDakarDocument,
  reviewerDisplayName,
  validateChangesRequestedFindings,
  validateCleanDakarFindings,
  classifyCoderabbitOutcome,
  classifyDakarReview,
  DAKAR_SEVERITY_MAP,
  CODERABBIT_SUCCESS_STATUSES,
  reviewBlockingItems,
}
export type {
  CodeSceneCheckResult,
  DakarAttemptDeps,
  DakarStateRoots,
  CoderabbitError,
  CoderabbitParsedOutput,
  DakarDocument,
  DakarFinding,
  DakarFindingValidation,
  DakarFindingValidationFailure,
  HostGateRun,
  HostGateResult,
  HostReviewConfig,
  HostReviewDeferral,
  HostReviewDeps,
  HostReviewRecordingDeps,
  HostReviewAttempt,
  HostReviewResult,
  ReviewErrorCategory,
  ReviewFinding,
  ReviewOutcome,
}

/** Compatibility alias for integrations compiled against older names. */
export type CoderabbitFinding = ReviewFinding
/** Compatibility alias for the former CodeRabbit-specific outcome type. */
export type CoderabbitOutcome = ReviewOutcome
/** Compatibility alias for the former CodeRabbit-specific result type. */
export type CoderabbitReview = HostReviewResult

/** Compatibility blocking helper that labels findings as CodeRabbit output. */
export function coderabbitBlockingItems(findings: readonly ReviewFinding[] | null | undefined): string[] {
  return reviewBlockingItems('CodeRabbit', findings)
}

/** Sleep for a host-side review backoff without consuming agent tokens. */
export async function hostSleepMinutes(minutes: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, minutes * 60000))
}

/** Bound host-review operations and retained CodeRabbit compatibility aliases. */
export interface HostReviewSurface {
  /** Compute deterministic retry backoff for a label. */
  reviewBackoffMinutes: (seed: unknown) => number
  /** Run the selected reviewer through the neutral adapter boundary. */
  runHostReview: (worktree: string, label: string, deps?: HostReviewDeps & DakarAttemptDeps) => Promise<HostReviewResult>
  /** Serialize one terminal review and its findings to the configured sink. */
  recordHostReview: (label: string, review: HostReviewResult, deps?: HostReviewRecordingDeps) => Promise<void>
  /** Execute configured deterministic commit gates. */
  runHostCommitGates: (worktree: string, tag: string, roundLabel: string) => Promise<HostGateRun>
  /** Execute the optional CodeScene health check. */
  runCodeSceneCheck: (worktree: string, tag: string, label: string) => Promise<CodeSceneCheckResult>
  /** Release private host-gate log roots after all workflow work has settled. */
  disposeHostGateLogs: () => void
  /** Return a read-only snapshot of this surface's bounded counters. */
  metrics: () => HostReviewMetricsSnapshot
  /** Record an auth failure discovered by entrypoint preflight. */
  recordHostReviewAuthFailure: () => void
  /** Compatibility alias for `reviewBackoffMinutes`. */
  coderabbitBackoffMinutes: (seed: unknown) => number
  /** Compatibility alias for `runHostReview`. */
  runCoderabbitHostReview: (worktree: string, label: string, deps?: HostReviewDeps & DakarAttemptDeps) => Promise<HostReviewResult>
  /** Compatibility alias for `recordHostReview`. */
  recordCoderabbitReview: (label: string, review: HostReviewResult, deps?: HostReviewRecordingDeps) => Promise<void>
}

/** Bind reviewer dispatch, retry, findings recording, and host-gate execution. */
export function makeHostReview(config: HostReviewConfig): HostReviewSurface {
  const dakarTokens = tokenizeShellCommand(config.dakarCommand)
  if (!dakarTokens || dakarTokens.hasUnquotedControlOperator || dakarTokens.words.length === 0) {
    throw new Error('Invalid dakarCommand: expected a non-empty command without unquoted control operators')
  }
  const parsed = config.dakarInvocation || dakarTokens.words.map((word) => word.value)
  const dakarAttempt = makeDakarAttempt({ ...config, dakarInvocation: parsed })
  const coderabbitAttempt = makeCoderabbitAttempt(config)
  const hostReviewMetrics: HostReviewMetrics = makeHostReviewMetrics()
  const hostGateMetrics: HostGateMetrics = { runs: 0, failures: 0 }
  const csCheckMetrics: CodeSceneMetrics = { runs: 0, failures: 0, probeFailures: 0, skipped: 0 }
  const gates = makeHostGates(config, { hostGates: hostGateMetrics, codeScene: csCheckMetrics })
  let findingsSinkTail = Promise.resolve()

  /** Return the deterministic retry delay for one review label. */
  function reviewBackoffMinutes(seed: unknown): number {
    let hash = 5381
    for (const ch of String(seed)) hash = ((hash * 33) ^ (ch.codePointAt(0) as number)) >>> 0
    const [low, high] = config.coderabbitBackoffMinutes
    return low + (hash % (high - low + 1))
  }

  /** Run one selected host reviewer through the common retry envelope. */
  async function runHostReview(worktree: string, label: string, deps: HostReviewDeps & DakarAttemptDeps = {}): Promise<HostReviewResult> {
    const exec = deps.exec || execFileStatus
    const sleep = deps.sleep || hostSleepMinutes
    const nowMs = deps.nowMs || (() => Number(process.hrtime.bigint() / 1_000_000n))
    const reviewer = config.reviewTool
    const displayName = reviewerDisplayName(reviewer)
    const boundedLabel = boundedTail(label, 120)
    const startedMs = nowMs()
    let terminalAttempt = 1
    try {
      for (let attempt = 1; ; attempt++) {
        terminalAttempt = attempt
        log(`[${boundedLabel}] ${displayName} host review attempt ${attempt} of ${config.coderabbitAttempts}`)
        const single: HostReviewAttempt = reviewer === 'dakar' ? await dakarAttempt(worktree, exec, deps) : await coderabbitAttempt(worktree, exec)
        if (single.outcome === 'rate-limited' && attempt < config.coderabbitAttempts) {
          const minutes = reviewBackoffMinutes(`${boundedLabel}#${attempt}`)
          log(`[${boundedLabel}] ${displayName} rate limited/deferred; host backs off ${minutes} minutes before attempt ${attempt + 1} of ${config.coderabbitAttempts} (wall-clock only, no agent tokens)`)
          await sleep(minutes)
          continue
        }
        const review: HostReviewResult = { reviewer, outcome: single.outcome, attempts: attempt, elapsedMs: Math.max(0, Math.trunc(nowMs() - startedMs)), errorCategory: single.errorCategory, findings: single.findings, detail: boundedTail(single.detail) }
        hostReviewMetrics.runs += 1
        hostReviewMetrics.retries += attempt - 1
        if (review.outcome === 'rate-limited') hostReviewMetrics.deferred += 1
        if (review.outcome === 'auth') hostReviewMetrics.authFailures += 1
        if (review.outcome === 'error') hostReviewMetrics.errors += 1
        if (review.errorCategory === 'timeout') hostReviewMetrics.timeouts += 1
        log(`[host-review] terminal ${JSON.stringify({ reviewer, label: boundedLabel, attempts: attempt, elapsedMs: review.elapsedMs, outcome: review.outcome, errorCategory: review.errorCategory })}`)
        return review
      }
    } catch (error) {
      const elapsedMs = Math.max(0, Math.trunc(nowMs() - startedMs))
      hostReviewMetrics.runs += 1
      hostReviewMetrics.retries += terminalAttempt - 1
      hostReviewMetrics.errors += 1
      log(`[host-review] terminal ${JSON.stringify({ reviewer, label: boundedLabel, attempts: terminalAttempt, elapsedMs, outcome: 'error', errorCategory: 'execution' })}`)
      throw error
    }
  }

  /** Serialize findings, preserving review success when the durable sink fails. */
  async function recordHostReview(label: string, review: HostReviewResult, deps: HostReviewRecordingDeps = {}): Promise<void> {
    for (const finding of review.findings) {
      hostReviewMetrics.findings += 1
      const rawSeverity = String(finding.severity || 'unknown').toLowerCase()
      const severity = Object.hasOwn(hostReviewMetrics.bySeverity, rawSeverity) ? rawSeverity as keyof typeof hostReviewMetrics.bySeverity : 'unknown'
      hostReviewMetrics.bySeverity[severity] += 1
    }
    if (!config.coderabbitFindingsFile || !review.findings.length) return
    const append = async () => {
      const timestamp = deps.timestamp || (async () => {
        const stamp = await execFileStatus('date', ['-u', '+%Y-%m-%dT%H:%M:%SZ'])
        return stamp.ok ? stamp.stdout.trim() : ''
      })
      const ts = await timestamp()
      const lines = review.findings.map((finding) => JSON.stringify({ ts, label, severity: String(finding.severity || ''), file: String(finding.fileName || ''), comment: String(finding.comment || '').slice(0, 2000), codegenInstructions: String(finding.codegenInstructions || '').slice(0, 2000), suggestions: Array.isArray(finding.suggestions) ? finding.suggestions.length : 0 }))
      try {
        const appendFile = deps.append || (async (path: string, data: string) => {
          const fs = process.getBuiltinModule('node:fs/promises')
          await fs.appendFile(path, data, 'utf8')
        })
        await appendFile(config.coderabbitFindingsFile, `${lines.join('\n')}\n`)
      } catch (error) {
        hostReviewMetrics.sinkFailures += 1
        hostReviewMetrics.sinkError = boundedTail((error as Error | null)?.message || String(error), 500)
        log(`[${boundedTail(label, 120)}] could not append ${reviewerDisplayName(review.reviewer)} host-review findings to ${config.coderabbitFindingsFile}: ${hostReviewMetrics.sinkError}`)
      }
    }
    const pending = findingsSinkTail.then(append, append)
    findingsSinkTail = pending.then(() => undefined, () => undefined)
    await pending
  }

  /** Copy counters so result assembly cannot mutate this surface's state. */
  function metrics(): HostReviewMetricsSnapshot {
    return {
      hostReview: { ...hostReviewMetrics, bySeverity: { ...hostReviewMetrics.bySeverity } },
      hostGates: { ...hostGateMetrics },
      codeScene: { ...csCheckMetrics },
    }
  }

  /** Account for a selected reviewer failing preflight before dispatch. */
  function recordHostReviewAuthFailure(): void {
    hostReviewMetrics.authFailures += 1
  }

  return {
    reviewBackoffMinutes,
    runHostReview,
    recordHostReview,
    runHostCommitGates: gates.runHostCommitGates,
    runCodeSceneCheck: gates.runCodeSceneCheck,
    disposeHostGateLogs: gates.disposeHostGateLogs,
    metrics,
    recordHostReviewAuthFailure,
    coderabbitBackoffMinutes: reviewBackoffMinutes,
    runCoderabbitHostReview: runHostReview,
    recordCoderabbitReview: recordHostReview,
  }
}
