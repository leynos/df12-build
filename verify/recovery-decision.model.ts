//@ backend dafny
// Verified twin of the recovery decision tables in
// src/workflows/df12-build-odw/recovery-decision.js (LemmaScript → Dafny).
//
// The twin abstracts each production input to the booleans the tables
// actually branch on, and renames the hyphenated production string enums to
// identifier-safe constructors (Dafny rejects '-' in constructor names); the
// differential property test in tests/modules/recovery-decision.model.test.ts
// pins the twin to the production implementation across generated inputs, so
// the theorems proven here — the resume actions fail closed — transfer.

export type Mode = 'Assess' | 'Review' | 'Continue' | 'OtherMode';

export type Classification =
  | 'AdoptComplete'
  | 'ContinueManual'
  | 'Restart'
  | 'Abandon'
  | 'NoClassification';

export type PlanStatus =
  | 'Draft'
  | 'Approved'
  | 'InProgress'
  | 'Blocked'
  | 'Complete'
  | 'Missing'
  | 'Unreadable'
  | 'Unknown';

export type Stage = 'PlanStage' | 'ImplementStage' | 'ReviewStage' | 'NoStage';

export type Action = 'Report' | 'Resume';

export type SkipReason =
  | 'AddendumBranch'
  | 'EvidenceCollectionError'
  | 'DirtyWorktree'
  | 'NoCommittedWork'
  | 'NotTaskScoped'
  | 'MissingValidationEvidence'
  | 'MissingExecplan'
  | 'PlanUnreadable'
  | 'PlanBlocked'
  | 'DryRun'
  | 'NoReason';

export interface Candidate {
  isAddendum: boolean;
  hasExecplan: boolean;
}

export interface Evidence {
  hasCollectionErrors: boolean;
  isClean: boolean;
  hasCommits: boolean;
}

export interface Assessment {
  classification: Classification;
  taskScoped: boolean;
  hasValidation: boolean;
  hasMissingEvidence: boolean;
}

export interface ReviewDecision {
  action: Action;
  classification: Classification;
  reason: SkipReason;
  skip: boolean;
}

export interface ContinueDecision {
  action: Action;
  stage: Stage;
  reason: SkipReason;
  skip: boolean;
}

// Mirror of recoveryResumeEligibility: 'NoReason' means eligible, anything
// else is the disqualifying skip reason, checked in the same order as the
// production implementation.
//@ pure
export function resumeEligibility(
  candidate: Candidate,
  evidence: Evidence,
  assessment: Assessment,
): SkipReason {
  //@ ensures \result === 'NoReason' ==> !candidate.isAddendum && !evidence.hasCollectionErrors && evidence.isClean && evidence.hasCommits && assessment.taskScoped && assessment.hasValidation && !assessment.hasMissingEvidence && candidate.hasExecplan
  if (candidate.isAddendum) return 'AddendumBranch';
  if (evidence.hasCollectionErrors) return 'EvidenceCollectionError';
  if (!evidence.isClean) return 'DirtyWorktree';
  if (!evidence.hasCommits) return 'NoCommittedWork';
  if (!assessment.taskScoped) return 'NotTaskScoped';
  if (!assessment.hasValidation) return 'MissingValidationEvidence';
  if (assessment.hasMissingEvidence) return 'MissingValidationEvidence';
  if (!candidate.hasExecplan) return 'MissingExecplan';
  return 'NoReason';
}

// Mirror of recoveryDecision: the review-mode decision table.
// Fail-closed theorems:
//   1. Resume happens only in review mode, for an adopt-complete verdict,
//      with clean eligibility and no dry-run.
//   2. Every skip is a report.
//   3. An ineligible adopt-complete verdict is downgraded to ContinueManual.
export function decideReview(
  candidate: Candidate,
  evidence: Evidence,
  assessment: Assessment,
  mode: Mode,
  dryRun: boolean,
): ReviewDecision {
  //@ ensures \result.action === 'Resume' ==> mode === 'Review' && assessment.classification === 'AdoptComplete' && !dryRun && resumeEligibility(candidate, evidence, assessment) === 'NoReason'
  //@ ensures \result.skip ==> \result.action === 'Report'
  //@ ensures mode === 'Review' && assessment.classification === 'AdoptComplete' && resumeEligibility(candidate, evidence, assessment) !== 'NoReason' ==> \result.classification === 'ContinueManual' && \result.skip
  if (mode !== 'Review' || assessment.classification !== 'AdoptComplete') {
    return { action: 'Report', classification: assessment.classification, reason: 'NoReason', skip: false };
  }
  const reason = resumeEligibility(candidate, evidence, assessment);
  if (reason !== 'NoReason') {
    return { action: 'Report', classification: 'ContinueManual', reason: reason, skip: true };
  }
  if (dryRun) {
    return { action: 'Report', classification: assessment.classification, reason: 'DryRun', skip: true };
  }
  return { action: 'Resume', classification: assessment.classification, reason: 'NoReason', skip: false };
}

// Stage dispatch keyed on the committed ExecPlan status: Draft, Missing and
// Unknown re-enter planning; Blocked and Unreadable never reach this map.
//@ pure
export function stageFor(status: PlanStatus): Stage {
  //@ ensures \result !== 'NoStage'
  //@ ensures \result === 'ReviewStage' <==> status === 'Complete'
  if (status === 'Approved' || status === 'InProgress') return 'ImplementStage';
  if (status === 'Complete') return 'ReviewStage';
  return 'PlanStage';
}

// Mirror of recoveryContinueDecision: the continue-mode dispatch table.
// Fail-closed theorems:
//   1. Resume requires clean hygiene (no addendum, no collection errors,
//      clean worktree), no dry-run, and never a Blocked or Unreadable plan.
//   2. A resumed dispatch always names a real stage.
//   3. Review-stage resume requires committed work.
//   4. Every non-resume outcome is a skipped report.
export function decideContinue(
  candidate: Candidate,
  evidence: Evidence,
  status: PlanStatus,
  dryRun: boolean,
): ContinueDecision {
  //@ ensures \result.action === 'Resume' ==> !candidate.isAddendum && !evidence.hasCollectionErrors && evidence.isClean && !dryRun && status !== 'Blocked' && status !== 'Unreadable'
  //@ ensures \result.action === 'Resume' ==> \result.stage !== 'NoStage'
  //@ ensures \result.action === 'Resume' && \result.stage === 'ReviewStage' ==> evidence.hasCommits
  //@ ensures \result.action === 'Report' ==> \result.skip
  if (candidate.isAddendum) {
    return { action: 'Report', stage: 'NoStage', reason: 'AddendumBranch', skip: true };
  }
  if (evidence.hasCollectionErrors) {
    return { action: 'Report', stage: 'NoStage', reason: 'EvidenceCollectionError', skip: true };
  }
  if (!evidence.isClean) {
    return { action: 'Report', stage: 'NoStage', reason: 'DirtyWorktree', skip: true };
  }
  if (status === 'Unreadable') {
    return { action: 'Report', stage: 'NoStage', reason: 'PlanUnreadable', skip: true };
  }
  if (status === 'Blocked') {
    return { action: 'Report', stage: 'NoStage', reason: 'PlanBlocked', skip: true };
  }
  const stage: Stage = stageFor(status);
  if (stage === 'ReviewStage' && !evidence.hasCommits) {
    return { action: 'Report', stage: 'NoStage', reason: 'NoCommittedWork', skip: true };
  }
  if (dryRun) {
    return { action: 'Report', stage: stage, reason: 'DryRun', skip: true };
  }
  return { action: 'Resume', stage: stage, reason: 'NoReason', skip: false };
}
