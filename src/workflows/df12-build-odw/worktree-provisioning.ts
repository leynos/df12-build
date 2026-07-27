/**
 * @file Injected deterministic worktree provisioning for ODW task branches.
 *
 * The module owns collision inspection and the narrowly permitted orphaned
 * branch reclaim. Its dependencies are injected so command failures and the
 * destructive boundary are testable without evaluating the ambient ODW entry.
 */
import { branchToRoadmapId, parseWorktreeList } from './recovery-decision.ts'
import { candidateRoadmapComplete, roadmapTaskIndex } from './roadmap.ts'
import { decideWorktreeDisposition } from './worktree-collision.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'
import type { WorktreeCollisionFacts } from './worktree-collision.ts'

export interface WorktreeProvisioningDeps {
  base: string
  gitTimeoutMs: number
  execFileStatus: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  execFileText: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<string>
  readRoadmap: () => Promise<{ text: string }>
  log: (message: string) => void
}

export interface WorktreeTarget {
  branch: string
  worktreePath: string
}

export type WorktreeProvisionResult =
  | { ok: true; resolvedWorktreePath: string; createdNote: string }
  | { ok: false; reason: string }

interface CollisionInspection {
  facts: WorktreeCollisionFacts
  notes: string[]
}

function statusDetail(label: string, status: ExecStatus): string {
  return `${label}: ${(status.message || status.stderr || status.stdout || 'command failed').trim()}`
}

export function makeWorktreeProvisioning(deps: WorktreeProvisioningDeps) {
  const gitOptions = { timeoutMs: deps.gitTimeoutMs }

  async function worktreeBranchExists(branch: string): Promise<boolean> {
    const probe = await deps.execFileStatus('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], gitOptions)
    return probe.ok
  }

  async function inspectWorktreeCollision(branch: string): Promise<CollisionInspection | { error: string }> {
    const merged = await deps.execFileStatus('git', ['merge-base', '--is-ancestor', branch, `origin/${deps.base}`], gitOptions)
    const list = await deps.execFileStatus('git', ['worktree', 'list', '--porcelain'], gitOptions)
    if (!list.ok) return { error: statusDetail('could not inspect registered worktrees', list) }
    const entry = parseWorktreeList(list.stdout).find((candidate) => candidate.branch === branch)
    const worktreeExists = Boolean(entry?.worktreePath)
    let worktreeDirty = false
    if (entry?.worktreePath) {
      const status = await deps.execFileStatus('git', ['-C', entry.worktreePath, 'status', '--porcelain'], gitOptions)
      if (!status.ok) return { error: statusDetail('could not inspect registered worktree status', status) }
      worktreeDirty = status.stdout.trim() !== ''
    }
    const notes: string[] = []
    let roadmapComplete = false
    const parsed = branchToRoadmapId(branch)
    if (parsed) {
      try {
        const roadmap = await deps.readRoadmap()
        const roadmapTask = roadmapTaskIndex(roadmap.text).get(parsed.id)
        if (roadmapTask) roadmapComplete = candidateRoadmapComplete(roadmapTask, parsed.isAddendum)
      } catch (error) {
        notes.push(`roadmap corroboration unavailable: ${(error as Error).message || String(error)}`)
      }
    }
    return {
      facts: {
        branchExists: true,
        branchMergedIntoBase: merged.ok,
        worktreeExists,
        worktreeDirty,
        candidateRoadmapComplete: roadmapComplete,
      },
      notes,
    }
  }

  async function reclaimOrphanedBranch(branch: string, worktreePath: string): Promise<void> {
    const prune = await deps.execFileStatus('git', ['worktree', 'prune'], gitOptions)
    if (!prune.ok) throw new Error(statusDetail('could not prune stale worktree registrations', prune))
    await deps.execFileText('git', ['branch', '-f', branch, `origin/${deps.base}`], gitOptions)
    await deps.execFileText('git', ['worktree', 'add', worktreePath, branch], gitOptions)
  }

  async function provisionWorktreeForBranch(target: WorktreeTarget): Promise<WorktreeProvisionResult> {
    const { branch, worktreePath } = target
    if (!(await worktreeBranchExists(branch))) {
      await deps.execFileText('git', ['worktree', 'add', '-b', branch, worktreePath, `origin/${deps.base}`], gitOptions)
      deps.log(JSON.stringify({ event: 'worktree_collision', disposition: 'create', branch, worktree: 'absent' }))
      return { ok: true, resolvedWorktreePath: worktreePath, createdNote: 'created deterministically by the ODW control loop; no setup agent required' }
    }
    const inspection = await inspectWorktreeCollision(branch)
    if ('error' in inspection) {
      deps.log(JSON.stringify({ event: 'worktree_collision', disposition: 'fail', branch, reason: inspection.error }))
      return { ok: false, reason: inspection.error }
    }
    const decision = decideWorktreeDisposition(inspection.facts)
    deps.log(JSON.stringify({ event: 'worktree_collision', disposition: decision.disposition, branch, worktree: inspection.facts.worktreeExists ? 'present' : 'absent', reason: decision.reason }))
    if (decision.disposition === 'fail') return { ok: false, reason: decision.reason }
    await reclaimOrphanedBranch(branch, worktreePath)
    const corroboration = inspection.notes.length ? `; ${inspection.notes.join('; ')}` : ''
    return { ok: true, resolvedWorktreePath: worktreePath, createdNote: `reclaimed stale branch ${branch}: ${decision.reason}${corroboration}` }
  }

  return { provisionWorktreeForBranch }
}
