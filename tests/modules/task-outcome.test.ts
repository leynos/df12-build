import { expect, test } from 'bun:test'
import { checkedTaskOutcome } from '../../src/workflows/df12-build-odw/task-outcome.ts'

test('checks optional task-result fields before use', () => {
  const result = { id: '1', status: 'done', integration: { pushed: true }, proposals: [{ title: 'item' }] }
  expect(checkedTaskOutcome(result)).toBe(result)
  expect(() => checkedTaskOutcome({ id: '1', status: 'done', integration: { pushed: 'yes' } })).toThrow('Invalid task outcome')
  expect(() => checkedTaskOutcome({ id: '1', status: 'done', proposals: [null] })).toThrow('Invalid task outcome')
})
