import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'df12-test',
      GIT_AUTHOR_EMAIL: 'df12-test@example.invalid',
      GIT_COMMITTER_NAME: 'df12-test',
      GIT_COMMITTER_EMAIL: 'df12-test@example.invalid',
    },
  }).trim()
}

const RECOVERY_ROADMAP = [
  '# Fixture roadmap',
  '',
  '### 1.2. Discovery step',
  '',
  '- [ ] 1.2.3. Implement the parser state machine.',
  '- [ ] 1.2.4. Another open task without a worktree.',
  '',
  '### 2.1. Completed step',
  '',
  '- [x] 2.1.1. Completed task.',
  '- [x] 2.1.2. Completed parent with an open addendum.',
  '  - [ ] 2.1.2.1. Addendum sub-task.',
  '',
].join('\n')

// A repo with an `origin` remote, surviving roadmap-* branches, and a live
// worktree for 1.2.3 — the durable state fresh-run discovery reads.
function makeRecoveryRepo({ withAddendumWorktree = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'df12-recovery-'))
  const dir = path.join(root, 'project')
  const originDir = path.join(root, 'origin.git')
  mkdirSync(dir)
  git(root, 'init', '--bare', originDir)
  git(root, 'init', '-b', 'main', dir)
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  mkdirSync(path.join(dir, 'docs'))
  writeFileSync(path.join(dir, 'docs', 'roadmap.md'), RECOVERY_ROADMAP)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Initial fixture')
  git(dir, 'remote', 'add', 'origin', originDir)
  git(dir, 'push', 'origin', 'main')
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  const addBranch = (branch, { commit = true, worktree = false } = {}) => {
    git(dir, 'branch', branch, 'main')
    let worktreePath = ''
    if (worktree) {
      worktreePath = path.join(root, 'worktrees', branch)
      git(dir, 'worktree', 'add', worktreePath, branch)
      if (commit) {
        writeFileSync(path.join(worktreePath, `${branch}.txt`), 'work\n')
        git(worktreePath, 'add', '.')
        git(worktreePath, 'commit', '-m', `Work on ${branch}`)
      }
    }
    return worktreePath
  }

  const parserWorktree = addBranch('roadmap-1-2-3', { worktree: true })
  addBranch('roadmap-1-2-4')
  addBranch('roadmap-2-1-1')
  addBranch('roadmap-9-9-9')
  addBranch('roadmap-x')
  let addendumWorktree = ''
  if (withAddendumWorktree) {
    addendumWorktree = addBranch('roadmap-2-1-2-addendum', { worktree: true })
  }

  return { root, dir, baseSha, parserWorktree, addendumWorktree }
}

async function loadRecoverySurface(args = {}) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/, 'const meta =')
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
return {
  RESUME_PARTIAL_BRANCHES,
  RESUME_MODE,
  RESUME_TASK_ID,
  RESUME_MAX_CANDIDATES,
  branchToRoadmapId,
  parseWorktreeList,
  discoverRecoveryCandidates,
}
`,
  )
  return factory(
    args,
    () => {},
    () => {},
    async () => null,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
}

test('recovery configuration defaults are non-mutating', async () => {
  const surface = await loadRecoverySurface({})

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, false)
  assert.equal(surface.RESUME_MODE, 'assess')
  assert.equal(surface.RESUME_TASK_ID, null)
  assert.equal(surface.RESUME_MAX_CANDIDATES, 4)
})

test('recovery configuration accepts explicit operator overrides', async () => {
  const surface = await loadRecoverySurface({
    resumePartialBranches: true,
    resumeMode: 'Review',
    resumeTaskId: '1.2.3',
    resumeMaxCandidates: 2,
  })

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, true)
  assert.equal(surface.RESUME_MODE, 'review')
  assert.equal(surface.RESUME_TASK_ID, '1.2.3')
  assert.equal(surface.RESUME_MAX_CANDIDATES, 2)
})

test('recovery discovery is opt-in: truthy but non-true values stay disabled', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: 'yes' })

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, false)
})

test('unsupported resumeMode values fail fast', async () => {
  await assert.rejects(
    loadRecoverySurface({ resumeMode: 'merge' }),
    /Unsupported resumeMode: merge/,
  )
})

test('resumeMaxCandidates is clamped to a sane positive bound', async () => {
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 0 })).RESUME_MAX_CANDIDATES, 1)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: -3 })).RESUME_MAX_CANDIDATES, 1)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 2.9 })).RESUME_MAX_CANDIDATES, 2)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 'many' })).RESUME_MAX_CANDIDATES, 4)
})

test('task branch names map back to dotted roadmap ids', async () => {
  const surface = await loadRecoverySurface({})

  assert.deepEqual(surface.branchToRoadmapId('roadmap-1-2-3'), { id: '1.2.3', isAddendum: false })
  assert.deepEqual(surface.branchToRoadmapId('roadmap-2-1-2-addendum'), { id: '2.1.2', isAddendum: true })
  assert.equal(surface.branchToRoadmapId('roadmap-x'), null)
  assert.equal(surface.branchToRoadmapId('roadmap-1-2-3-extra'), null)
  assert.equal(surface.branchToRoadmapId('feature/parser'), null)
  assert.equal(surface.branchToRoadmapId(''), null)
})

test('worktree porcelain output parses into branch-to-path entries', async () => {
  const surface = await loadRecoverySurface({})
  const fixture = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo.worktrees/roadmap-1-2-3',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/roadmap-1-2-3',
    '',
    'worktree /repo.worktrees/detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\n')

  assert.deepEqual(surface.parseWorktreeList(fixture), [
    { worktreePath: '/repo', branch: 'main', head: '1111111111111111111111111111111111111111' },
    {
      worktreePath: '/repo.worktrees/roadmap-1-2-3',
      branch: 'roadmap-1-2-3',
      head: '2222222222222222222222222222222222222222',
    },
    { worktreePath: '/repo.worktrees/detached', branch: '', head: '3333333333333333333333333333333333333333' },
  ])
})

test('discovery maps branches, skips completed and unmapped work, and keeps order deterministic', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo()

  const { candidates, skipped, errors } = await surface.discoverRecoveryCandidates(RECOVERY_ROADMAP, repo.dir)

  assert.deepEqual(errors, [])
  assert.equal(candidates.length, 1)
  const [candidate] = candidates
  assert.equal(candidate.taskId, '1.2.3')
  assert.equal(candidate.taskTitle, 'Implement the parser state machine.')
  assert.equal(candidate.branchName, 'roadmap-1-2-3')
  assert.equal(candidate.worktreePath, repo.parserWorktree)
  assert.equal(candidate.baseCommit, repo.baseSha)
  assert.match(candidate.currentCommit, /^[0-9a-f]{40}$/)
  assert.notEqual(candidate.currentCommit, repo.baseSha, 'candidate should carry its branch commit')
  assert.equal(candidate.roadmapComplete, false)
  assert.equal(candidate.isAddendum, false)

  const reasonByBranch = new Map(skipped.map((entry) => [entry.branchName, entry.reason]))
  assert.equal(reasonByBranch.get('roadmap-1-2-4'), 'missing-worktree')
  assert.equal(reasonByBranch.get('roadmap-2-1-1'), 'already-complete')
  assert.equal(reasonByBranch.get('roadmap-9-9-9'), 'unmapped-branch')
  assert.equal(reasonByBranch.get('roadmap-x'), 'unmapped-branch')
})

test('discovery keeps addendum branches for parents with open sub-tasks', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo({ withAddendumWorktree: true })

  const { candidates } = await surface.discoverRecoveryCandidates(RECOVERY_ROADMAP, repo.dir)

  const addendum = candidates.find((candidate) => candidate.isAddendum)
  assert.ok(addendum, 'addendum candidate should be discovered')
  assert.equal(addendum.taskId, '2.1.2')
  assert.equal(addendum.branchName, 'roadmap-2-1-2-addendum')
  assert.equal(addendum.worktreePath, repo.addendumWorktree)
  assert.deepEqual(
    candidates.map((candidate) => candidate.branchName),
    ['roadmap-1-2-3', 'roadmap-2-1-2-addendum'],
    'candidates should sort by roadmap line order',
  )
})

test('discovery honours resumeTaskId and the candidate cap', async () => {
  const repo = makeRecoveryRepo({ withAddendumWorktree: true })

  const filtered = await (await loadRecoverySurface({ resumeTaskId: '2.1.2' }))
    .discoverRecoveryCandidates(RECOVERY_ROADMAP, repo.dir)
  assert.deepEqual(filtered.candidates.map((candidate) => candidate.taskId), ['2.1.2'])
  assert.ok(
    !filtered.skipped.some((entry) => entry.branchName === 'roadmap-1-2-3'),
    'resumeTaskId narrowing is silent, not a skip diagnostic',
  )

  const capped = await (await loadRecoverySurface({ resumeMaxCandidates: 1 }))
    .discoverRecoveryCandidates(RECOVERY_ROADMAP, repo.dir)
  assert.deepEqual(capped.candidates.map((candidate) => candidate.branchName), ['roadmap-1-2-3'])
  assert.deepEqual(
    capped.skipped.filter((entry) => entry.reason === 'candidate-cap').map((entry) => entry.branchName),
    ['roadmap-2-1-2-addendum'],
  )
})

test('discovery reports git failures as errors instead of throwing', async () => {
  const surface = await loadRecoverySurface({})
  const notARepo = mkdtempSync(path.join(tmpdir(), 'df12-recovery-empty-'))

  const { candidates, errors } = await surface.discoverRecoveryCandidates(RECOVERY_ROADMAP, notARepo)
  assert.deepEqual(candidates, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /for-each-ref failed/)
})
