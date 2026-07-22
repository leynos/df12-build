/**
 * @file Fresh-run recovery discovery (failure resume, phase 1) —
 * reconstruct recovery candidates from durable Git state alone: local
 * roadmap-* branches, live worktrees, and the canonical roadmap. Discovery
 * never mutates the target project; it only reads refs, worktree metadata,
 * and commit ids. Discovery limits (base branch, resumeTaskId, candidate
 * cap) are bound once via makeRecoveryDiscovery so the run configuration
 * stays in the entry.
 */
import { execFileStatus, fileState } from './exec.ts'
import { directoryExists, readFileText } from './git-evidence.ts'
import { branchToRoadmapId, parseExecplanState, parseWorktreeList } from './recovery-decision.ts'
import type { ExecplanState, RecoveryEvidence } from './recovery-decision.ts'
import { candidateRoadmapComplete, roadmapTaskIndex } from './roadmap.ts'
import type { RecoveryCandidate } from './types.ts'

/**
 * A roadmap-* branch that discovery examined but excluded from the
 * recoverable candidate set, together with the reason for exclusion.
 *
 * @property id - Roadmap task id parsed from the branch name, or an empty
 *   string when the branch name did not map to a task.
 * @property branchName - The local `roadmap-*` branch name that was skipped.
 * @property reason - Short machine-readable code identifying why the branch
 *   was skipped (for example `unmapped-branch`, `already-complete`,
 *   `missing-worktree`, `worktree-probe-fault`, `unreadable-commit`, or
 *   `candidate-cap`).
 */
export interface RecoverySkip {
  id: string
  branchName: string
  reason: string
}

/**
 * The result of a discovery pass over durable Git state: the recoverable
 * candidates found, the branches skipped along with their reasons, and any
 * errors surfaced while probing refs, worktrees, or commits.
 *
 * @property candidates - Recovery candidates eligible for resume, ordered by
 *   roadmap line then branch name.
 * @property skipped - Branches examined but excluded, with their skip reasons.
 * @property errors - Human-readable diagnostics gathered while running Git
 *   commands or probing the filesystem; these do not necessarily halt
 *   discovery.
 */
export interface RecoveryDiscovery {
  candidates: RecoveryCandidate[]
  skipped: RecoverySkip[]
  errors: string[]
}

/**
 * Configuration bound once per run that constrains which candidates
 * discovery may surface.
 *
 * @property base - The upstream base branch (for example `origin/main`'s
 *   short name) used to compute each candidate's merge base.
 * @property resumeTaskId - When set, restrict discovery to the candidate
 *   matching this single roadmap task id; `null` allows any candidate.
 * @property resumeMaxCandidates - The maximum number of candidates discovery
 *   may return before further eligible branches are skipped with reason
 *   `candidate-cap`.
 */
export interface RecoveryDiscoveryLimits {
  base: string
  resumeTaskId: string | null
  resumeMaxCandidates: number
}

/**
 * Factory that binds the discovery limits (base branch, resumeTaskId,
 * candidate cap) once, so the returned function can be reused across the
 * entry without re-threading run configuration on every call.
 *
 * Discovery never mutates the target project: it only reads refs, worktree
 * metadata, and commit ids from the given (or current) Git root.
 *
 * @param limits - The discovery limits to bind for every call of the
 *   returned function.
 * @returns An async `discoverRecoveryCandidates(roadmapText, gitRoot?)`
 *   function that reconstructs recovery candidates from durable Git state
 *   and resolves to a {@link RecoveryDiscovery}.
 */
export function makeRecoveryDiscovery(limits: RecoveryDiscoveryLimits) {
  return async function discoverRecoveryCandidates(roadmapText: string, gitRoot?: string): Promise<RecoveryDiscovery> {
    const root = gitRoot || process.cwd()
    const skipped: RecoverySkip[] = []
    const errors: string[] = []

    const branchList = await execFileStatus('git', ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/roadmap-*'])
    if (!branchList.ok) {
      errors.push(`for-each-ref failed: ${[branchList.message, branchList.stderr].filter(Boolean).join('; ')}`)
      return { candidates: [], skipped, errors }
    }
    const branches = branchList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

    const worktreeList = await execFileStatus('git', ['-C', root, 'worktree', 'list', '--porcelain'])
    if (!worktreeList.ok) {
      errors.push(`worktree list failed: ${[worktreeList.message, worktreeList.stderr].filter(Boolean).join('; ')}`)
    }
    const worktreeByBranch = new Map(
      parseWorktreeList(worktreeList.stdout)
        .filter((entry) => entry.branch)
        .map((entry) => [entry.branch, entry.worktreePath]),
    )

    const byId = roadmapTaskIndex(roadmapText)
    const mapped: RecoveryCandidate[] = []
    for (const branch of branches) {
      const parsed = branchToRoadmapId(branch)
      const task = parsed ? byId.get(parsed.id) : null
      if (!parsed || !task) {
        skipped.push({ id: parsed?.id || '', branchName: branch, reason: 'unmapped-branch' })
        continue
      }
      if (candidateRoadmapComplete(task, parsed.isAddendum)) {
        skipped.push({ id: parsed.id, branchName: branch, reason: 'already-complete' })
        continue
      }

      const commit = await execFileStatus('git', ['-C', root, 'rev-parse', '--verify', `${branch}^{commit}`])
      if (!commit.ok) {
        skipped.push({ id: parsed.id, branchName: branch, reason: 'unreadable-commit' })
        continue
      }
      const mergeBase = await execFileStatus('git', ['-C', root, 'merge-base', `origin/${limits.base}`, branch])

      const worktreePath = worktreeByBranch.get(branch) || ''
      // A stat FAULT on the worktree path is neither present nor absent:
      // report it distinctly so a permissions/IO fault is not silently
      // recorded as a missing worktree.
      const worktreeDir = await directoryExists(worktreePath)
      if (!worktreeDir.ok) {
        skipped.push({ id: parsed.id, branchName: branch, reason: 'worktree-probe-fault' })
        errors.push(`worktree probe failed for ${branch}: ${worktreeDir.detail}`)
        continue
      }
      mapped.push({
        taskId: parsed.id,
        taskTitle: task.title || '',
        branchName: branch,
        worktreePath: worktreeDir.exists ? worktreePath : '',
        baseCommit: mergeBase.ok ? mergeBase.stdout.trim() : '',
        currentCommit: commit.stdout.trim(),
        roadmapComplete: false,
        isAddendum: parsed.isAddendum,
        line: task.line || Number.MAX_SAFE_INTEGER,
      })
    }

    mapped.sort((left, right) => (left.line - right.line) || left.branchName.localeCompare(right.branchName))

    const candidates: RecoveryCandidate[] = []
    for (const candidate of mapped) {
      if (limits.resumeTaskId && candidate.taskId !== limits.resumeTaskId) continue
      if (!candidate.worktreePath) {
        skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: 'missing-worktree' })
        continue
      }
      if (candidates.length >= limits.resumeMaxCandidates) {
        skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: 'candidate-cap' })
        continue
      }
      candidates.push(candidate)
    }

    return { candidates, skipped, errors }
  }
}

/**
 * Read and parse the durable ExecPlan checklist for a recovery candidate,
 * distinguishing an absent plan from one that could not be read.
 *
 * This performs I/O: it reads the plan file from the candidate's worktree
 * (when both a worktree path and execplan path are present) and parses its
 * checklist state.
 *
 * @param candidate - An object carrying the candidate's `worktreePath` and
 *   `execplanPath`, or `null`/`undefined` when no candidate is available.
 * @returns The parsed {@link ExecplanState}: `status: 'missing'` when there is
 *   no execplan path or the file does not exist, `status: 'unreadable'` with
 *   an `error` message when reading fails for any other reason (for example a
 *   permissions fault), or the parsed ticked/unticked item state otherwise.
 */
export async function readExecplanState(
  candidate: { worktreePath?: string; execplanPath?: string } | null | undefined,
): Promise<ExecplanState> {
  if (!candidate?.execplanPath) return { status: 'missing', ticked: 0, unticked: 0, items: [] }
  const path = process.getBuiltinModule('node:path')
  try {
    const text = await readFileText(path.join(candidate.worktreePath || '', candidate.execplanPath), candidate.worktreePath || undefined)
    return parseExecplanState(text)
  } catch (error) {
    const failure = error as (Error & { code?: string }) | null
    if (failure && (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')) {
      return { status: 'missing', ticked: 0, unticked: 0, items: [] }
    }
    // A plan that cannot be read is NOT a missing plan: dispatching to the
    // planning stage on an I/O or permission fault could overwrite durable
    // work. Surface the fault; the continue boundary reports it.
    return {
      status: 'unreadable',
      ticked: 0,
      unticked: 0,
      items: [],
      error: `${candidate.execplanPath}: ${(failure && failure.message) || String(error)}`,
    }
  }
}

/**
 * Skip reasons whose branch still exists and still maps to a selectable
 * roadmap id — normal selection must not re-open these this run, because
 * `git worktree add -b` would collide with the surviving branch.
 */
export const RECOVERY_HOLD_REASONS = new Set(['missing-worktree', 'worktree-probe-fault', 'candidate-cap', 'unreadable-commit', 'assessment-error'])

/**
 * Turn a read-only recovery discovery into the roadmap task ids whose
 * surviving `roadmap-*` branch must be held out of selection this run: every
 * resumable candidate plus every skip whose branch still maps to a selectable
 * id (see {@link RECOVERY_HOLD_REASONS}).
 *
 * Pure — it depends only on the discovery result, {@link branchToRoadmapId},
 * and {@link RECOVERY_HOLD_REASONS}, reads no run-scoped state, and spawns
 * nothing — so both the recovery loop and the always-on stale-branch guard can
 * share one notion of "held" rather than diverging.
 *
 * @param discovery - The read-only recovery discovery result to derive holds
 *   from.
 * @returns The held roadmap task ids split into `normal` and `addendum` lanes.
 */
export function computeHeldFromDiscovery(discovery: RecoveryDiscovery): { normal: Set<string>; addendum: Set<string> } {
  const held = { normal: new Set<string>(), addendum: new Set<string>() }
  const holdCandidate = (branchName: string, taskId?: string) => {
    const parsed = branchToRoadmapId(branchName)
    if (!parsed) return
    const lane = parsed.isAddendum ? held.addendum : held.normal
    lane.add(taskId || parsed.id)
  }
  for (const entry of discovery.skipped) {
    if (RECOVERY_HOLD_REASONS.has(entry.reason)) holdCandidate(entry.branchName, entry.id)
  }
  for (const candidate of discovery.candidates) {
    holdCandidate(candidate.branchName, candidate.taskId)
  }
  return held
}

/**
 * Resolve the canonical durable ExecPlan path for a task branch by probing
 * the filesystem in the candidate's worktree (I/O). An absent plan stays
 * absent: nothing downstream may substitute the canonical path back in after
 * this check has failed.
 *
 * @param candidate - The candidate's `branchName` (used to derive the
 *   canonical `docs/execplans/<branchName>.md` path) and `worktreePath` to
 *   probe within.
 * @returns The canonical `execplanPath` when the plan exists on disk, or an
 *   empty string when it does not exist or could not be verified; `error`
 *   carries a diagnostic message when the probe itself failed.
 */
export async function recoveryExecplanPath(
  candidate: { branchName: string; worktreePath: string },
): Promise<{ execplanPath: string; error: string }> {
  const canonicalPlan = `docs/execplans/${candidate.branchName}.md`
  const state = await fileState(canonicalPlan, candidate.worktreePath)
  if (!state.ok) return { execplanPath: '', error: state.detail }
  return { execplanPath: state.exists ? canonicalPlan : '', error: '' }
}

/**
 * Bridge an eligible recovered branch into the ordinary review path without
 * re-running implementation. Builds and returns an IMPL_SCHEMA-shaped report
 * from durable evidence alone; it does not re-execute the implementation
 * stage. The synthetic result is NOT proof the branch is shippable: code
 * review, expert review, gates, and integration remain decisive, and the
 * open issue makes that explicit to reviewers reading the implementation
 * summary.
 *
 * @param candidate - The recovered branch's `branchName` and `worktreePath`,
 *   plus an optional pre-resolved `execplanPath`; when `execplanPath` is not
 *   already a string, it is resolved via {@link recoveryExecplanPath}
 *   (I/O).
 * @param evidence - The recovery evidence gathered for the candidate (used
 *   for `commits`), or `null`/`undefined` when no evidence is available.
 * @param residualRisk - Advisory, non-blocking caveats carried forward from
 *   the resume assessment (#23); surfaced to the resumed reviewer/integrator
 *   without downgrading adopt-complete. Defaults to an empty array.
 * @returns An IMPL_SCHEMA-shaped report object with `ok: true`,
 *   `gatesGreen: true`, the resolved `execplanPath`, zeroed work-item counts,
 *   `commits` from `evidence`, an `openIssues` list flagging the branch for
 *   fresh review, `residualRisk: string[]` carrying forward the given
 *   caveats, and a fixed `summary`.
 */
export async function syntheticRecoveryImpl(
  candidate: { branchName: string; worktreePath: string; execplanPath?: unknown },
  evidence: RecoveryEvidence | null | undefined,
  residualRisk: readonly string[] | null | undefined = [],
) {
  const resolved =
    typeof candidate.execplanPath === 'string'
      ? { execplanPath: candidate.execplanPath, error: '' }
      : await recoveryExecplanPath(candidate)
  return {
    ok: true,
    gatesGreen: true,
    execplanPath: resolved.execplanPath,
    workItemsCompleted: 0,
    workItemsTotal: 0,
    commits: evidence?.recentCommits || [],
    coderabbitRuns: 0,
    openIssues: [
      'recovered branch requires fresh review',
      ...(resolved.error ? [`could not verify the durable ExecPlan: ${resolved.error}`] : []),
    ],
    // Advisory, non-blocking caveats the assessment carried forward: surfaced to
    // the resumed reviewer/integrator without downgrading adopt-complete (#23).
    residualRisk: [...(residualRisk || [])],
    summary: 'Recovered adopt-complete branch from durable git state.',
  }
}
