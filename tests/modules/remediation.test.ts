// Module tests for remediation triage (decomposition milestone 8): the step
// grouping key, the lane contract in the triage schema, and the prompt/agent
// wiring for a settled step's proposals.
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  TRIAGE_SCHEMA,
  makeRemediation,
  stepOf,
} from '../../src/workflows/df12-build-odw/remediation.ts'

const globals = globalThis as Record<string, unknown>
globals.log = () => {}
globals.phase = () => {}

// bun test runs every module suite in one process, so start each test with a
// clean agent global rather than whatever a sibling suite left behind.
beforeEach(() => {
  delete globals.agent
})

function subject() {
  return makeRemediation({
    preamble: (worktree) => `PREAMBLE ${worktree || '<none>'}`,
    base: 'main',
    roadmap: 'docs/roadmap.md',
    triageAgentOptions: (options) => ({ adapter: 'codex', ...options }),
  })
}

describe('stepOf', () => {
  test('groups any roadmap id by its phase.step prefix', () => {
    expect(stepOf('1.2.3')).toBe('1.2')
    expect(stepOf('1.2.3.4')).toBe('1.2')
    expect(stepOf('7.4')).toBe('7.4')
    expect(stepOf('3')).toBe('3')
  })
})

describe('TRIAGE_SCHEMA', () => {
  test('pins the five triage lanes and the decision contract', () => {
    expect(TRIAGE_SCHEMA.properties.decisions.items.properties.lane.enum).toEqual([
      'addendum',
      'step-task',
      'reroute',
      'editorial',
      'dropped',
    ])
    expect(TRIAGE_SCHEMA.properties.decisions.items.required).toEqual(['proposal', 'lane', 'reason'])
    expect(TRIAGE_SCHEMA.required).toEqual(['ok', 'decisions', 'summary'])
  })
})

describe('makeRemediation', () => {
  const proposals = [
    { title: 'Fix flaky fixture teardown', rationale: 'audit:1.2.3', severity: 'low' },
    { title: 'Harden the merge queue', rationale: 'review:1.2.4' },
  ]

  test('triagePrompt names the step, the roadmap, the base branch, and every proposal', () => {
    const { triagePrompt } = subject()
    const prompt = triagePrompt('1.2', proposals)
    expect(prompt).toContain('step 1.2')
    expect(prompt).toContain('docs/roadmap.md')
    expect(prompt).toContain('origin/main')
    expect(prompt).toContain('Fix flaky fixture teardown')
    expect(prompt).toContain('Harden the merge queue')
    expect(prompt).toContain('PREAMBLE <none>')
  })

  test('runTriage dispatches one triage agent with the schema and Remediation phase', async () => {
    const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = []
    globals.agent = async (prompt: string, opts: Record<string, unknown>) => {
      calls.push({ prompt, opts })
      return { ok: true, decisions: [], summary: 'triaged' }
    }
    const { runTriage } = subject()
    const outcome = await runTriage('1.2', proposals)
    expect(outcome).toEqual({ ok: true, decisions: [], summary: 'triaged' })
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.label).toBe('triage:1.2')
    expect(calls[0].opts.phase).toBe('Remediation')
    expect(calls[0].opts.schema).toBe(TRIAGE_SCHEMA)
    expect(calls[0].opts.adapter).toBe('codex')
  })
})
