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
    HOST_GATES_BETWEEN_WORK_ITEMS: false,
    CODERABBIT_HOST_REVIEW: false,
    CODERABBIT_BETWEEN_WORK_ITEMS: false,
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

  test('per-work-item build fails when the committed plan disappears mid-build', async () => {
    const worktree = makeWorktree()
    // A committed plan with one unticked Progress item, so the work-item loop
    // has an item to dispatch.
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: build the thing\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'Add a Progress checklist')
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        // A builder that removes the committed plan and returns a green
        // report — the host must re-read the plan and reject the false done.
        git(worktree, 'rm', '-q', PLAN_PATH)
        git(worktree, 'commit', '-m', 'Delete the plan mid-build')
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, commits: ['x'], coderabbitRuns: 0, openIssues: [], summary: 'claimed done' }
      }
      // Reuse the happy plan/design so the pipeline reaches the work-item loop.
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree, { PER_WORK_ITEM_BUILD: true }).runTask(task, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('implement')
    expect(outcome.detail).toMatch(/ExecPlan (disappeared|is absent)/)
    expect(labels.filter((label) => label.startsWith('implement:'))).toHaveLength(1)
  })

  test('between-item CodeRabbit passes the build when each item is clean', async () => {
    const worktree = makeWorktree()
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: first\n- [ ] WI-2: second\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'Two-item checklist')
    let tick = 0
    const reviews: string[] = []
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        tick += 1
        writeFileSync(path.join(worktree, PLAN_PATH), `# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [${tick >= 1 ? 'x' : ' '}] WI-1: first\n- [${tick >= 2 ? 'x' : ' '}] WI-2: second\n`)
        git(worktree, 'commit', '-aqm', `Tick WI-${tick}`)
        return { ok: true, gatesGreen: true, workItemsCompleted: tick, workItemsTotal: 2, commits: [`c${tick}`], coderabbitRuns: 0, openIssues: [], summary: 'item done' }
      }
      return happyScript()(label, prompt)
    })
    const pipe = subject(worktree, {
      PER_WORK_ITEM_BUILD: true,
      CODERABBIT_HOST_REVIEW: true,
      CODERABBIT_BETWEEN_WORK_ITEMS: true,
      runCoderabbitHostReview: async (_wt: string, label: string) => {
        reviews.push(label)
        return { outcome: 'clean' as const, attempts: 1, findings: [], detail: '' }
      },
    })
    const outcome = await pipe.runTask(task, null)
    expect(outcome.status).toBe('done')
    // One between-item review per committed item, before the dual-review pass.
    expect(reviews.filter((label) => /wi1|wi2/.test(label))).toHaveLength(2)
  })

  test('a committed red host gate fails the work item before CodeRabbit runs', async () => {
    const worktree = makeWorktree()
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: only\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'One-item checklist')
    const order: string[] = []
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: COMPLETE\n\n## Progress\n\n- [x] WI-1: only\n')
        git(worktree, 'commit', '-aqm', 'Tick WI-1')
        // The builder claims green, but the host gate below finds it red.
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, commits: ['c1'], coderabbitRuns: 0, openIssues: [], summary: 'claimed green' }
      }
      if (label.startsWith('fix:')) {
        git(worktree, 'commit', '-qm', 'attempt fix', '--allow-empty')
        return { gatesGreen: true, summary: 'tried' }
      }
      return happyScript()(label, prompt)
    })
    const pipe = subject(worktree, {
      PER_WORK_ITEM_BUILD: true,
      HOST_COMMIT_GATES: true,
      HOST_GATES_BETWEEN_WORK_ITEMS: true,
      CODERABBIT_HOST_REVIEW: true,
      CODERABBIT_BETWEEN_WORK_ITEMS: true,
      runHostCommitGates: async () => {
        order.push('gate')
        return { green: false, results: [], detail: '`make all` failed: 1 test red' }
      },
      runCoderabbitHostReview: async () => {
        order.push('coderabbit')
        return { outcome: 'clean' as const, attempts: 1, findings: [], detail: '' }
      },
    })
    const outcome = await pipe.runTask(task, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('implement')
    expect(outcome.detail).toMatch(/HOST GATES RED/)
    // Gates ran; CodeRabbit was never reached for the red item.
    expect(order).toContain('gate')
    expect(order).not.toContain('coderabbit')
    expect(labels.some((label) => label.startsWith('integrate:'))).toBe(false)
  })

  test('per-item host gates run before the between-item CodeRabbit on a clean item', async () => {
    const worktree = makeWorktree()
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: only\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'One-item checklist')
    const order: string[] = []
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: COMPLETE\n\n## Progress\n\n- [x] WI-1: only\n')
        git(worktree, 'commit', '-aqm', 'Tick WI-1')
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, commits: ['c1'], coderabbitRuns: 0, openIssues: [], summary: 'done' }
      }
      return happyScript()(label, prompt)
    })
    const pipe = subject(worktree, {
      PER_WORK_ITEM_BUILD: true,
      HOST_COMMIT_GATES: true,
      HOST_GATES_BETWEEN_WORK_ITEMS: true,
      CODERABBIT_HOST_REVIEW: true,
      CODERABBIT_BETWEEN_WORK_ITEMS: true,
      runHostCommitGates: async () => {
        order.push('gate')
        return { green: true, results: [], detail: '' }
      },
      runCoderabbitHostReview: async () => {
        order.push('coderabbit')
        return { outcome: 'clean' as const, attempts: 1, findings: [], detail: '' }
      },
    })
    const outcome = await pipe.runTask(task, null)
    expect(outcome.status).toBe('done')
    // The per-item gate precedes the per-item CodeRabbit review.
    expect(order.indexOf('gate')).toBeLessThan(order.indexOf('coderabbit'))
    expect(order.indexOf('gate')).toBeGreaterThanOrEqual(0)
  })

  test('between-item CodeRabbit blocking findings fail the build after the fix cap', async () => {
    const worktree = makeWorktree()
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: only\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'One-item checklist')
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: COMPLETE\n\n## Progress\n\n- [x] WI-1: only\n')
        git(worktree, 'commit', '-aqm', 'Tick WI-1')
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, commits: ['c1'], coderabbitRuns: 0, openIssues: [], summary: 'done' }
      }
      if (label.startsWith('fix:')) {
        git(worktree, 'commit', '-qm', 'attempt fix', '--allow-empty')
        return { gatesGreen: true, summary: 'tried' }
      }
      return happyScript()(label, prompt)
    })
    const pipe = subject(worktree, {
      PER_WORK_ITEM_BUILD: true,
      CODERABBIT_HOST_REVIEW: true,
      CODERABBIT_BETWEEN_WORK_ITEMS: true,
      // Always returns a blocking finding, so the bounded fix loop exhausts.
      runCoderabbitHostReview: async () => ({ outcome: 'findings' as const, attempts: 1, findings: [{ type: 'finding', severity: 'major', fileName: 'x.ts', comment: 'fix me' }], detail: '' }),
    })
    const outcome = await pipe.runTask(task, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('code-review')
    expect(outcome.detail).toMatch(/blocking finding/)
  })

  test('between-item CodeRabbit terminal deferral halts rather than silently continuing', async () => {
    const worktree = makeWorktree()
    writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: IN PROGRESS\n\n## Progress\n\n- [ ] WI-1: only\n')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-m', 'One-item checklist')
    scriptAgent((label, prompt) => {
      if (label.startsWith('implement:')) {
        writeFileSync(path.join(worktree, PLAN_PATH), '# ExecPlan\n\nStatus: COMPLETE\n\n## Progress\n\n- [x] WI-1: only\n')
        git(worktree, 'commit', '-aqm', 'Tick WI-1')
        return { ok: true, gatesGreen: true, workItemsCompleted: 1, workItemsTotal: 1, commits: ['c1'], coderabbitRuns: 0, openIssues: [], summary: 'done' }
      }
      return happyScript()(label, prompt)
    })
    const pipe = subject(worktree, {
      PER_WORK_ITEM_BUILD: true,
      CODERABBIT_HOST_REVIEW: true,
      CODERABBIT_BETWEEN_WORK_ITEMS: true,
      runCoderabbitHostReview: async () => ({ outcome: 'rate-limited' as const, attempts: 3, findings: [], detail: 'quota exhausted' }),
    })
    const outcome = await pipe.runTask(task, null)
    expect(outcome.status).toBe('halted')
    expect(outcome.stage).toBe('code-review')
    expect(outcome.detail).toMatch(/could not complete/)
    expect(outcome.assessed).toBe(true)
    expect(labels.some((label) => label.startsWith('integrate:'))).toBe(false)
  })

  test('a review fix that leaves the worktree dirty fails the FIX DURABILITY gate', async () => {
    const worktree = makeWorktree()
    let round = 0
    scriptAgent((label, prompt) => {
      if (label.startsWith('code-review:')) {
        round += 1
        return round === 1 ? { verdict: 'changes-requested', blocking: ['fix this'] } : passReview
      }
      if (label.startsWith('fix:')) {
        // A fix that edits but does not commit — the durability gate must catch it.
        writeFileSync(path.join(worktree, 'stray.txt'), 'uncommitted\n')
        return { gatesGreen: true, summary: 'edited without committing' }
      }
      return happyScript()(label, prompt)
    })
    const outcome = await subject(worktree).runTask(task, null)
    expect(outcome.status).toBe('failed')
    expect(outcome.stage).toBe('implement')
    expect(outcome.detail).toMatch(/FIX DURABILITY/)
    expect(labels.some((label) => label.startsWith('integrate:'))).toBe(false)
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
