// Module tests for remediation triage (decomposition milestone 8): the step
// grouping key, the lane contract in the triage schema, and the prompt/agent
// wiring for a settled step's proposals.
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  TRIAGE_SCHEMA,
  dedupeProposals,
  makeRemediation,
  stepOf,
  triageNeedsEscalation,
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
    worktreeSafetyNet: (base) => `SAFETY-NET ${base}`,
    base: 'main',
    roadmap: 'docs/roadmap.md',
    triageAgentOptions: (options) => ({ adapter: 'codex', ...options }),
    triageEscalationModel: 'gpt-5.5@high',
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

describe('dedupeProposals', () => {
  test('collapses exact-title duplicates and unions their sources', () => {
    const deduped = dedupeProposals([
      { title: 'Fix flaky teardown', rationale: 'audit:1.2.3' },
      { title: 'fix flaky teardown', rationale: 'review:1.2.4' },
      { title: 'Harden the queue', rationale: 'review:1.2.4' },
    ])
    expect(deduped).toHaveLength(2)
    const flaky = deduped.find((p) => /flaky/i.test(String(p.title)))
    expect((flaky as { sources?: string[] }).sources?.sort()).toEqual(['audit:1.2.3', 'review:1.2.4'])
  })

  test('drops titleless proposals', () => {
    expect(dedupeProposals([{ rationale: 'audit:1.1.1' }])).toHaveLength(0)
  })
})

describe('triageNeedsEscalation', () => {
  test('escalates only when proposals span more than one source', () => {
    expect(triageNeedsEscalation([{ title: 'a', sources: ['audit:1.2.3'] }])).toBe(false)
    expect(triageNeedsEscalation([{ title: 'a', sources: ['audit:1.2.3', 'review:1.2.4'] }])).toBe(true)
    expect(triageNeedsEscalation([
      { title: 'a', sources: ['audit:1.2.3'] },
      { title: 'b', sources: ['review:1.2.4'] },
    ])).toBe(true)
  })
})

describe('runTriage tiering', () => {
  test('a single-source set stays on the medium default; a multi-source set escalates', async () => {
    const models: string[] = []
    globals.agent = async (_prompt: string, opts: Record<string, unknown> = {}) => {
      models.push(String(opts.model || '<default>'))
      return { ok: true, decisions: [], summary: 'triaged' }
    }
    const { runTriage } = makeRemediation({
      preamble: () => 'P',
      worktreeSafetyNet: () => 'SN',
      base: 'main',
      roadmap: 'docs/roadmap.md',
      triageAgentOptions: (options: Record<string, unknown>) => ({ adapter: 'codex', model: 'gpt-5.5', ...options }),
      triageEscalationModel: 'gpt-5.5@high',
    })
    await runTriage('1.2', [{ title: 'x', rationale: 'audit:1.2.3' }])
    await runTriage('1.2', [
      { title: 'x', rationale: 'audit:1.2.3' },
      { title: 'y', rationale: 'review:1.2.4' },
    ])
    expect(models[0]).toBe('gpt-5.5')
    expect(models[1]).toBe('gpt-5.5@high')
  })

  test('an all-duplicate set is dropped deterministically with no agent call', async () => {
    let called = false
    globals.agent = async () => {
      called = true
      return { ok: true, decisions: [], summary: 'x' }
    }
    const { runTriage } = makeRemediation({
      preamble: () => 'P',
      worktreeSafetyNet: () => 'SN',
      base: 'main',
      roadmap: 'docs/roadmap.md',
      triageAgentOptions: (options: Record<string, unknown>) => options,
      triageEscalationModel: 'gpt-5.5@high',
    })
    const outcome = await runTriage('1.2', [{ rationale: 'audit:1.2.3' }, { title: '', rationale: 'x' }])
    expect(called).toBe(false)
    expect((outcome as { decisions: unknown[] }).decisions).toEqual([])
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

  test('triagePrompt threads the injected worktree safety-net for the base branch', () => {
    const { triagePrompt } = subject()
    const prompt = triagePrompt('1.2', proposals)
    expect(prompt).toContain('SAFETY-NET main')
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
