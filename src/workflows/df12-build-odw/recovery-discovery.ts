// Fresh-run recovery discovery (failure resume, phase 1) — reconstruct
// recovery candidates from durable Git state alone: local roadmap-* branches,
// live worktrees, and the canonical roadmap. Discovery never mutates the
// target project; it only reads refs, worktree metadata, and commit ids.
// Discovery limits (base branch, resumeTaskId, candidate cap) are bound once
// via makeRecoveryDiscovery so the run configuration stays in the entry.
import { execFileStatus, fileState } from './exec.ts'
import { directoryExists, readFileText } from './git-evidence.ts'
import { branchToRoadmapId, parseExecplanState, parseWorktreeList } from './recovery-decision.ts'
import type { ExecplanState, RecoveryEvidence } from './recovery-decision.ts'
import { candidateRoadmapComplete, roadmapTaskIndex } from './roadmap.ts'
import type { RecoveryCandidate } from './types.ts'

export interface RecoverySkip {
  id: string
  branchName: string
  reason: string
}

export interface RecoveryDiscovery {
  candidates: RecoveryCandidate[]
  skipped: RecoverySkip[]
  errors: string[]
}

export interface RecoveryDiscoveryLimits {
  base: string
  resumeTaskId: string | null
  resumeMaxCandidates: number
}

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
      mapped.push({
        taskId: parsed.id,
        taskTitle: task.title || '',
        branchName: branch,
        worktreePath: (await directoryExists(worktreePath)) ? worktreePath : '',
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

export async function readExecplanState(
  candidate: { worktreePath?: string; execplanPath?: string } | null | undefined,
): Promise<ExecplanState> {
  if (!candidate?.execplanPath) return { status: 'missing', ticked: 0, unticked: 0, items: [] }
  const path = process.getBuiltinModule('node:path')
  try {
    const text = await readFileText(path.join(candidate.worktreePath || '', candidate.execplanPath))
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

// Skip reasons whose branch still exists and still maps to a selectable
// roadmap id — normal selection must not re-open these this run, because
// `git worktree add -b` would collide with the surviving branch.
export const RECOVERY_HOLD_REASONS = new Set(['missing-worktree', 'candidate-cap', 'unreadable-commit', 'assessment-error'])

// The canonical durable plan for a task branch, or '' when it does not exist
// on disk in the worktree. An absent plan stays absent: nothing downstream may
// substitute the canonical path back in after this check has failed.
export async function recoveryExecplanPath(
  candidate: { branchName: string; worktreePath: string },
): Promise<{ execplanPath: string; error: string }> {
  const canonicalPlan = `docs/execplans/${candidate.branchName}.md`
  const state = await fileState(canonicalPlan, candidate.worktreePath)
  if (!state.ok) return { execplanPath: '', error: state.detail }
  return { execplanPath: state.exists ? canonicalPlan : '', error: '' }
}

// Bridge an eligible recovered branch into the ordinary review path without
// re-running implementation. The synthetic result mirrors IMPL_SCHEMA but is
// NOT proof the branch is shippable: code review, expert review, gates, and
// integration remain decisive, and the open issue makes that explicit to
// reviewers reading the implementation summary.
export async function syntheticRecoveryImpl(
  candidate: { branchName: string; worktreePath: string; execplanPath?: unknown },
  evidence: RecoveryEvidence | null | undefined,
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
    summary: 'Recovered adopt-complete branch from durable git state.',
  }
}
