// ADR 002 partial-branch assessment: deferred-review classification, the
// manual-merge handoff guard, the assessment gate, and the report-only
// assessment agents. Assessment output NEVER merges, pushes, or ticks the
// roadmap; classification is advice for the operator, and host-collected
// evidence is decisive over anything the agent reports. The run wiring
// (preamble, adapter routing, retry, enable switch) binds once via
// makeAssessment.
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

// Classifications where the branch is kept but not fully adopted, so any
// untracked task-scoped ExecPlan/review artefact is worth durably committing
// onto the branch before later cleanup. `adopt-partial` explicitly preserves
// work "only through Git state" (ADR 002), which is exactly a branch-local
// commit; `continue-manual` hands the branch to an operator who needs the
// planning artefacts intact. `adopt-complete` proceeds through the ordinary
// path and `discard` is thrown away, so neither salvages.
const SALVAGE_CLASSIFICATIONS = new Set(['continue-manual', 'adopt-partial'])

// A salvage record carrying the classification that triggered (or skipped) it,
// spread onto the assessment result. The result types extend
// Record<string, unknown>, so this rides through run-task.ts without a breaking
// type change.
export interface SalvageRecord extends SalvageOutcome {
  classification: string
}

export interface ImplementationReport {
  ok?: boolean
  gatesGreen?: boolean
  workItemsCompleted?: unknown
  workItemsTotal?: unknown
  summary?: string
  openIssues?: readonly string[]
}

export interface AssessableResult extends Record<string, unknown> {
  status?: string
  stage?: string
  detail?: string
  openIssues?: readonly string[]
}

export interface AssessmentWorktree {
  branch?: string
  worktreePath?: string
  baseSha?: string
}

export interface AssessmentDeps {
  preamble: (worktree: string | null | undefined) => string
  assessPartialBranches: boolean
  assessmentAgentOptions: (options: Record<string, unknown>) => Record<string, unknown>
  assessmentEscalationModel: string
  withInfraRetry: <T>(run: () => Promise<T>, label: string) => Promise<T>
}

// Deterministic fast-classifier for the two clear, non-judgement cases, run
// before any model call: an empty branch with a clean worktree is `discard`
// (nothing durable to adopt) and a host evidence-collection failure is
// `continue-manual` (cannot judge without evidence). Everything else — a
// branch with committed work, or a dirty worktree (whose downgrade the
// recovery eligibility gate owns) — returns null and reaches the model. Never
// yields an adopt verdict, so recovery review-mode resume is unaffected.
export function fastAssessmentClassification(
  evidence: { collectionErrors?: readonly string[]; dirtyState?: string; recentCommits?: readonly unknown[] } | null | undefined,
): { classification: string; reason: string } | null {
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
    risks: [],
    rationale: reason,
    recommendation: reason,
    nextActions: [],
    classifier: 'deterministic',
    hostEvidence: evidence,
  }
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
    return { classification, committed: [], skipped: [], sha: '', detail: 'salvage skipped: no worktree path in the assessment evidence' }
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
    return { classification, ...outcome }
  } catch (error) {
    return {
      classification,
      committed: [],
      skipped: [],
      sha: '',
      detail: `salvage errored: ${((error as Error | null) && (error as Error).message) || String(error)}`,
    }
  }
}

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

export function hasOnlyDeferredReviewIssues(openIssues: readonly unknown[] | null | undefined): boolean {
  const issues = openIssues || []
  return issues.length > 0 && issues.every(isDeferredReviewIssue)
}

export function implementationAuthFailureDetail(impl: ImplementationReport | null | undefined): string {
  const detail = [impl?.summary, ...(impl?.openIssues || [])].filter(Boolean).join('\n')
  return authFailureDetail(detail)
}

// A complete, gate-green addendum whose builder did not set ok=true is an
// operator handoff, not an assessment case. Open issues are tolerated only
// when every one is a deferred/recoverable review fault (e.g. a CodeRabbit
// 429): that exact missing evidence is bounded and mechanical — retry the
// review, verify, integrate — so spending an unbounded judgement agent on it
// burns tokens without adding operator information (issue #27).
export function addendumImplementationNeedsManualMerge(impl: ImplementationReport | null | undefined): boolean {
  if (!impl || impl.ok || !impl.gatesGreen) return false
  const openIssues = impl.openIssues || []
  if (openIssues.length > 0 && !hasOnlyDeferredReviewIssues(openIssues)) return false
  const completed = Number(impl.workItemsCompleted)
  const total = Number(impl.workItemsTotal)
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total
}

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
      return { evidence, assessment: deterministicAssessment(fast.classification, evidence, fast.reason), assessmentError: '' }
    }
    try {
      const label = `recover-assess:${candidate.taskId}${candidate.isAddendum ? '-addendum' : ''}`
      const assessment = await runModelAssessment(() => recoveryAssessmentPrompt(task, candidate, evidence), 'Recovery', label, evidence)
      if (!assessment) {
        return { evidence, assessment: null, assessmentError: 'assessment agent returned no structured output' }
      }
      return { evidence, assessment: { ...assessment, hostEvidence: evidence }, assessmentError: '' }
    } catch (error) {
      return { evidence, assessment: null, assessmentError: ((error as Error | null) && (error as Error).message) || String(error) }
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

  async function attachAssessment<T extends AssessableResult>(
    task: { id: string; title?: string },
    wt: AssessmentWorktree,
    result: T,
  ): Promise<T & { assessment?: Record<string, unknown>; assessmentError?: string; assessmentEvidence?: AssessmentEvidence; salvage?: SalvageRecord }> {
    if (!shouldAssessFailure(result, wt)) return result
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

  return { assessmentPrompt, recoveryAssessmentPrompt, assessRecoveryCandidate, shouldAssessFailure, attachAssessment }
}
