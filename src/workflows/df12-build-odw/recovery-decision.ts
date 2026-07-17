/**
 * @file Pure decision helpers for fresh-run recovery (failure-resume
 * design): task-branch naming, `git worktree list --porcelain` parsing,
 * the review-mode and continue-mode decision tables, and committed-ExecPlan
 * state parsing. Everything here is deterministic and free of I/O, injected
 * ODW primitives, and run configuration, so it is unit-testable by direct
 * import.
 */

export interface WorktreeEntry {
  worktreePath: string
  branch: string
  head: string
}

/**
 * The hygiene-relevant slice of a recovery candidate. Callers pass the full
 * discovery record, but the decision tables only dereference these fields:
 * whether the branch is an addendum, and the path to its committed ExecPlan.
 */
export interface RecoveryCandidateHygiene {
  isAddendum?: boolean
  execplanPath?: string
}

/**
 * Host-collected git evidence for a recovery candidate's worktree: any
 * collection errors, the working-tree dirty/clean state, and recent commit
 * subjects. Fields are optional because the decision tables treat absent
 * evidence as failing the corresponding hygiene check.
 */
export interface RecoveryEvidence {
  collectionErrors?: readonly string[]
  dirtyState?: string
  recentCommits?: readonly string[]
}

/**
 * Agent-reported assessment fields the review-mode decision table consults.
 * Host evidence stays decisive; these fields can only disqualify, never
 * force, a resume.
 *
 * `missingEvidence` is the BLOCKING channel — genuinely missing validation or
 * review evidence that must prevent a resume. `residualRisk` is the ADVISORY
 * channel — non-blocking caveats carried forward as review/integration
 * context; the eligibility gate never consults it (issue #23).
 *
 * `residualRisk` is REQUIRED: it mirrors `ASSESSMENT_SCHEMA` (which lists it
 * in `required`) and forces every typed assessment producer to declare
 * advisory risk explicitly, even if empty. Untrusted agent JSON is still read
 * defensively at the boundary through {@link advisoryResidualRisk} below,
 * which tolerates an absent or malformed field — the required type governs
 * typed producers, not the runtime guard.
 */
export interface RecoveryAssessmentFields {
  classification?: string
  taskScoped?: boolean
  validation?: string
  missingEvidence?: readonly string[]
  residualRisk: readonly string[]
}

/**
 * Read the ADVISORY residual risk off an assessment record, tolerating the
 * continue-mode case where there is no assessment at all. Defensively reads
 * untrusted agent-produced JSON: an absent or non-array `residualRisk` field
 * yields an empty list rather than throwing. Kept here beside the
 * `residualRisk` contract so the resume caller stays a plain field read
 * rather than repeating the shape guard inline (issue #23).
 *
 * @param assessment - The (possibly absent or malformed) assessment record.
 * @returns The reported residual-risk strings, or an empty array when the
 *   field is missing or not an array.
 */
export function advisoryResidualRisk(
  assessment: { residualRisk?: unknown } | null | undefined,
): string[] {
  return Array.isArray(assessment?.residualRisk) ? (assessment.residualRisk as string[]) : []
}

/**
 * The normalized status of a committed ExecPlan's `Status` field, as parsed
 * by {@link parseExecplanState}. `'missing'` and `'unreadable'` denote
 * host-detected absence or read failure; `'unknown'` covers an unfilled
 * skeleton line or an unrecognized value.
 */
export type ExecplanStatus =
  | 'draft'
  | 'approved'
  | 'in-progress'
  | 'blocked'
  | 'complete'
  | 'missing'
  | 'unreadable'
  | 'unknown'

/**
 * A single parsed Progress checkbox line from a committed ExecPlan: its
 * trimmed text and whether it is ticked.
 */
export interface ExecplanProgressItem {
  text: string
  ticked: boolean
}

/**
 * The durable state parsed from a committed ExecPlan: the normalized
 * `status`, ticked/unticked Progress-checkbox tallies, the parsed
 * {@link ExecplanProgressItem} list, and an optional `error` describing a
 * read or parse failure.
 */
export interface ExecplanState {
  status: ExecplanStatus
  ticked: number
  unticked: number
  items: ExecplanProgressItem[]
  error?: string
}

/**
 * The implementation stage a continue-mode resume re-enters: `'plan'` for
 * design and planning, `'implement'` for implementation, or `'review'` for
 * dual review and integration.
 */
export type RecoveryStage = 'plan' | 'implement' | 'review'

/**
 * The outcome of the review-mode decision table: whether to `'report'` or
 * `'resume'`, the (possibly downgraded) classification, a disqualifying
 * `reason` when applicable, and whether the candidate was `skip`ped.
 */
export interface ReviewDecision {
  action: 'report' | 'resume'
  classification: string
  reason: string
  skip: boolean
}

/**
 * The outcome of the continue-mode decision table: whether to `'report'` or
 * `'resume'`, the dispatched {@link RecoveryStage} (or `null` when
 * reporting), a disqualifying `reason` when applicable, and whether the
 * candidate was `skip`ped.
 */
export interface ContinueDecision {
  action: 'report' | 'resume'
  stage: RecoveryStage | null
  reason: string
  skip: boolean
}

/**
 * Matches a task-scoped roadmap branch name, capturing the dotted roadmap
 * identifier (with hyphens in place of dots) and an optional `-addendum`
 * suffix. Used by {@link branchToRoadmapId} to recognize and decompose
 * branch names.
 */
export const TASK_BRANCH_RE = /^roadmap-((?:\d+-)*\d+)(-addendum)?$/

/**
 * Derive the roadmap identifier and addendum flag from a branch name,
 * tolerating non-string input. Pure and side-effect free.
 *
 * @param branch - The branch name to parse (coerced to a string).
 * @returns The dotted roadmap `id` and `isAddendum` flag, or `null` when the
 *   branch does not match {@link TASK_BRANCH_RE}.
 */
export function branchToRoadmapId(branch: unknown): { id: string; isAddendum: boolean } | null {
  const match = TASK_BRANCH_RE.exec(String(branch || ''))
  if (!match) return null
  return { id: match[1].replace(/-/g, '.'), isAddendum: Boolean(match[2]) }
}

/**
 * Parse the output of `git worktree list --porcelain` into structured
 * entries, tolerating non-string input. Pure and side-effect free — the
 * caller is responsible for invoking git.
 *
 * @param output - The raw porcelain output to parse (coerced to a string).
 * @returns The parsed {@link WorktreeEntry} records, one per worktree block.
 */
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

/**
 * Reasons a discovered branch is recorded in `recovery.skipped` instead of
 * proceeding to its mode's maximum action. Discovery emits the first five;
 * the assessment and resume-decision stages emit the rest.
 */
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

/**
 * Review-mode resume eligibility gate: only a clean, committed, task-scoped
 * adopt-complete branch whose assessment reports no blocking `missingEvidence`
 * may spend review and integration effort. `missingEvidence` is the sole
 * evidence-based downgrade gate (issue #23): callers surface genuinely missing
 * validation or review evidence through it, so an empty or absent `validation`
 * field no longer disqualifies on its own. Host-collected evidence is decisive
 * over agent-reported fields; advisory `residualRisk` is deliberately not
 * consulted here. Pure and side-effect free.
 *
 * @param candidate - The candidate's hygiene fields, or a nullish value.
 * @param evidence - The host-collected git evidence, or a nullish value.
 * @param assessment - The agent-reported assessment fields, or a nullish
 *   value.
 * @returns `''` when eligible, otherwise the disqualifying skip reason from
 *   {@link RECOVERY_SKIP_REASONS}.
 */
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
  // `missingEvidence` is the SOLE evidence-based downgrade gate (issue #23):
  // callers represent genuinely missing validation or review evidence through
  // it, so an empty or absent `validation` field no longer disqualifies on its
  // own. Advisory `residualRisk` is deliberately NOT consulted here — it is
  // carried forward to the resumed reviewer/integrator instead of downgrading
  // adopt-complete.
  if ((assessment?.missingEvidence || []).length) return 'missing-validation-evidence'
  if (!candidate?.execplanPath) return 'missing-execplan'
  return ''
}

/**
 * The review-mode failure-resume decision table. Every classification is
 * report-only outside review mode; in review mode only eligible
 * adopt-complete candidates may resume, and an adopt-complete verdict that
 * fails an eligibility check is DOWNGRADED to `continue-manual` in the
 * summary — the decision fails closed rather than resuming an ineligible
 * candidate. Pure and side-effect free.
 *
 * @param candidate - The candidate's hygiene fields, or a nullish value.
 * @param evidence - The host-collected git evidence, or a nullish value.
 * @param assessment - The agent-reported assessment fields, or a nullish
 *   value.
 * @param mode - The recovery mode; only `'review'` can produce a resume.
 * @param flags - `dryRun` forces a report-only outcome even when eligible.
 * @returns The {@link ReviewDecision}, with `action: 'resume'` only for an
 *   eligible adopt-complete candidate in review mode with `dryRun` unset.
 */
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

/**
 * Continue-mode dispatch (failure resume, phase 3) relies on the committed
 * ExecPlan as the durable source of truth for where a task stands: agents
 * commit the plan after every change and keep its Status field accurate, so
 * a fresh run can dispatch a survivor branch deterministically, with no
 * judgement agent:
 *   Status DRAFT (or missing/unfilled) -> re-enter the plan/design-review loop
 *   Status APPROVED or IN PROGRESS     -> re-enter implementation
 *   Status COMPLETE                    -> re-enter dual review + integration
 *   Status BLOCKED                     -> report for the operator
 * Safety comes from the downstream gates the resumed branch still has to pass
 * (design review, deterministic gates, dual review, serialized integration),
 * not from an up-front classification.
 *
 * `EXECPLAN_STATUS_MAP` normalizes the lower-cased, whitespace-collapsed
 * Status field text into an {@link ExecplanStatus}; any value absent from
 * this map (or an unfilled skeleton line) parses as `'unknown'`.
 */
export const EXECPLAN_STATUS_MAP: Record<string, ExecplanStatus> = {
  draft: 'draft',
  approved: 'approved',
  'in progress': 'in-progress',
  blocked: 'blocked',
  complete: 'complete',
}

/**
 * Parse the durable state out of a committed ExecPlan: the `Status` field
 * and the Progress checkbox tallies (informational — dispatch keys on
 * `status` alone). An unfilled skeleton line (`"Status: DRAFT | APPROVED |
 * …"`) or an unrecognized value parses as `'unknown'`, which dispatches to
 * planning. Pure and side-effect free — the caller is responsible for
 * reading the ExecPlan file.
 *
 * @param text - The raw ExecPlan markdown text (coerced to a string).
 * @returns The parsed {@link ExecplanState}.
 */
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

/**
 * The continue-mode decision table. Purely deterministic: hygiene checks
 * from host-collected evidence, then a {@link RecoveryStage} keyed on the
 * committed ExecPlan `status`. Fails closed — any hygiene failure, an
 * unreadable or blocked plan, or a complete-status branch with no committed
 * work is reported rather than resumed. Pure and side-effect free.
 *
 * @param candidate - The candidate's hygiene fields, or a nullish value.
 * @param evidence - The host-collected git evidence, or a nullish value.
 * @param planState - The parsed ExecPlan status/tallies/error to dispatch on.
 * @param flags - `dryRun` forces a report-only outcome even when eligible.
 * @returns The {@link ContinueDecision}.
 */
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
