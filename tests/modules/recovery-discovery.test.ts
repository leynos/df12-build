// Module tests for fresh-run recovery discovery (decomposition milestone 4):
// makeRecoveryDiscovery against the shared recovery fixture repo, the
// committed-ExecPlan reader, and the synthetic implementation bridge.
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { makeRecoveryRepo, RECOVERY_ROADMAP } from '../fixtures/recovery-repo.mjs'
import {
  RECOVERY_HOLD_REASONS,
  computeHeldFromDiscovery,
  makeRecoveryDiscovery,
  readExecplanState,
  recoveryExecplanPath,
  syntheticRecoveryImpl,
} from '../../src/workflows/df12-build-odw/recovery-discovery.ts'

const DEFAULT_LIMITS = { base: 'main', resumeTaskId: null, resumeMaxCandidates: 4 }

describe('makeRecoveryDiscovery', () => {
  test('maps surviving branches to candidates and skips the rest with reasons', async () => {
    const repo = makeRecoveryRepo()
    try {
      const discover = makeRecoveryDiscovery(DEFAULT_LIMITS)
      const { candidates, skipped, errors } = await discover(RECOVERY_ROADMAP, repo.dir)
      expect(errors).toEqual([])
      expect(candidates.map((candidate) => candidate.taskId)).toEqual(['1.2.3'])
      expect(candidates[0].worktreePath).toBe(repo.parserWorktree)
      expect(candidates[0].baseCommit).toBe(repo.baseSha)
      const reasonByBranch = new Map(skipped.map((entry) => [entry.branchName, entry.reason]))
      expect(reasonByBranch.get('roadmap-1-2-4')).toBe('missing-worktree')
      expect(reasonByBranch.get('roadmap-2-1-1')).toBe('already-complete')
      expect(reasonByBranch.get('roadmap-9-9-9')).toBe('unmapped-branch')
      expect(reasonByBranch.get('roadmap-x')).toBe('unmapped-branch')
    } finally {
      repo.cleanup()
    }
  })

  test('resumeTaskId filters and the candidate cap records candidate-cap skips', async () => {
    const repo = makeRecoveryRepo({ withAddendumWorktree: true })
    try {
      const filtered = await makeRecoveryDiscovery({ ...DEFAULT_LIMITS, resumeTaskId: '2.1.2' })(
        RECOVERY_ROADMAP,
        repo.dir,
      )
      expect(filtered.candidates.map((candidate) => candidate.taskId)).toEqual(['2.1.2'])

      const capped = await makeRecoveryDiscovery({ ...DEFAULT_LIMITS, resumeMaxCandidates: 1 })(
        RECOVERY_ROADMAP,
        repo.dir,
      )
      expect(capped.candidates).toHaveLength(1)
      expect(capped.skipped.some((entry) => entry.reason === 'candidate-cap')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  test('a broken git root reports errors instead of throwing', async () => {
    const discover = makeRecoveryDiscovery(DEFAULT_LIMITS)
    const { candidates, errors } = await discover(RECOVERY_ROADMAP, '/nonexistent/nowhere')
    expect(candidates).toEqual([])
    expect(errors.join('; ')).toMatch(/for-each-ref failed/)
  })

  test('a worktree path that cannot be stat-probed is skipped as worktree-probe-fault', async () => {
    // A permission fault (EACCES) on the worktree probe is neither present nor
    // absent: it must skip the branch distinctly and record an error, not fall
    // through to missing-worktree. Remove search permission on the worktrees
    // parent so fs.stat of the registered worktree path raises EACCES. Root
    // bypasses permission bits, so skip there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const repo = makeRecoveryRepo()
    const worktreesParent = join(repo.root, 'worktrees')
    try {
      chmodSync(worktreesParent, 0o000)
      const { candidates, skipped, errors } = await makeRecoveryDiscovery(DEFAULT_LIMITS)(RECOVERY_ROADMAP, repo.dir)
      expect(candidates.map((candidate) => candidate.taskId)).not.toContain('1.2.3')
      const entry = skipped.find((item) => item.branchName === 'roadmap-1-2-3')
      expect(entry?.reason).toBe('worktree-probe-fault')
      expect(errors.some((error) => /worktree probe failed for roadmap-1-2-3/.test(error))).toBe(true)
    } finally {
      chmodSync(worktreesParent, 0o755)
      repo.cleanup()
    }
  })
})

describe('readExecplanState', () => {
  test('reads the committed plan status from the worktree', async () => {
    const repo = makeRecoveryRepo({ parserExecplanStatus: 'IN PROGRESS' })
    try {
      const state = await readExecplanState({
        worktreePath: repo.parserWorktree,
        execplanPath: 'docs/execplans/roadmap-1-2-3.md',
      })
      expect(state.status).toBe('in-progress')
    } finally {
      repo.cleanup()
    }
  })

  test('missing plans and unreadable plans stay distinct', async () => {
    const repo = makeRecoveryRepo()
    try {
      expect((await readExecplanState({ worktreePath: repo.parserWorktree, execplanPath: '' })).status).toBe('missing')
      expect(
        (await readExecplanState({ worktreePath: repo.parserWorktree, execplanPath: 'docs/absent.md' })).status,
      ).toBe('missing')
      const unreadable = await readExecplanState({
        worktreePath: repo.parserWorktree,
        execplanPath: 'docs/execplans/roadmap-1-2-3.md\0',
      })
      expect(unreadable.status).toBe('unreadable')
      expect(unreadable.error).toMatch(/roadmap-1-2-3/)
    } finally {
      repo.cleanup()
    }
  })
})

describe('recoveryExecplanPath and syntheticRecoveryImpl', () => {
  test('resolves the canonical plan when present and stays absent when not', async () => {
    const withPlan = makeRecoveryRepo()
    const withoutPlan = makeRecoveryRepo({ withParserExecplan: false })
    try {
      const present = await recoveryExecplanPath({
        branchName: 'roadmap-1-2-3',
        worktreePath: withPlan.parserWorktree,
      })
      expect(present).toEqual({ execplanPath: 'docs/execplans/roadmap-1-2-3.md', error: '' })

      const absent = await recoveryExecplanPath({
        branchName: 'roadmap-1-2-3',
        worktreePath: withoutPlan.parserWorktree,
      })
      expect(absent).toEqual({ execplanPath: '', error: '' })
    } finally {
      withPlan.cleanup()
      withoutPlan.cleanup()
    }
  })

  test('a filesystem fault surfaces as an error, distinct from an absent plan', async () => {
    const repo = makeRecoveryRepo()
    try {
      // A NUL byte makes the stat fail with a non-ENOENT error: the fault
      // must be reported, never conflated with "no plan on disk".
      const fault = await recoveryExecplanPath({
        branchName: 'roadmap-1-2-3',
        worktreePath: `${repo.parserWorktree}\0`,
      })
      expect(fault.execplanPath).toBe('')
      expect(fault.error).toMatch(/stat failed/)
    } finally {
      repo.cleanup()
    }
  })

  test('the synthetic implementation mirrors IMPL_SCHEMA and flags fresh review', async () => {
    const repo = makeRecoveryRepo()
    try {
      const impl = await syntheticRecoveryImpl(
        { branchName: 'roadmap-1-2-3', worktreePath: repo.parserWorktree, execplanPath: 'docs/execplans/roadmap-1-2-3.md' },
        { recentCommits: ['abc Work on roadmap-1-2-3'] },
      )
      expect(impl.ok).toBe(true)
      expect(impl.gatesGreen).toBe(true)
      expect(impl.execplanPath).toBe('docs/execplans/roadmap-1-2-3.md')
      expect(impl.commits).toEqual(['abc Work on roadmap-1-2-3'])
      expect(impl.openIssues).toContain('recovered branch requires fresh review')
    } finally {
      repo.cleanup()
    }
  })
})

describe('computeHeldFromDiscovery', () => {
  test('holds resumable and hold-reason branches out of selection, but not completed ones', async () => {
    // This is the guard the always-on stale-branch path (issue #33) relies on:
    // a surviving `roadmap-*` branch with no live worktree (roadmap-1-2-4)
    // must be held so ordinary selection never re-opens it and collides on
    // `git worktree add -b`, whereas an already-complete branch (roadmap-2-1-1)
    // and unmapped branches must NOT be held.
    const repo = makeRecoveryRepo()
    try {
      const discovery = await makeRecoveryDiscovery(DEFAULT_LIMITS)(RECOVERY_ROADMAP, repo.dir)
      const held = computeHeldFromDiscovery(discovery)
      // roadmap-1-2-3 is a resumable candidate (has a worktree); roadmap-1-2-4
      // survives with no worktree (missing-worktree, a hold reason).
      expect([...held.normal].sort()).toEqual(['1.2.3', '1.2.4'])
      expect(held.normal.has('2.1.1')).toBe(false)
      expect(held.addendum.size).toBe(0)
    } finally {
      repo.cleanup()
    }
  })

  test('routes an addendum branch to the addendum lane only', () => {
    // A cap skip keeps the branch mapped to a selectable id; an addendum branch
    // (roadmap-2-1-2-addendum) must hold only the addendum lane so the normal
    // lane for the same parent id stays free.
    const held = computeHeldFromDiscovery({
      candidates: [],
      skipped: [{ id: '2.1.2', branchName: 'roadmap-2-1-2-addendum', reason: 'candidate-cap' }],
      errors: [],
    })
    expect(held.addendum.has('2.1.2')).toBe(true)
    expect(held.normal.has('2.1.2')).toBe(false)
  })
})

describe('RECOVERY_HOLD_REASONS', () => {
  test('holds exactly the reasons whose branches must not be re-opened', () => {
    expect([...RECOVERY_HOLD_REASONS].sort()).toEqual([
      'assessment-error',
      'candidate-cap',
      'missing-worktree',
      'unreadable-commit',
      'worktree-probe-fault',
    ])
  })
})
