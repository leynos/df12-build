// Pure disposition helper for the deterministic worktree-creation path
// (failure-resume design, worktree-collision milestone). `createWorktree`
// builds a deterministic branch name (`roadmap-<id>[-addendum]`) with no
// unique suffix, so a stale completed addendum branch left over from a prior
// round collides with `git worktree add -b <branch>` and halts the run. This
// module turns the host-observed git facts about such a collision into an
// explicit disposition — create a fresh worktree, reclaim the leftover, or
// fail closed — without performing any I/O, so the safety rules are directly
// unit-testable and stay out of the formally-verified recovery-decision twin.
//
// The governing rule is reclaim-when-safe, fail-closed-otherwise: a leftover
// branch is only reclaimed when its tip is already merged into `origin/BASE`
// and any worktree checked out on it is clean, so the automation never
// discards unmerged commits or uncommitted work (see docs/adr-003). The
// destructive-operation policy this encodes is scoped deliberately narrowly;
// the general `discard`-branch sweeper remains deferred (roadmap 4.2.1).

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
// Fail closed: any existing branch with unmerged commits or a dirty worktree
// is refused so no automation destroys work the operator has not merged.
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
  if (facts.worktreeExists && facts.worktreeDirty) {
    return {
      disposition: 'fail',
      reason: 'pre-existing branch has a dirty worktree; refusing to discard uncommitted work',
    }
  }
  const corroboration = facts.candidateRoadmapComplete
    ? ' (the roadmap marks this task complete)'
    : ''
  return {
    disposition: 'reclaim',
    reason: `stale branch is fully merged into the base with no dirty worktree; reclaiming it${corroboration}`,
  }
}
