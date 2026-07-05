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
import type { RecoveryCandidate } from './types.ts'

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
  withInfraRetry: <T>(run: () => Promise<T>, label: string) => Promise<T>
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

export function makeAssessment({ preamble, assessPartialBranches, assessmentAgentOptions, withInfraRetry }: AssessmentDeps) {
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

  // Route a discovered candidate through the SAME ADR 002 assessment contract as
  // in-run failures: same evidence collector, same schema, same adapter routing.
  async function assessRecoveryCandidate(candidate: RecoveryCandidate) {
    const task = { id: candidate.taskId, title: candidate.taskTitle }
    const wt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit }
    const evidence = await collectAssessmentEvidence(task, wt)
    try {
      const label = `recover-assess:${candidate.taskId}${candidate.isAddendum ? '-addendum' : ''}`
      const assessment = (await withInfraRetry(() => agent(recoveryAssessmentPrompt(task, candidate, evidence), assessmentAgentOptions({
        phase: 'Recovery',
        label,
        schema: ASSESSMENT_SCHEMA,
      })), label)) as Record<string, unknown> | null
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

  async function attachAssessment(
    task: { id: string; title?: string },
    wt: AssessmentWorktree,
    result: AssessableResult,
  ): Promise<AssessableResult & { assessment?: Record<string, unknown>; assessmentError?: string; assessmentEvidence?: AssessmentEvidence }> {
    if (!shouldAssessFailure(result, wt)) return result
    phase('Assess')
    const evidence = await collectAssessmentEvidence(task, wt)
    try {
      const assessment = (await withInfraRetry(() => agent(assessmentPrompt(task, wt, result, evidence), assessmentAgentOptions({
        phase: 'Assess',
        label: `assess:${task.id}`,
        schema: ASSESSMENT_SCHEMA,
      })), `assess:${task.id}`)) as Record<string, unknown> | null
      if (!assessment) {
        return { ...result, assessmentError: 'assessment agent returned no structured output', assessmentEvidence: evidence }
      }
      return { ...result, assessment: { ...assessment, hostEvidence: evidence } }
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
