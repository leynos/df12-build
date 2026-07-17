/**
 * @file ADR 002 partial-branch assessment: deferred-review classification, the
 * manual-merge handoff guard, the assessment gate, and the report-only
 * assessment agents. Assessment output NEVER merges, pushes, or ticks the
 * roadmap; classification is advice for the operator, and host-collected
 * evidence is decisive over anything the agent reports. The run wiring
 * (preamble, adapter routing, retry, enable switch) binds once via
 * makeAssessment.
 */
import { ASSESSMENT_SCHEMA } from './schemas.ts'
import {
  authFailureDetail,
  infrastructureFailureDetail,
  providerFailureDetail,
} from './faults.ts'
import { collectAssessmentEvidence } from './git-evidence.ts'
import type { AssessmentEvidence } from './git-evidence.ts'
import { salvageTaskArtefacts } from './execplan-durability.ts'
import type { SalvageOutcome } from './execplan-durability.ts'
import type { RecoveryCandidate } from './types.ts'

// States in which the assessed branch is KEPT (not fully adopted), so any
// untracked task-scoped ExecPlan/review artefact is worth durably committing
// onto the branch before later cleanup:
//   - `adopt-partial`  — ADR 002 preserves work "only through Git state", which
//     is exactly a branch-local commit;
//   - `continue-manual` — hands the branch to an operator who needs the planning
//     artefacts intact;
//   - `infra-fault`    — schema-retry exhaustion / adapter death never reaches
//     the model assessment (faults.ts), yet a planner or reviewer may have
//     written the artefact just before the parse failure, which is exactly the
//     case issue #18 targets. This is not a model classification (the schema
//     enum cannot produce it), so it never collides with a model verdict; the
//     infra-fault salvage path passes it explicitly.
// `adopt-complete` proceeds through the ordinary path and `discard` is thrown
// away, so neither salvages.
const SALVAGE_CLASSIFICATIONS = new Set(['continue-manual', 'adopt-partial', 'infra-fault'])

/**
 * A salvage record carrying the classification that triggered (or skipped) it,
 * spread onto the assessment result. The result types extend
 * Record<string, unknown>, so this rides through run-task.ts without a breaking
 * type change.
 */
export interface SalvageRecord extends SalvageOutcome {
  /** The assessment classification that triggered (or skipped) the salvage. */
  classification: string
}

/**
 * One run-summary row per task that ATTEMPTED salvage (committed or skipped),
 * carrying the classification, committed paths, a skipped-count, the commit sha,
 * and the (structured) detail.
 */
export interface SalvageSummaryEntry {
  /** The task id whose branch attempted salvage. */
  id: string
  /** The classification that drove the attempt. */
  classification: string
  /** Repository-relative paths actually committed; empty for a skipped attempt. */
  committed: string[]
  /** Count of candidate paths skipped (not the salvage-convention artefacts). */
  skipped: number
  /** The salvage commit sha, or '' when nothing was committed. */
  sha: string
  /** Structured detail (e.g. the skip reason), unbounded for the summary row. */
  detail: string
}

/**
 * Aggregate per-task salvage records into the terminal run summary. Every task
 * whose result carries a `salvage` record contributes a row — including a
 * skipped attempt, which has `committed: []` — so `salvages` is empty only when
 * no salvage was attempted anywhere. `salvagedBranches` counts the branches that
 * actually committed artefacts, and drives `summarySuffix`, which is '' when
 * every attempt was a skip (nothing committed). Pure and side-effect free so the
 * aggregation can be unit-tested without running the workflow body.
 *
 * @param results Per-task results, each optionally carrying a `salvage` record.
 * @returns The `salvages` rows, the `salvagedBranches` count, and the
 *   `summarySuffix` text for the terminal run summary.
 */
export function summarizeSalvages(
  results: ReadonlyArray<{ id?: string; salvage?: Partial<SalvageRecord> | null }>,
): {
  /** One row per task that attempted salvage (committed or skipped). */
  salvages: SalvageSummaryEntry[]
  /** Count of branches that actually committed artefacts. */
  salvagedBranches: number
  /** Terminal-summary suffix text; '' when every attempt was a skip. */
  summarySuffix: string
} {
  const salvages: SalvageSummaryEntry[] = results
    .filter((result) => result.salvage)
    .map((result) => ({
      id: result.id || '',
      classification: result.salvage?.classification || '',
      committed: result.salvage?.committed || [],
      skipped: (result.salvage?.skipped || []).length,
      sha: result.salvage?.sha || '',
      detail: result.salvage?.detail || '',
    }))
  const salvagedBranches = salvages.filter((entry) => entry.committed.length > 0).length
  const summarySuffix = salvagedBranches ? ` | salvaged artefacts on ${salvagedBranches} branch(es)` : ''
  return { salvages, salvagedBranches, summarySuffix }
}

/** The build/fix-report shape addendum manual-merge and auth-failure checks read from. */
export interface ImplementationReport {
  /** Builder's own success claim; a complete-but-not-ok report is a manual-merge handoff. */
  ok?: boolean
  /** Builder's claim that the required gates are green (host-verified elsewhere). */
  gatesGreen?: boolean
  /** Work items the builder reports complete; coerced to a number for the completion check. */
  workItemsCompleted?: unknown
  /** Total work items; coerced to a number for the completion check. */
  workItemsTotal?: unknown
  /** Free-text summary, scanned for auth-failure detail. */
  summary?: string
  /** Open issues; tolerated for handoff only when every one is a deferred review. */
  openIssues?: readonly string[]
}

/** A task result eligible for ADR 002 assessment: its status, stage, detail, and open issues. */
export interface AssessableResult extends Record<string, unknown> {
  /** Terminal task status; only 'failed'/'halted' branches are assessment candidates. */
  status?: string
  /** Failure stage; infra/auth/provider/worktree stages are excluded from assessment. */
  stage?: string
  /** Failure detail, scanned for auth/provider/infrastructure fault patterns. */
  detail?: string
  /** Open issues, folded into the fault-pattern scan alongside `detail`. */
  openIssues?: readonly string[]
}

/** The branch identity and location assessment needs: branch name, worktree path, and base commit. */
export interface AssessmentWorktree {
  /** The surviving task branch name; assessment is skipped when absent. */
  branch?: string
  /** The branch's worktree path, read for host evidence and salvage. */
  worktreePath?: string
  /** The base commit the branch diverged from. */
  baseSha?: string
}

/** The run wiring `makeAssessment` binds once: the prompt preamble, the enable switch, adapter routing, the escalation model, and the shared infra-retry wrapper. */
export interface AssessmentDeps {
  /** Builds the shared prompt preamble for a given worktree path. */
  preamble: (worktree: string | null | undefined) => string
  /** Master enable switch; when false, no assessment or salvage runs. */
  assessPartialBranches: boolean
  /** Maps base agent options to the routed adapter options for the assessment call. */
  assessmentAgentOptions: (options: Record<string, unknown>) => Record<string, unknown>
  /** The escalation model used for high-stakes adopt-complete candidates. */
  assessmentEscalationModel: string
  /** Wraps a model call with the shared infrastructure-fault retry policy. */
  withInfraRetry: <T>(run: () => Promise<T>, label: string) => Promise<T>
}

/**
 * Deterministic fast-classifier for the two clear, non-judgement cases, run
 * before any model call: an empty branch with a clean worktree is `discard`
 * (nothing durable to adopt) and a host evidence-collection failure is
 * `continue-manual` (cannot judge without evidence). Everything else — a
 * branch with committed work, or a dirty worktree (whose downgrade the
 * recovery eligibility gate owns) — returns null and reaches the model. Never
 * yields an adopt verdict, so recovery review-mode resume is unaffected.
 *
 * @param evidence Host-collected git evidence, or undefined/null when unavailable.
 * @returns The classification and reason, or null when the model must decide.
 */
export function fastAssessmentClassification(
  evidence: { collectionErrors?: readonly string[]; dirtyState?: string; recentCommits?: readonly unknown[] } | null | undefined,
): {
  /** The deterministic classification ('discard' or 'continue-manual'). */
  classification: string
  /** Operator-facing rationale, reused as the assessment rationale/recommendation. */
  reason: string
} | null {
  const collectionErrors = evidence?.collectionErrors || []
  if (collectionErrors.length) {
    return { classification: 'continue-manual', reason: `host evidence collection reported error(s) (${collectionErrors.slice(0, 3).join('; ')}); operator judgement required` }
  }
  const hasCommittedWork = (evidence?.recentCommits || []).length > 0
  const dirtyState = evidence?.dirtyState || 'unknown'
  if (!hasCommittedWork && dirtyState === 'clean') {
    return { classification: 'discard', reason: 'the branch has no committed work and a clean worktree; nothing durable to adopt' }
  }
  // Everything else — including dirty branches, whose downgrade is owned by the
  // recovery eligibility gate — reaches the model.
  return null
}

// Build a schema-shaped assessment object for a deterministic classification,
// carrying host evidence and a `classifier: 'deterministic'` marker so
// operators can see it was not a model judgement.
function deterministicAssessment(
  classification: string,
  evidence: AssessmentEvidence,
  reason: string,
): Record<string, unknown> {
  return {
    classification,
    branchName: evidence.branchName || '',
    worktreePath: evidence.worktreePath || '',
    baseCommit: evidence.baseCommit || '',
    currentCommit: evidence.currentCommit || '',
    dirtyState: evidence.dirtyState || 'unknown',
    changedFiles: evidence.changedFiles || [],
    taskScoped: false,
    execPlan: '',
    roadmap: '',
    validation: '',
    missingEvidence: [],
    residualRisk: [],
    risks: [],
    rationale: reason,
    recommendation: reason,
    nextActions: [],
    classifier: 'deterministic',
    hostEvidence: evidence,
  }
}

// Salvage detail and caught git-error text can carry multi-line git stderr;
// collapse whitespace and bound the length so a single operator log line never
// dumps an unbounded stderr blob. The full text still rides on the structured
// `result.salvage.detail`; only the log line is bounded.
function boundedSalvageLogText(text: unknown, max = 200): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Commit any untracked/uncommitted task-scoped planning or review artefact the
// assessed branch left behind, so a `continue-manual`/`adopt-partial` handoff
// keeps the ExecPlan and review files the operator (or a later resume) needs.
// Salvage runs only on a kept-but-not-adopted classification; every other
// classification records a skip reason instead. It is deliberately total: a
// git failure or an unexpected throw records a reason rather than escaping,
// because salvage must never turn a failed task into a run-halting error.
async function salvageAssessmentArtefacts(
  taskId: string,
  worktree: string,
  evidence: AssessmentEvidence,
  classification: string,
): Promise<SalvageRecord | null> {
  if (!SALVAGE_CLASSIFICATIONS.has(classification)) return null
  if (!worktree) {
    const record: SalvageRecord = { classification, committed: [], skipped: [], sha: '', detail: 'salvage skipped: no worktree path in the assessment evidence' }
    log(`[salvage] task ${taskId} (${classification}): skipped — no worktree path in the assessment evidence`)
    return record
  }
  try {
    // Candidates are the uncommitted entries the host observed: untracked (??)
    // and modified-but-unstaged (dirtyChanges) plus staged-but-uncommitted
    // (stagedChanges). The primitive filters them to the artefact convention.
    const candidates = [
      ...(evidence.dirtyChanges || []),
      ...(evidence.stagedChanges || []),
    ].map((entry) => entry.path)
    const outcome = await salvageTaskArtefacts(worktree, candidates, taskId)
    // Salvage is otherwise silent structured data; emit one bounded operator
    // line at the boundary so a commit, a "nothing to salvage", or a skipped
    // path is diagnosable without scraping result.json.
    // sha is fixed-length and the counts are bounded, so only the free-text
    // detail needs collapsing/truncation before it reaches the log line.
    if (outcome.committed.length) {
      log(`[salvage] task ${taskId} (${classification}): committed ${outcome.committed.length} artefact(s) at ${outcome.sha || '<no sha>'}${outcome.skipped.length ? `; skipped ${outcome.skipped.length}` : ''}`)
    } else {
      log(`[salvage] task ${taskId} (${classification}): nothing committed — ${boundedSalvageLogText(outcome.detail || 'no eligible artefacts')}${outcome.skipped.length ? `; skipped ${outcome.skipped.length}` : ''}`)
    }
    return { classification, ...outcome }
  } catch (error) {
    const detail = `salvage errored: ${((error as Error | null) && (error as Error).message) || String(error)}`
    log(`[salvage] task ${taskId} (${classification}): ${boundedSalvageLogText(detail)}`)
    return { classification, committed: [], skipped: [], sha: '', detail }
  }
}

// Mirror the infra-fault detection shouldAssessFailure uses to EXCLUDE a result
// from model assessment: a status/stage the fault classifier stamped, or a
// detail matching the ODW infrastructure patterns (schema-retry exhaustion,
// adapter death). These branches never reach the model, but a planner or
// reviewer may still have left a docs/execplans/*.md artefact dirty (#18).
function isInfraFaultResult(result: AssessableResult | null | undefined): boolean {
  if (!result) return false
  // Positive signal: the fault classifier stamped an infra fault.
  if (result.status === 'infra-fault' || result.stage === 'infrastructure') return true
  // Reject success, provider, auth, and worktree-preflight outcomes BEFORE the
  // detail heuristic (mirroring shouldAssessFailure's exclusions): those are
  // handled on their own paths and must never trigger salvage, even when their
  // detail happens to embed infra-shaped text (e.g. a provider error that quotes
  // an underlying SchemaValidationError). Only a genuine product failure whose
  // detail matches the ODW infrastructure patterns falls through.
  if (result.status === 'done' || result.status === 'provider-fault' || result.status === 'fatal-auth') return false
  if (result.stage === 'provider' || result.stage === 'auth' || result.stage === 'worktree' || result.stage === 'worktree-write') return false
  const detail = [result.detail, ...(result.openIssues || [])].filter(Boolean).join('\n')
  return Boolean(infrastructureFailureDetail(detail))
}

/**
 * Whether an open issue text describes a deferred/rate-limited CodeRabbit
 * review rather than a substantive product defect.
 *
 * @param issue A single open-issue string (or any value, coerced to text).
 * @returns True when the text mentions CodeRabbit alongside a deferred/rate-limit marker.
 */
export function isDeferredReviewIssue(issue: unknown): boolean {
  const text = String(issue || '').toLowerCase()
  const deferredReviewMarkers = [
    'rate limit',
    'rate_limit',
    'rate-limit',
    'ratelimit',
    '429',
    'retry after',
    'waittime',
    'wait time',
    'deferred review',
    'deferred coderabbit review',
    'coderabbit review deferred',
    'unavailable',
  ]
  return text.includes('coderabbit') && deferredReviewMarkers.some((marker) => text.includes(marker))
}

/**
 * Whether every open issue in the list is a deferred/recoverable CodeRabbit
 * review fault (e.g. a 429), so the list carries no substantive defect.
 *
 * @param openIssues The open-issue list, or null/undefined.
 * @returns True only when the list is non-empty and every entry is deferred-review.
 */
export function hasOnlyDeferredReviewIssues(openIssues: readonly unknown[] | null | undefined): boolean {
  const issues = openIssues || []
  return issues.length > 0 && issues.every(isDeferredReviewIssue)
}

/**
 * Extract an authentication-failure detail from an implementation report's
 * summary and open issues, using the shared auth-fault pattern matcher.
 *
 * @param impl The implementation/fix report, or null/undefined.
 * @returns The matched auth-failure detail, or '' when none is found.
 */
export function implementationAuthFailureDetail(impl: ImplementationReport | null | undefined): string {
  const detail = [impl?.summary, ...(impl?.openIssues || [])].filter(Boolean).join('\n')
  return authFailureDetail(detail)
}

/**
 * A complete, gate-green addendum whose builder did not set ok=true is an
 * operator handoff, not an assessment case. Open issues are tolerated only
 * when every one is a deferred/recoverable review fault (e.g. a CodeRabbit
 * 429): that exact missing evidence is bounded and mechanical — retry the
 * review, verify, integrate — so spending an unbounded judgement agent on it
 * burns tokens without adding operator information (issue #27).
 *
 * @param impl The implementation/fix report, or null/undefined.
 * @returns True when the addendum needs manual-merge handoff rather than assessment.
 */
export function addendumImplementationNeedsManualMerge(impl: ImplementationReport | null | undefined): boolean {
  if (!impl || impl.ok || !impl.gatesGreen) return false
  const openIssues = impl.openIssues || []
  if (openIssues.length > 0 && !hasOnlyDeferredReviewIssues(openIssues)) return false
  const completed = Number(impl.workItemsCompleted)
  const total = Number(impl.workItemsTotal)
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total
}

/**
 * Bind the ADR 002 assessment run wiring once (preamble, adapter routing,
 * escalation model, retry, enable switch) and return the assessment surface:
 * prompt builders, the recovery-candidate assessor, the assessment-eligibility
 * gate, and `attachAssessment`, which also drives artefact salvage. Assessment
 * output NEVER merges, pushes, or ticks the roadmap.
 *
 * @param deps The run-scoped assessment dependencies (see {@link AssessmentDeps}).
 * @returns `{ assessmentPrompt, recoveryAssessmentPrompt, assessRecoveryCandidate, shouldAssessFailure, attachAssessment }`.
 */
export function makeAssessment({ preamble, assessPartialBranches, assessmentAgentOptions, assessmentEscalationModel, withInfraRetry }: AssessmentDeps) {
  // Shared ADR 002 assessment prompt body — the classification contract is ONE
  // contract: in-run failure assessment and fresh-run recovery assessment feed
  // the same schema, enum, and evidence expectations. Only the task header and
  // the context block differ between the two entry points.
  function assessmentPromptLines(
    taskHeader: string,
    worktreePath: string | undefined,
    evidence: AssessmentEvidence | Record<string, unknown>,
    contextTitle: string,
    contextValue: unknown,
  ): string {
    return [
      preamble(worktreePath),
      taskHeader,
      '',
      'This is a READ-ONLY recovery assessment. Do not edit files, commit, stash, merge, cherry-pick, push, delete worktrees, mark roadmap checkboxes, or run any command that mutates repository state. Do not resume or rely on the failed agent transcript. Inspect only durable state that exists on disk or in Git.',
      '',
      'Use ADR 002 (`docs/adr-002-assess-partial-task-branches.md`) as the classification contract. Return exactly one classification:',
      '- `adopt-complete`: the branch satisfies the roadmap task success criterion, has an up-to-date ExecPlan, required gates are green, and can proceed through the ordinary review and integration path.',
      '- `adopt-partial`: the branch contains a coherent useful slice, but the roadmap task must remain unchecked and the work should be preserved only through Git state.',
      '- `continue-manual`: the branch is promising, but scope, roadmap state, validation, or review evidence needs operator judgement before any merge.',
      '- `discard`: the branch is stale, unsafe, incoherent, unrelated, or too incomplete to keep.',
      '',
      'Assess evidence first:',
      '- branch name, worktree path, base commit, and current commit;',
      '- dirty-state summary;',
      '- changed files and whether they are scoped to the task;',
      '- ExecPlan status, progress notes, decision log, and retrospective state;',
      '- roadmap checkbox state for the task;',
      '- available validation evidence;',
      '- missing validation or review evidence;',
      '- safety risks and recommended operator next actions.',
      '',
      'Separate blocking evidence gaps from advisory residual risk:',
      "- Put a gap in `missingEvidence` ONLY when it genuinely blocks confidence that the task's success criterion and required gates are met — it must be a real reason to withhold adoption.",
      '- Put everything a downstream reviewer or integrator should weigh, but which does NOT block adoption, into `residualRisk`. These are non-blocking caveats carried forward as review/integration context.',
      '- An `adopt-complete` branch that is clean, committed, task-scoped, and backed by a durable ExecPlan and validation evidence must NOT be held back for advisory residual risk alone; record such caveats in `residualRisk`, not `missingEvidence`.',
      '',
      'Evidence freshness rules:',
      '- Judge the branch at the CURRENT commit recorded in the host-collected evidence below. ExecPlan prose, earlier assessments, and logs that predate later commits are historical context, not the current validation state.',
      "- When the failure context includes `reviewRounds`, those review verdicts and structured fix-round reports were produced by this workflow AFTER any earlier snapshot: treat the latest fix round's gate and CodeRabbit report, together with the host-collected git evidence, as the branch's current validation state. Do not list evidence as missing when the latest fix round reports the named gates green at the current tip — cite that report instead.",
      '- Gate logs under /tmp are not durable; their absence is not, by itself, missing evidence when a structured fix-round or implementation report records the gates that ran and their outcomes.',
      '',
      'Host-collected git evidence:',
      '```json',
      JSON.stringify(evidence, null, 2),
      '```',
      '',
      contextTitle,
      '```json',
      JSON.stringify(contextValue, null, 2),
      '```',
      '',
      'Return only the schema-bound assessment object. Free-text recommendations do not drive integration; make the enum classification and evidence fields precise.',
    ].join('\n')
  }

  function assessmentPrompt(
    task: { id: string; title?: string },
    wt: AssessmentWorktree,
    result: unknown,
    evidence: AssessmentEvidence | Record<string, unknown>,
  ): string {
    return assessmentPromptLines(
      `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") after a workflow failure.`,
      wt.worktreePath,
      evidence,
      'Original workflow failure result:',
      result,
    )
  }

  function recoveryAssessmentPrompt(
    task: { id: string; title?: string },
    candidate: RecoveryCandidate,
    evidence: AssessmentEvidence | Record<string, unknown>,
  ): string {
    return assessmentPromptLines(
      `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") discovered during fresh-run recovery.`,
      candidate.worktreePath,
      evidence,
      "Recovery discovery context (fresh launch; the failed run's transcript and result are unavailable by design):",
      candidate,
    )
  }

  // A committed ExecPlan on the branch marks a strong adopt-complete candidate,
  // so the genuinely high-stakes adopt decision uses the escalation model;
  // every other ambiguous branch uses the medium default. One model call
  // either way (the tier is chosen from host evidence, not by re-running).
  function assessmentModelTier(evidence: AssessmentEvidence): 'escalated' | 'medium' {
    const hasExecplan = (evidence.changedFiles || []).some((entry) => /^docs\/execplans\/.+\.md$/.test(String(entry)))
    return hasExecplan ? 'escalated' : 'medium'
  }

  // Run the assessment model on a genuinely-ambiguous branch at the
  // evidence-chosen tier. Returns the assessment object (tier-tagged) or null.
  async function runModelAssessment(
    buildPrompt: () => string,
    phaseName: string,
    label: string,
    evidence: AssessmentEvidence,
  ): Promise<Record<string, unknown> | null> {
    const tier = assessmentModelTier(evidence)
    const options: Record<string, unknown> = { phase: phaseName, label, schema: ASSESSMENT_SCHEMA }
    if (tier === 'escalated') options.model = assessmentEscalationModel
    const assessment = (await withInfraRetry(() => agent(buildPrompt(), assessmentAgentOptions(options)), label)) as Record<string, unknown> | null
    if (!assessment) return null
    return { ...assessment, assessmentTier: tier }
  }

  // Route a discovered candidate through the SAME ADR 002 assessment contract as
  // in-run failures: same evidence collector, same schema, same adapter routing.
  async function assessRecoveryCandidate(candidate: RecoveryCandidate) {
    const task = { id: candidate.taskId, title: candidate.taskTitle }
    const wt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit }
    // Re-assert the global phase: a previously resumed candidate re-enters
    // the ordinary pipeline (Plan/Implement/Integrate), so without this the
    // next candidate's assessment would be recorded under a stale phase.
    phase('Recovery')
    const evidence = await collectAssessmentEvidence(task, wt)
    const fast = fastAssessmentClassification(evidence)
    if (fast) {
      return {
        /** Host-collected git evidence for the candidate branch. */
        evidence,
        /** The assessment object (deterministic or model), or null on failure. */
        assessment: deterministicAssessment(fast.classification, evidence, fast.reason),
        /** Error text when no structured assessment was produced; '' otherwise. */
        assessmentError: '',
      }
    }
    try {
      const label = `recover-assess:${candidate.taskId}${candidate.isAddendum ? '-addendum' : ''}`
      const assessment = await runModelAssessment(() => recoveryAssessmentPrompt(task, candidate, evidence), 'Recovery', label, evidence)
      if (!assessment) {
        return {
          /** Host-collected git evidence for the candidate branch. */
          evidence,
          /** The assessment object (deterministic or model), or null on failure. */
          assessment: null,
          /** Error text when no structured assessment was produced; '' otherwise. */
          assessmentError: 'assessment agent returned no structured output',
        }
      }
      return {
        /** Host-collected git evidence for the candidate branch. */
        evidence,
        /** The assessment object (deterministic or model), or null on failure. */
        assessment: { ...assessment, hostEvidence: evidence },
        /** Error text when no structured assessment was produced; '' otherwise. */
        assessmentError: '',
      }
    } catch (error) {
      return {
        /** Host-collected git evidence for the candidate branch. */
        evidence,
        /** The assessment object (deterministic or model), or null on failure. */
        assessment: null,
        /** Error text when no structured assessment was produced; '' otherwise. */
        assessmentError: ((error as Error | null) && (error as Error).message) || String(error),
      }
    }
  }

  function shouldAssessFailure(result: AssessableResult | null | undefined, wt: AssessmentWorktree | null | undefined): boolean {
    if (!assessPartialBranches) return false
    if (!wt?.branch || !wt?.worktreePath) return false
    if (!result || !['failed', 'halted'].includes(result.status || '')) return false
    if (result.stage === 'worktree' || result.stage === 'worktree-write' || result.stage === 'auth' || result.stage === 'provider' || result.stage === 'infrastructure' || result.status === 'fatal-auth' || result.status === 'provider-fault' || result.status === 'infra-fault') return false
    const detail = [result.detail, ...(result.openIssues || [])].filter(Boolean).join('\n')
    return !authFailureDetail(detail) && !providerFailureDetail(detail) && !infrastructureFailureDetail(detail)
  }

  // Schema-retry exhaustion — the exact failure issue #18 targets — is
  // classified as an infra-fault (faults.ts), which shouldAssessFailure rightly
  // excludes from MODEL assessment: the error says nothing about the branch, so
  // spending a judgement agent on it is wasted. But salvage is deterministic and
  // needs no model call, and the branch may hold a docs/execplans/*.md artefact
  // the planner/reviewer wrote just before the parse failure. Commit it here so
  // it survives later worktree cleanup; every non-infra early-return is passed
  // through untouched.
  async function salvageInfraFaultArtefacts<T extends AssessableResult>(
    task: { id: string; title?: string },
    wt: AssessmentWorktree,
    result: T,
  ): Promise<T & { salvage?: SalvageRecord }> {
    if (!assessPartialBranches || !wt?.branch) return result
    if (!isInfraFaultResult(result)) return result
    const worktree = wt.worktreePath || ''
    // Only collect git evidence when there is a worktree to read; without one,
    // salvage short-circuits on its no-worktree guard before touching evidence.
    const evidence = worktree
      ? await collectAssessmentEvidence(task, wt)
      : ({ dirtyChanges: [], stagedChanges: [] } as unknown as AssessmentEvidence)
    const salvage = await salvageAssessmentArtefacts(task.id, worktree, evidence, 'infra-fault')
    return salvage ? { ...result, salvage } : result
  }

  async function attachAssessment<T extends AssessableResult>(
    task: { id: string; title?: string },
    wt: AssessmentWorktree,
    result: T,
  ): Promise<T & {
    /** The model or deterministic assessment object, when one was produced. */
    assessment?: Record<string, unknown>
    /** The error text when the assessment agent failed or returned nothing. */
    assessmentError?: string
    /** Host evidence attached on the error paths so operators can still judge. */
    assessmentEvidence?: AssessmentEvidence
    /** The artefact-salvage record, when a kept-but-not-adopted branch salvaged. */
    salvage?: SalvageRecord
  }> {
    if (!shouldAssessFailure(result, wt)) return await salvageInfraFaultArtefacts(task, wt, result)
    phase('Assess')
    const evidence = await collectAssessmentEvidence(task, wt)
    const fast = fastAssessmentClassification(evidence)
    if (fast) {
      // The deterministic continue-manual fires only when host evidence
      // collection failed, so the evidence is untrustworthy — do NOT salvage
      // against it; record the skip so operators see why.
      const salvage: SalvageRecord | null = fast.classification === 'continue-manual'
        ? { classification: fast.classification, committed: [], skipped: [], sha: '', detail: 'salvage skipped: deterministic continue-manual fires on untrustworthy host evidence' }
        : null
      return { ...result, assessment: deterministicAssessment(fast.classification, evidence, fast.reason), ...(salvage ? { salvage } : {}) }
    }
    try {
      const assessment = await runModelAssessment(() => assessmentPrompt(task, wt, result, evidence), 'Assess', `assess:${task.id}`, evidence)
      if (!assessment) {
        return { ...result, assessmentError: 'assessment agent returned no structured output', assessmentEvidence: evidence }
      }
      const salvage = await salvageAssessmentArtefacts(task.id, wt.worktreePath || '', evidence, String(assessment.classification || ''))
      return { ...result, assessment: { ...assessment, hostEvidence: evidence }, ...(salvage ? { salvage } : {}) }
    } catch (error) {
      return {
        ...result,
        assessmentError: ((error as Error | null) && (error as Error).message) || String(error),
        assessmentEvidence: evidence,
      }
    }
  }

  return {
    /** Build the in-run failure-assessment prompt for a surviving branch. */
    assessmentPrompt,
    /** Build the fresh-run recovery-assessment prompt (transcript unavailable by design). */
    recoveryAssessmentPrompt,
    /** Assess a discovered recovery candidate through the ADR 002 contract. */
    assessRecoveryCandidate,
    /** The eligibility gate: whether a failed result's branch reaches model assessment. */
    shouldAssessFailure,
    /** Attach an assessment (or infra-fault salvage) to a task result; never merges or ticks the roadmap. */
    attachAssessment,
  }
}
