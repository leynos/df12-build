// Module tests for host-enforced ExecPlan durability (decomposition
// milestone 7). Plan paths come back from planner agents — untrusted,
// prompt-injectable data — so containment must fail closed BEFORE any
// filesystem or git access, and durability checks must distinguish
// "not committed" from "the environment would not answer".
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  commitExecplanApproval,
  commitExecplanDraft,
  execplanRelPath,
  verifyExecplanCommitted,
  verifyWorktreeCommitted,
} from '../../src/workflows/df12-build-odw/execplan-durability.ts'

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
    expect(await commitExecplanApproval(dir, PLAN, '1.2.3')).toEqual({ ok: true, detail: '' })
    expect(readFileSync(path.join(dir, PLAN), 'utf8')).toContain('Status: APPROVED')
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Approve ExecPlan for task 1.2.3')
    expect(git(dir, 'status', '--porcelain=v1')).toBe('')

    const again = await commitExecplanApproval(dir, PLAN, '1.2.3')
    expect(again.ok).toBe(true)
    expect(again.detail).toBe('already committed as APPROVED')
  })

  test('appends a Status line when the plan lacks one', async () => {
    const dir = makeWorktree('# ExecPlan without status\n')
    expect((await commitExecplanApproval(dir, PLAN, '1.2.3')).ok).toBe(true)
    expect(readFileSync(path.join(dir, PLAN), 'utf8')).toMatch(/\n\nStatus: APPROVED\n$/)
  })
})

describe('commitExecplanDraft', () => {
  test('commits the plan when it is the only dirty path', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, PLAN), '# ExecPlan\n\nStatus: DRAFT\n\nRevised.\n')
    expect(await commitExecplanDraft(dir, PLAN, '1.2.3')).toEqual({ ok: true, detail: '' })
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Draft ExecPlan for task 1.2.3')
    expect(git(dir, 'status', '--porcelain=v1')).toBe('')
  })

  test('bounces when other paths are dirty, and when nothing is dirty', async () => {
    const dir = makeWorktree()
    writeFileSync(path.join(dir, PLAN), 'revised\n')
    writeFileSync(path.join(dir, 'stray.txt'), 'stray\n')
    const bounced = await commitExecplanDraft(dir, PLAN, '1.2.3')
    expect(bounced.ok).toBe(false)
    expect(bounced.detail).toMatch(/beyond the plan file/)
    expect(bounced.detail).toContain('stray.txt')

    const clean = makeWorktree()
    const nothing = await commitExecplanDraft(clean, PLAN, '1.2.3')
    expect(nothing.ok).toBe(false)
    expect(nothing.detail).toMatch(/already clean/)
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
