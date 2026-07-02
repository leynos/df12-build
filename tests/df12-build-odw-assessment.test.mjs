import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

async function loadAssessmentSurface() {
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
  ASSESSMENT_CLASSIFICATIONS,
  ASSESSMENT_SCHEMA,
  AUTH_REQUIRED_ADAPTERS,
  collectAssessmentEvidence,
  shouldAssessFailure,
  authFailureDetail,
  providerFailureDetail,
  resultFromUnhandledAgentError,
  isDeferredReviewIssue,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
}
`,
  )
  return factory(
    {},
    () => {},
    () => {},
    async () => null,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
}

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

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-assessment-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-m', 'Initial fixture')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'switch', '-c', 'roadmap-1-2-3')
  return { dir, baseSha, branch: 'roadmap-1-2-3' }
}

test('assessment schema exposes only ADR 002 classifications', async () => {
  const surface = await loadAssessmentSurface()

  assert.deepEqual(surface.ASSESSMENT_CLASSIFICATIONS, [
    'adopt-complete',
    'adopt-partial',
    'continue-manual',
    'discard',
  ])
  assert.deepEqual(
    surface.ASSESSMENT_SCHEMA.properties.classification.enum,
    surface.ASSESSMENT_CLASSIFICATIONS,
  )
  assert.equal(surface.ASSESSMENT_SCHEMA.additionalProperties, false)
  assert.deepEqual(surface.ASSESSMENT_SCHEMA.required, [
    'classification',
    'branchName',
    'worktreePath',
    'baseCommit',
    'currentCommit',
    'dirtyState',
    'changedFiles',
    'taskScoped',
    'execPlan',
    'roadmap',
    'validation',
    'missingEvidence',
    'risks',
    'rationale',
    'recommendation',
    'nextActions',
  ])
})

test('auth-shaped implementation issues are fatal, not deferred review', async () => {
  const surface = await loadAssessmentSurface()
  const impl = {
    ok: true,
    gatesGreen: true,
    summary: 'Implementation complete',
    openIssues: ['CodeRabbit auth failed'],
  }

  assert.equal(surface.isDeferredReviewIssue('CodeRabbit auth failed'), false)
  assert.equal(surface.hasOnlyDeferredReviewIssues(['CodeRabbit auth failed']), false)
  assert.equal(surface.hasOnlyDeferredReviewIssues(['CodeRabbit rate limit retry after 10m']), true)
  assert.equal(surface.implementationAuthFailureDetail(impl), 'Implementation complete\nCodeRabbit auth failed')
  assert.equal(surface.authFailureDetail('CodeRabbit browser login required'), 'CodeRabbit browser login required')
  assert.equal(surface.authFailureDetail('{"loggedIn":false}'), '{"loggedIn":false}')
  assert.equal(surface.AUTH_REQUIRED_ADAPTERS.has('claude'), true)
})

test('provider-shaped agent failures are retry-later infrastructure faults', async () => {
  const surface = await loadAssessmentSurface()
  const detail =
    'unhandled agent error: adapter exited with code 1: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'

  assert.equal(surface.providerFailureDetail(detail), detail)
  assert.deepEqual(surface.resultFromUnhandledAgentError('2.1.8', detail), {
    id: '2.1.8',
    status: 'provider-fault',
    stage: 'provider',
    detail,
    proposals: [],
  })
})

test('auth preflight checks Claude when routing uses the Claude adapter', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')

  assert.match(
    source,
    /if \(AUTH_REQUIRED_ADAPTERS\.has\('claude'\)\)[\s\S]*?execFileStatus\('claude', \['auth', 'status'\]\)/,
  )
  assert.match(source, /preflight passed for \$\{passed\.join\(', '\)\}/)
})

test('normal and addendum implementations gate auth before integration', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')

  assert.match(
    source,
    /if \(task\.isAddendum\)[\s\S]*?const authDetail = implementationAuthFailureDetail\(impl\)[\s\S]*?status: 'fatal-auth'/,
  )
  assert.match(
    source,
    /const impl = await buildLock\(\(\) => agent\(implementPrompt\(task, worktree, plan\)[\s\S]*?const authDetail = implementationAuthFailureDetail\(impl\)[\s\S]*?status: 'fatal-auth'/,
  )
})

test('assessment guard admits only non-auth failed or halted task branches', async () => {
  const { shouldAssessFailure } = await loadAssessmentSurface()
  const wt = {
    branch: 'roadmap-1-2-3',
    worktreePath: '/tmp/project.worktrees/roadmap-1-2-3',
    baseSha: 'abc123',
  }

  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: 'turn exhausted' }, wt), true)
  assert.equal(shouldAssessFailure({ status: 'halted', stage: 'review', detail: 'review cap' }, wt), true)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'worktree', detail: 'worktree creation failed' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'dry-run', stage: 'post-design', detail: '' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'manual-merge-ready', stage: 'review', detail: '' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'done', stage: 'integrate', detail: '' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'fatal-auth', stage: 'auth', detail: 'Run codex login' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'provider-fault', stage: 'provider', detail: 'API Error: 529 Overloaded' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: '401 Unauthorized' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: 'API Error: 429 rate limited' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: 'turn exhausted' }, null), false)
})

test('assessment evidence records committed and dirty git state', async () => {
  const { collectAssessmentEvidence } = await loadAssessmentSurface()
  const repo = makeRepo()
  writeFileSync(path.join(repo.dir, 'docs.txt'), 'committed docs\n')
  git(repo.dir, 'add', 'docs.txt')
  git(repo.dir, 'commit', '-m', 'Add docs')
  writeFileSync(path.join(repo.dir, 'dirty.txt'), 'dirty\n')
  writeFileSync(path.join(repo.dir, 'staged.txt'), 'staged\n')
  git(repo.dir, 'add', 'staged.txt')

  const evidence = await collectAssessmentEvidence(
    { id: '1.2.3', title: 'Recover partial work' },
    { branch: repo.branch, worktreePath: repo.dir, baseSha: repo.baseSha },
  )

  assert.equal(evidence.taskId, '1.2.3')
  assert.equal(evidence.branchName, repo.branch)
  assert.equal(evidence.worktreePath, repo.dir)
  assert.equal(evidence.baseCommit, repo.baseSha)
  assert.match(evidence.currentCommit, /^[0-9a-f]{40}$/)
  assert.deepEqual(evidence.committedChanges, [{ status: 'A', path: 'docs.txt' }])
  assert.deepEqual(evidence.dirtyChanges, [{ status: '??', path: 'dirty.txt' }])
  assert.deepEqual(evidence.stagedChanges, [{ status: 'A', path: 'staged.txt' }])
  assert.equal(evidence.collectionErrors.length, 0)
})

test('assessment evidence handles branches without commits after base', async () => {
  const { collectAssessmentEvidence } = await loadAssessmentSurface()
  const repo = makeRepo()
  const evidence = await collectAssessmentEvidence(
    { id: '1.2.3', title: 'Recover partial work' },
    { branch: repo.branch, worktreePath: repo.dir, baseSha: repo.baseSha },
  )

  assert.deepEqual(evidence.committedChanges, [])
  assert.deepEqual(evidence.dirtyChanges, [])
  assert.deepEqual(evidence.stagedChanges, [])
  assert.deepEqual(evidence.recentCommits, [])
  assert.equal(evidence.collectionErrors.length, 0)
}
)
