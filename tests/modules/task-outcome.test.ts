/**
 * Verify the worker-pool boundary for optional task-result fields.
 *
 * @module
 */
import { expect, test } from 'bun:test'
import { checkedTaskOutcome } from '../../src/workflows/df12-build-odw/task-outcome.ts'

const validSalvage = {
  classification: 'continue-manual',
  sha: 'abc123',
  detail: 'salvaged',
  committed: ['docs/execplans/plan.md'],
  skipped: [{ path: 'README.md', reason: 'outside task scope' }],
}

test('returns the original valid outcome with all optional fields intact', () => {
  const result = {
    id: '1',
    status: 'done',
    kind: 'addendum',
    integration: { pushed: true },
    proposals: [{ title: 'item' }],
    assessment: { classification: 'continue-manual', evidence: { source: 'git' } },
    assessmentError: 'assessment was retried',
    salvage: validSalvage,
    extra: { retained: true },
  }

  expect(checkedTaskOutcome(result)).toBe(result)
})

test('accepts a null integration result', () => {
  const result = { id: '1', status: 'done', integration: null }
  expect(checkedTaskOutcome(result)).toBe(result)
})

const invalidCases = [
  { name: 'a non-boolean integration push flag', fields: { integration: { pushed: 'yes' } } },
  { name: 'a null proposal', fields: { proposals: [null] } },
  { name: 'a non-string task kind', fields: { kind: 1 } },
  { name: 'a null task kind', fields: { kind: null } },
  { name: 'a null assessment', fields: { assessment: null } },
  { name: 'an array assessment', fields: { assessment: [] } },
  { name: 'a non-string assessment error', fields: { assessmentError: { message: 'failed' } } },
  { name: 'a null assessment error', fields: { assessmentError: null } },
  { name: 'a null salvage record', fields: { salvage: null } },
  { name: 'an array salvage record', fields: { salvage: [] } },
  { name: 'a non-string salvage classification', fields: { salvage: { ...validSalvage, classification: 1 } } },
  { name: 'a non-string salvage commit SHA', fields: { salvage: { ...validSalvage, sha: null } } },
  { name: 'a non-string salvage detail', fields: { salvage: { ...validSalvage, detail: false } } },
  { name: 'a non-array committed field', fields: { salvage: { ...validSalvage, committed: 'plan.md' } } },
  { name: 'a non-string committed path', fields: { salvage: { ...validSalvage, committed: ['plan.md', 1] } } },
  { name: 'a non-array skipped field', fields: { salvage: { ...validSalvage, skipped: 'README.md' } } },
  { name: 'a null skipped entry', fields: { salvage: { ...validSalvage, skipped: [null] } } },
  { name: 'a skipped entry without a path', fields: { salvage: { ...validSalvage, skipped: [{ reason: 'out of scope' }] } } },
  { name: 'a skipped entry without a reason', fields: { salvage: { ...validSalvage, skipped: [{ path: 'README.md' }] } } },
  { name: 'a non-string skipped path', fields: { salvage: { ...validSalvage, skipped: [{ path: 1, reason: 'out of scope' }] } } },
  { name: 'a non-string skipped reason', fields: { salvage: { ...validSalvage, skipped: [{ path: 'README.md', reason: 1 }] } } },
]

for (const { name, fields } of invalidCases) {
  test(`rejects ${name}`, () => {
    expect(() => checkedTaskOutcome({ id: '1', status: 'done', ...fields })).toThrow('Invalid task outcome')
  })
}
