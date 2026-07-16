// Module tests for the ADR 002 assessment surface (decomposition milestone
// 8): deferred-review classification, the manual-merge handoff guard, the
// assessment gate, and the attach path with scripted agents over a real
// fixture repo.
import { describe, expect, spyOn, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  addendumImplementationNeedsManualMerge,
  fastAssessmentClassification,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
  isDeferredReviewIssue,
  makeAssessment,
  summarizeSalvages,
} from '../../src/workflows/df12-build-odw/assessment.ts'
import * as durability from '../../src/workflows/df12-build-odw/execplan-durability.ts'

const globals = globalThis as Record<string, unknown>
globals.log = () => {}
globals.phase = () => {}

// Both assessment entry points (assessmentPrompt and recoveryAssessmentPrompt)
// share the ADR 002 classification contract via assessmentPromptLines: blocking
// gaps route to `missingEvidence`, advisory caveats to `residualRisk`, and an
// eligible adopt-complete is never held back for advisory risk alone (#23).
// Pin that instructional wording so a regression that weakens it fails loudly.
function assertClassificationContract(prompt: string): void {
  expect(prompt).toContain('Separate blocking evidence gaps from advisory residual risk:')
  expect(prompt).toContain('Put a gap in `missingEvidence` ONLY when it genuinely blocks confidence')
  expect(prompt).toContain('into `residualRisk`. These are non-blocking caveats carried forward')
  expect(prompt).toContain('must NOT be held back for advisory residual risk alone')
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim()
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'assessment-module-'))
  git(dir, 'init', '-b', 'roadmap-1-2-3')
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-m', 'Initial fixture')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  // Commit work AFTER the base and leave the tree clean, so the deterministic
  // fast-classifier (empty/dirty/error cases) does not short-circuit — these
  // tests exercise the MODEL path.
  writeFileSync(path.join(dir, 'feature.txt'), 'work\n')
  git(dir, 'add', 'feature.txt')
  git(dir, 'commit', '-m', 'Implement the feature')
  return { dir, baseSha }
}

function subject(overrides: Record<string, unknown> = {}) {
  return makeAssessment({
    preamble: (worktree) => `PREAMBLE ${worktree || '<none>'}`,
    assessPartialBranches: true,
    assessmentAgentOptions: (options) => options,
    assessmentEscalationModel: 'claude-opus-4-8',
    withInfraRetry: (run) => run(),
    ...overrides,
  })
}

describe('deferred-review classification', () => {
  const table: Array<[string, boolean]> = [
    ['Second CodeRabbit review pass deferred: rate_limit, waitTime 26s', true],
    ['coderabbit review returned HTTP 429; retry later', true],
    ['CodeRabbit temporarily unavailable', true],
    ['coderabbit found 3 blocking issues', false],
    ['rate limit exceeded on the build API', false],
    ['', false],
  ]
  for (const [issue, expected] of table) {
    test(`"${issue || '<empty>'}" -> ${expected}`, () => {
      expect(isDeferredReviewIssue(issue)).toBe(expected)
    })
  }

  test('hasOnlyDeferredReviewIssues demands a non-empty, all-deferred list', () => {
    expect(hasOnlyDeferredReviewIssues([])).toBe(false)
    expect(hasOnlyDeferredReviewIssues(['coderabbit 429 rate limit'])).toBe(true)
    expect(hasOnlyDeferredReviewIssues(['coderabbit 429 rate limit', 'tests failing'])).toBe(false)
  })
})

describe('manual-merge handoff guard', () => {
  const base = { ok: false, gatesGreen: true, workItemsCompleted: 3, workItemsTotal: 3, openIssues: ['coderabbit 429 rate limit'] }
  test('a complete, gate-green addendum with only deferred review issues hands off', () => {
    expect(addendumImplementationNeedsManualMerge(base)).toBe(true)
  })
  test('anything else does not', () => {
    expect(addendumImplementationNeedsManualMerge({ ...base, ok: true })).toBe(false)
    expect(addendumImplementationNeedsManualMerge({ ...base, gatesGreen: false })).toBe(false)
    expect(addendumImplementationNeedsManualMerge({ ...base, openIssues: ['real defect'] })).toBe(false)
    expect(addendumImplementationNeedsManualMerge({ ...base, workItemsCompleted: 2 })).toBe(false)
    expect(addendumImplementationNeedsManualMerge(null)).toBe(false)
  })
})

describe('implementationAuthFailureDetail', () => {
  test('detects auth failures across summary and open issues, ignoring prose', () => {
    expect(implementationAuthFailureDetail({ summary: 'Not logged in', openIssues: [] })).toBeTruthy()
    expect(implementationAuthFailureDetail({ summary: 'done', openIssues: ['token expired mid-run'] })).toBeTruthy()
    expect(implementationAuthFailureDetail({ summary: 'documented the auth design', openIssues: [] })).toBe('')
  })
})

describe('shouldAssessFailure gate', () => {
  const wt = { branch: 'roadmap-1-2-3', worktreePath: '/tmp/wt' }
  const assessment = subject()
  test('admits only non-auth, non-provider, non-infra failed or halted branches', () => {
    expect(assessment.shouldAssessFailure({ status: 'failed', stage: 'review', detail: 'gates red' }, wt)).toBe(true)
    expect(assessment.shouldAssessFailure({ status: 'halted', stage: 'review', detail: 'pool halt' }, wt)).toBe(true)
    expect(assessment.shouldAssessFailure({ status: 'done', stage: 'integrate', detail: '' }, wt)).toBe(false)
    expect(assessment.shouldAssessFailure({ status: 'failed', stage: 'worktree-write', detail: 'probe failed' }, wt)).toBe(false)
    expect(assessment.shouldAssessFailure({ status: 'fatal-auth', stage: 'auth', detail: 'Not logged in' }, wt)).toBe(false)
    expect(assessment.shouldAssessFailure({ status: 'failed', stage: 'review', detail: 'API Error: 529 overloaded' }, wt)).toBe(false)
    expect(assessment.shouldAssessFailure({ status: 'failed', stage: 'review', detail: "adapter 'codex' timed out" }, wt)).toBe(false)
    expect(assessment.shouldAssessFailure({ status: 'failed', stage: 'review', detail: 'gates red' }, { branch: '', worktreePath: '' })).toBe(false)
  })

  test('the assessPartialBranches switch disables the gate entirely', () => {
    const disabled = subject({ assessPartialBranches: false })
    expect(disabled.shouldAssessFailure({ status: 'failed', stage: 'review', detail: 'gates red' }, wt)).toBe(false)
  })
})

describe('fastAssessmentClassification', () => {
  test('an empty branch with a clean worktree is a deterministic discard', () => {
    expect(fastAssessmentClassification({ recentCommits: [], dirtyState: 'clean', collectionErrors: [] })).toEqual({
      classification: 'discard',
      reason: expect.stringContaining('no committed work'),
    })
  })

  test('evidence collection errors are a deterministic continue-manual', () => {
    const out = fastAssessmentClassification({ recentCommits: ['c'], dirtyState: 'clean', collectionErrors: ['git status failed'] })
    expect(out?.classification).toBe('continue-manual')
  })

  test('a branch with committed work on a clean tree reaches the model (null)', () => {
    expect(fastAssessmentClassification({ recentCommits: ['c'], dirtyState: 'clean', collectionErrors: [] })).toBeNull()
  })

  test('a dirty branch reaches the model so the eligibility gate owns the downgrade', () => {
    expect(fastAssessmentClassification({ recentCommits: ['c'], dirtyState: 'dirty', collectionErrors: [] })).toBeNull()
  })
})

describe('deterministic assessment path (zero tokens)', () => {
  test('attachAssessment classifies an empty clean branch without calling the model', async () => {
    const { dir, baseSha } = makeRepo()
    // A branch at base with no work after it and a clean tree.
    execFileSync('git', ['checkout', '-q', '-b', 'roadmap-9-9-9', baseSha], { cwd: dir, env: process.env })
    let called = false
    globals.agent = async () => {
      called = true
      return { classification: 'adopt-complete' }
    }
    const result = await subject().attachAssessment(
      { id: '9.9.9', title: 'Empty' },
      { branch: 'roadmap-9-9-9', worktreePath: dir, baseSha: git(dir, 'rev-parse', 'HEAD') },
      { status: 'failed', stage: 'review', detail: 'gates red' },
    )
    expect(called).toBe(false)
    const assessment = result.assessment as { classification?: string; classifier?: string } | undefined
    expect(assessment?.classification).toBe('discard')
    expect(assessment?.classifier).toBe('deterministic')
  })
})

describe('assessment model tier', () => {
  test('a branch that committed an ExecPlan uses the escalation model; others use the medium default', async () => {
    const models: string[] = []
    globals.agent = async (_prompt: string, opts: Record<string, unknown> = {}) => {
      models.push(String(opts.model || '<default>'))
      return { classification: 'continue-manual', taskScoped: true }
    }
    // The assessmentAgentOptions here echoes the incoming options AND records
    // the medium default when no model override is passed.
    const withModels = subject({
      assessmentAgentOptions: (options: Record<string, unknown>) => ({ model: 'medium-default', ...options }),
      assessmentEscalationModel: 'escalation-high',
    })
    const { dir, baseSha } = makeRepo()
    // makeRepo commits a plain feature file (no execplan) -> medium tier.
    await withModels.attachAssessment({ id: '1.2.3', title: 'T' }, { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha }, { status: 'failed', stage: 'review', detail: 'x' })
    // A second branch that committed an execplan -> escalation tier.
    mkdirSync(path.join(dir, 'docs', 'execplans'), { recursive: true })
    writeFileSync(path.join(dir, 'docs', 'execplans', 'roadmap-1-2-3.md'), '# Plan\n')
    execFileSync('git', ['add', '.'], { cwd: dir, env: process.env })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.i', 'commit', '-m', 'Add execplan'], { cwd: dir, env: process.env })
    await withModels.attachAssessment({ id: '1.2.3', title: 'T' }, { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha }, { status: 'failed', stage: 'review', detail: 'x' })
    expect(models[0]).toBe('medium-default')
    expect(models[1]).toBe('escalation-high')
  })
})

// A branch whose docs/execplans directory is already tracked, so a fresh
// artefact under it surfaces as an individual untracked (??) path rather than
// a collapsed untracked directory — mirroring a real task branch.
function makeRepoWithExecplans() {
  const { dir, baseSha } = makeRepo()
  mkdirSync(path.join(dir, 'docs', 'execplans'), { recursive: true })
  writeFileSync(path.join(dir, 'docs', 'execplans', 'roadmap-1-2-3.md'), '# Plan\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Add execplan')
  return { dir, baseSha }
}

const REVIEW_REL = 'docs/execplans/roadmap-1-2-3-review.md'

function addUntrackedReview(dir: string) {
  writeFileSync(path.join(dir, REVIEW_REL), '# Review notes left before the schema-parse failure\n')
}

type SalvageShape = { classification: string; committed: string[]; skipped: unknown[]; sha: string; detail: string }

describe('continue-manual/adopt-partial artefact salvage', () => {
  for (const classification of ['continue-manual', 'adopt-partial']) {
    test(`${classification} commits an eligible untracked artefact and records it on result.salvage`, async () => {
      const { dir, baseSha } = makeRepoWithExecplans()
      addUntrackedReview(dir)
      globals.agent = async () => ({ classification, taskScoped: true })
      const result = await subject().attachAssessment(
        { id: '1.2.3', title: 'Parser' },
        { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
        { status: 'failed', stage: 'review', detail: 'gates red' },
      )
      const salvage = result.salvage as SalvageShape | undefined
      expect(salvage?.classification).toBe(classification)
      expect(salvage?.committed).toEqual([REVIEW_REL])
      expect(salvage?.sha).toMatch(/^[0-9a-f]{40}$/)
      // The artefact is durably committed onto the branch; the tree is clean.
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('Salvage task artefacts for task 1.2.3')
      expect(git(dir, 'status', '--porcelain=v1')).toBe('')
    })
  }

  for (const classification of ['adopt-complete', 'discard']) {
    test(`${classification} salvages nothing and leaves the branch untouched`, async () => {
      const { dir, baseSha } = makeRepoWithExecplans()
      addUntrackedReview(dir)
      globals.agent = async () => ({ classification, taskScoped: true })
      const result = await subject().attachAssessment(
        { id: '1.2.3', title: 'Parser' },
        { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
        { status: 'failed', stage: 'review', detail: 'gates red' },
      )
      expect(result.salvage).toBeUndefined()
      // The artefact stays untracked and HEAD is unchanged.
      expect(git(dir, 'status', '--porcelain=v1')).toBe(`?? ${REVIEW_REL}`)
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add execplan')
    })
  }

  test('the deterministic (collection-error) continue-manual skips salvage on untrustworthy evidence', async () => {
    const { dir } = makeRepoWithExecplans()
    addUntrackedReview(dir)
    let called = false
    globals.agent = async () => {
      called = true
      return { classification: 'continue-manual' }
    }
    // Omitting baseSha makes the base-relative git probes fail, so evidence
    // collection reports errors and the deterministic fast-path fires.
    const result = await subject().attachAssessment(
      { id: '1.2.3', title: 'T' },
      { branch: 'roadmap-1-2-3', worktreePath: dir },
      { status: 'failed', stage: 'review', detail: 'x' },
    )
    expect(called).toBe(false)
    const assessment = result.assessment as { classification?: string; classifier?: string } | undefined
    expect(assessment?.classification).toBe('continue-manual')
    expect(assessment?.classifier).toBe('deterministic')
    const salvage = result.salvage as SalvageShape | undefined
    expect(salvage?.committed).toEqual([])
    expect(salvage?.detail).toMatch(/skipped/)
    // The artefact is NOT committed — nothing was salvaged against bad evidence.
    expect(git(dir, 'status', '--porcelain=v1')).toBe(`?? ${REVIEW_REL}`)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add execplan')
  })

  // A thrown salvageTaskArtefacts must be recorded, never escape: salvage can
  // never turn a failed task into a run-halting error. Reachable only by forcing
  // the primitive to throw, which the model-classified path is otherwise too
  // defensive to trigger.
  test('a thrown salvageTaskArtefacts is recorded as a salvage error, not escaped', async () => {
    const { dir, baseSha } = makeRepoWithExecplans()
    addUntrackedReview(dir)
    globals.agent = async () => ({ classification: 'continue-manual', taskScoped: true })
    const spy = spyOn(durability, 'salvageTaskArtefacts').mockImplementation(async () => {
      throw new Error('boom in salvage')
    })
    try {
      const result = await subject().attachAssessment(
        { id: '1.2.3', title: 'Parser' },
        { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
        { status: 'failed', stage: 'review', detail: 'gates red' },
      )
      const salvage = result.salvage as SalvageShape | undefined
      expect(salvage?.classification).toBe('continue-manual')
      expect(salvage?.committed).toEqual([])
      expect(salvage?.detail.startsWith('salvage errored')).toBe(true)
      expect(salvage?.detail).toContain('boom in salvage')
      // The branch is untouched — the artefact stays untracked, HEAD unmoved.
      expect(git(dir, 'status', '--porcelain=v1')).toBe(`?? ${REVIEW_REL}`)
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add execplan')
    } finally {
      spy.mockRestore()
    }
  })
})

// Schema-retry exhaustion is classified as an infra-fault, which
// shouldAssessFailure excludes from MODEL assessment — but a planner or reviewer
// may have written a docs/execplans/*.md artefact just before the parse failure,
// and that artefact must still be salvaged (#18).
describe('infra-fault artefact salvage (#18)', () => {
  for (const [label, result] of [
    ['status/stage', { id: '1.2.3', status: 'infra-fault', stage: 'infrastructure', detail: 'adapter reply did not satisfy the schema after 3 attempts' }],
    ['detail-classified', { id: '1.2.3', status: 'failed', stage: 'plan', detail: 'SchemaValidationError: reply was not valid JSON' }],
  ] as const) {
    test(`salvages the untracked artefact without a model call (${label})`, async () => {
      const { dir, baseSha } = makeRepoWithExecplans()
      addUntrackedReview(dir)
      let called = false
      globals.agent = async () => {
        called = true
        return { classification: 'discard' }
      }
      const attached = await subject().attachAssessment(
        { id: '1.2.3', title: 'Parser' },
        { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
        result,
      )
      // No model assessment runs for an infra-fault...
      expect(called).toBe(false)
      expect(attached.assessment).toBeUndefined()
      // ...yet the artefact is durably committed onto the branch.
      const salvage = attached.salvage as SalvageShape | undefined
      expect(salvage?.classification).toBe('infra-fault')
      expect(salvage?.committed).toEqual([REVIEW_REL])
      expect(salvage?.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('Salvage task artefacts for task 1.2.3')
      expect(git(dir, 'status', '--porcelain=v1')).toBe('')
    })
  }

  test('an infra-fault with no worktree path records the no-worktree skip', async () => {
    globals.agent = async () => {
      throw new Error('the model must not be called for an infra-fault')
    }
    const result = await subject().attachAssessment(
      { id: '1.2.3', title: 'Parser' },
      { branch: 'roadmap-1-2-3' }, // worktreePath omitted
      { id: '1.2.3', status: 'infra-fault', stage: 'infrastructure', detail: 'SchemaValidationError' },
    )
    const salvage = result.salvage as SalvageShape | undefined
    expect(salvage?.classification).toBe('infra-fault')
    expect(salvage?.committed).toEqual([])
    expect(salvage?.detail.startsWith('salvage skipped: no worktree path')).toBe(true)
  })

  test('a provider fault with infra-shaped detail does not trigger infra-fault salvage', async () => {
    const { dir, baseSha } = makeRepoWithExecplans()
    addUntrackedReview(dir)
    // The provider-fault STATUS must reject salvage before the detail heuristic,
    // even though the detail embeds infra-shaped text ("SchemaValidationError"):
    // isInfraFaultResult must not misclassify it. Salvage must not fire, and the
    // model must not be consulted.
    globals.agent = async () => {
      throw new Error('the model must not be called for a provider fault')
    }
    const result = await subject().attachAssessment(
      { id: '1.2.3', title: 'Parser' },
      { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
      { id: '1.2.3', status: 'provider-fault', stage: 'provider', detail: 'API Error: 529 overloaded; SchemaValidationError while parsing the retried reply' },
    )
    expect(result.salvage).toBeUndefined()
    expect(git(dir, 'status', '--porcelain=v1')).toBe(`?? ${REVIEW_REL}`)
  })
})

// The terminal-summary aggregation (main.ts) is a pure helper so it can be
// tested without running workflowMain: it must count only branches that
// committed artefacts toward the summary suffix, while still surfacing skipped
// attempts as rows.
describe('summarizeSalvages', () => {
  const committed = (id: string) => ({
    id,
    salvage: { classification: 'continue-manual', committed: [`docs/execplans/${id}.md`], skipped: [], sha: 'a'.repeat(40), detail: '' },
  })
  const skipped = (id: string) => ({
    id,
    salvage: { classification: 'infra-fault', committed: [], skipped: [], sha: '', detail: 'salvage skipped: no worktree path in the assessment evidence' },
  })
  const noSalvage = (id: string) => ({ id, status: 'done' })

  test('no salvage attempted yields empty salvages and no summary suffix', () => {
    const out = summarizeSalvages([noSalvage('1.1'), noSalvage('1.2')])
    expect(out.salvages).toEqual([])
    expect(out.salvagedBranches).toBe(0)
    expect(out.summarySuffix).toBe('')
  })

  test('a skipped attempt is a row but not a salvaged branch and adds no suffix', () => {
    const out = summarizeSalvages([skipped('1.2.3'), noSalvage('1.2.4')])
    expect(out.salvages).toHaveLength(1)
    expect(out.salvages[0]).toMatchObject({ id: '1.2.3', classification: 'infra-fault', committed: [], skipped: 0 })
    expect(out.salvages[0].detail).toMatch(/salvage skipped: no worktree path/)
    expect(out.salvagedBranches).toBe(0)
    expect(out.summarySuffix).toBe('')
  })

  test('committed attempts count toward salvagedBranches and the summary suffix', () => {
    const out = summarizeSalvages([committed('1.2.3'), skipped('1.2.4'), committed('1.2.5')])
    // Every attempted salvage (committed AND skipped) is a row...
    expect(out.salvages.map((entry) => entry.id)).toEqual(['1.2.3', '1.2.4', '1.2.5'])
    // ...but only the two that committed artefacts count as salvaged branches.
    expect(out.salvagedBranches).toBe(2)
    expect(out.summarySuffix).toBe(' | salvaged artefacts on 2 branch(es)')
    expect(out.salvages.find((entry) => entry.id === '1.2.4')?.committed).toEqual([])
  })

  test('the skipped count reflects the number of skipped candidate paths', () => {
    const out = summarizeSalvages([{
      id: '1.2.3',
      salvage: { classification: 'adopt-partial', committed: ['docs/execplans/1-2-3.md'], skipped: [{ path: 'src/x.ts', reason: 'not a task-scoped docs/execplans/*.md artefact' }], sha: 'b'.repeat(40), detail: '' },
    }])
    expect(out.salvages[0].skipped).toBe(1)
    expect(out.salvagedBranches).toBe(1)
    expect(out.summarySuffix).toBe(' | salvaged artefacts on 1 branch(es)')
  })
})

describe('recovery assessment entry points', () => {
  const candidate = (dir: string, baseSha: string) => ({
    taskId: '1.2.3',
    taskTitle: 'Parser',
    branchName: 'roadmap-1-2-3',
    worktreePath: dir,
    baseCommit: baseSha,
    currentCommit: 'deadbeef',
    roadmapComplete: false,
    isAddendum: false,
    line: 6,
  })

  test('the recovery prompt carries the recovery header and discovery context, not the failure shape', () => {
    const assessment = subject()
    const prompt = assessment.recoveryAssessmentPrompt(
      { id: '1.2.3', title: 'Parser' },
      candidate('/tmp/wt', 'abc123'),
      { branchName: 'roadmap-1-2-3', collectionErrors: [] },
    )
    expect(prompt).toContain('discovered during fresh-run recovery')
    expect(prompt).toContain('Recovery discovery context')
    expect(prompt).not.toContain('after a workflow failure')
    expect(prompt).toContain('"branchName": "roadmap-1-2-3"')
    expect(prompt).toContain('"baseCommit": "abc123"')
    assertClassificationContract(prompt)
  })

  test('assessRecoveryCandidate returns the structured assessment with host evidence', async () => {
    const { dir, baseSha } = makeRepo()
    globals.agent = async () => ({ classification: 'adopt-complete', taskScoped: true })
    const assessed = await subject().assessRecoveryCandidate(candidate(dir, baseSha))
    expect(assessed.assessmentError).toBe('')
    const attached = assessed.assessment as { classification?: string; hostEvidence?: { branchName?: string } } | null
    expect(attached?.classification).toBe('adopt-complete')
    expect(attached?.hostEvidence?.branchName).toBe('roadmap-1-2-3')
    expect(assessed.evidence.collectionErrors).toEqual([])
  })

  test('a null reply and a thrown agent error both surface as assessmentError', async () => {
    const { dir, baseSha } = makeRepo()

    globals.agent = async () => null
    const nulled = await subject().assessRecoveryCandidate(candidate(dir, baseSha))
    expect(nulled.assessment).toBeNull()
    expect(nulled.assessmentError).toMatch(/no structured output/)

    globals.agent = async () => {
      throw new Error("adapter 'claude' exited with code 137")
    }
    const threw = await subject().assessRecoveryCandidate(candidate(dir, baseSha))
    expect(threw.assessment).toBeNull()
    expect(threw.assessmentError).toMatch(/exited with code 137/)
    expect(threw.evidence).toBeDefined()
  })
})

describe('attachAssessment', () => {
  test('attaches the agent assessment with host evidence riding along', async () => {
    const { dir, baseSha } = makeRepo()
    globals.agent = async () => ({ classification: 'continue-manual', taskScoped: true })
    const assessment = subject()
    const result = await assessment.attachAssessment(
      { id: '1.2.3', title: 'Parser' },
      { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha },
      { status: 'failed', stage: 'review', detail: 'gates red' },
    )
    expect(result.assessment?.classification).toBe('continue-manual')
    const hostEvidence = result.assessment?.hostEvidence as { branchName?: string } | undefined
    expect(hostEvidence?.branchName).toBe('roadmap-1-2-3')
  })

  test('a null reply and a thrown error both surface as assessmentError', async () => {
    const { dir, baseSha } = makeRepo()
    const wt = { branch: 'roadmap-1-2-3', worktreePath: dir, baseSha }
    const failing = { status: 'failed', stage: 'review', detail: 'gates red' }
    const assessment = subject()

    globals.agent = async () => null
    const nulled = await assessment.attachAssessment({ id: '1.2.3', title: 'T' }, wt, failing)
    expect(nulled.assessmentError).toMatch(/no structured output/)

    globals.agent = async () => {
      throw new Error("adapter 'claude' exited with code 137")
    }
    const threw = await assessment.attachAssessment({ id: '1.2.3', title: 'T' }, wt, failing)
    expect(threw.assessmentError).toMatch(/exited with code 137/)
    expect(threw.assessmentEvidence).toBeDefined()
  })

  test('prompts carry the task header, the preamble, and the evidence JSON', () => {
    const assessment = subject()
    const prompt = assessment.assessmentPrompt(
      { id: '1.2.3', title: 'Parser' },
      { worktreePath: '/tmp/wt' },
      { status: 'failed' },
      { branchName: 'roadmap-1-2-3', collectionErrors: [] },
    )
    expect(prompt).toContain('PREAMBLE /tmp/wt')
    expect(prompt).toContain('roadmap task 1.2.3')
    expect(prompt).toContain('"branchName": "roadmap-1-2-3"')
    assertClassificationContract(prompt)
  })
})
