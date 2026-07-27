/** @file Tests for the pure worktree-collision disposition helper. */
// Module tests for the pure worktree-collision disposition helper
// (worktree-collision milestone, issue #42): every branch of the decision
// table that turns host-observed git facts into create / reclaim / fail, so
// the fail-closed guarantee — never discard unmerged or dirty work — is
// explicit. Direct import, literal-expected-object assertions in the style of
// git-evidence.test.ts.
import { describe, expect, test } from 'bun:test'

import {
  decideWorktreeDisposition,
  type WorktreeCollisionFacts,
} from '../../src/workflows/df12-build-odw/worktree-collision.ts'

// A merged-and-clean collision (the reclaimable baseline); override per case.
function facts(overrides: Partial<WorktreeCollisionFacts> = {}): WorktreeCollisionFacts {
  return {
    branchExists: true,
    branchMergedIntoBase: true,
    worktreeExists: false,
    worktreeDirty: false,
    candidateRoadmapComplete: false,
    ...overrides,
  }
}

describe('decideWorktreeDisposition', () => {
  test('no pre-existing branch creates a fresh worktree', () => {
    // The other facts are irrelevant when the branch is absent; a create must
    // never be overridden by stale merged/dirty flags carried over.
    expect(decideWorktreeDisposition(facts({ branchExists: false }))).toEqual({
      disposition: 'create',
      reason: 'no pre-existing branch; creating a fresh worktree',
    })
    expect(
      decideWorktreeDisposition(
        facts({ branchExists: false, branchMergedIntoBase: false, worktreeDirty: true }),
      ).disposition,
    ).toBe('create')
  })

  test('a merged branch with no worktree is reclaimed', () => {
    expect(decideWorktreeDisposition(facts())).toEqual({
      disposition: 'reclaim',
      reason: 'stale branch is fully merged into the base with no registered worktree; reclaiming it',
    })
  })

  test('a merged branch with a clean registered worktree fails closed', () => {
    expect(decideWorktreeDisposition(facts({ worktreeExists: true, worktreeDirty: false }))).toEqual({
      disposition: 'fail',
      reason: 'pre-existing branch has a registered clean worktree; refusing to reset a worktree another run may own',
    })
  })

  test('a complete roadmap task corroborates the reclaim reason', () => {
    expect(decideWorktreeDisposition(facts({ candidateRoadmapComplete: true }))).toEqual({
      disposition: 'reclaim',
      reason:
        'stale branch is fully merged into the base with no registered worktree; reclaiming it' +
        ' (the roadmap marks this task complete)',
    })
  })

  test('a merged branch with a dirty worktree fails closed', () => {
    expect(decideWorktreeDisposition(facts({ worktreeExists: true, worktreeDirty: true }))).toEqual({
      disposition: 'fail',
      reason: 'pre-existing branch has a dirty worktree; refusing to discard uncommitted work',
    })
  })

  test('an unmerged branch fails closed regardless of worktree or roadmap state', () => {
    const unmergedReason =
      'pre-existing branch carries commits not merged into the base; refusing to discard unmerged work'
    // Unmerged clean worktree.
    expect(
      decideWorktreeDisposition(facts({ branchMergedIntoBase: false, worktreeExists: true })),
    ).toEqual({ disposition: 'fail', reason: unmergedReason })
    // Unmerged dirty worktree: the unmerged verdict still wins.
    expect(
      decideWorktreeDisposition(
        facts({ branchMergedIntoBase: false, worktreeExists: true, worktreeDirty: true }),
      ),
    ).toEqual({ disposition: 'fail', reason: unmergedReason })
    // A complete-roadmap signal must NOT license discarding unmerged work.
    expect(
      decideWorktreeDisposition(
        facts({ branchMergedIntoBase: false, candidateRoadmapComplete: true }),
      ),
    ).toEqual({ disposition: 'fail', reason: unmergedReason })
  })

  test('exhaustively preserves the fail-closed collision invariant', () => {
    for (let bits = 0; bits < 32; bits++) {
      const state = facts({
        branchExists: Boolean(bits & 1),
        branchMergedIntoBase: Boolean(bits & 2),
        worktreeExists: Boolean(bits & 4),
        worktreeDirty: Boolean(bits & 8),
        candidateRoadmapComplete: Boolean(bits & 16),
      })
      const decision = decideWorktreeDisposition(state)
      if (!state.branchExists) expect(decision.disposition).toBe('create')
      else if (!state.branchMergedIntoBase || state.worktreeExists) expect(decision.disposition).toBe('fail')
      else expect(decision.disposition).toBe('reclaim')
    }
  })
})
