/** @file Property tests for review-tool configuration clamps. Generated inputs
 * pin the full numeric mapping rather than a handful of boundary examples. */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import { makeConfig } from '../../src/workflows/df12-build-odw/config.ts'

const numericInput = fc.oneof(
  fc.integer({ min: -100_000, max: 100_000 }),
  fc.integer({ min: -100_000, max: 100_000 }).map(String),
)

describe('Dakar configuration clamp properties', () => {
  test('timeout maps every numeric input into the 60..7200-second band', () => {
    fc.assert(
      fc.property(numericInput, (input) => {
        const raw = Math.trunc(Number(input)) || 3600
        const expected = Math.min(7200, Math.max(60, raw))
        expect(makeConfig({ dakarTimeoutSeconds: input }).DAKAR_TIMEOUT_SECONDS)
          .toBe(expected)
      }),
    )
  })

  test('budget maps every numeric input into the 0..10 GBP band', () => {
    fc.assert(
      fc.property(numericInput, (input) => {
        const expected = Math.min(10, Math.max(0, Number(input)))
        expect(makeConfig({ dakarBudgetGbp: input }).DAKAR_BUDGET_GBP)
          .toBe(expected)
      }),
    )
  })
})
