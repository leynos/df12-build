// Module tests for the per-task pipeline (decomposition milestone 9), run
// with scripted primitives keyed on stable agent labels — mirroring the
// artefact-level simulation suites, but by direct import. Real git fixtures
// back the durability gates the pipeline consults.
import { beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  makeTaskPipeline,
  summarizeFixReport,
  summarizeReviewVerdict,
} from '../../src/workflows/df12-build-odw/run-task.ts'

const globals = globalThis as Record<string, unknown>

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

const PLAN_PATH = 'docs/execplans/roadmap-1-2-3.md'

function makeWorktree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipeline-'))
  git(dir, 'init', '-b', 'roadmap-1-2-3')
  mkdirSync(path.join(dir, 'docs', 'execplans'), { recursive: true })
  writeFileSync(path.join(dir, PLAN_PATH), '# ExecPlan\n\nStatus: COMPLETE\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Commit plan')
  return dir
}

const task = { id: '1.2.3', title: 'Implement the parser', requires: [], rationale: '', isAddendum: false, subtasks: [] }

type Script = (label: string, prompt: string) => unknown
let labels: string[] = []

function scriptAgent(script: Script) {
  globals.agent = async (prompt: string, opts: Record<string, unknown> = {}) => {
    const label = String(opts.label || '')
    labels.push(label)
    return script(label, prompt)
  }
}

function subject(worktree: string, overrides: Record<string, unknown> = {}) {
  return makeTaskPipeline({
    MAX_DESIGN_ROUNDS: 2,
    MAX_REVIEW_ROUNDS: 2,
    // The upstream defaults for these are ON, but the module tests drive the
    // pipeline against fixture repos: host gates would run real gate
    // commands, host review would exec the real coderabbit CLI, and the
    // work-item loop expects ticked Progress items — so they default OFF
    // here, mirroring the artefact simulation suites.
    MAX_WORK_ITEM_ROUNDS: 4,
    PER_WORK_ITEM_BUILD: false,
    HOST_COMMIT_GATES: false,
    CODERABBIT_HOST_REVIEW: false,
    DRY_RUN: false,
    AUTO_MERGE: true,
    BASE: 'main',
    planPrompt: () => 'PLAN',
    designReviewPrompt: () => 'DESIGN',
    implementPrompt: () => 'IMPLEMENT',
    implementWorkItemPrompt: (_task, _worktree, _plan, item) => `WORK-ITEM ${item.text}`,
    fixPrompt: () => 'FIX',
    codeReviewPrompt: () => 'CODE-REVIEW',
    expertReviewPrompt: () => 'EXPERT-REVIEW',
    addendumReviewPrompt: () => 'ADDENDUM-REVIEW',
    implementAddendumPrompt: () => 'ADDENDUM',
    integratePrompt: () => 'INTEGRATE',
    planAgentOptions: (options) => options,
    reviewAgentOptions: (options) => options,
    buildAgentOptions: (options) => options,
    planningLock: (fn) => fn(),
    buildLock: (fn) => fn(),
    hostGateLock: (fn) => fn(),
    withInfraRetry: (run) => run(),
    attachAssessment: async (_task, _wt, result) => ({ ...result, assessed: true }),
    ensureTaskAgentWriteAccess: async () => ({ ok: true, failures: [] }),
    createWorktree: async () => ({ ok: true, worktreePath: worktree, branch: 'roadmap-1-2-3', baseSha: git(worktree, 'rev-parse', 'HEAD'), notes: '' }),
    runHostCommitGates: async () => ({ green: true, results: [], detail: '' }),
    runCoderabbitHostReview: async () => ({ outcome: 'clean' as const, attempts: 1, findings: [], detail: '' }),
    recordCoderabbitReview: async () => {},
    ...overrides,
  })
}

beforeEach(() => {
  labels = []
  globals.log = () => {}
  globals.phase = () => {}
  globals.parallel = async (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)))
})

const passReview = { verdict: 'pass', blocking: [] }
const greenImpl = { ok: true, gatesGreen: true, execplanPath: PLAN_PATH, summary: 'done' }
const cleanIntegration = { ok: true, pushed: true, squashMerged: true, roadmapMarkedDone: true }

function happyScript(): Script {
  return (label) => {
    if (label.startsWith('plan:')) return { execplanPath: PLAN_PATH, workItems: ['a'], summary: 'planned' }
    if (label.startsWith('design-review:')) return { satisfied: true, blocking: [] }
    if (label.startsWith('implement:')) return greenImpl
    if (label.startsWith('code-review:') || label.startsWith('expert-review:')) return passReview
    if (label.startsWith('integrate:')) return cleanIntegration
    throw new Error(`unscripted label: ${label}`)
  }
}

describe('summarizers', () => {
  test('bound the review and fix evidence carried into assessments', () => {
    expect(summarizeReviewVerdict(null)).toBeNull()
    expect(summarizeReviewVerdict({ verdict: 'pass', blocking: [], summary: 's' })).toEqual({ verdict: 'pass', blocking: [], summary: 's' })
    expect(summarizeFixReport('plain text')).toEqual({ summary: 'plain text' })
    expect(summarizeFixReport({ gatesGreen: true, coderabbitRuns: '2' })).toEqual({
      commits: [],
      gatesGreen: true,
      coderabbitRuns: 2,
      resolved: [],
      openIssues: [],
      summary: '',
    })
  })
})

describe('runTask', () => {
  test('happy path lands done through plan, design, implement, dual review, integrate', async () => {
    const worktree = makeWorktree()
    scriptAgent(happyScript())
    const pipeline = subject(worktree)
    const outcome = await pipeline.runTask(task, null)
    expect(outcome.status).toBe('done')
    expect(labels.some((label) => label.startsWith('plan:'))).toBe(true)
    expect(labels.filter((label) => label.startsWith('code-review:'))).toHaveLength(1)
    expect(labels.filter((label) => label.startsWith('integrate:'))).toHaveLength(1)
  })

  test('a blocking review round dispatches one fix agent then passes', async () => {
    const worktree = makeWorktree()
    let reviewRound = 0
    scriptAgent((label, prompt) => {
      if (label.startsWith('code-review:')) {
        reviewRound += 1
        return reviewRound === 1 ? { verdict: 'changes-requested', blocking: ['broken test'] } : passReview
      }
      if (label.startsWith('fix:')) return { gatesGreen: true, summary: 'fixed' }
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree).runTask(task, null)
    expect(outcome.status).toBe('done')
    expect(labels.filter((label) => label.startsWith('fix:'))).toHaveLength(1)
  })

  test('reviews never passing halts at the review stage with the blocking evidence', async () => {
    const worktree = makeWorktree()
    scriptAgent((label, prompt) => {
      if (label.startsWith('code-review:')) return { verdict: 'changes-requested', blocking: ['still broken'] }
      if (label.startsWith('fix:')) return { gatesGreen: true, summary: 'tried' }
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree).runTask(task, null)
    expect(outcome.status).toBe('halted')
    expect(outcome.stage).toBe('review')
    expect(outcome.detail).toContain('still broken')
    expect(outcome.assessed).toBe(true) // failed outcomes route through attachAssessment
  })

  test('an implementation auth failure is fatal and never assessed', async () => {
    const worktree = makeWorktree()
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) return { ok: false, gatesGreen: false, summary: 'Not logged in', openIssues: [] }
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree).runTask(task, null)
    expect(outcome.status).toBe('fatal-auth')
    expect(outcome.assessed).toBeUndefined()
  })

  test('green implementation with a dirty worktree fails the durability gate', async () => {
    const worktree = makeWorktree()
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        writeFileSync(path.join(worktree, 'uncommitted.txt'), 'stray\n')
        return greenImpl
      }
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree).runTask(task, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('implement')
    expect(outcome.detail).toContain('uncommitted state')
  })

  test('a green addendum with a dirty worktree fails the durability gate before review or integration', async () => {
    const worktree = makeWorktree()
    scriptAgent((label) => {
      if (label.startsWith('addendum:')) {
        writeFileSync(path.join(worktree, 'uncommitted.txt'), 'stray\n')
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, openIssues: [], summary: 'green but dirty' }
      }
      throw new Error(`unscripted label: ${label}`)
    })
    const addendum = { ...task, isAddendum: true, subtasks: ['1.2.3.1'] }
    const outcome = await subject(worktree).runTask(addendum, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('addendum')
    expect(outcome.detail).toContain('uncommitted state')
    expect(outcome.assessed).toBe(true)
    expect(labels.some((label) => label.startsWith('integrate:'))).toBe(false)
    expect(labels.some((label) => label.startsWith('addendum-review:'))).toBe(false)
  })

  test('a completed addendum with only deferred review issues is manual-merge-ready', async () => {
    const worktree = makeWorktree()
    scriptAgent((label) => {
      if (label.startsWith('addendum:')) {
        return {
          ok: false,
          gatesGreen: true,
          workItemsCompleted: 2,
          workItemsTotal: 2,
          openIssues: ['coderabbit 429 rate limit'],
          summary: 'complete but review deferred',
        }
      }
      throw new Error(`unscripted label: ${label}`)
    })
    const addendum = { ...task, isAddendum: true, subtasks: ['1.2.3.1'] }
    const outcome = await subject(worktree).runTask(addendum, null)
    expect(outcome.status).toBe('manual-merge-ready')
    expect(outcome.kind).toBe('addendum')
  })

  test('recovery resume shares the same integration path, tagged recovery-resume', async () => {
    const worktree = makeWorktree()
    scriptAgent(happyScript())
    const pipeline = subject(worktree)
    const outcome = await pipeline.runDualReviewAndIntegration(task, worktree, { execplanPath: PLAN_PATH }, greenImpl, null, { kind: 'recovery-resume' })
    expect(outcome.status).toBe('done')
    expect(outcome.kind).toBe('recovery-resume')
  })
})
