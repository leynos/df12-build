// Tests for the ODW workflow's partial-branch assessment contract: the ADR
// 002 schema, failure classifiers, the assessment guard, git evidence
// collection, and runtime auth-preflight behaviour with fake CLIs on PATH.
// Helpers compile from the workflow's pre-control-loop slice (odw-testing
// skill, layer 1).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { makeRecoveryRepo, repoStateSnapshot, sampleAssessment } from './fixtures/recovery-repo.mjs'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

async function loadAssessmentSurface(args = {}, agentImpl = async () => null) {
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
return {
  ASSESSMENT_CLASSIFICATIONS,
  ASSESSMENT_SCHEMA,
  AUTH_REQUIRED_ADAPTERS,
  collectAssessmentEvidence,
  attachAssessment,
  commitSalvageArtefacts,
  salvageCandidateEntries,
  verifySalvageCandidate,
  shouldAssessFailure,
  authFailureDetail,
  providerFailureDetail,
  resultFromUnhandledAgentError,
  isDeferredReviewIssue,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
  addendumImplementationNeedsManualMerge,
  runAuthPreflight,
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

async function withGitIdentity(fn) {
  const previous = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  }
  process.env.GIT_AUTHOR_NAME = 'df12-test'
  process.env.GIT_AUTHOR_EMAIL = 'df12-test@example.invalid'
  process.env.GIT_COMMITTER_NAME = 'df12-test'
  process.env.GIT_COMMITTER_EMAIL = 'df12-test@example.invalid'
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
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

test('green addendum implementation contract drift is manual merge ready', async () => {
  const surface = await loadAssessmentSurface()

  assert.equal(
    surface.addendumImplementationNeedsManualMerge({
      ok: false,
      gatesGreen: true,
      workItemsCompleted: 1,
      workItemsTotal: 1,
      openIssues: [],
      summary: 'Implemented addendum and gates passed',
    }),
    true,
  )
  assert.equal(
    surface.addendumImplementationNeedsManualMerge({
      ok: false,
      gatesGreen: true,
      workItemsCompleted: 0,
      workItemsTotal: 1,
      openIssues: [],
      summary: 'Still incomplete',
    }),
    false,
  )
  assert.equal(
    surface.addendumImplementationNeedsManualMerge({
      ok: false,
      gatesGreen: true,
      workItemsCompleted: 1,
      workItemsTotal: 1,
      openIssues: ['review still pending'],
      summary: 'Implemented addendum and gates passed',
    }),
    false,
  )
})

// Runtime auth-preflight coverage: fake auth CLIs on PATH record every
// invocation, so the tests fail for reordered, inverted, or dead preflight
// code — not merely for edited source text.
function makeAuthBin({ codexOk = true, claudeOk = true, coderabbitOk = true } = {}) {
  const bin = mkdtempSync(path.join(tmpdir(), 'df12-auth-bin-'))
  const logFile = path.join(bin, 'calls.log')
  writeFileSync(logFile, '')
  const fake = (name, ok) => {
    const file = path.join(bin, name)
    const body = ok
      ? `#!/bin/sh\necho "${name} $@" >> "${logFile}"\necho "Session healthy"\nexit 0\n`
      : `#!/bin/sh\necho "${name} $@" >> "${logFile}"\necho "Not logged in"\nexit 1\n`
    writeFileSync(file, body)
    chmodSync(file, 0o755)
  }
  fake('codex', codexOk)
  fake('claude', claudeOk)
  fake('coderabbit', coderabbitOk)
  return { bin, calls: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) }
}

async function runPreflightWithFakes(args, fakes) {
  const surface = await loadAssessmentSurface(args)
  const previousPath = process.env.PATH
  process.env.PATH = `${fakes.bin}:${previousPath}`
  try {
    return await surface.runAuthPreflight()
  } finally {
    process.env.PATH = previousPath
  }
}

test('auth preflight consults Claude only when a stage routes to the claude adapter', async () => {
  const withClaude = makeAuthBin()
  const failures = await runPreflightWithFakes({}, withClaude)
  assert.deepEqual(failures, [])
  assert.deepEqual(withClaude.calls(), [
    'codex login status',
    'claude auth status',
    'coderabbit auth status',
  ])

  const codexOnly = makeAuthBin()
  const codexOnlyArgs = {
    planAdapter: 'codex',
    reviewAdapter: 'codex',
    triageAdapter: 'codex',
    assessmentAdapter: 'codex',
  }
  const codexFailures = await runPreflightWithFakes(codexOnlyArgs, codexOnly)
  assert.deepEqual(codexFailures, [])
  assert.ok(
    !codexOnly.calls().some((line) => line.startsWith('claude ')),
    'claude must not be consulted when no stage routes to it',
  )
})

test('auth preflight reports a signed-out Claude as a failure', async () => {
  const fakes = makeAuthBin({ claudeOk: false })
  const failures = await runPreflightWithFakes({}, fakes)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].tool, 'claude')
  assert.equal(failures[0].command, 'claude auth status')
  assert.match(failures[0].detail, /Not logged in/)
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
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'provider', detail: 'API Error: 529 Overloaded' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: '401 Unauthorized' }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: 'API Error: 429 rate limited' }, wt), false)
  assert.equal(
    shouldAssessFailure(
      { status: 'failed', stage: 'implement', detail: 'turn exhausted', openIssues: ['API Error: 529 Overloaded'] },
      wt,
    ),
    false,
  )
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
})

test('continue-manual assessment commits task-scoped ExecPlan salvage on the task branch only', async () => {
  const repo = makeRecoveryRepo()
  const before = repoStateSnapshot(repo)
  const reviewPath = path.join(repo.parserWorktree, 'docs', 'execplans', 'roadmap-1-2-3.review-r1.md')
  writeFileSync(reviewPath, '# Review\n\nUseful branch-local notes.\n')
  const execplanPath = path.join(repo.parserWorktree, 'docs', 'execplans', 'roadmap-1-2-3.md')
  writeFileSync(execplanPath, `${readFileSync(execplanPath, 'utf8')}\nRetrospective: preserve this note.\n`)

  const assessment = sampleAssessment({
    classification: 'continue-manual',
    branchName: 'roadmap-1-2-3',
    worktreePath: repo.parserWorktree,
    dirtyState: 'dirty',
  })
  const surface = await loadAssessmentSurface({}, async () => assessment)

  const result = await withGitIdentity(() => surface.attachAssessment(
    { id: '1.2.3', title: 'Implement the parser state machine' },
    { branch: 'roadmap-1-2-3', worktreePath: repo.parserWorktree, baseSha: repo.baseSha },
    { id: '1.2.3', status: 'failed', stage: 'plan', detail: 'schema parsing failed', worktree: repo.parserWorktree, proposals: [] },
  ))

  assert.equal(result.assessment.classification, 'continue-manual')
  assert.equal(result.salvage.enabled, true)
  assert.equal(result.salvage.eligible, true)
  assert.equal(result.salvage.branch, 'roadmap-1-2-3')
  assert.deepEqual(result.salvage.committedPaths.sort(), [
    'docs/execplans/roadmap-1-2-3.md',
    'docs/execplans/roadmap-1-2-3.review-r1.md',
  ])
  assert.match(result.salvage.commitSha, /^[0-9a-f]{40}$/)
  assert.equal(git(repo.parserWorktree, 'log', '-1', '--format=%s'), 'df12 salvage v1 task=1.2.3 kind=continue-manual')
  assert.equal(git(repo.parserWorktree, 'status', '--porcelain=v1'), '')

  const after = repoStateSnapshot(repo)
  assert.equal(after.originRefs, before.originRefs, 'salvage must not push or mutate origin refs')
  assert.equal(after.controlStatus, before.controlStatus, 'salvage must not dirty the control checkout')
  assert.equal(after.canonicalRoadmap, before.canonicalRoadmap, 'salvage must not mark roadmap state')
  assert.equal(after.stashes, before.stashes, 'salvage must not use stash state')
})

test('salvage records symlink rejection without committing the candidate', async () => {
  const repo = makeRecoveryRepo()
  const outside = mkdtempSync(path.join(tmpdir(), 'df12-salvage-target-'))
  const target = path.join(outside, 'outside.md')
  writeFileSync(target, '# Outside\n')
  const linkPath = path.join(repo.parserWorktree, 'docs', 'execplans', 'roadmap-1-2-3.review-r2.md')
  symlinkSync(target, linkPath)

  const surface = await loadAssessmentSurface({}, async () => sampleAssessment({
    classification: 'continue-manual',
    branchName: 'roadmap-1-2-3',
    worktreePath: repo.parserWorktree,
  }))

  const result = await withGitIdentity(() => surface.attachAssessment(
    { id: '1.2.3', title: 'Implement the parser state machine' },
    { branch: 'roadmap-1-2-3', worktreePath: repo.parserWorktree, baseSha: repo.baseSha },
    { id: '1.2.3', status: 'failed', stage: 'plan', detail: 'schema parsing failed', worktree: repo.parserWorktree, proposals: [] },
  ))

  assert.deepEqual(result.salvage.committedPaths, [])
  assert.equal(result.salvage.skippedPaths.length, 1)
  assert.equal(result.salvage.skippedPaths[0].path, 'docs/execplans/roadmap-1-2-3.review-r2.md')
  assert.match(result.salvage.skippedPaths[0].reason, /not a regular file/)
  assert.equal(readFileSync(target, 'utf8'), '# Outside\n')
})

test('salvage verification rejects paths escaping the worktree root', async () => {
  const repo = makeRecoveryRepo()
  const { verifySalvageCandidate } = await loadAssessmentSurface()

  const verdict = await verifySalvageCandidate(repo.parserWorktree, { path: '../outside.md', status: '??' })

  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /escapes the worktree root/)
})

test('salvage skips ineligible classifications and disabled runs', async () => {
  const repo = makeRecoveryRepo()
  mkdirSync(path.join(repo.parserWorktree, 'docs', 'execplans'), { recursive: true })
  const reviewPath = path.join(repo.parserWorktree, 'docs', 'execplans', 'roadmap-1-2-3.review-r3.md')
  writeFileSync(reviewPath, '# Review\n')

  const completeSurface = await loadAssessmentSurface({}, async () => sampleAssessment({
    classification: 'adopt-complete',
    branchName: 'roadmap-1-2-3',
    worktreePath: repo.parserWorktree,
  }))
  const complete = await withGitIdentity(() => completeSurface.attachAssessment(
    { id: '1.2.3', title: 'Implement the parser state machine' },
    { branch: 'roadmap-1-2-3', worktreePath: repo.parserWorktree, baseSha: repo.baseSha },
    { id: '1.2.3', status: 'failed', stage: 'plan', detail: 'schema parsing failed', worktree: repo.parserWorktree, proposals: [] },
  ))
  assert.equal(complete.salvage.eligible, false)
  assert.deepEqual(complete.salvage.committedPaths, [])
  assert.match(git(repo.parserWorktree, 'status', '--porcelain=v1'), /\?\? docs\/execplans\/roadmap-1-2-3\.review-r3\.md/)

  const disabledSurface = await loadAssessmentSurface({ salvageArtefacts: false }, async () => sampleAssessment({
    classification: 'continue-manual',
    branchName: 'roadmap-1-2-3',
    worktreePath: repo.parserWorktree,
  }))
  const disabled = await withGitIdentity(() => disabledSurface.attachAssessment(
    { id: '1.2.3', title: 'Implement the parser state machine' },
    { branch: 'roadmap-1-2-3', worktreePath: repo.parserWorktree, baseSha: repo.baseSha },
    { id: '1.2.3', status: 'failed', stage: 'plan', detail: 'schema parsing failed', worktree: repo.parserWorktree, proposals: [] },
  ))
  assert.equal(disabled.salvage.enabled, false)
  assert.deepEqual(disabled.salvage.committedPaths, [])
  assert.match(git(repo.parserWorktree, 'status', '--porcelain=v1'), /\?\? docs\/execplans\/roadmap-1-2-3\.review-r3\.md/)
})
