// Property-based proof of the dry-run no-mutation invariant. The dry-run
// short-circuit at the head of runTask is a UNIVERSAL contract: for EVERY task
// shape (any id — collision-prone, roadmap-shaped, or arbitrary string; either
// lane; any requires/subtasks) and EVERY repo state, a dry run must terminate
// at stage pre-worktree with status dry-run, dispatch no agent, and leave
// durable git state byte-for-byte unchanged. The concrete regression cases in
// df12-build-odw-dry-run.test.mjs pin a couple of points; this fast-check
// property sweeps the space so a future edit that moves the guard below
// createWorktree, the write preflight, or the addendum/normal split is caught
// for arbitrary inputs rather than just the hand-picked ones.

import assert from 'node:assert/strict'
import test from 'node:test'

import fc from 'fast-check'

import { loadRunTask } from './fixtures/load-run-task.mjs'
import { makeRecoveryRepo, repoStateSnapshot } from './fixtures/recovery-repo.mjs'

// A roadmap-shaped dotted id, e.g. "3.1.4" — built from small integers so the
// generator reaches ids that do and do not collide with a surviving branch.
const dottedId = fc
  .array(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('.'))

// A small pool of distinct repo states, built once and reused across every
// generated input. A dry run must be inert against each, so the baseline
// captured here is the "before" every iteration compares its "after" against —
// the first iteration that mutated any pooled repo would fail on the very next
// snapshot compare. Reusing the pool keeps 100 iterations fast (no per-run
// `git worktree add`/branch setup) while still exercising both a plain repo and
// one carrying an extra addendum worktree.
test('property: any dry run over arbitrary task shapes and repo states mutates nothing', async () => {
  // Pool construction sits OUTSIDE the try: if makeRecoveryRepo() throws there is
  // nothing to clean up yet. The finally then releases BOTH pooled repos as soon
  // as the property finishes, rather than deferring to the process-exit hook.
  const repoPool = {
    normal: makeRecoveryRepo(),
    addendum: makeRecoveryRepo({ withAddendumWorktree: true }),
  }
  try {
    const baseline = {
      normal: repoStateSnapshot(repoPool.normal),
      addendum: repoStateSnapshot(repoPool.addendum),
    }
    let agentCalls = 0
    const surface = await loadRunTask({ dryRun: true }, async () => {
      agentCalls += 1
      return { ok: true }
    })
    const taskArb = fc.record({
      // Mix branch-colliding ids (roadmap-1-2-3 has a live worktree, roadmap-1-2-4
      // is a bare branch, roadmap-2-1-1 exists), freely generated dotted ids, and
      // fully arbitrary strings — the guard must not care what the id is.
      id: fc.oneof(fc.constantFrom('1.2.3', '1.2.4', '2.1.1', '2.1.2.1'), dottedId, fc.string()),
      title: fc.string(),
      requires: fc.array(dottedId, { maxLength: 3 }),
      isAddendum: fc.boolean(),
      subtasks: fc.array(dottedId, { maxLength: 2 }),
    })
    await fc.assert(
      fc.asyncProperty(taskArb, fc.constantFrom('normal', 'addendum'), async (task, repoKey) => {
        agentCalls = 0
        const repo = repoPool[repoKey]
        const previousCwd = process.cwd()
        process.chdir(repo.dir)
        let result
        try {
          result = await surface.runTask(task, null)
        } finally {
          process.chdir(previousCwd)
        }
        // (a) terminal status is always dry-run; (b) stage is always pre-worktree
        assert.equal(result.status, 'dry-run')
        assert.equal(result.stage, 'pre-worktree')
        assert.equal(result.worktree, undefined)
        assert.equal(result.branch, undefined)
        assert.equal(result.plan, undefined)
        // (d) the agent stub is never invoked
        assert.equal(agentCalls, 0, 'a dry run must never invoke the agent stub')
        // (c) no new git refs or worktrees — the whole durable snapshot is intact
        assert.deepEqual(repoStateSnapshot(repo), baseline[repoKey], 'a dry run must leave durable state untouched for every input')
      }),
      { numRuns: 100 },
    )
  } finally {
    repoPool.normal.cleanup()
    repoPool.addendum.cleanup()
  }
})
