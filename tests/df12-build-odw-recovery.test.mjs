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

  return { root, dir, originDir, baseSha, parserWorktree, addendumWorktree }
}

// Every observable piece of durable state assess-only recovery must not touch:
// local refs, origin refs, control-checkout dirt, worktree dirt, stashes, and
// the canonical roadmap text.
function repoStateSnapshot(repo) {
  return {
    localRefs: git(repo.dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    originRefs: git(repo.originDir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    controlStatus: git(repo.dir, 'status', '--porcelain=v1'),
    worktreeStatus: repo.parserWorktree ? git(repo.parserWorktree, 'status', '--porcelain=v1') : '',
    stashes: git(repo.dir, 'stash', 'list'),
    worktrees: git(repo.dir, 'worktree', 'list', '--porcelain'),
    canonicalRoadmap: git(repo.dir, 'show', 'origin/main:docs/roadmap.md'),
  }
}

async function loadRecoverySurface(args = {}, agentImpl = async () => null) {
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
  ASSESSMENT_SCHEMA,
  RECOVERY_SKIP_REASONS,
  branchToRoadmapId,
  parseWorktreeList,
  discoverRecoveryCandidates,
  assessmentPrompt,
  recoveryAssessmentPrompt,
  assessRecoveryCandidate,
  runRecovery,
}
`,
  )
  return factory(
    args,
    () => {},
    () => {},
    agentImpl,
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

function sampleCandidate(repo) {
  return {
    taskId: '1.2.3',
    taskTitle: 'Implement the parser state machine.',
    branchName: 'roadmap-1-2-3',
    worktreePath: repo.parserWorktree,
    baseCommit: repo.baseSha,
    currentCommit: git(repo.parserWorktree, 'rev-parse', 'HEAD'),
    roadmapComplete: false,
    isAddendum: false,
    line: 5,
  }
}

function sampleAssessment(overrides = {}) {
  return {
    classification: 'adopt-complete',
    branchName: 'roadmap-1-2-3',
    worktreePath: '/tmp/wt',
    baseCommit: 'abc',
    currentCommit: 'def',
    dirtyState: 'clean',
    changedFiles: ['roadmap-1-2-3.txt'],
    taskScoped: true,
    execPlan: 'ExecPlan complete with retrospective',
    roadmap: 'task unchecked',
    validation: 'make all green at HEAD',
    missingEvidence: [],
    risks: [],
    rationale: 'complete slice',
    recommendation: 'review and integrate',
    nextActions: [],
    ...overrides,
  }
}

test('recovery and failure assessments share one ADR 002 prompt contract', async () => {
  const surface = await loadRecoverySurface({})
  const task = { id: '1.2.3', title: 'Implement the parser state machine.' }
  const evidence = { taskId: '1.2.3' }
  const failurePrompt = surface.assessmentPrompt(
    task,
    { worktreePath: '/tmp/wt' },
    { status: 'failed' },
    evidence,
  )
  const recoveryPrompt = surface.recoveryAssessmentPrompt(
    task,
    { worktreePath: '/tmp/wt', taskId: '1.2.3' },
    evidence,
  )

  const contractOf = (prompt) => {
    const start = prompt.indexOf('Use ADR 002')
    const end = prompt.indexOf('Host-collected git evidence:')
    assert.ok(start !== -1 && end > start, 'prompt should carry the ADR 002 contract block')
    return prompt.slice(start, end)
  }
  assert.equal(contractOf(recoveryPrompt), contractOf(failurePrompt))
  assert.match(recoveryPrompt, /discovered during fresh-run recovery/)
  assert.match(recoveryPrompt, /READ-ONLY recovery assessment/)
})

test('recovered candidates reuse the assessment evidence collector and schema', async () => {
  const calls = []
  const stubAgent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return sampleAssessment()
  }
  const surface = await loadRecoverySurface({}, stubAgent)
  const repo = makeRecoveryRepo()
  const candidate = sampleCandidate(repo)

  const outcome = await surface.assessRecoveryCandidate(candidate)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.schema, surface.ASSESSMENT_SCHEMA, 'recovery must reuse the ADR 002 schema object')
  assert.equal(calls[0].opts.label, 'recover-assess:1.2.3')
  assert.equal(calls[0].opts.phase, 'Recovery')
  assert.equal(outcome.assessmentError, '')
  assert.equal(outcome.assessment.classification, 'adopt-complete')
  assert.equal(outcome.evidence.taskId, '1.2.3')
  assert.equal(outcome.evidence.branchName, 'roadmap-1-2-3')
  assert.equal(outcome.evidence.baseCommit, repo.baseSha)
  assert.deepEqual(outcome.evidence.committedChanges, [{ status: 'A', path: 'roadmap-1-2-3.txt' }])
  assert.deepEqual(outcome.assessment.hostEvidence, outcome.evidence)
})

test('recovery assessment failures are reported, not thrown', async () => {
  const repo = makeRecoveryRepo()
  const candidate = sampleCandidate(repo)

  const silent = await (await loadRecoverySurface({}, async () => null)).assessRecoveryCandidate(candidate)
  assert.equal(silent.assessment, null)
  assert.match(silent.assessmentError, /no structured output/)
  assert.equal(silent.evidence.taskId, '1.2.3', 'evidence should survive an assessment failure')

  const thrown = await (
    await loadRecoverySurface({}, async () => {
      throw new Error('adapter exited with code 1')
    })
  ).assessRecoveryCandidate(candidate)
  assert.equal(thrown.assessment, null)
  assert.match(thrown.assessmentError, /adapter exited with code 1/)
})

test('discovery reports git failures as errors instead of throwing', async () => {
  const surface = await loadRecoverySurface({})
  const notARepo = mkdtempSync(path.join(tmpdir(), 'df12-recovery-empty-'))

  const { candidates, errors } = await surface.discoverRecoveryCandidates(RECOVERY_ROADMAP, notARepo)
  assert.deepEqual(candidates, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /for-each-ref failed/)
})

test('assess-only recovery returns a report-only summary and holds surviving ids', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: true }, async () => sampleAssessment())
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.fatal, null)
  assert.deepEqual(outcome.taskResults, [], 'assess-only recovery must not produce task results')
  const summary = outcome.summary
  assert.equal(summary.enabled, true)
  assert.equal(summary.mode, 'assess')
  assert.equal(summary.candidates, 1)
  assert.equal(summary.assessed, 1)
  assert.equal(summary.resumed, 0)
  assert.deepEqual(summary.errors, [])
  assert.equal(summary.results.length, 1)
  const [entry] = summary.results
  assert.equal(entry.id, '1.2.3')
  assert.equal(entry.branchName, 'roadmap-1-2-3')
  assert.equal(entry.classification, 'adopt-complete')
  assert.equal(entry.action, 'reported')
  assert.equal(entry.assessment.hostEvidence.taskId, '1.2.3')
  assert.deepEqual([...outcome.held.normal].sort(), ['1.2.3', '1.2.4'])
  assert.deepEqual([...outcome.held.addendum], [])
})

test('recovery assessment errors are reported and non-fatal for ordinary faults', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: true }, async () => {
    throw new Error('adapter exited with code 1: transient tool failure')
  })
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.fatal, null)
  assert.equal(outcome.summary.assessed, 0)
  assert.equal(outcome.summary.results[0].action, 'assessment-error')
  assert.match(outcome.summary.results[0].assessmentError, /transient tool failure/)
  assert.ok(
    outcome.summary.skipped.some(
      (entry) => entry.branchName === 'roadmap-1-2-3' && entry.reason === 'assessment-error',
    ),
  )
  assert.ok(outcome.held.normal.has('1.2.3'), 'unassessed surviving branches stay held')
})

test('auth-shaped recovery assessment failures halt the run as fatal', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: true }, async () => {
    throw new Error('401 Unauthorized: run codex login')
  })
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.ok(outcome.fatal, 'auth failures during recovery must be fatal')
  assert.equal(outcome.fatal.status, 'fatal-auth')
  assert.equal(outcome.fatal.stage, 'auth')
})

test('recovery survives an unreadable canonical roadmap', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: true }, async () => sampleAssessment())
  const notARepo = mkdtempSync(path.join(tmpdir(), 'df12-recovery-empty-'))

  const outcome = await surface.runRecovery(notARepo)

  assert.equal(outcome.fatal, null)
  assert.equal(outcome.summary.candidates, 0)
  assert.ok(outcome.summary.errors.length >= 1)
})

test('skip reasons are a stable published contract', async () => {
  const surface = await loadRecoverySurface({})
  assert.deepEqual(surface.RECOVERY_SKIP_REASONS, [
    'unmapped-branch',
    'already-complete',
    'unreadable-commit',
    'missing-worktree',
    'candidate-cap',
    'assessment-error',
  ])
})

test('assess-only recovery leaves every piece of durable git state untouched', async () => {
  const repo = makeRecoveryRepo({ withAddendumWorktree: true })
  writeFileSync(path.join(repo.parserWorktree, 'dirty.txt'), 'uncommitted operator work\n')
  const before = repoStateSnapshot(repo)

  for (const classification of ['adopt-complete', 'adopt-partial', 'continue-manual', 'discard']) {
    const surface = await loadRecoverySurface(
      { resumePartialBranches: true },
      async () => sampleAssessment({ classification }),
    )
    const outcome = await surface.runRecovery(repo.dir)

    assert.equal(outcome.summary.assessed, 2, `both candidates assessed for ${classification}`)
    assert.equal(outcome.summary.resumed, 0, 'assess-only mode never resumes')
    assert.deepEqual(outcome.taskResults, [], 'assess-only mode never produces task results')
    assert.ok(
      outcome.summary.results.every((entry) => entry.action === 'reported'),
      'assess-only mode only reports',
    )
  }

  assert.deepEqual(
    repoStateSnapshot(repo),
    before,
    'no branch tip, origin ref, roadmap text, stash, worktree, or dirty file may change',
  )
})

test('recovery marks processed only for pushed, integrated resume results', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')
  assert.match(
    source,
    new RegExp(
      String.raw`for \(const entry of outcome\.taskResults\) \{` +
        String.raw`[\s\S]*?status === 'done' && entry\.result\.integration\?\.pushed` +
        String.raw`[\s\S]*?markProcessed\(entry\.task\)`,
    ),
    'processed ids may only come from pushed integrations, never from reported assessments',
  )
})

test('control loop wires recovery ahead of normal selection', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')

  assert.match(source, /\{ title: 'Recovery' \},/, 'meta.phases should declare the Recovery lane')
  assert.match(
    source,
    /if \(RESUME_PARTIAL_BRANCHES && halted\) \{\s*recovery\.blocked = 'auth-preflight-failed'/,
    'fatal auth preflight must block recovery entirely',
  )
  assert.match(
    source,
    /if \(RESUME_PARTIAL_BRANCHES && !halted\) \{[\s\S]*?await runRecovery\(process\.cwd\(\)\)/,
    'recovery must run only when enabled and not halted',
  )
  assert.match(
    source,
    /normal: \[\.\.\.processedNormal[\s\S]*?\.\.\.recoveryHeldNormal\]/,
    'takenSnapshot must exclude recovery-held ids from normal selection',
  )
  assert.match(source, /\n  recovery,\n/, 'workflow result must expose the recovery summary')
})
