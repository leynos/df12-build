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

  test('fixPrompt carries the CodeScene suppression syntax and smell glossary when csCheck is on', () => {
    const text = prompts.fixPrompt(task, worktree, plan, ['CODESCENE RED: Complex Method'], 1)
    expect(text).toContain('@codescene(disable:')
    expect(text).toContain('Bumpy Road')
    expect(text).toContain('Primitive Obsession')
    // Disabling the check removes the guidance from the prompt.
    const off = makePrompts(makeConfig({ csCheck: false }))
    expect(off.fixPrompt(task, worktree, plan, ['x'], 1)).not.toContain('@codescene(disable:')
  })

  test('implementWorkItemPrompt notes the CodeScene check runs after the gates, before CodeRabbit', () => {
    const item = { text: 'WI-1: add the parser' }
    const text = prompts.implementWorkItemPrompt(task, worktree, plan, item)
    expect(text).toContain('CODE HEALTH')
    expect(text).toContain('CodeScene')
  })
})

describe('dual review prompts', () => {
  test('codeReviewPrompt benchmarks against the plan and the configured gates', () => {
    const text = prompts.codeReviewPrompt(task, worktree, plan)
    expect(text).toContain(task.id)
    expect(text).toContain(plan.execplanPath)
    expect(text).toContain(config.COMMIT_GATE_TEXT)
  })

  test('expertReviewPrompt scopes the crew to the task and its plan', () => {
    const text = prompts.expertReviewPrompt(task, worktree, plan)
    expect(text).toContain(task.id)
    expect(text).toContain(plan.execplanPath)
  })
})

describe('addendum prompts', () => {
  const addendum = { ...task, id: '1.2.8', isAddendum: true, subtasks: ['1.2.8.5', '1.2.8.6'] }

  test('addendumReviewPrompt names the sub-tasks, the parent plan, and the builder evidence', () => {
    const impl = { summary: 'complete but review deferred', openIssues: ['coderabbit 429 rate limit'] }
    const text = prompts.addendumReviewPrompt(addendum, worktree, impl)
    expect(text).toContain('1.2.8.5, 1.2.8.6')
    expect(text).toContain('docs/execplans/roadmap-1-2-8.md')
    expect(text).toContain('complete but review deferred')
    expect(text).toContain('1. coderabbit 429 rate limit')
  })

  test('implementAddendumPrompt scopes the pass to the open sub-tasks and parent plan', () => {
    const text = prompts.implementAddendumPrompt(addendum, worktree)
    expect(text).toContain('1.2.8.5, 1.2.8.6')
    expect(text).toContain('docs/execplans/roadmap-1-2-8.md')
    expect(text).toContain(config.COMMIT_GATE_TEXT)
  })

  test('integratePrompt in the addendum lane ticks sub-tasks and preserves the parent', () => {
    const text = prompts.integratePrompt(addendum, worktree)
    expect(text).toContain(`origin/${config.BASE}`)
    expect(text).toContain('[1.2.8.5, 1.2.8.6]')
    expect(text).toContain('LEAVE the parent 1.2.8')
  })
})

describe('integration and audit prompts', () => {
  test('integratePrompt targets the configured base branch', () => {
    const text = prompts.integratePrompt(task, worktree)
    expect(text).toContain(`origin/${config.BASE}`)
  })

  test('auditPrompt names the task and writes findings when documentAudit is on', () => {
    const text = prompts.auditPrompt(task, worktree)
    expect(text).toContain(task.id)
    expect(text).toContain(`docs/issues/audit-${task.id}.md`)
  })

  test('auditPrompt with documentAudit=false reports findings without writing', () => {
    const reportOnly = makePrompts(makeConfig({ documentAudit: false }))
    const text = reportOnly.auditPrompt(task, worktree)
    expect(text).not.toContain(`docs/issues/audit-${task.id}.md`)
    expect(text).toMatch(/return findings only/i)
  })
})
