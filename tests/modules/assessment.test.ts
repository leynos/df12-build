// Module tests for the ADR 002 assessment surface (decomposition milestone
// 8): deferred-review classification, the manual-merge handoff guard, the
// assessment gate, and the attach path with scripted agents over a real
// fixture repo.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  addendumImplementationNeedsManualMerge,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
  isDeferredReviewIssue,
  makeAssessment,
} from '../../src/workflows/df12-build-odw/assessment.ts'

const globals = globalThis as Record<string, unknown>
globals.log = () => {}
globals.phase = () => {}

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
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD') }
}

function subject(overrides: Record<string, unknown> = {}) {
  return makeAssessment({
    preamble: (worktree) => `PREAMBLE ${worktree || '<none>'}`,
    assessPartialBranches: true,
    assessmentAgentOptions: (options) => options,
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
  })
})
