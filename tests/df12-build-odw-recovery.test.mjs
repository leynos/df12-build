// Tests for fresh-run recovery (failure-resume phases 1-2): configuration,
// candidate discovery, ADR 002 assessment reuse, the resumeMode decision
// table (including an exhaustive domain sweep), review-mode resume wiring,
// and the assess-only no-mutation guarantee, against throwaway git fixtures
// from tests/fixtures/recovery-repo.mjs.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readWorkflowSource } from './support/workflow-source.mjs'

import {
  git,
  RECOVERY_ROADMAP,
  makeFixtureDir,
  makeRecoveryRepo,
  probeDetailsFromPrompt,
  repoStateSnapshot,
  sampleAssessment,
} from './fixtures/recovery-repo.mjs'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

// Golden-file fixtures for the recovery-resume prompt contract. A tiny
// Node-only mechanism (no bun snapshot APIs, no extra test-framework dep):
// each prompt is sanitized to stable placeholders, then compared byte-for-byte
// against a committed artefact. Regenerate deliberately with
// `UPDATE_PROMPT_GOLDEN=1 node --test tests/df12-build-odw-recovery.test.mjs`.
const PROMPT_GOLDEN_DIR = new URL('./fixtures/prompts/', import.meta.url)

// Replace the per-run temporary fixture paths with stable placeholders so the
// captured prompts are deterministic across runs and machines. The worktree
// and project paths nest under root, so substitute the longer, more specific
// paths first. Kept local, explicit, and free of any other rewriting.
function sanitizePrompt(text, repo) {
  return text
    .replaceAll(repo.parserWorktree, '<WORKTREE>')
    .replaceAll(repo.dir, '<PROJECT>')
    .replaceAll(repo.root, '<FIXTURE_ROOT>')
}

// Assert a sanitized prompt equals its committed golden artefact, or rewrite the
// artefact when UPDATE_PROMPT_GOLDEN is set. Exact equality means drift ANYWHERE
// in the prompt — not only the residual-risk section — forces a deliberate
// review of the regenerated golden.
function assertPromptGolden(name, sanitized) {
  const file = new URL(`${name}.txt`, PROMPT_GOLDEN_DIR)
  if (process.env.UPDATE_PROMPT_GOLDEN) {
    mkdirSync(PROMPT_GOLDEN_DIR, { recursive: true })
    writeFileSync(file, sanitized)
    return
  }
  const expected = readFileSync(file, 'utf8')
  assert.equal(
    sanitized,
    expected,
    `${name} prompt drifted from its golden artefact; if intentional, regenerate with UPDATE_PROMPT_GOLDEN=1`,
  )
}


async function loadRecoverySurface(args = {}, agentImpl = async () => null) {
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
  RESUME_PARTIAL_BRANCHES,
  RESUME_MODE,
  RESUME_TASK_ID,
  RESUME_MAX_CANDIDATES,
  ASSESSMENT_SCHEMA,
  IMPL_SCHEMA,
  RECOVERY_SKIP_REASONS,
  recoveryResumeEligibility,
  recoveryDecision,
  parseExecplanState,
  recoveryContinueDecision,
  syntheticRecoveryImpl,
  branchToRoadmapId,
  parseWorktreeList,
  discoverRecoveryCandidates,
  assessmentPrompt,
  recoveryAssessmentPrompt,
  assessRecoveryCandidate,
  planPrompt,
  designReviewPrompt,
  implementPrompt,
  verifyExecplanCommitted,
  commitExecplanApproval,
  commitExecplanDraft,
  verifyWorktreeCommitted,
  runPlanDesignLoop,
  runImplementationStage,
  runDualReviewAndIntegration,
  runRecovery,
  computeHeldFromDiscovery,
  discoverHeldBranches,
  takenSnapshot,
  isAlreadyTaken,
  recoveryHeldNormal,
  recoveryHeldAddendum,
}
`,
  )
  return factory(
    // Host review, host gates, and the per-work-item build loop default OFF
    // here: several tests drive the pipeline against fixture repos, where
    // the host review would exec the REAL coderabbit CLI on PATH (burning
    // review quota), host gates would run `make all` in Makefile-less
    // fixtures, and the build loop expects agents to tick Progress items.
    { coderabbitHostReview: false, hostCommitGates: false, perWorkItemBuild: false, ...args },
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

test('the always-on guard holds stale branches out of selection when recovery is off (issue #33)', async () => {
  // Recovery is disabled (resumePartialBranches defaults off), so runRecovery
  // never runs. discoverHeldBranches must still surface surviving roadmap-*
  // branches so ordinary selection cannot re-open them and collide on
  // `git worktree add -b`.
  const surface = await loadRecoverySurface({})
  assert.equal(surface.RESUME_PARTIAL_BRANCHES, false)
  const repo = makeRecoveryRepo()

  const guard = await surface.discoverHeldBranches(repo.dir)
  // roadmap-1-2-4 survives with no worktree; roadmap-1-2-3 is a resumable
  // candidate. The completed branch roadmap-2-1-1 must not be held.
  assert.ok(guard.held.normal.has('1.2.4'), 'stale branch 1.2.4 should be held')
  assert.ok(guard.held.normal.has('1.2.3'), 'candidate branch 1.2.3 should be held')
  assert.equal(guard.held.normal.has('2.1.1'), false, 'completed branch must not be held')
  assert.equal(guard.held.addendum.size, 0)

  // Merge the guard result into the held sets exactly as workflowMain does when
  // recovery is off, then confirm the single selection-exclusion point
  // (takenSnapshot / isAlreadyTaken) drops the stale id.
  for (const id of guard.held.normal) surface.recoveryHeldNormal.add(id)
  for (const id of guard.held.addendum) surface.recoveryHeldAddendum.add(id)
  assert.ok(surface.takenSnapshot().normal.includes('1.2.4'))
  assert.equal(surface.isAlreadyTaken({ id: '1.2.4', isAddendum: false }), true)
  assert.equal(surface.isAlreadyTaken({ id: '2.1.1', isAddendum: false }), false)
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
  assert.deepEqual(outcome.evidence.committedChanges, [
    { status: 'A', path: 'docs/execplans/roadmap-1-2-3.md' },
    { status: 'A', path: 'roadmap-1-2-3.txt' },
  ])
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
  const notARepo = makeFixtureDir('df12-recovery-empty-')

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
  const notARepo = makeFixtureDir('df12-recovery-empty-')

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
    'worktree-probe-fault',
    'candidate-cap',
    'assessment-error',
    'addendum-branch',
    'evidence-collection-error',
    'dirty-worktree',
    'no-committed-work',
    'not-task-scoped',
    'missing-validation-evidence',
    'missing-execplan',
    'plan-blocked',
    'plan-unreadable',
    'execplan-stat-error',
    'dry-run',
  ])
})

function eligibleCandidate() {
  return {
    taskId: '1.2.3',
    branchName: 'roadmap-1-2-3',
    isAddendum: false,
    execplanPath: 'docs/execplans/roadmap-1-2-3.md',
  }
}

function eligibleEvidence(overrides = {}) {
  return {
    collectionErrors: [],
    dirtyState: 'clean',
    recentCommits: ['abc1234 Work on roadmap-1-2-3'],
    ...overrides,
  }
}

test('resume eligibility admits only clean, committed, task-scoped, validated branches', async () => {
  const surface = await loadRecoverySurface({})
  const assessment = sampleAssessment()

  assert.equal(surface.recoveryResumeEligibility(eligibleCandidate(), eligibleEvidence(), assessment), '')

  // Advisory residual risk is NOT a disqualifier: an otherwise-eligible
  // adopt-complete branch remains eligible even with non-empty residualRisk,
  // provided blocking missingEvidence stays empty (issue #23).
  assert.equal(
    surface.recoveryResumeEligibility(
      eligibleCandidate(),
      eligibleEvidence(),
      sampleAssessment({ residualRisk: ['flaky integration test observed once'] }),
    ),
    '',
  )
  // Blocking missingEvidence still disqualifies even when residualRisk is set.
  assert.equal(
    surface.recoveryResumeEligibility(
      eligibleCandidate(),
      eligibleEvidence(),
      sampleAssessment({ missingEvidence: ['no gate log'], residualRisk: ['advisory note'] }),
    ),
    'missing-validation-evidence',
  )

  const rows = [
    [{ candidate: { ...eligibleCandidate(), isAddendum: true } }, 'addendum-branch'],
    [{ evidence: eligibleEvidence({ collectionErrors: ['diff failed'] }) }, 'evidence-collection-error'],
    [{ evidence: eligibleEvidence({ dirtyState: 'dirty' }) }, 'dirty-worktree'],
    [{ evidence: eligibleEvidence({ dirtyState: 'unknown' }) }, 'dirty-worktree'],
    [{ evidence: eligibleEvidence({ recentCommits: [] }) }, 'no-committed-work'],
    [{ assessment: sampleAssessment({ taskScoped: false }) }, 'not-task-scoped'],
    // Empty/whitespace `validation` no longer disqualifies on its own — blocking
    // missingEvidence is the sole evidence-based gate now, so this stays eligible
    // (issue #23).
    [{ assessment: sampleAssessment({ validation: '   ' }) }, ''],
    [{ assessment: sampleAssessment({ missingEvidence: ['no gate log'] }) }, 'missing-validation-evidence'],
    [{ candidate: { ...eligibleCandidate(), execplanPath: '' } }, 'missing-execplan'],
  ]
  for (const [overrides, expected] of rows) {
    const verdict = surface.recoveryResumeEligibility(
      overrides.candidate || eligibleCandidate(),
      overrides.evidence || eligibleEvidence(),
      overrides.assessment || assessment,
    )
    assert.equal(verdict, expected)
  }
})

test('the resumeMode decision table reports everywhere except eligible review-mode adopt-complete', async () => {
  const surface = await loadRecoverySurface({})
  const candidate = eligibleCandidate()
  const evidence = eligibleEvidence()

  for (const classification of ['adopt-complete', 'adopt-partial', 'continue-manual', 'discard']) {
    const assessed = sampleAssessment({ classification })
    const inAssess = surface.recoveryDecision(candidate, evidence, assessed, 'assess')
    assert.deepEqual(inAssess, { action: 'report', classification, reason: '', skip: false })
    if (classification !== 'adopt-complete') {
      const inReview = surface.recoveryDecision(candidate, evidence, assessed, 'review')
      assert.deepEqual(inReview, { action: 'report', classification, reason: '', skip: false })
    }
  }

  assert.deepEqual(surface.recoveryDecision(candidate, evidence, sampleAssessment(), 'review'), {
    action: 'resume',
    classification: 'adopt-complete',
    reason: '',
    skip: false,
  })
})

// Property-style guarantee by exhaustion: the eligibility/decision domain is
// finite, so instead of sampling it (fast-check would also add a package
// dependency this repository does not have), enumerate EVERY combination and
// assert the fail-closed invariant holds at each point.
test('decision-table sweep: resume happens only when every eligibility fact holds in review mode', async () => {
  const surface = await loadRecoverySurface({})
  const dims = {
    isAddendum: [false, true],
    collectionErrors: [[], ['diff failed']],
    dirtyState: ['clean', 'dirty', 'unknown'],
    recentCommits: [['abc Work'], []],
    taskScoped: [true, false],
    validation: ['make all green', '   '],
    missingEvidence: [[], ['no gate log']],
    residualRisk: [[], ['residual note']],
    execplanPath: ['docs/execplans/roadmap-1-2-3.md', ''],
    classification: ['adopt-complete', 'adopt-partial', 'continue-manual', 'discard'],
    mode: ['assess', 'review'],
    dryRun: [false, true],
  }
  const combos = Object.entries(dims).reduce(
    (acc, [key, values]) => acc.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value }))),
    [{}],
  )

  let resumes = 0
  for (const combo of combos) {
    const candidate = { taskId: '1.2.3', branchName: 'roadmap-1-2-3', isAddendum: combo.isAddendum, execplanPath: combo.execplanPath }
    const evidence = {
      collectionErrors: combo.collectionErrors,
      dirtyState: combo.dirtyState,
      recentCommits: combo.recentCommits,
    }
    const assessment = sampleAssessment({
      classification: combo.classification,
      taskScoped: combo.taskScoped,
      validation: combo.validation,
      missingEvidence: combo.missingEvidence,
      residualRisk: combo.residualRisk,
    })
    // Eligibility depends only on blocking missingEvidence — neither advisory
    // residualRisk nor the descriptive `validation` string affects the resume
    // decision (issue #23).
    const eligible =
      !combo.isAddendum &&
      combo.collectionErrors.length === 0 &&
      combo.dirtyState === 'clean' &&
      combo.recentCommits.length > 0 &&
      combo.taskScoped === true &&
      combo.missingEvidence.length === 0 &&
      combo.execplanPath !== ''

    const decision = surface.recoveryDecision(candidate, evidence, assessment, combo.mode, { dryRun: combo.dryRun })
    const gated = combo.mode === 'review' && combo.classification === 'adopt-complete'
    const shouldResume = gated && eligible && !combo.dryRun

    assert.equal(decision.action, shouldResume ? 'resume' : 'report', JSON.stringify(combo))
    assert.equal(decision.skip, gated && !shouldResume, JSON.stringify(combo))
    assert.equal(
      decision.classification,
      gated && !eligible ? 'continue-manual' : combo.classification,
      JSON.stringify(combo),
    )
    assert.equal(decision.reason !== '', decision.skip, JSON.stringify(combo))
    if (shouldResume) resumes += 1
  }
  assert.ok(resumes > 0, 'the sweep must include the fully eligible corner')
  assert.equal(combos.length, 2 * 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2 * 4 * 2 * 2, 'the sweep must cover the whole domain')
})

test('review-mode resume fails closed: ineligible adopt-complete downgrades to continue-manual', async () => {
  const surface = await loadRecoverySurface({})

  const dirty = surface.recoveryDecision(
    eligibleCandidate(),
    eligibleEvidence({ dirtyState: 'dirty' }),
    sampleAssessment(),
    'review',
  )
  assert.deepEqual(dirty, {
    action: 'report',
    classification: 'continue-manual',
    reason: 'dirty-worktree',
    skip: true,
  })

  const dryRun = surface.recoveryDecision(eligibleCandidate(), eligibleEvidence(), sampleAssessment(), 'review', {
    dryRun: true,
  })
  assert.deepEqual(dryRun, {
    action: 'report',
    classification: 'adopt-complete',
    reason: 'dry-run',
    skip: true,
  })
})

test('synthetic recovery implementation bridges into review without faking evidence', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo({ withParserExecplan: false })
  const candidate = sampleCandidate(repo)
  const evidence = { recentCommits: ['abc1234 Work on roadmap-1-2-3'] }

  const missingPlan = await surface.syntheticRecoveryImpl(candidate, evidence)
  assert.equal(missingPlan.ok, true)
  assert.equal(missingPlan.gatesGreen, true)
  assert.equal(missingPlan.execplanPath, '', 'absent canonical plan must not be claimed')
  assert.equal(missingPlan.workItemsCompleted, 0)
  assert.equal(missingPlan.workItemsTotal, 0)
  assert.deepEqual(missingPlan.commits, ['abc1234 Work on roadmap-1-2-3'])
  assert.equal(missingPlan.coderabbitRuns, 0)
  assert.deepEqual(missingPlan.openIssues, ['recovered branch requires fresh review'])
  assert.deepEqual(missingPlan.residualRisk, [], 'residualRisk defaults to an empty carry-forward channel')
  assert.match(missingPlan.summary, /Recovered adopt-complete branch from durable git state/)

  // Advisory residual risk from the assessment is carried forward verbatim
  // (issue #23) without touching any blocking field.
  const withRisk = await surface.syntheticRecoveryImpl(candidate, evidence, ['flaky teardown seen once'])
  assert.deepEqual(withRisk.residualRisk, ['flaky teardown seen once'])
  assert.deepEqual(withRisk.openIssues, ['recovered branch requires fresh review'])

  mkdirSync(path.join(repo.parserWorktree, 'docs', 'execplans'), { recursive: true })
  writeFileSync(
    path.join(repo.parserWorktree, 'docs', 'execplans', 'roadmap-1-2-3.md'),
    '# ExecPlan\n',
  )
  const withPlan = await surface.syntheticRecoveryImpl(candidate, evidence)
  assert.equal(withPlan.execplanPath, 'docs/execplans/roadmap-1-2-3.md')

  // The synthetic report mirrors IMPL_SCHEMA, plus the host-only `residualRisk`
  // carry-forward channel that is rendered as review/integration context but is
  // never sent back to an agent under IMPL_SCHEMA.
  const allowed = new Set([...Object.keys(surface.IMPL_SCHEMA.properties), 'residualRisk'])
  for (const key of Object.keys(withPlan)) {
    assert.ok(allowed.has(key), `synthetic field ${key} must exist in IMPL_SCHEMA or be the residualRisk carry-forward`)
  }
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
  const source = await readWorkflowSource()
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

// Scripted agent for review-mode resume runs: keyed on stable labels, never
// prompt prose. Overrides let each scenario steer one role.
function reviewModeAgent(calls, overrides = {}) {
  return async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push(label)
    if (label.startsWith('write-probe:')) {
      if (overrides.writeProbe === 'ignore') return { ok: true } // claims without writing
      const details = probeDetailsFromPrompt(prompt)
      assert.ok(details, 'write-probe prompt should carry PROBE_FILE and PROBE_TOKEN')
      writeFileSync(details.file, details.token, 'utf8')
      return { ok: true }
    }
    if (label.startsWith('recover-assess:') || label.startsWith('assess:')) {
      return (overrides.assess || (async () => sampleAssessment()))(prompt, opts)
    }
    if (label.startsWith('plan:')) {
      return (overrides.plan || (async () => ({
        execplanPath: 'docs/execplans/roadmap-1-2-3.md',
        workItems: ['work item 1'],
        summary: 'plan completed and committed',
      })))(prompt, opts)
    }
    if (label.startsWith('design-review:')) {
      return (overrides.designReview || (async () => ({ satisfied: true, blocking: [] })))(prompt, opts)
    }
    if (label.startsWith('implement:')) {
      return (overrides.implement || (async () => ({
        ok: true,
        gatesGreen: true,
        execplanPath: 'docs/execplans/roadmap-1-2-3.md',
        workItemsCompleted: 1,
        workItemsTotal: 1,
        commits: ['Finish remaining work items'],
        coderabbitRuns: 1,
        openIssues: [],
        summary: 'resumed and completed the remaining work items',
      })))(prompt, opts)
    }
    if (label.startsWith('code-review:') || label.startsWith('expert-review:')) {
      return (overrides.review || (async () => ({ verdict: 'pass', blocking: [], summary: 'ship it' })))(prompt, opts)
    }
    if (label.startsWith('integrate:')) {
      return (
        overrides.integrate ||
        (async () => ({
          ok: true,
          roadmapMarkedDone: true,
          rebased: true,
          squashMerged: true,
          mergeSha: 'feedfeed',
          pushed: true,
          conflicts: '',
          summary: 'squash merged and pushed',
        }))
      )(prompt, opts)
    }
    if (label.startsWith('fix:')) return 'applied fixes'
    throw new Error(`unexpected agent label in recovery resume test: ${label}`)
  }
}

test('review-mode resume routes an eligible branch through review and integration', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.fatal, null)
  assert.equal(outcome.summary.resumed, 1)
  assert.deepEqual(
    outcome.summary.results.map((entry) => [entry.id, entry.action]),
    [['1.2.3', 'resumed']],
  )
  assert.equal(outcome.taskResults.length, 1)
  const { task, result } = outcome.taskResults[0]
  assert.equal(task.id, '1.2.3')
  assert.equal(result.status, 'done')
  assert.equal(result.kind, 'recovery-resume')
  assert.equal(result.integration.pushed, true)
  assert.equal(result.impl.summary, 'Recovered adopt-complete branch from durable git state.')
  assert.deepEqual(
    calls,
    [
      'recover-assess:1.2.3',
      'write-probe:claude',
      'write-probe:codex-medium',
      'code-review:1.2.3 r1',
      'expert-review:1.2.3 r1',
      'integrate:1.2.3',
    ],
    'resume must pass the write preflight, then use the ordinary review labels and the integration agent',
  )
})

test('review-mode resume carries advisory residualRisk into the review and integration prompts', async () => {
  const calls = []
  const prompts = { codeReview: '', expertReview: '', integrate: '' }
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls, {
      assess: async () => sampleAssessment({ residualRisk: ['telemetry counter not yet wired up'] }),
      review: async (prompt, opts) => {
        if ((opts.label || '').startsWith('code-review:')) prompts.codeReview = prompt
        else prompts.expertReview = prompt
        return { verdict: 'pass', blocking: [], summary: 'ship it' }
      },
      integrate: async (prompt) => {
        prompts.integrate = prompt
        return { ok: true, roadmapMarkedDone: true, rebased: true, squashMerged: true, mergeSha: 'feedfeed', pushed: true, conflicts: '', summary: 'squash merged and pushed' }
      },
    }),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.fatal, null)
  assert.equal(outcome.summary.resumed, 1, 'advisory residualRisk must not block the resume')
  const { result } = outcome.taskResults[0]
  assert.equal(result.status, 'done')
  // The advisory context must survive onto the synthetic impl report...
  assert.deepEqual(result.impl.residualRisk, ['telemetry counter not yet wired up'])
  // ...and be rendered as an explicitly non-blocking, injection-safe section in
  // every prompt: the item is JSON-encoded inside a fenced untrusted-data block
  // so agent-authored residual risk cannot smuggle instructions downstream.
  // These semantic assertions guard the residual-risk contract directly; the
  // golden comparison below additionally locks the WHOLE prompt so drift outside
  // this section still needs a deliberate golden update.
  const advisoryLabel = 'Advisory residual risk (non-blocking'
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text.includes(advisoryLabel), `${name} prompt must carry the advisory residual-risk section`)
    assert.ok(text.includes('"telemetry counter not yet wired up"'), `${name} prompt must list the JSON-encoded residual-risk item`)
    assert.ok(text.includes('UNTRUSTED DATA'), `${name} prompt must mark residual risk as untrusted data`)
    assert.ok(
      text.includes('----- BEGIN RESIDUAL RISK DATA (untrusted) -----'),
      `${name} prompt must fence the residual-risk data block`,
    )
  }

  // Full-prompt regression coverage: sanitize the per-run temp paths, then
  // assert exact equality against committed golden artefacts scoped to this
  // recovery-resume prompt contract.
  assertPromptGolden('recovery-resume-code-review', sanitizePrompt(prompts.codeReview, repo))
  assertPromptGolden('recovery-resume-expert-review', sanitizePrompt(prompts.expertReview, repo))
  assertPromptGolden('recovery-resume-integrate', sanitizePrompt(prompts.integrate, repo))
})

test('review-mode resume enforces the write preflight before any review agent', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls, { writeProbe: 'ignore' }),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'resume-failed')
  assert.match(entry.reason, /writable-root preflight failed/)
  assert.equal(outcome.taskResults[0].result.status, 'failed')
  assert.equal(outcome.taskResults[0].result.stage, 'worktree-write')
  assert.ok(
    !calls.some((label) => label.startsWith('code-review:') || label.startsWith('integrate:')),
    'no review or integration agent may run when the write probe fails',
  )
})

test('review-mode resume requires a durable ExecPlan and never fabricates one', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo({ withParserExecplan: false })

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  assert.deepEqual(outcome.taskResults, [])
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'reported')
  assert.equal(entry.classification, 'continue-manual')
  assert.equal(entry.reason, 'missing-execplan')
  assert.deepEqual(calls, ['recover-assess:1.2.3'], 'no probe, review, or integration spend without a plan')
})

test('review-mode resume skips a dirty branch with an explicit reason and no review spend', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo()
  writeFileSync(path.join(repo.parserWorktree, 'dirty.txt'), 'uncommitted\n')

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  assert.deepEqual(outcome.taskResults, [])
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'reported')
  assert.equal(entry.classification, 'continue-manual', 'ineligible adopt-complete must fail closed')
  assert.equal(entry.reason, 'dirty-worktree')
  assert.ok(
    outcome.summary.skipped.some(
      (skip) => skip.branchName === 'roadmap-1-2-3' && skip.reason === 'dirty-worktree',
    ),
  )
  assert.deepEqual(calls, ['recover-assess:1.2.3'], 'no review or integration agents may run')
})

test('review-mode resume reports non-adopt-complete classifications without spending review effort', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review' },
    reviewModeAgent(calls, {
      assess: async () => sampleAssessment({ classification: 'adopt-partial' }),
    }),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  assert.deepEqual(outcome.taskResults, [])
  assert.deepEqual(
    outcome.summary.results.map((entry) => [entry.classification, entry.action]),
    [['adopt-partial', 'reported']],
  )
  assert.deepEqual(calls, ['recover-assess:1.2.3'])
})

test('a failed resume review halts the branch without integration', async () => {
  const calls = []
  const assessPrompts = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review', maxReviewRounds: 2 },
    reviewModeAgent(calls, {
      review: async () => ({ verdict: 'changes-requested', blocking: ['recovered slice misses the success criterion'], summary: 'not shippable' }),
      assess: async (prompt) => {
        assessPrompts.push(prompt)
        return sampleAssessment()
      },
    }),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'resume-failed')
  const haltedResult = outcome.taskResults[0].result
  assert.equal(haltedResult.status, 'halted')
  assert.equal(haltedResult.stage, 'review')
  assert.match(haltedResult.detail, /Final blocking items: recovered slice misses the success criterion/)
  assert.ok(
    calls.includes('assess:1.2.3'),
    'a failed resume must be re-assessed with current branch evidence, not the stale pre-resume assessment',
  )
  assert.equal(haltedResult.assessment.classification, 'adopt-complete')
  assert.ok(
    haltedResult.assessment.hostEvidence,
    'the refreshed assessment carries newly collected host evidence',
  )
  // The halted outcome records each review round and the fix agent's
  // structured report, and that evidence reaches the fresh assessment prompt
  // together with the freshness rules (issue #24).
  assert.equal(haltedResult.reviewRounds.length, 2)
  assert.equal(haltedResult.reviewRounds[0].codeReview.verdict, 'changes-requested')
  assert.deepEqual(haltedResult.reviewRounds[0].fix, { summary: 'applied fixes' })
  assert.equal(haltedResult.reviewRounds[1].fix, null, 'no fix round after the final review round')
  const finalAssessPrompt = assessPrompts.filter((prompt) => prompt.includes('after a workflow failure')).pop()
  assert.ok(finalAssessPrompt, 'the fresh post-resume assessment prompt must exist')
  assert.match(finalAssessPrompt, /"reviewRounds"/)
  assert.match(finalAssessPrompt, /Evidence freshness rules:/)
  assert.ok(!calls.some((label) => label.startsWith('integrate:')), 'no integration after a failed review')
})

test('autoMerge=false resume stops at manual-merge-ready instead of integrating', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'review', autoMerge: false },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo()

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  assert.deepEqual(
    outcome.summary.results.map((entry) => entry.action),
    ['manual-merge-ready'],
  )
  assert.equal(outcome.taskResults[0].result.status, 'manual-merge-ready')
  assert.ok(!calls.some((label) => label.startsWith('integrate:')))
})

// --- Continue mode: the committed ExecPlan is the durable source of truth ---

test('the ExecPlan parser reads the status vocabulary the prompts require', async () => {
  const surface = await loadRecoverySurface({})

  const rows = [
    ['Status: DRAFT', 'draft'],
    ['Status: APPROVED', 'approved'],
    ['Status: IN PROGRESS', 'in-progress'],
    ['Status: In Progress', 'in-progress'],
    ['Status: BLOCKED', 'blocked'],
    ['Status: COMPLETE', 'complete'],
    ['Status: DRAFT | APPROVED | IN PROGRESS | BLOCKED | COMPLETE', 'unknown'],
    ['Status: SHIPPED', 'unknown'],
    ['no status line at all', 'unknown'],
  ]
  for (const [text, expected] of rows) {
    assert.equal(surface.parseExecplanState(text).status, expected, text)
  }

  const withProgress = surface.parseExecplanState(
    ['Status: IN PROGRESS', '', '## Progress', '', '- [x] (2026-07-01) Done step.', '- [ ] Remaining step.', '- [ ] Another remaining step.', '', '## Decision log', '', '- [ ] not a progress tick'].join('\n'),
  )
  assert.equal(withProgress.ticked, 1)
  assert.equal(withProgress.unticked, 2)
  // The work-item build loop dispatches from this list, in order.
  assert.deepEqual(withProgress.items, [
    { text: '(2026-07-01) Done step.', ticked: true },
    { text: 'Remaining step.', ticked: false },
    { text: 'Another remaining step.', ticked: false },
  ])
  assert.deepEqual(surface.parseExecplanState('Status: DRAFT\n\nno progress section').items, [])
})

test('the continue-mode decision table dispatches on the committed ExecPlan Status', async () => {
  const surface = await loadRecoverySurface({})
  const candidate = eligibleCandidate()
  const evidence = eligibleEvidence()
  const plan = (status) => ({ status, ticked: 0, unticked: 0 })

  const rows = [
    [plan('missing'), 'plan'],
    [plan('draft'), 'plan'],
    [plan('unknown'), 'plan'],
    [plan('approved'), 'implement'],
    [plan('in-progress'), 'implement'],
    [plan('complete'), 'review'],
  ]
  for (const [planState, stage] of rows) {
    assert.deepEqual(
      surface.recoveryContinueDecision(candidate, evidence, planState, {}),
      { action: 'resume', stage, reason: '', skip: false },
      planState.status,
    )
  }

  const reports = [
    [{ candidate: { ...candidate, isAddendum: true } }, plan('draft'), 'addendum-branch'],
    [{ evidence: eligibleEvidence({ collectionErrors: ['diff failed'] }) }, plan('draft'), 'evidence-collection-error'],
    [{ evidence: eligibleEvidence({ dirtyState: 'dirty' }) }, plan('approved'), 'dirty-worktree'],
    [{}, plan('blocked'), 'plan-blocked'],
    [{}, { ...plan('unreadable'), error: 'docs/execplans/roadmap-1-2-3.md: EACCES' }, 'plan-unreadable'],
    [{ evidence: eligibleEvidence({ recentCommits: [] }) }, plan('complete'), 'no-committed-work'],
  ]
  for (const [overrides, planState, reason] of reports) {
    const decision = surface.recoveryContinueDecision(
      overrides.candidate || candidate,
      overrides.evidence || evidence,
      planState,
      {},
    )
    assert.equal(decision.action, 'report', reason)
    assert.equal(decision.reason, reason)
    assert.equal(decision.skip, true)
  }

  assert.deepEqual(surface.recoveryContinueDecision(candidate, evidence, plan('draft'), { dryRun: true }), {
    action: 'report',
    stage: 'plan',
    reason: 'dry-run',
    skip: true,
  })
})

test('the prompt status vocabulary matches the continue-mode parser contract', async () => {
  const surface = await loadRecoverySurface({})
  const task = { id: '1.2.3', title: 'Implement the parser state machine.' }
  const plan = { execplanPath: 'docs/execplans/roadmap-1-2-3.md' }

  const planPrompt = surface.planPrompt(task, '/tmp/wt', null, 1)
  assert.match(planPrompt, /COMMIT the ExecPlan/)
  assert.match(planPrompt, /`DRAFT`/)
  assert.match(surface.planPrompt(task, '/tmp/wt', null, 1, { resume: true }), /^RESUME:/m)
  assert.doesNotMatch(planPrompt, /^RESUME:/m)

  const reviewPrompt = surface.designReviewPrompt(task, '/tmp/wt', plan, 1)
  assert.match(reviewPrompt, /`APPROVED`/)

  const buildPrompt = surface.implementPrompt(task, '/tmp/wt', plan)
  assert.match(buildPrompt, /`IN PROGRESS`/)
  assert.match(buildPrompt, /`COMPLETE`/)
  assert.match(surface.implementPrompt(task, '/tmp/wt', plan, { resume: true }), /^RESUME:/m)
  assert.doesNotMatch(buildPrompt, /^RESUME:/m)

  // Every status token the prompts instruct agents to write must round-trip
  // through the parser to the stage continue mode dispatches on.
  for (const [token, parsed] of [
    ['DRAFT', 'draft'],
    ['APPROVED', 'approved'],
    ['IN PROGRESS', 'in-progress'],
    ['BLOCKED', 'blocked'],
    ['COMPLETE', 'complete'],
  ]) {
    assert.equal(surface.parseExecplanState(`Status: ${token}`).status, parsed)
  }
})

test('continue mode resumes a draft-plan branch at the plan stage with no judgement agent', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'continue' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.fatal, null)
  assert.equal(outcome.summary.resumed, 1)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'resumed')
  assert.equal(entry.resumeStage, 'plan')
  assert.equal(entry.planStatus, 'draft')
  assert.equal(outcome.taskResults[0].result.status, 'done')
  assert.equal(outcome.taskResults[0].result.kind, 'recovery-resume')
  assert.ok(!calls.some((label) => label.startsWith('recover-assess:')), 'continue mode spawns no judgement agent')
  assert.deepEqual(calls, [
    'write-probe:claude',
    'write-probe:codex-medium',
    'plan:1.2.3 r1',
    'design-review:1.2.3 r1',
    'implement:1.2.3',
    'code-review:1.2.3 r1',
    'expert-review:1.2.3 r1',
    'integrate:1.2.3',
  ])
})

test('continue mode resumes an approved-plan branch at the implement stage', async () => {
  const calls = []
  const prompts = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'continue' },
    reviewModeAgent(calls, {
      implement: async (prompt) => {
        prompts.push(prompt)
        return {
          ok: true,
          gatesGreen: true,
          execplanPath: 'docs/execplans/roadmap-1-2-3.md',
          workItemsCompleted: 2,
          workItemsTotal: 2,
          commits: ['Finish remaining work items'],
          coderabbitRuns: 1,
          openIssues: [],
          summary: 'resumed and completed the remaining work items',
        }
      },
    }),
  )
  const repo = makeRecoveryRepo({
    parserExecplanStatus: 'IN PROGRESS',
    parserExecplanProgress: ['- [x] (2026-07-04) First work item.', '- [ ] Second work item.'],
  })

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 1)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'resumed')
  assert.equal(entry.resumeStage, 'implement')
  assert.equal(entry.planStatus, 'in-progress')
  assert.ok(
    !calls.some((label) => label.startsWith('plan:') || label.startsWith('design-review:')),
    'an approved plan must not be re-planned',
  )
  assert.ok(calls.includes('implement:1.2.3'))
  assert.match(prompts[0], /^RESUME:/m, 'the resumed builder is told the committed ExecPlan is the source of truth')
})

test('continue mode routes a complete-plan branch straight to review and integration', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'continue' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo() // fixture ExecPlan Status: COMPLETE

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 1)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'resumed')
  assert.equal(entry.resumeStage, 'review')
  assert.equal(entry.planStatus, 'complete')
  assert.ok(
    !calls.some((label) => label.startsWith('plan:') || label.startsWith('implement:')),
    'a complete plan re-enters at review, not implementation',
  )
  assert.ok(calls.includes('code-review:1.2.3 r1'))
  assert.ok(calls.includes('integrate:1.2.3'))
})

test('continue mode reports a BLOCKED plan for the operator without spending agents', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'continue' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'BLOCKED' })

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  assert.deepEqual(outcome.taskResults, [])
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'reported')
  assert.equal(entry.reason, 'plan-blocked')
  assert.equal(entry.planStatus, 'blocked')
  assert.ok(
    outcome.summary.skipped.some(
      (skip) => skip.branchName === 'roadmap-1-2-3' && skip.reason === 'plan-blocked',
    ),
  )
  assert.deepEqual(calls, [], 'a blocked plan is pure operator work')
})

test('continue mode reports a dirty survivor fail-closed like the other modes', async () => {
  const calls = []
  const surface = await loadRecoverySurface(
    { resumePartialBranches: true, resumeMode: 'continue' },
    reviewModeAgent(calls),
  )
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })
  writeFileSync(path.join(repo.parserWorktree, 'dirty.txt'), 'uncommitted draft plan work\n')

  const outcome = await surface.runRecovery(repo.dir)

  assert.equal(outcome.summary.resumed, 0)
  const [entry] = outcome.summary.results
  assert.equal(entry.action, 'reported')
  assert.equal(entry.reason, 'dirty-worktree')
  assert.deepEqual(calls, [], 'no agent spend on a dirty worktree')
})

// --- Host-enforced ExecPlan durability gates ---

const PARSER_PLAN = 'docs/execplans/roadmap-1-2-3.md'

test('the durability check accepts only a plan committed clean at HEAD', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })

  assert.deepEqual(await surface.verifyExecplanCommitted(repo.parserWorktree, PARSER_PLAN), { ok: true, detail: '' })

  writeFileSync(path.join(repo.parserWorktree, PARSER_PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nrevised but uncommitted\n')
  const dirty = await surface.verifyExecplanCommitted(repo.parserWorktree, PARSER_PLAN)
  assert.equal(dirty.ok, false)
  assert.match(dirty.detail, /uncommitted modifications/)

  const untracked = await surface.verifyExecplanCommitted(repo.parserWorktree, 'docs/execplans/never-committed.md')
  assert.equal(untracked.ok, false)
  assert.match(untracked.detail, /not committed at HEAD/)
})

test('the approval flip is host-committed, path-scoped, and idempotent', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })
  // Unrelated dirt must survive the approval commit untouched.
  writeFileSync(path.join(repo.parserWorktree, 'unrelated-dirt.txt'), 'agent scratch\n')

  const flipped = await surface.commitExecplanApproval(repo.parserWorktree, PARSER_PLAN, '1.2.3')
  assert.equal(flipped.ok, true, flipped.detail)
  const committed = git(repo.parserWorktree, 'show', `HEAD:${PARSER_PLAN}`)
  assert.match(committed, /^Status: APPROVED$/m)
  assert.match(git(repo.parserWorktree, 'log', '-1', '--format=%s'), /Approve ExecPlan for task 1\.2\.3/)
  assert.match(
    git(repo.parserWorktree, 'status', '--porcelain=v1'),
    /unrelated-dirt\.txt/,
    'the approval commit must not sweep unrelated files',
  )

  const again = await surface.commitExecplanApproval(repo.parserWorktree, PARSER_PLAN, '1.2.3')
  assert.equal(again.ok, true)
  assert.match(again.detail, /already committed/)
})

test('the draft salvage commit is path-scoped and declines foreign dirt', async () => {
  const surface = await loadRecoverySurface({})
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })
  const worktree = repo.parserWorktree

  // Clean tree: nothing to salvage.
  const clean = await surface.commitExecplanDraft(worktree, PARSER_PLAN, '1.2.3')
  assert.equal(clean.ok, false)
  assert.match(clean.detail, /already clean/)

  // Plan-only dirt: the host commits it, path-scoped, hermetic identity.
  writeFileSync(path.join(worktree, PARSER_PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nrevised but uncommitted\n')
  const salvaged = await surface.commitExecplanDraft(worktree, PARSER_PLAN, '1.2.3')
  assert.equal(salvaged.ok, true, salvaged.detail)
  assert.match(git(worktree, 'log', '-1', '--format=%s'), /Draft ExecPlan for task 1\.2\.3/)
  assert.match(git(worktree, 'show', `HEAD:${PARSER_PLAN}`), /revised but uncommitted/)
  assert.equal(git(worktree, 'status', '--porcelain=v1'), '')

  // Foreign dirt alongside the plan: declined, with the paths as evidence.
  writeFileSync(path.join(worktree, PARSER_PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nsecond revision\n')
  writeFileSync(path.join(worktree, 'scratch.txt'), 'planner scratch\n')
  const declined = await surface.commitExecplanDraft(worktree, PARSER_PLAN, '1.2.3')
  assert.equal(declined.ok, false)
  assert.match(declined.detail, /beyond the plan file/)
  assert.match(declined.detail, /scratch\.txt/)
  assert.doesNotMatch(git(worktree, 'log', '-1', '--format=%s'), /second/, 'a declined salvage commits nothing')
})

test('the plan loop host-commits a plan-only dirty draft without spending a round', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })
  const worktree = repo.parserWorktree
  // The observed live failure: the planner revises the plan on disk but does
  // not commit. With only the plan dirty, durability is host bookkeeping.
  writeFileSync(path.join(worktree, PARSER_PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nrevised draft\n')

  const labels = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    if (opts.label?.startsWith('plan:')) return { execplanPath: PARSER_PLAN, workItems: ['w1'], summary: 'plan' }
    if (opts.label?.startsWith('design-review:')) return { satisfied: true, blocking: [] }
    throw new Error(`unexpected label: ${opts.label}`)
  }
  const gated = await loadRecoverySurface({}, agentImpl)

  const outcome = await gated.runPlanDesignLoop({ id: '1.2.3', title: 'Parser' }, worktree)

  assert.ok(!outcome.fail, JSON.stringify(outcome.fail || {}))
  assert.deepEqual(labels, ['plan:1.2.3 r1', 'design-review:1.2.3 r1'], 'no planner round is spent on bookkeeping')
  assert.match(git(worktree, 'show', `HEAD:${PARSER_PLAN}`), /^Status: APPROVED$/m, 'approval leaves a committed APPROVED status')
})

test('the plan loop bounces an uncommitted plan with foreign dirt back to the planner', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'DRAFT' })
  const worktree = repo.parserWorktree
  // Dirty plan PLUS other uncommitted work: the host must not guess, so the
  // bounce reaches the planner carrying the salvage-refusal evidence.
  writeFileSync(path.join(worktree, PARSER_PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nrevised draft\n')
  writeFileSync(path.join(worktree, 'half-done.txt'), 'uncommitted planner side effect\n')

  const planPrompts = []
  const labels = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    if (opts.label?.startsWith('plan:')) {
      planPrompts.push(prompt)
      if (planPrompts.length === 2) {
        git(worktree, 'add', '--all')
        git(worktree, 'commit', '-m', 'Revise parser ExecPlan and commit side effects')
      }
      return { execplanPath: PARSER_PLAN, workItems: ['w1'], summary: 'plan' }
    }
    if (opts.label?.startsWith('design-review:')) return { satisfied: true, blocking: [] }
    throw new Error(`unexpected label: ${opts.label}`)
  }
  const gated = await loadRecoverySurface({}, agentImpl)

  const outcome = await gated.runPlanDesignLoop({ id: '1.2.3', title: 'Parser' }, worktree)

  assert.ok(!outcome.fail, JSON.stringify(outcome.fail || {}))
  assert.deepEqual(labels, ['plan:1.2.3 r1', 'plan:1.2.3 r2', 'design-review:1.2.3 r2'])
  assert.match(planPrompts[1], /EXECPLAN DURABILITY/, 'the bounce reaches the planner as a blocking item')
  assert.match(planPrompts[1], /host salvage declined/, 'the bounce carries the salvage-refusal evidence')
  assert.match(planPrompts[1], /half-done\.txt/, 'the foreign dirty path is named for the planner')
  assert.match(
    git(worktree, 'show', `HEAD:${PARSER_PLAN}`),
    /^Status: APPROVED$/m,
    'approval leaves a committed APPROVED status',
  )
})

test('host-run CodeRabbit findings drive a fix round through the real CLI seam', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'COMPLETE' })
  const worktree = repo.parserWorktree

  // Fake coderabbit on PATH: one major finding on the first review, clean on
  // the re-review after the fix round. NDJSON matches the pinned contract.
  const bin = mkdtempSync(path.join(tmpdir(), 'df12-cr-bin-'))
  const countFile = path.join(bin, 'count')
  writeFileSync(path.join(bin, 'coderabbit'), [
    '#!/bin/sh',
    `count_file="${countFile}"`,
    'n=$(cat "$count_file" 2>/dev/null || echo 0)',
    'n=$((n+1)); echo $n > "$count_file"',
    'if [ "$n" -eq 1 ]; then',
    `  echo '{"type":"finding","severity":"major","fileName":"src/a.rs","comment":"guard the index"}'`,
    `  echo '{"type":"complete","status":"reviewed","findings":1}'`,
    'else',
    `  echo '{"type":"complete","status":"reviewed","findings":0}'`,
    'fi',
    '',
  ].join('\n'))
  chmodSync(path.join(bin, 'coderabbit'), 0o755)

  const labels = []
  const fixPrompts = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    if (opts.label?.startsWith('code-review:') || opts.label?.startsWith('expert-review:')) {
      return { verdict: 'pass', blocking: [], summary: 'ship it' }
    }
    if (opts.label?.startsWith('fix:')) {
      fixPrompts.push(prompt)
      return { gatesGreen: true, commits: ['Guard the index'], coderabbitRuns: 0, resolved: ['guard'], openIssues: [], summary: 'fixed' }
    }
    if (opts.label?.startsWith('integrate:')) {
      return { ok: true, roadmapMarkedDone: true, rebased: true, squashMerged: true, mergeSha: 'feed', pushed: true, conflicts: '', summary: 'merged' }
    }
    throw new Error(`unexpected label: ${opts.label}`)
  }
  const surface = await loadRecoverySurface({ coderabbitHostReview: true }, agentImpl)

  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  let outcome
  try {
    outcome = await surface.runDualReviewAndIntegration(
      { id: '1.2.3', title: 'Parser' },
      worktree,
      { execplanPath: PARSER_PLAN },
      { ok: true, gatesGreen: true },
      null,
    )
  } finally {
    process.env.PATH = previousPath
  }

  assert.equal(outcome.status, 'done', JSON.stringify(outcome))
  assert.equal(readFileSync(countFile, 'utf8').trim(), '2', 'the committed diff is re-reviewed after the fix round')
  assert.ok(labels.some((label) => label.startsWith('fix:1.2.3 r1')), 'the CodeRabbit finding forces a fix round')
  assert.match(fixPrompts[0], /CodeRabbit \(major\) src\/a\.rs: guard the index/, 'the fix agent sees the finding verbatim')
  assert.equal(outcome.openIssues, undefined, 'no deferred-review issue on a clean pass')
})

test('a red host gate drives a fix round before any reviewer agent spends tokens', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'COMPLETE' })
  const worktree = repo.parserWorktree

  // Fake gate: red on the first run, green on the re-run after the fix.
  const bin = mkdtempSync(path.join(tmpdir(), 'df12-gate-bin-'))
  const countFile = path.join(bin, 'count')
  const gateScript = path.join(bin, 'gate.sh')
  writeFileSync(gateScript, [
    '#!/bin/sh',
    `count_file="${countFile}"`,
    'n=$(cat "$count_file" 2>/dev/null || echo 0)',
    'n=$((n+1)); echo $n > "$count_file"',
    'if [ "$n" -eq 1 ]; then',
    '  echo "test_parser_range FAILED: expected 3, got 2"',
    '  exit 1',
    'fi',
    'echo "all gates green"',
    '',
  ].join('\n'))
  chmodSync(gateScript, 0o755)

  const labels = []
  const fixPrompts = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    if (opts.label?.startsWith('code-review:') || opts.label?.startsWith('expert-review:')) {
      return { verdict: 'pass', blocking: [], summary: 'ship it' }
    }
    if (opts.label?.startsWith('fix:')) {
      fixPrompts.push(prompt)
      return { gatesGreen: true, commits: ['Fix the range check'], coderabbitRuns: 0, resolved: [], openIssues: [], summary: 'fixed' }
    }
    if (opts.label?.startsWith('integrate:')) {
      return { ok: true, roadmapMarkedDone: true, rebased: true, squashMerged: true, mergeSha: 'feed', pushed: true, conflicts: '', summary: 'merged' }
    }
    throw new Error(`unexpected label: ${opts.label}`)
  }
  const surface = await loadRecoverySurface({ hostCommitGates: true, commitGates: [gateScript] }, agentImpl)

  const outcome = await surface.runDualReviewAndIntegration(
    { id: '1.2.3', title: 'Parser' },
    worktree,
    { execplanPath: PARSER_PLAN },
    { ok: true, gatesGreen: true },
    null,
  )

  assert.equal(outcome.status, 'done', JSON.stringify(outcome))
  assert.equal(readFileSync(countFile, 'utf8').trim(), '2', 'the gates re-run after the fix round')
  assert.equal(labels[0], 'fix:1.2.3 r1', 'the red gate reaches a fix agent before any reviewer runs')
  assert.ok(!labels.slice(0, 1).some((label) => label.startsWith('code-review:')), 'no reviewer tokens spent on a red branch')
  assert.match(fixPrompts[0], /HOST GATES RED/, 'the fix agent sees the host verdict')
  assert.match(fixPrompts[0], /test_parser_range FAILED/, 'the fix agent sees the gate output tail')
})

// Tick the first unticked Progress item of the fixture plan and commit it,
// as a compliant per-work-item builder would.
function tickFirstProgressItem(worktree) {
  const planPath = path.join(worktree, PARSER_PLAN)
  const text = readFileSync(planPath, 'utf8')
  writeFileSync(planPath, text.replace('- [ ] ', '- [x] '))
  git(worktree, 'add', PARSER_PLAN)
  git(worktree, 'commit', '-m', 'Complete a work item')
}

test('the work-item build loop dispatches one builder turn per unticked item', async () => {
  const repo = makeRecoveryRepo({
    parserExecplanStatus: 'APPROVED',
    parserExecplanProgress: ['- [ ] WI-1: Add the parser state machine.', '- [ ] WI-2: Add the behavioural tests.'],
  })
  const worktree = repo.parserWorktree

  const labels = []
  const prompts = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    prompts.push(prompt)
    if (!opts.label?.startsWith('implement:')) throw new Error(`unexpected label: ${opts.label}`)
    tickFirstProgressItem(worktree)
    return { ok: true, gatesGreen: true, execplanPath: PARSER_PLAN, workItemsCompleted: 1, workItemsTotal: 2, commits: [`Complete ${opts.label}`], coderabbitRuns: 0, openIssues: [], summary: 'work item done' }
  }
  const surface = await loadRecoverySurface({ perWorkItemBuild: true }, agentImpl)

  const outcome = await surface.runImplementationStage({ id: '1.2.3', title: 'Parser' }, worktree, { execplanPath: PARSER_PLAN })

  assert.ok(outcome.impl, JSON.stringify(outcome.fail || {}))
  assert.deepEqual(labels, ['implement:1.2.3 wi1', 'implement:1.2.3 wi2'])
  assert.match(prompts[0], /EXACTLY ONE work item/)
  assert.match(prompts[0], /WI-1: Add the parser state machine\./)
  assert.match(prompts[1], /WI-2: Add the behavioural tests\./)
  assert.equal(outcome.impl.workItemsCompleted, 2)
  assert.equal(outcome.impl.workItemsTotal, 2)
  assert.deepEqual(outcome.impl.commits, ['Complete implement:1.2.3 wi1', 'Complete implement:1.2.3 wi2'])
})

test('a builder that never commits a tick is bounced once, then failed', async () => {
  const repo = makeRecoveryRepo({
    parserExecplanStatus: 'APPROVED',
    parserExecplanProgress: ['- [ ] WI-1: Add the parser state machine.'],
  })
  const worktree = repo.parserWorktree

  const prompts = []
  const agentImpl = async (prompt, opts = {}) => {
    prompts.push(prompt)
    if (!opts.label?.startsWith('implement:')) throw new Error(`unexpected label: ${opts.label}`)
    // Claims success but commits nothing: the committed plan cannot move.
    return { ok: true, gatesGreen: true, execplanPath: PARSER_PLAN, summary: 'claims done' }
  }
  const surface = await loadRecoverySurface({ perWorkItemBuild: true }, agentImpl)

  const outcome = await surface.runImplementationStage({ id: '1.2.3', title: 'Parser' }, worktree, { execplanPath: PARSER_PLAN })

  assert.ok(outcome.fail, 'two no-progress turns must fail the stage')
  assert.equal(outcome.fail.stage, 'implement')
  assert.match(outcome.fail.detail, /no committed ExecPlan progress in two consecutive turns/)
  assert.equal(prompts.length, 2)
  assert.doesNotMatch(prompts[0], /PREVIOUS TURN DEFECT/)
  assert.match(prompts[1], /PREVIOUS TURN DEFECT/, 'the bounce reaches the second turn as evidence')
  assert.match(prompts[1], /tick the work item you completed/)
})

test('a plan without a Progress checklist falls back to the single-turn build', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'APPROVED' })
  const worktree = repo.parserWorktree

  const labels = []
  const agentImpl = async (prompt, opts = {}) => {
    labels.push(opts.label || '')
    return { ok: true, gatesGreen: true, execplanPath: PARSER_PLAN, workItemsCompleted: 1, workItemsTotal: 1, summary: 'done in one turn' }
  }
  const surface = await loadRecoverySurface({ perWorkItemBuild: true }, agentImpl)

  const outcome = await surface.runImplementationStage({ id: '1.2.3', title: 'Parser' }, worktree, { execplanPath: PARSER_PLAN })

  assert.ok(outcome.impl, JSON.stringify(outcome.fail || {}))
  assert.deepEqual(labels, ['implement:1.2.3'], 'no wi-suffixed turns without a checklist')
})

test('the planner prompt pins the WI checklist convention the loop dispatches from', async () => {
  const surface = await loadRecoverySurface({})
  const prompt = surface.planPrompt({ id: '1.2.3', title: 'Parser' }, '/tmp/wt', null, 1)
  assert.match(prompt, /- \[ \] WI-<n>: <imperative title>/)
  assert.match(prompt, /dispatch the build one work item at a time/)
})

test('a green implementation that leaves uncommitted state fails the durability gate', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'APPROVED' })
  const worktree = repo.parserWorktree
  const agentImpl = async (prompt, opts = {}) => {
    if (opts.label?.startsWith('implement:')) {
      // A builder that claims success while leaving work uncommitted.
      writeFileSync(path.join(worktree, 'uncommitted-work.txt'), 'not committed\n')
      return { ok: true, gatesGreen: true, execplanPath: PARSER_PLAN, workItemsCompleted: 1, workItemsTotal: 1, summary: 'claims done' }
    }
    throw new Error(`unexpected label: ${opts.label}`)
  }
  const surface = await loadRecoverySurface({}, agentImpl)

  const outcome = await surface.runImplementationStage(
    { id: '1.2.3', title: 'Parser' },
    worktree,
    { execplanPath: PARSER_PLAN },
  )

  assert.ok(outcome.fail, 'a dirty worktree must fail the stage')
  assert.equal(outcome.fail.stage, 'implement')
  assert.match(outcome.fail.detail, /uncommitted state in the worktree/)
  assert.match(outcome.fail.detail, /uncommitted-work\.txt/)
})

test('a green implementation with a committed clean worktree passes the durability gate', async () => {
  const repo = makeRecoveryRepo({ parserExecplanStatus: 'COMPLETE' })
  const worktree = repo.parserWorktree
  const surface = await loadRecoverySurface({}, async (prompt, opts = {}) => {
    if (opts.label?.startsWith('implement:')) {
      return { ok: true, gatesGreen: true, execplanPath: PARSER_PLAN, workItemsCompleted: 1, workItemsTotal: 1, summary: 'done' }
    }
    throw new Error(`unexpected label: ${opts.label}`)
  })

  const outcome = await surface.runImplementationStage(
    { id: '1.2.3', title: 'Parser' },
    worktree,
    { execplanPath: PARSER_PLAN },
  )

  assert.ok(!outcome.fail, JSON.stringify(outcome.fail || {}))
  assert.equal(outcome.impl.ok, true)
})

test('normal tasks and recovery resume share one review and integration implementation', async () => {
  const source = await readWorkflowSource()

  assert.match(
    source,
    /const outcome = await runDualReviewAndIntegration\(task, worktree, plan, impl, mergeLock\)/,
    'runTask must delegate to the shared review/integration path',
  )
  assert.match(
    source,
    // The optional `as …` groups tolerate TypeScript casts on the plan and
    // implementation arguments in the src tree.
    /runDualReviewAndIntegration\(task, candidate\.worktreePath, plan(?: as \w+)?, impl(?: as \w+)?, mergeLock, \{ kind: 'recovery-resume' \}\)/,
    'recovery resume must delegate to the same shared path',
  )
})

test('control loop wires recovery ahead of normal selection', async () => {
  const source = await readWorkflowSource()

  assert.match(source, /\{ title: 'Recovery' \},/, 'meta.phases should declare the Recovery lane')
  assert.match(
    source,
    /if \(RESUME_PARTIAL_BRANCHES && halted\) \{\s*recovery\.blocked = 'auth-preflight-failed'/,
    'fatal auth preflight must block recovery entirely',
  )
  assert.match(
    source,
    /if \(RESUME_PARTIAL_BRANCHES && !halted\) \{[\s\S]*?await runRecovery\(process\.cwd\(\), mergeLock\)/,
    'recovery must run only when enabled and not halted',
  )
  assert.match(
    source,
    /normal: \[\.\.\.processedNormal[\s\S]*?\.\.\.recoveryHeldNormal\]/,
    'takenSnapshot must exclude recovery-held ids from normal selection',
  )
  assert.match(
    source,
    /return \{[\s\S]*?\brecovery\b[\s\S]*?\bsummary:/,
    'workflow result must expose the recovery summary',
  )
})
