// Pure decision helpers for fresh-run recovery (failure-resume design):
// task-branch naming, `git worktree list --porcelain` parsing, the review-mode
// and continue-mode decision tables, and committed-ExecPlan state parsing.
// Everything here is deterministic and free of I/O, injected ODW primitives,
// and run configuration, so it is unit-testable by direct import.

export interface WorktreeEntry {
  worktreePath: string
  branch: string
  head: string
}

// The hygiene-relevant slice of a recovery candidate: callers pass the full
// discovery record, but the decision tables only dereference these fields.
export interface RecoveryCandidateHygiene {
  isAddendum?: boolean
  execplanPath?: string
}

// Host-collected git evidence. The fields are optional because the tables
// treat absent evidence as failing the corresponding hygiene check.
export interface RecoveryEvidence {
  collectionErrors?: readonly string[]
  dirtyState?: string
  recentCommits?: readonly string[]
}

// Agent-reported assessment fields the review-mode table consults. Host
// evidence stays decisive; these can only disqualify, never force, a resume.
export interface RecoveryAssessmentFields {
  classification?: string
  taskScoped?: boolean
  validation?: string
  missingEvidence?: readonly string[]
}

export type ExecplanStatus =
  | 'draft'
  | 'approved'
  | 'in-progress'
  | 'blocked'
  | 'complete'
  | 'missing'
  | 'unreadable'
  | 'unknown'

export interface ExecplanProgressItem {
  text: string
  ticked: boolean
}

export interface ExecplanState {
  status: ExecplanStatus
  ticked: number
  unticked: number
  items: ExecplanProgressItem[]
  error?: string
}

export type RecoveryStage = 'plan' | 'implement' | 'review'

export interface ReviewDecision {
  action: 'report' | 'resume'
  classification: string
  reason: string
  skip: boolean
}

export interface ContinueDecision {
  action: 'report' | 'resume'
  stage: RecoveryStage | null
  reason: string
  skip: boolean
}

export const TASK_BRANCH_RE = /^roadmap-((?:\d+-)*\d+)(-addendum)?$/

export function branchToRoadmapId(branch: unknown): { id: string; isAddendum: boolean } | null {
  const match = TASK_BRANCH_RE.exec(String(branch || ''))
  if (!match) return null
  return { id: match[1].replace(/-/g, '.'), isAddendum: Boolean(match[2]) }
}

export function parseWorktreeList(output: unknown): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current)
      current = null
      continue
    }
    const spaceIndex = line.indexOf(' ')
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex)
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1)
    if (key === 'worktree') {
      current = { worktreePath: value, branch: '', head: '' }
    } else if (current && key === 'HEAD') {
      current.head = value
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '')
    }
  }
  if (current) entries.push(current)
  return entries
}

// Reasons a discovered branch is recorded in recovery.skipped instead of
// proceeding to its mode's maximum action. Discovery emits the first five;
// the assessment and resume-decision stages emit the rest.
export const RECOVERY_SKIP_REASONS = [
  'unmapped-branch',
  'already-complete',
  'unreadable-commit',
  'missing-worktree',
  'worktree-probe-fault',
  'candidate-cap',
  'assessment-error',
  'addendum-branch',
  'evidence-collection-error',
  'dirty-worktree',
  'no-committed-work',
  'not-task-scoped',
  'missing-validation-evidence',
  'missing-execplan',
  'plan-blocked',
  'plan-unreadable',
  'execplan-stat-error',
  'dry-run',
]

// Review-mode resume eligibility: only a clean, committed, task-scoped
// adopt-complete branch with validation evidence may spend review and
// integration effort. Returns '' when eligible, else the disqualifying skip
// reason. Host-collected evidence is decisive over agent-reported fields.
export function recoveryResumeEligibility(
  candidate: RecoveryCandidateHygiene | null | undefined,
  evidence: RecoveryEvidence | null | undefined,
  assessment: RecoveryAssessmentFields | null | undefined,
): string {
  if (candidate?.isAddendum) return 'addendum-branch'
  if ((evidence?.collectionErrors || []).length) return 'evidence-collection-error'
  if (evidence?.dirtyState !== 'clean') return 'dirty-worktree'
  if (!(evidence?.recentCommits || []).length) return 'no-committed-work'
  if (assessment?.taskScoped !== true) return 'not-task-scoped'
  if (!String(assessment?.validation || '').trim()) return 'missing-validation-evidence'
  if ((assessment?.missingEvidence || []).length) return 'missing-validation-evidence'
  if (!candidate?.execplanPath) return 'missing-execplan'
  return ''
}

// The failure-resume decision table. Every classification is report-only in
// assess mode; in review mode only eligible adopt-complete candidates may
// resume, and an adopt-complete verdict that fails an eligibility check is
// DOWNGRADED to continue-manual in the summary (fail closed).
export function recoveryDecision(
  candidate: RecoveryCandidateHygiene | null | undefined,
  evidence: RecoveryEvidence | null | undefined,
  assessment: RecoveryAssessmentFields | null | undefined,
  mode: string,
  flags: { dryRun?: boolean } = {},
): ReviewDecision {
  const classification = assessment?.classification || ''
  if (mode !== 'review' || classification !== 'adopt-complete') {
    return { action: 'report', classification, reason: '', skip: false }
  }
  const reason = recoveryResumeEligibility(candidate, evidence, assessment)
  if (reason) {
    return { action: 'report', classification: 'continue-manual', reason, skip: true }
  }
  if (flags.dryRun) {
    return { action: 'report', classification, reason: 'dry-run', skip: true }
  }
  return { action: 'resume', classification, reason: '', skip: false }
}

// ---------------------------------------------------------------------------
// Continue-mode dispatch (failure resume, phase 3) — the committed ExecPlan is
// the durable source of truth for where a task stands. Agents commit the plan
// after every change and keep its Status field accurate, so a fresh run can
// dispatch a survivor branch deterministically, with no judgement agent:
//   Status DRAFT (or missing/unfilled) -> re-enter the plan/design-review loop
//   Status APPROVED or IN PROGRESS     -> re-enter implementation
//   Status COMPLETE                    -> re-enter dual review + integration
//   Status BLOCKED                     -> report for the operator
// Safety comes from the downstream gates the resumed branch still has to pass
// (design review, deterministic gates, dual review, serialized integration),
// not from an up-front classification.
// ---------------------------------------------------------------------------
export const EXECPLAN_STATUS_MAP: Record<string, ExecplanStatus> = {
  draft: 'draft',
  approved: 'approved',
  'in progress': 'in-progress',
  blocked: 'blocked',
  complete: 'complete',
}

// Parse the durable state out of a committed ExecPlan: the Status field and
// the Progress checkbox tallies (informational — dispatch keys on Status
// alone). An unfilled skeleton line ("Status: DRAFT | APPROVED | …") or an
// unrecognized value parses as 'unknown', which dispatches to planning.
export function parseExecplanState(text: unknown): ExecplanState {
  const source = String(text || '')
  let status: ExecplanStatus = 'unknown'
  const statusMatch = source.match(/^Status:\s*([A-Za-z ]+?)\s*$/m)
  if (statusMatch) {
    const value = statusMatch[1].trim().toLowerCase().replace(/\s+/g, ' ')
    status = EXECPLAN_STATUS_MAP[value] || 'unknown'
  }
  let ticked = 0
  let unticked = 0
  const items: ExecplanProgressItem[] = []
  const progressSection = source.split(/^##\s+/m).find((section) => /^progress\b/i.test(section)) || ''
  for (const line of progressSection.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s*(.*)$/)
    if (!match) continue
    const isTicked = match[1] !== ' '
    if (isTicked) ticked += 1
    else unticked += 1
    items.push({ text: match[2].trim(), ticked: isTicked })
  }
  return { status, ticked, unticked, items }
}

// The continue-mode decision table. Purely deterministic: hygiene checks from
// host-collected evidence, then a stage keyed on the committed ExecPlan
// Status. Returns { action: 'report'|'resume', stage, reason, skip }.
export function recoveryContinueDecision(
  candidate: RecoveryCandidateHygiene | null | undefined,
  evidence: RecoveryEvidence | null | undefined,
  planState: { status: string; ticked?: number; unticked?: number; error?: string },
  flags: { dryRun?: boolean } = {},
): ContinueDecision {
  const report = (reason: string): ContinueDecision => ({ action: 'report', stage: null, reason, skip: true })
  if (candidate?.isAddendum) return report('addendum-branch')
  if ((evidence?.collectionErrors || []).length) return report('evidence-collection-error')
  if (evidence?.dirtyState !== 'clean') return report('dirty-worktree')
  if (planState.status === 'unreadable') return report('plan-unreadable')
  if (planState.status === 'blocked') return report('plan-blocked')
  const stage: RecoveryStage =
    planState.status === 'approved' || planState.status === 'in-progress'
      ? 'implement'
      : planState.status === 'complete'
        ? 'review'
        : 'plan' // missing, draft, or unknown: (re-)enter planning
  if (stage === 'review' && !(evidence?.recentCommits || []).length) return report('no-committed-work')
  if (flags.dryRun) return { action: 'report', stage, reason: 'dry-run', skip: true }
  return { action: 'resume', stage, reason: '', skip: false }
}
