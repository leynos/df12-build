// Tests for the dry-run posture of runTask: a dry run must terminate before
// any git state is mutated, so it never creates a branch or worktree and
// remains a safe validation path even against a repository whose surviving
// roadmap-* branches would otherwise collide with `git worktree add -b`.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { makeRecoveryRepo, repoStateSnapshot } from './fixtures/recovery-repo.mjs'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

// Slice the helper surface out of the generated artefact and evaluate it, so
// the test drives the real runTask exactly as the write-preflight suite does.
async function loadRunTask(args = {}, agentImpl = async () => null) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/m, 'const meta =')
  const markerIndex = source.indexOf(CONTROL_LOOP_MARKER)
  assert.notEqual(markerIndex, -1, 'workflow control-loop marker should exist')
  const helperSource = source.slice(0, markerIndex)
  const factory = new Function(
    'args',
    'phase',
    'log',
    'agent',
    'parallel',
    'budget',
    `${helperSource}
return { runTask }
`,
  )
  return factory(
    { coderabbitHostReview: false, hostCommitGates: false, perWorkItemBuild: false, ...args },
    () => {},
    () => {},
    agentImpl,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
}

test('a dry run stops before worktree creation and mutates no git state', async () => {
  let agentCalls = 0
  const surface = await loadRunTask({ dryRun: true }, async () => {
    agentCalls += 1
    return { ok: true }
  })
  // roadmap-1-2-4 already exists as a surviving branch, so a real
  // `git worktree add -b roadmap-1-2-4` would fail on the collision.
  const repo = makeRecoveryRepo()
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
})
