// Property tests for the roadmap parsing module (decomposition milestone 2).
// The roadmap is the single source of scheduling truth, so parsing and
// dependency accounting are checked over generated roadmaps rather than
// hand-picked fixtures.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  completedIds,
  expandStepRange,
  extractRoadmapIds,
  isTaskFullyComplete,
  parseRoadmap,
  selectRoadmapTask,
} from '../../src/workflows/df12-build-odw/roadmap.ts'

describe('expandStepRange', () => {
  test('expands an in-phase ascending range to every step, inclusive', () => {
    fc.assert(
      fc.property(fc.nat(20), fc.nat(30), fc.nat(10), (phase, first, span) => {
        const expanded = expandStepRange(`${phase}.${first}`, `${phase}.${first + span}`)
        expect(expanded).toHaveLength(span + 1)
        expect(expanded[0]).toBe(`${phase}.${first}`)
        expect(expanded[span]).toBe(`${phase}.${first + span}`)
      }),
    )
  })

  test('rejects cross-phase and descending ranges', () => {
    fc.assert(
      fc.property(fc.nat(20), fc.nat(20), fc.nat(9), (phase, step, offset) => {
        expect(expandStepRange(`${phase}.${step + offset + 1}`, `${phase}.${step}`)).toEqual([])
        expect(expandStepRange(`${phase}.${step}`, `${phase + 1}.${step}`)).toEqual([])
      }),
    )
  })

  test('rejects malformed step ids before numeric conversion', () => {
    const invalid = ['', '-1.2', '1.-2', '1', '1.', '.2', '1.2.3', ' 1.2', '1.2 ', '0x1.2', '1e2.3']
    for (const value of invalid) {
      expect(expandStepRange(value, '1.3')).toEqual([])
      expect(expandStepRange('1.1', value)).toEqual([])
    }
  })
})

describe('extractRoadmapIds', () => {
  test('finds every dotted id and expands declared step ranges', () => {
    const ids = extractRoadmapIds('steps 2.1-2.3 and task 4.5.6.')
    expect(ids.sort()).toEqual(['2.1', '2.2', '2.3', '4.5.6'])
  })
})

// A generated roadmap: a flat list of phase.step tasks with random ticks.
const roadmapArb = fc
  .array(
    fc.record({
      phase: fc.integer({ min: 1, max: 4 }),
      step: fc.integer({ min: 1, max: 9 }),
      done: fc.boolean(),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((rows) => {
    const seen = new Set<string>()
    const tasks = rows.filter((row) => {
      const id = `${row.phase}.${row.step}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    tasks.sort((a, b) => a.phase - b.phase || a.step - b.step)
    const text = tasks
      .map((row) => `- [${row.done ? 'x' : ' '}] ${row.phase}.${row.step}. Task ${row.phase}.${row.step}.`)
      .join('\n')
    return { tasks, text }
  })

describe('parseRoadmap', () => {
  test('round-trips ids, ticks, and line numbers from generated roadmaps', () => {
    fc.assert(
      fc.property(roadmapArb, ({ tasks, text }) => {
        const parsed = parseRoadmap(text)
        expect(parsed.tasks.map((task) => task.id)).toEqual(tasks.map((row) => `${row.phase}.${row.step}`))
        for (const [index, task] of parsed.tasks.entries()) {
          expect(isTaskFullyComplete(task)).toBe(tasks[index].done)
          expect(task.line).toBeGreaterThan(0)
        }
      }),
    )
  })

  test('a phase prefix is completed exactly when every task under it is done', () => {
    fc.assert(
      fc.property(roadmapArb, ({ tasks, text }) => {
        const { tasks: parsed } = parseRoadmap(text)
        const completed = completedIds(parsed)
        const phases = new Set(tasks.map((row) => row.phase))
        for (const phase of phases) {
          const inPhase = tasks.filter((row) => row.phase === phase)
          expect(completed.has(String(phase))).toBe(inPhase.every((row) => row.done))
        }
      }),
    )
  })
})

describe('selectRoadmapTask invariants', () => {
  test('never selects a completed or taken task, and picks the earliest line', () => {
    fc.assert(
      fc.property(
        roadmapArb,
        fc.array(fc.integer({ min: 1, max: 4 }).map(String), { maxLength: 3 }),
        ({ tasks, text }, takenIds) => {
          const taken = { normal: takenIds.map((phase) => `${phase}.1`), addendum: [] }
          const selection = selectRoadmapTask(text, taken, null)
          const open = tasks.filter(
            (row) => !row.done && !taken.normal.includes(`${row.phase}.${row.step}`),
          )
          if (selection.hasTask && selection.task) {
            expect(taken.normal).not.toContain(selection.task.id)
            expect(open.map((row) => `${row.phase}.${row.step}`)).toContain(selection.task.id)
            expect(selection.task.id).toBe(`${open[0].phase}.${open[0].step}`)
          } else {
            expect(open).toHaveLength(0)
          }
        },
      ),
    )
  })
})
