// Tests for the dry-run posture of runTask: a dry run must terminate before
// any git state is mutated, so it never creates a branch or worktree and
// remains a safe validation path even against a repository whose surviving
// roadmap-* branches would otherwise collide with `git worktree add -b`. The
// property-based sweep of the same no-mutation invariant across arbitrary task
// shapes and repo states lives in df12-build-odw-dry-run.property.test.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRunTask } from './fixtures/load-run-task.mjs'
import { makeRecoveryRepo, repoStateSnapshot } from './fixtures/recovery-repo.mjs'

test('a dry run stops before worktree creation and mutates no git state', async () => {
  let agentCalls = 0
  const surface = await loadRunTask({ dryRun: true }, async () => {
    agentCalls += 1
    return { ok: true }
  })
  // roadmap-1-2-4 already exists as a surviving branch, so a real
  // `git worktree add -b roadmap-1-2-4` would fail on the collision.
  const repo = makeRecoveryRepo()
  try {
    const before = repoStateSnapshot(repo)
    const previousCwd = process.cwd()
    process.chdir(repo.dir)
    let result
    try {
      result = await surface.runTask(
        { id: '1.2.4', title: 'Dry-run no-mutation probe', requires: [], isAddendum: false, subtasks: [] },
        null,
      )
    } finally {
      process.chdir(previousCwd)
    }

    assert.equal(result.status, 'dry-run')
    assert.equal(result.stage, 'pre-worktree')
    assert.equal(result.worktree, undefined, 'a dry run creates no worktree, so it must report none')
    assert.equal(result.branch, undefined)
    assert.equal(result.plan, undefined)
    assert.equal(agentCalls, 0, 'a dry run must not dispatch any agent (no probe, plan, or build)')

    const after = repoStateSnapshot(repo)
    assert.deepEqual(after, before, 'a dry run must leave every observable piece of durable state untouched')
    // Explicit branch/worktree assertions on top of the whole-snapshot compare,
    // to pinpoint a regression to `git worktree add -b …` if it ever returns.
    assert.equal(after.localRefs, before.localRefs, 'no new branch may appear')
    assert.equal(after.worktrees, before.worktrees, 'no new worktree may appear')

    // Observability: the decision boundary must emit a structured, parseable
    // trace so operators see WHY the task stopped, not just the terminal status.
    const boundaryLog = surface.logs.find((line) => line.includes('reason=dry-run'))
    assert.ok(boundaryLog, 'the dry-run early return must emit a structured log line')
    assert.match(boundaryLog, /\[task 1\.2\.4\]/, 'the log must carry the task id')
    assert.match(boundaryLog, /lane=normal/, 'the log must record the lane (normal, from task.isAddendum)')
    assert.match(boundaryLog, /stage=pre-worktree/, 'the log must record stage=pre-worktree')
    assert.match(boundaryLog, /reason=dry-run/, 'the log must record reason=dry-run')
  } finally {
    repo.cleanup()
  }
})

test('a dry run in the addendum lane logs lane=addendum', async () => {
  let agentCalls = 0
  const surface = await loadRunTask({ dryRun: true }, async () => {
    agentCalls += 1
    return { ok: true }
  })
  const repo = makeRecoveryRepo()
  try {
    const before = repoStateSnapshot(repo)
    const previousCwd = process.cwd()
    process.chdir(repo.dir)
    let result
    try {
      result = await surface.runTask(
        { id: '2.1.2.1', title: 'Addendum dry-run probe', requires: [], isAddendum: true, subtasks: [] },
        null,
      )
    } finally {
      process.chdir(previousCwd)
    }
    assert.equal(result.status, 'dry-run')
    assert.equal(result.stage, 'pre-worktree')
    assert.equal(agentCalls, 0, 'a dry run must not dispatch any agent (no probe, plan, or build)')

    const after = repoStateSnapshot(repo)
    assert.deepEqual(after, before, 'a dry run must leave every observable piece of durable state untouched')

    const boundaryLog = surface.logs.find((line) => line.includes('reason=dry-run'))
    assert.ok(boundaryLog, 'the dry-run early return must emit a structured log line')
    assert.match(boundaryLog, /lane=addendum/, 'the addendum lane must be reflected in the log')
  } finally {
    repo.cleanup()
  }
})
