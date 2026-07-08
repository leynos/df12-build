// Module tests for host-enforced ExecPlan durability (decomposition
// milestone 7). Plan paths come back from planner agents — untrusted,
// prompt-injectable data — so containment must fail closed BEFORE any
// filesystem or git access, and durability checks must distinguish
// "not committed" from "the environment would not answer".
import { describe, expect, spyOn, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'

import {
  commitExecplanApproval,
  commitExecplanDraft,
  execplanRelPath,
  isTaskArtefactPath,
  salvageTaskArtefacts,
  verifyExecplanCommitted,
  verifyWorktreeCommitted,
} from '../../src/workflows/df12-build-odw/execplan-durability.ts'
import * as exec from '../../src/workflows/df12-build-odw/exec.ts'

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

const PLAN = 'docs/execplans/roadmap-1-2-3.md'

function makeWorktree(planText = '# ExecPlan\n\nStatus: DRAFT\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'durability-'))
  git(dir, 'init', '-b', 'main')
  mkdirSync(path.join(dir, 'docs', 'execplans'), { recursive: true })
  writeFileSync(path.join(dir, PLAN), planText)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Commit plan')
  return dir
}

describe('execplanRelPath containment', () => {
  test('accepts in-worktree relative and absolute paths', () => {
    expect(execplanRelPath('/wt', 'docs/plan.md')).toEqual({ ok: true, relPath: 'docs/plan.md', detail: '' })
    expect(execplanRelPath('/wt', '/wt/docs/plan.md')).toEqual({ ok: true, relPath: 'docs/plan.md', detail: '' })
    expect(execplanRelPath('/wt', 'docs/../docs/plan.md').relPath).toBe('docs/plan.md')
  })

  test('fails closed on every escape shape before any I/O', () => {
    const cases = ['', '.', '..', '../outside.md', 'docs/../../outside.md', '/etc/passwd', '/wt-evil/plan.md']
    for (const planPath of cases) {
      const contained = execplanRelPath('/wt', planPath)
      expect(contained.ok, planPath).toBe(false)
      expect(contained.relPath, planPath).toBe('')
      expect(contained.detail, planPath).toMatch(/escapes the assigned worktree/)
    }
  })

  test('containment holds across fuzzed untrusted planner paths', () => {
    // Planner output is untrusted, prompt-injectable data: for ANY string,
    // an accepted path must resolve inside the worktree and a rejected one
    // must carry no usable relPath. Structured segments bias the search
    // toward traversal shapes; plain strings cover the rest.
    const segmentPath = fc
      .array(fc.constantFrom('..', '.', 'docs', 'execplans', 'plan.md', '~', 'a b', '...'), { maxLength: 6 })
      .map((parts) => parts.join('/'))
    const plannerPath = fc.oneof(
      fc.string(),
      segmentPath,
      segmentPath.map((p) => `/${p}`),
      segmentPath.map((p) => `/wt/${p}`),
      segmentPath.map((p) => `/wt-evil/${p}`),
    )
    fc.assert(
      fc.property(plannerPath, (planPath) => {
        const contained = execplanRelPath('/wt', planPath)
        if (contained.ok) {
          const resolved = path.resolve('/wt', contained.relPath)
          expect(resolved).not.toBe('/wt')
          expect(resolved.startsWith('/wt/')).toBe(true)
        } else {
          expect(contained.relPath).toBe('')
          expect(contained.detail).toMatch(/escapes the assigned worktree/)
        }
      }),
    )
  })
})

describe('verifyExecplanCommitted', () => {
  test('a committed, clean plan is durable', async () => {
    const dir = makeWorktree()
    expect(await verifyExecplanCommitted(dir, PLAN)).toEqual({ ok: true, detail: '' })
  })

  test('uncommitted modifications and missing-at-HEAD both fail with distinct detail', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nEdited.\n')
    const dirty = await verifyExecplanCommitted(dir, PLAN)
    expect(dirty.ok).toBe(false)
    expect(dirty.detail).toMatch(/uncommitted modifications/)

    const absent = await verifyExecplanCommitted(dir, 'docs/execplans/other.md')
    expect(absent.ok).toBe(false)
    expect(absent.detail).toMatch(/not committed at HEAD/)
  })

  test('an escaping path is rejected without touching git', async () => {
    const escape = await verifyExecplanCommitted('/nonexistent/worktree', '../../etc/passwd')
    expect(escape.ok).toBe(false)
    expect(escape.detail).toMatch(/escapes the assigned worktree/)
  })
})

describe('commitExecplanApproval', () => {
  test('flips the committed status to APPROVED exactly once', async () => {
    const dir = makeWorktree()
    expect(await commitExecplanApproval({ worktree: dir, planPath: PLAN, tag: '1.2.3' })).toEqual({ ok: true, detail: '' })
    expect(readFileSync(path.join(dir, PLAN), 'utf8')).toContain('Status: APPROVED')
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Approve ExecPlan for task 1.2.3')
    expect(git(dir, 'status', '--porcelain=v1')).toBe('')

    const again = await commitExecplanApproval({ worktree: dir, planPath: PLAN, tag: '1.2.3' })
    expect(again.ok).toBe(true)
    expect(again.detail).toBe('already committed as APPROVED')
  })

  test('appends a Status line when the plan lacks one', async () => {
    const dir = makeWorktree('# ExecPlan without status\n')
    expect((await commitExecplanApproval({ worktree: dir, planPath: PLAN, tag: '1.2.3' })).ok).toBe(true)
    expect(readFileSync(path.join(dir, PLAN), 'utf8')).toMatch(/\n\nStatus: APPROVED\n$/)
  })
})

describe('symlinked plan paths (untrusted worktree)', () => {
  test('the approval flip refuses to read or write through a committed symlink', async () => {
    const dir = makeWorktree()
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'outside-')), 'target.md')
    writeFileSync(outside, '# Precious file outside the worktree\n')
    unlinkSync(path.join(dir, PLAN))
    symlinkSync(outside, path.join(dir, PLAN))
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'Swap the plan for a symlink')

    const flipped = await commitExecplanApproval({ worktree: dir, planPath: PLAN, tag: '1.2.3' })
    expect(flipped.ok).toBe(false)
    expect(flipped.detail).toMatch(/could not update the plan status/)
    // The symlink target must be untouched: no read-modify-write escape.
    expect(readFileSync(outside, 'utf8')).toBe('# Precious file outside the worktree\n')
  })
})

describe('commitExecplanDraft', () => {
  test('commits the plan when it is the only dirty path', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nRevised.\n')
    expect(await commitExecplanDraft({ worktree: dir, planPath: PLAN, tag: '1.2.3' })).toEqual({ ok: true, detail: '' })
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Draft ExecPlan for task 1.2.3')
    expect(git(dir, 'status', '--porcelain=v1')).toBe('')
  })

  test('bounces when other paths are dirty, and when nothing is dirty', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, PLAN), 'revised\n')
    writeFileSync(path.join(dir, 'stray.txt'), 'stray\n')
    const bounced = await commitExecplanDraft({ worktree: dir, planPath: PLAN, tag: '1.2.3' })
    expect(bounced.ok).toBe(false)
    expect(bounced.detail).toMatch(/beyond the plan file/)
    expect(bounced.detail).toContain('stray.txt')

    const clean = makeWorktree()
    const nothing = await commitExecplanDraft({ worktree: clean, planPath: PLAN, tag: '1.2.3' })
    expect(nothing.ok).toBe(false)
    expect(nothing.detail).toMatch(/already clean/)
  })
})

const REVIEW = 'docs/execplans/roadmap-1-2-3-review.md'

describe('isTaskArtefactPath', () => {
  test('accepts docs/execplans/*.md and rejects everything else', () => {
    expect(isTaskArtefactPath('docs/execplans/roadmap-1-2-3.md')).toBe(true)
    expect(isTaskArtefactPath(REVIEW)).toBe(true)
    expect(isTaskArtefactPath('docs/execplans/notes.txt')).toBe(false)
    expect(isTaskArtefactPath('src/main.ts')).toBe(false)
    expect(isTaskArtefactPath('docs/other/plan.md')).toBe(false)
    expect(isTaskArtefactPath('')).toBe(false)
    expect(isTaskArtefactPath(null)).toBe(false)
  })
})

describe('salvageTaskArtefacts', () => {
  test('commits an eligible untracked artefact onto the branch', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, REVIEW), '# Review notes salvaged before cleanup\n')
    const outcome = await salvageTaskArtefacts(dir, [REVIEW], '1.2.3')
    expect(outcome.detail).toBe('')
    expect(outcome.committed).toEqual([REVIEW])
    expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Salvage task artefacts for task 1.2.3')
    expect(git(dir, 'status', '--porcelain=v1')).toBe('')
    // Only the eligible artefact is committed; a non-artefact dirty path is
    // skipped, not swept into the salvage commit.
    expect(git(dir, 'rev-parse', 'HEAD:docs/execplans/roadmap-1-2-3-review.md')).toMatch(/^[0-9a-f]{40}$/)
  })

  test('skips non-artefact candidates and never sweeps the whole worktree', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, REVIEW), '# Review\n')
    writeFileSync(path.join(dir, 'stray.txt'), 'stray\n')
    const outcome = await salvageTaskArtefacts(dir, [REVIEW, 'stray.txt'], '1.2.3')
    expect(outcome.committed).toEqual([REVIEW])
    expect(outcome.skipped).toEqual([{ path: 'stray.txt', reason: expect.stringContaining('not a task-scoped') }])
    // The stray path is left untracked — salvage is path-scoped.
    expect(git(dir, 'status', '--porcelain=v1')).toBe('?? stray.txt')
  })

  test('rejects a symlink at the candidate path without following it', async () => {
    const dir = makeWorktree()
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'outside-')), 'secret.md')
    writeFileSync(outside, '# Precious file outside the worktree\n')
    symlinkSync(outside, path.join(dir, REVIEW))
    const outcome = await salvageTaskArtefacts(dir, [REVIEW], '1.2.3')
    expect(outcome.committed).toEqual([])
    expect(outcome.detail).toMatch(/nothing to salvage/)
    expect(outcome.skipped).toEqual([{ path: REVIEW, reason: expect.stringContaining('no regular file') }])
    // Nothing committed, and the symlink target is untouched.
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Commit plan')
    expect(readFileSync(outside, 'utf8')).toBe('# Precious file outside the worktree\n')
  })

  test('rejects an artefact-shaped path that escapes the worktree', async () => {
    const dir = makeWorktree()
    const outcome = await salvageTaskArtefacts(dir, ['docs/execplans/../../../etc/passwd.md'], '1.2.3')
    expect(outcome.committed).toEqual([])
    expect(outcome.skipped[0].reason).toMatch(/escapes the assigned worktree/)
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Commit plan')
  })

  test('reports nothing to salvage on a clean tree', async () => {
    const dir = makeWorktree()
    const outcome = await salvageTaskArtefacts(dir, [], '1.2.3')
    expect(outcome).toEqual({ committed: [], skipped: [], sha: '', detail: expect.stringContaining('nothing to salvage') })
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Commit plan')
  })

  test('skips an artefact-shaped candidate that normalizes outside the artefact scope', async () => {
    const dir = makeWorktree()
    // `docs/execplans/../../README.md` passes the RAW artefact pattern but
    // normalizes to `README.md` — still inside the worktree (so containment
    // passes) yet outside the task-artefact scope. Leave README.md dirty so a
    // missing re-check would sweep it into the salvage commit.
    writeFileSync(path.join(dir, 'README.md'), '# top-level readme\n')
    const outcome = await salvageTaskArtefacts(dir, ['docs/execplans/../../README.md'], '1.2.3')
    expect(outcome.committed).toEqual([])
    expect(outcome.detail).toMatch(/nothing to salvage/)
    expect(outcome.skipped[0].reason).toMatch(/normalizes outside the docs\/execplans\/\*\.md artefact scope/)
    // README.md is left dirty — the normalized path was never committed.
    expect(git(dir, 'status', '--porcelain=v1')).toBe('?? README.md')
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Commit plan')
  })

  test('surfaces a rev-parse failure after the commit instead of a clean empty sha', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, REVIEW), '# Review notes\n')
    // Fail ONLY the post-commit `git rev-parse HEAD`; the add and commit run for
    // real, so the artefact is genuinely committed but the sha cannot be read.
    const real = exec.execFileStatus
    const spy = spyOn(exec, 'execFileStatus').mockImplementation(async (command, commandArgs, options) => {
      if (Array.isArray(commandArgs) && commandArgs.includes('rev-parse')) {
        return { ok: false, stdout: '', stderr: 'simulated rev-parse failure', message: 'simulated rev-parse failure' }
      }
      return real(command, commandArgs, options)
    })
    try {
      const outcome = await salvageTaskArtefacts(dir, [REVIEW], '1.2.3')
      // The commit still happened, so `committed` reflects the salvaged set...
      expect(outcome.committed).toEqual([REVIEW])
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('Salvage task artefacts for task 1.2.3')
      // ...but an empty sha must NOT read as a clean success: the failure is
      // surfaced in `detail`, keeping empty sha reserved for nothing-committed.
      expect(outcome.sha).toBe('')
      expect(outcome.detail).toMatch(/reading HEAD failed: simulated rev-parse failure/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('verifyWorktreeCommitted', () => {
  test('clean worktrees pass; dirty ones fail with a bounded sample', async () => {
    const dir = makeWorktree()
    expect(await verifyWorktreeCommitted(dir)).toEqual({ ok: true, detail: '' })

    writeFileSync(path.join(dir, 'loose.txt'), 'x\n')
    const dirty = await verifyWorktreeCommitted(dir)
    expect(dirty.ok).toBe(false)
    expect(dirty.detail).toMatch(/1 uncommitted path/)
    expect(dirty.detail).toContain('loose.txt')
  })
})
