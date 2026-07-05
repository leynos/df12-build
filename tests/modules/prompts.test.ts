// Module tests for the prompt builders (decomposition milestone 5). These
// pin data flow — task ids, paths, round numbers, blocking items, and
// configured guidance reaching the prompt text — never prose wording, which
// must stay freely editable.
import { describe, expect, test } from 'bun:test'

import { makeConfig } from '../../src/workflows/df12-build-odw/config.ts'
import { makePrompts } from '../../src/workflows/df12-build-odw/prompts.ts'

const config = makeConfig({})
const prompts = makePrompts(config)

const task = { id: '1.2.3', title: 'Implement the parser', requires: ['1.2.1'], rationale: '', isAddendum: false, subtasks: [] }
const worktree = '/tmp/project.worktrees/roadmap-1-2-3'
const plan = { execplanPath: 'docs/execplans/roadmap-1-2-3.md', workItems: ['a', 'b'], summary: 'Plan.' }

describe('preamble', () => {
  test('binds the worktree path when given, and stays read-only when not', () => {
    expect(prompts.preamble(worktree)).toContain(worktree)
    expect(prompts.preamble(null)).toMatch(/read-only/i)
  })
})

describe('code search guidance', () => {
  test('grepai backend names the workspace and project in the command', () => {
    const grepai = makePrompts(makeConfig({ project: 'df12-build' }))
    expect(grepai.codeSearchGuidance()).toContain("--workspace 'Projects'")
    expect(grepai.codeSearchGuidance()).toContain("--project 'df12-build'")
  })

  test('memtrace backend names the repo id and an unsupported backend throws', () => {
    const memtrace = makePrompts(makeConfig({ memtraceRepoId: 'repo-1' }))
    expect(memtrace.codeSearchGuidance()).toContain("repo_id 'repo-1'")
    const broken = makePrompts(makeConfig({ searchBackend: 'sourcegraph' }))
    expect(() => broken.codeSearchGuidance()).toThrow(/Unsupported searchBackend/)
  })
})

describe('planning prompts', () => {
  test('round one and revision rounds carry the round state and blocking items', () => {
    const first = prompts.planPrompt(task, worktree, null, 1)
    expect(first).toContain(task.id)
    expect(first).toContain('first planning round')

    const revised = prompts.planPrompt(task, worktree, { blocking: ['missing rollback story'] }, 2)
    expect(revised).toContain('round 2')
    expect(revised).toContain('missing rollback story')
  })

  test('design review names the plan path and the round', () => {
    const text = prompts.designReviewPrompt(task, worktree, plan, 3)
    expect(text).toContain(plan.execplanPath)
    expect(text).toContain(task.id)
  })
})

describe('implementation and fix prompts', () => {
  test('implementPrompt cites the execplan path and the commit gates', () => {
    const text = prompts.implementPrompt(task, worktree, plan)
    expect(text).toContain(plan.execplanPath)
    expect(text).toContain(config.COMMIT_GATE_TEXT)
  })

  test('fixPrompt enumerates every blocking item', () => {
    const text = prompts.fixPrompt(task, worktree, plan, ['broken test', 'missing doc'], 2)
    expect(text).toContain('broken test')
    expect(text).toContain('missing doc')
  })
})

describe('integration and audit prompts', () => {
  test('integratePrompt targets the configured base branch', () => {
    const text = prompts.integratePrompt(task, worktree)
    expect(text).toContain(`origin/${config.BASE}`)
  })

  test('auditPrompt names the task and worktree', () => {
    const text = prompts.auditPrompt(task, worktree)
    expect(text).toContain(task.id)
  })
})
