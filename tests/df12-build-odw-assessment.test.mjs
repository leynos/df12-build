// Tests for the ODW workflow's partial-branch assessment contract: the ADR
// 002 schema, failure classifiers, the assessment guard, git evidence
// collection, and runtime auth-preflight behaviour with fake CLIs on PATH.
// Helpers compile from the workflow's pre-control-loop slice (odw-testing
// skill, layer 1).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

async function loadAssessmentSurface(args = {}) {
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
  COMMIT_GATES,
  FIX_SCHEMA,
  summarizeReviewVerdict,
  summarizeFixReport,
  implementAddendumPrompt,
  collectAssessmentEvidence,
  shouldAssessFailure,
  authFailureDetail,
  providerFailureDetail,
  infrastructureFailureDetail,
  withInfraRetry,
  STAGE_ATTEMPTS,
  faultMetrics,
  fileState,
  readExecplanState,
  execplanRelPath,
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

test('ODW infrastructure faults classify distinctly from product failures', async () => {
  const surface = await loadAssessmentSurface()

  // The overnight-run shapes: a hung stream killed by the adapter hard
  // timeout, and schema-retry exhaustion after the reply channel failed.
  const rows = [
    ["unhandled agent error: adapter 'claude' timed out", true],
    ["unhandled agent error: adapter 'codex' exited with code 143", true],
    ["SchemaValidationError: adapter 'claude' did not satisfy the schema after 3 attempt(s); last problems: no JSON value found in the reply", true],
    ['AdapterExecutionError: something died', true],
    ['implementation did not reach a green state', false],
    ['reviewers not satisfied within cap', false],
    ['make test failed: the adapter pattern timed out waiting for the queue', false],
  ]
  for (const [detail, expected] of rows) {
    assert.equal(Boolean(surface.infrastructureFailureDetail(detail)), expected, detail)
  }

  const detail = "unhandled agent error: adapter 'claude' timed out"
  assert.deepEqual(surface.resultFromUnhandledAgentError('6.4.1', detail), {
    id: '6.4.1',
    status: 'infra-fault',
    stage: 'infrastructure',
    detail,
    proposals: [],
  })
  // Auth and provider classification keep precedence over the infra check.
  assert.equal(
    surface.resultFromUnhandledAgentError('6.4.1', "adapter 'claude' exited with code 1: Run codex login").status,
    'fatal-auth',
  )
  assert.equal(
    surface.resultFromUnhandledAgentError('6.4.1', "adapter 'claude' exited with code 1: API Error: 529 Overloaded, temporarily unavailable").status,
    'provider-fault',
  )
})

test('withInfraRetry retries infrastructure faults only, within the attempt cap', async () => {
  const surface = await loadAssessmentSurface()
  assert.equal(surface.STAGE_ATTEMPTS, 2)

  // Transient infra fault: one retry, then the reply lands.
  let calls = 0
  const value = await surface.withInfraRetry(async () => {
    calls += 1
    if (calls === 1) throw new Error("adapter 'claude' timed out")
    return { ok: true }
  }, 'plan:test r1')
  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 2)

  // Product failure: never retried.
  calls = 0
  await assert.rejects(
    surface.withInfraRetry(async () => {
      calls += 1
      throw new Error('reviewers found a real defect')
    }, 'plan:test r1'),
    /real defect/,
  )
  assert.equal(calls, 1)

  // Persistent infra fault: surfaces after the attempt cap.
  calls = 0
  await assert.rejects(
    surface.withInfraRetry(async () => {
      calls += 1
      throw new Error("adapter 'claude' timed out")
    }, 'plan:test r1'),
    /timed out/,
  )
  assert.equal(calls, 2)
})

test('fault metrics count retries and terminal fault classes with fixed keys', async () => {
  const surface = await loadAssessmentSurface()
  assert.deepEqual(surface.faultMetrics, { infraRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 })

  let calls = 0
  await surface.withInfraRetry(async () => {
    calls += 1
    if (calls === 1) throw new Error("adapter 'claude' timed out")
    return { ok: true }
  }, 'plan:metrics r1')
  assert.equal(surface.faultMetrics.infraRetries, 1)

  surface.resultFromUnhandledAgentError('1.1.1', "adapter 'claude' timed out")
  surface.resultFromUnhandledAgentError('1.1.1', 'API Error: 529 Overloaded, temporarily unavailable')
  surface.resultFromUnhandledAgentError('1.1.1', 'CodeRabbit auth failed')
  surface.resultFromUnhandledAgentError('1.1.1', 'make test failed: 3 assertions')
  assert.deepEqual(surface.faultMetrics, { infraRetries: 1, infraFaults: 1, providerFaults: 1, authFaults: 1 })
})

test('ExecPlan paths are contained within the worktree before any filesystem access', async () => {
  const surface = await loadAssessmentSurface()
  const worktree = '/work/tree'

  assert.deepEqual(surface.execplanRelPath(worktree, 'docs/execplans/roadmap-1-2-3.md'), {
    ok: true,
    relPath: 'docs/execplans/roadmap-1-2-3.md',
    detail: '',
  })
  assert.deepEqual(surface.execplanRelPath(worktree, '/work/tree/docs/plan.md'), {
    ok: true,
    relPath: 'docs/plan.md',
    detail: '',
  })
  // A leading-dots FILENAME is not an escape.
  assert.equal(surface.execplanRelPath(worktree, '..plan.md').ok, true)

  const escapes = [
    '../outside.md',
    'docs/../../outside.md',
    '/etc/passwd',
    '/work/tree/../tree-b/plan.md',
    '..',
    '.',
    '',
  ]
  for (const escape of escapes) {
    const contained = surface.execplanRelPath(worktree, escape)
    assert.equal(contained.ok, false, JSON.stringify(escape))
    assert.equal(contained.relPath, '')
    assert.match(contained.detail, /escapes the assigned worktree/)
  }
})

test('filesystem faults surface distinctly from absent files', async () => {
  const surface = await loadAssessmentSurface()
  const repo = makeRepo()

  assert.deepEqual(await surface.fileState('README.md', repo.dir), { ok: true, exists: true, detail: '' })
  assert.deepEqual(await surface.fileState('no-such-file.md', repo.dir), { ok: true, exists: false, detail: '' })
  // ENOTDIR (a path component is a file) still means "absent", not a fault.
  assert.deepEqual(await surface.fileState('README.md/nested.md', repo.dir), { ok: true, exists: false, detail: '' })
  // A fault the filesystem raises (here an invalid path) must NOT read as
  // "absent": the caller has to see it and fail closed.
  const fault = await surface.fileState('plan\0.md', repo.dir)
  assert.equal(fault.ok, false)
  assert.equal(fault.exists, false)
  assert.match(fault.detail, /stat failed/)

  assert.equal((await surface.readExecplanState({ worktreePath: repo.dir, execplanPath: 'no-plan.md' })).status, 'missing')
  const unreadable = await surface.readExecplanState({ worktreePath: repo.dir, execplanPath: 'plan\0.md' })
  assert.equal(unreadable.status, 'unreadable')
  assert.match(unreadable.error, /plan\0\.md/)
})

test('integration is never retried on infrastructure faults', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')
  // The push to origin/BASE is not idempotent: a hidden-success first
  // attempt re-run after an adapter death could integrate the task twice.
  assert.doesNotMatch(source, /withInfraRetry\([^\n]*integratePrompt/)
  const bareCalls = source.match(/buildLock\(\(\) => agent\(integratePrompt\(task, worktree\)/g) || []
  assert.equal(bareCalls.length, 2, 'both integrate call sites (normal and addendum) stay unwrapped')
})

test('recoverable review faults classify as deferred review issues', async () => {
  const surface = await loadAssessmentSurface()

  // The live-run shape from issue #27: a CodeRabbit 429 recorded with the
  // machine form "rate_limit" (and the log path carrying "coderabbit").
  const rows = [
    ['Second CodeRabbit review pass deferred: /tmp/coderabbit-x.out reported errorType: rate_limit, waitTime: 26 seconds, recoverable: true', true],
    ['coderabbit review returned HTTP 429; retry later', true],
    ['CodeRabbit rate-limit backoff in progress', true],
    ['CodeRabbit temporarily unavailable', true],
    ['coderabbit found 3 blocking issues', false],
    ['make test failed: rate_limit spec regression', false],
  ]
  for (const [issue, expected] of rows) {
    assert.equal(surface.isDeferredReviewIssue(issue), expected, issue)
  }
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
  // A complete, gate-green addendum blocked ONLY by a deferred/recoverable
  // review fault is a bounded operator handoff, not an assessment case
  // (issue #27).
  assert.equal(
    surface.addendumImplementationNeedsManualMerge({
      ok: false,
      gatesGreen: true,
      workItemsCompleted: 4,
      workItemsTotal: 4,
      openIssues: ['Second CodeRabbit review deferred: errorType: rate_limit, waitTime: 26 seconds'],
      summary: 'All addendum work items complete; second review pass rate limited',
    }),
    true,
  )
  assert.equal(
    surface.addendumImplementationNeedsManualMerge({
      ok: false,
      gatesGreen: false,
      workItemsCompleted: 4,
      workItemsTotal: 4,
      openIssues: ['CodeRabbit rate limit'],
      summary: 'Gates not green',
    }),
    false,
    'deferred review issues never excuse red gates',
  )
})

test('addendum deferred-review manual handoff bypasses the assessment agent', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')
  // The manual-merge-ready return must be checked BEFORE the failure branch
  // that calls attachAssessment, so a bounded deferred-review handoff can
  // never fall through into an unbounded Assess agent (issue #27).
  assert.match(
    source,
    /if \(addendumImplementationNeedsManualMerge\(impl\)\) \{[\s\S]*?status: 'manual-merge-ready'[\s\S]*?\}\s*if \(!impl \|\| !impl\.ok \|\| !impl\.gatesGreen \|\| \(openIssues\.length > 0 && !onlyDeferredReviewIssues\)\) \{\s*return await attachAssessment/,
  )
})

test('fix rounds carry a structured, mock-satisfiable evidence contract', async () => {
  const surface = await loadAssessmentSurface()

  assert.equal(surface.FIX_SCHEMA.additionalProperties, false)
  assert.deepEqual(surface.FIX_SCHEMA.required, ['gatesGreen', 'summary'])

  assert.equal(surface.summarizeReviewVerdict(null), null)
  assert.deepEqual(
    surface.summarizeReviewVerdict({ verdict: 'changes-requested', blocking: ['missing tests'], summary: 'not yet', coverage: { correctness: 'ok' } }),
    { verdict: 'changes-requested', blocking: ['missing tests'], summary: 'not yet' },
  )

  assert.equal(surface.summarizeFixReport(null), null)
  assert.deepEqual(surface.summarizeFixReport('applied fixes'), { summary: 'applied fixes' })
  assert.deepEqual(
    surface.summarizeFixReport({ gatesGreen: true, commits: ['Fix lint'], coderabbitRuns: 2, summary: 'green' }),
    { commits: ['Fix lint'], gatesGreen: true, coderabbitRuns: 2, resolved: [], openIssues: [], summary: 'green' },
  )
})

test('commit gates default to make all and honour operator overrides', async () => {
  const defaults = await loadAssessmentSurface()
  assert.deepEqual(defaults.COMMIT_GATES, ['make all'])

  const stilyagiGates = ['make check-fmt', 'make typecheck', 'make lint', 'make test']
  const surface = await loadAssessmentSurface({ commitGates: stilyagiGates })
  assert.deepEqual(surface.COMMIT_GATES, stilyagiGates)

  // The configured gate set must reach the branch agents' instructions: an
  // addendum executor on a Stilyagi-style repo is told to run the named
  // sequential gates, not to assume `make all` aggregates them (issue #28).
  const prompt = surface.implementAddendumPrompt(
    { id: '3.1.2', title: 'Doc-comment ownership', subtasks: ['3.1.2.1'], isAddendum: true },
    '/tmp/project.worktrees/roadmap-3-1-2-addendum',
  )
  for (const gate of stilyagiGates) {
    assert.ok(prompt.includes(`\`${gate}\``), `addendum prompt must name ${gate}`)
  }
  assert.match(prompt, /AGENTS\.md is authoritative for the gate set/)
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
    /const impl = await buildLock\(\(\) => withInfraRetry\(\(\) => agent\(implementPrompt\(task, worktree, plan, opts\)[\s\S]*?const authDetail = implementationAuthFailureDetail\(impl\)[\s\S]*?status: 'fatal-auth'/,
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
  assert.equal(shouldAssessFailure({ status: 'infra-fault', stage: 'infrastructure', detail: "adapter 'claude' timed out" }, wt), false)
  assert.equal(shouldAssessFailure({ status: 'failed', stage: 'implement', detail: "unhandled agent error: adapter 'claude' timed out" }, wt), false)
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
}
)
