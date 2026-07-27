/** @file Tests for injected deterministic worktree collision provisioning. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import { execFileStatus, execFileText } from '../../src/workflows/df12-build-odw/exec.ts'
import { makeWorktreeProvisioning } from '../../src/workflows/df12-build-odw/worktree-provisioning.ts'
import { makeRecoveryRepo } from '../fixtures/recovery-repo.mjs'

function provisioningFor(repo: ReturnType<typeof makeRecoveryRepo>, events: string[] = []) {
  const options = { cwd: repo.dir, timeoutMs: 5_000 }
  return makeWorktreeProvisioning({
    base: 'main',
    gitTimeoutMs: 5_000,
    execFileStatus: (command, args, overrides = {}) => execFileStatus(command, args, { ...options, ...overrides }),
    execFileText: (command, args, overrides = {}) => execFileText(command, args, { ...options, ...overrides }),
    readRoadmap: async () => ({ text: readFileSync(path.join(repo.dir, 'docs/roadmap.md'), 'utf8') }),
    log: (message) => events.push(message),
  })
}

describe('makeWorktreeProvisioning', () => {
  test('reclaims an orphaned merged stale addendum branch from the fixture', async () => {
    const repo = makeRecoveryRepo({ withStaleAddendumBranch: true })
    try {
      const events: string[] = []
      const target = path.join(repo.root, 'reclaimed-addendum')
      const result = await provisioningFor(repo, events).provisionWorktreeForBranch({
        branch: repo.staleAddendumBranch,
        worktreePath: target,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.resolvedWorktreePath).toBe(target)
      expect((await execFileText('git', ['-C', target, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })).trim()).toBe(repo.baseSha)
      expect(events.join('\n')).toContain('"disposition":"reclaim"')
    } finally {
      repo.cleanup()
    }
  })

  test('refuses a clean registered stale branch without resetting its worktree', async () => {
    const repo = makeRecoveryRepo({ withStaleAddendumBranch: true, staleAddendumWorktree: true })
    try {
      const before = await execFileText('git', ['-C', repo.staleAddendumWorktreePath, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })
      const result = await provisioningFor(repo).provisionWorktreeForBranch({
        branch: repo.staleAddendumBranch,
        worktreePath: path.join(repo.root, 'must-not-be-created'),
      })
      expect(result).toEqual(expect.objectContaining({ ok: false }))
      if (!result.ok) expect(result.reason).toContain('registered clean worktree')
      expect(await execFileText('git', ['-C', repo.staleAddendumWorktreePath, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })).toBe(before)
    } finally {
      repo.cleanup()
    }
  })
})
