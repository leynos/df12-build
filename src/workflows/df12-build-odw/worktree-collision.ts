/**
 * @file Pure disposition helper for deterministic worktree creation.
 *
 * `createWorktree` builds a deterministic branch name with no unique suffix,
 * so a stale completed addendum branch can collide with `git worktree add -b`.
 * This module turns host-observed facts into create, reclaim, or fail without
 * I/O, keeping the safety rule directly unit-testable and out of the formally
 * verified recovery-decision twin.
 *
 * The governing rule is reclaim-when-safe, fail-closed-otherwise: a leftover
 * branch is only reclaimed when its tip is already merged into `origin/BASE`
 * and has no registered worktree, so the automation never resets a tree that
 * another run may own (see docs/adr-003). The destructive-operation policy is
 * deliberately narrow; the general `discard`-branch sweeper remains deferred.
 */

// The host-observed git facts a collision disposition is decided from. Every
// field is a boolean the caller derives from a single git probe, so the
// decision is a pure function of observable state.
export interface WorktreeCollisionFacts {
  // A local branch of the deterministic name already exists.
  branchExists: boolean
  // The existing branch tip is an ancestor of `origin/BASE` — i.e. its work is
  // already merged into the base line and carries nothing unique.
  branchMergedIntoBase: boolean
  // A live worktree is currently checked out on the existing branch.
  worktreeExists: boolean
  // That worktree has uncommitted changes (untracked, unstaged, or staged).
  worktreeDirty: boolean
  // The roadmap marks the branch's task (or addendum) complete. This only ever
  // corroborates a reclaim; it never licenses discarding unmerged or dirty
  // work, so it cannot turn a `fail` into a `reclaim`.
  candidateRoadmapComplete: boolean
}

export type WorktreeDisposition = 'create' | 'reclaim' | 'fail'

export interface WorktreeDispositionDecision {
  disposition: WorktreeDisposition
  reason: string
}

// Decide what to do when the deterministic worktree branch may already exist.
// Fail closed: any existing branch with unmerged commits or a registered
// worktree is refused so no automation destroys work an operator or another
// workflow run may still own.
export function decideWorktreeDisposition(facts: WorktreeCollisionFacts): WorktreeDispositionDecision {
  if (!facts.branchExists) {
    return { disposition: 'create', reason: 'no pre-existing branch; creating a fresh worktree' }
  }
  if (!facts.branchMergedIntoBase) {
    return {
      disposition: 'fail',
      reason: 'pre-existing branch carries commits not merged into the base; refusing to discard unmerged work',
    }
  }
  if (facts.worktreeExists) {
    return {
      disposition: 'fail',
      reason: facts.worktreeDirty
        ? 'pre-existing branch has a dirty worktree; refusing to discard uncommitted work'
        : 'pre-existing branch has a registered clean worktree; refusing to reset a worktree another run may own',
    }
  }
  const corroboration = facts.candidateRoadmapComplete
    ? ' (the roadmap marks this task complete)'
    : ''
  return {
    disposition: 'reclaim',
    reason: `stale branch is fully merged into the base with no registered worktree; reclaiming it${corroboration}`,
  }
}
