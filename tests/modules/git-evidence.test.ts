// Module tests for the git evidence collectors (decomposition milestone 4):
// name-status and porcelain parsing tables, and collectAssessmentEvidence
// against real throwaway repositories in the states the assessor must
// distinguish (committed-only, dirty plus staged plus untracked, missing
// base, unreachable worktree).
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectAssessmentEvidence,
  directoryExists,
  parseNameStatus,
  parsePorcelainDirty,
  readFileText,
} from '../../src/workflows/df12-build-odw/git-evidence.ts'

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
  const dir = mkdtempSync(path.join(tmpdir(), 'evidence-module-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-m', 'Initial fixture')
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD') }
}

describe('parseNameStatus', () => {
  test('parses plain and renamed entries, dropping blanks', () => {
    const parsed = parseNameStatus('M\tsrc/a.js\nR100\told.js\tnew.js\n\nA\tdocs/b.md\n')
    expect(parsed).toEqual([
      { status: 'M', path: 'src/a.js' },
      { status: 'R100', path: 'new.js', oldPath: 'old.js' },
      { status: 'A', path: 'docs/b.md' },
    ])
  })

  test('empty and null-ish input parse to an empty list', () => {
    expect(parseNameStatus('')).toEqual([])
    expect(parseNameStatus(null)).toEqual([])
  })
})

describe('parsePorcelainDirty', () => {
  test('keeps untracked and worktree-side changes, drops index-only ones', () => {
    const parsed = parsePorcelainDirty('?? new.txt\nM  staged-only.txt\n M worktree.txt\nMM both.txt\n')
    expect(parsed).toEqual([
      { status: '??', path: 'new.txt' },
      { status: 'M', path: 'worktree.txt' },
      { status: 'M', path: 'both.txt' },
    ])
  })
})

describe('collectAssessmentEvidence', () => {
  test('a clean committed branch reports clean state and its commits', async () => {
    const { dir, baseSha } = makeRepo()
    git(dir, 'checkout', '-b', 'roadmap-1-1-1')
    writeFileSync(path.join(dir, 'feature.txt'), 'work\n')
    git(dir, 'add', 'feature.txt')
    git(dir, 'commit', '-m', 'Implement 1.1.1')

    const evidence = await collectAssessmentEvidence(
      { id: '1.1.1', title: 'Feature' },
      { worktreePath: dir, baseSha, branch: 'roadmap-1-1-1' },
    )
    expect(evidence.collectionErrors).toEqual([])
    expect(evidence.dirtyState).toBe('clean')
    expect(evidence.changedFiles).toEqual(['feature.txt'])
    expect(evidence.recentCommits).toHaveLength(1)
    expect(evidence.recentCommits[0]).toMatch(/Implement 1\.1\.1/)
  })

  test('dirty, staged, and untracked files all surface in changedFiles', async () => {
    const { dir, baseSha } = makeRepo()
    writeFileSync(path.join(dir, 'README.md'), '# Changed\n')
    writeFileSync(path.join(dir, 'staged.txt'), 's\n')
    git(dir, 'add', 'staged.txt')
    writeFileSync(path.join(dir, 'untracked.txt'), 'u\n')

    const evidence = await collectAssessmentEvidence(
      { id: '1.1.2', title: 'Dirty' },
      { worktreePath: dir, baseSha, branch: 'main' },
    )
    expect(evidence.dirtyState).toBe('dirty')
    expect(evidence.changedFiles).toEqual(['README.md', 'staged.txt', 'untracked.txt'])
  })

  test('a missing base accumulates errors instead of throwing', async () => {
    const { dir } = makeRepo()
    const evidence = await collectAssessmentEvidence(
      { id: '1.1.3', title: 'No base' },
      { worktreePath: dir, baseSha: '', branch: 'main' },
    )
    expect(evidence.collectionErrors.join('; ')).toMatch(/missing base commit/)
  })

  test('an unreachable worktree reports collection errors, not a crash', async () => {
    const evidence = await collectAssessmentEvidence(
      { id: '1.1.4', title: 'Gone' },
      { worktreePath: '/nonexistent/nowhere', baseSha: 'abc', branch: '' },
    )
    expect(evidence.dirtyState).toBe('unknown')
    expect(evidence.collectionErrors.length).toBeGreaterThan(0)
  })
})

describe('small readers', () => {
  test('readFileText and directoryExists behave on present and absent paths', async () => {
    const { dir } = makeRepo()
    expect(await readFileText(path.join(dir, 'README.md'))).toBe('# Fixture\n')
    expect(await directoryExists(dir)).toEqual({ ok: true, exists: true, detail: '' })
    expect(await directoryExists(path.join(dir, 'README.md'))).toEqual({ ok: true, exists: false, detail: '' })
    expect(await directoryExists('')).toEqual({ ok: true, exists: false, detail: '' })
    const fault = await directoryExists(`${dir}\0bad`)
    expect(fault.ok).toBe(false)
    expect(fault.detail).toMatch(/stat failed/)
  })

  test('readFileText refuses to follow a symlink at the read path', async () => {
    const { dir } = makeRepo()
    const link = path.join(dir, 'plan-link.md')
    symlinkSync(path.join(dir, 'README.md'), link)
    await expect(readFileText(link)).rejects.toThrow()
  })

  test('with a worktree root, a symlinked parent directory escape is rejected', async () => {
    const { dir } = makeRepo()
    // docs/ is a symlink to a sibling tree outside the worktree; the plan
    // path resolves through it, so realpath containment must reject it even
    // though the final component is a real file.
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'outside-'))
    writeFileSync(path.join(outsideRoot, 'plan.md'), '# outside\n')
    symlinkSync(outsideRoot, path.join(dir, 'docs'))
    await expect(readFileText(path.join(dir, 'docs', 'plan.md'), dir)).rejects.toThrow(/escapes the worktree/)
  })

  test('with a worktree root, an in-worktree read still succeeds', async () => {
    const { dir } = makeRepo()
    expect(await readFileText(path.join(dir, 'README.md'), dir)).toBe('# Fixture\n')
  })
})
