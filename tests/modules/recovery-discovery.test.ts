// Module tests for fresh-run recovery discovery (decomposition milestone 4):
// makeRecoveryDiscovery against the shared recovery fixture repo, the
// committed-ExecPlan reader, and the synthetic implementation bridge.
import { describe, expect, test } from 'bun:test'

import { makeRecoveryRepo, RECOVERY_ROADMAP } from '../fixtures/recovery-repo.mjs'
import {
  RECOVERY_HOLD_REASONS,
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
