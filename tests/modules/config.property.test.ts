/** @file Property tests for review-tool configuration clamps. Generated inputs
 * pin the full numeric mapping rather than a handful of boundary examples. */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import { makeConfig } from '../../src/workflows/df12-build-odw/config.ts'

const numericInput = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -100_000, max: 100_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -100_000, max: 100_000 }).map(String),
)
const timeoutInput = fc.oneof(
  numericInput,
  fc.string().filter((value) => Number.isNaN(Number(value))),
)
const budgetInput = fc.oneof(
  numericInput,
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'not-a-budget', '£1'),
)
const retryInput = numericInput

describe('Dakar configuration clamp properties', () => {
  test('timeout maps every numeric input into the 60..7200-second band', () => {
    fc.assert(
      fc.property(timeoutInput, (input) => {
        const timeout = makeConfig({ reviewTimeoutSeconds: input }).REVIEW_TIMEOUT_SECONDS
        expect(Number.isInteger(timeout)).toBe(true)
        expect(timeout).toBeGreaterThanOrEqual(60)
        expect(timeout).toBeLessThanOrEqual(7200)
        if (Number.isNaN(Number(input))) expect(timeout).toBe(3600)
      }),
    )
  })

  test('budget maps finite input into the 0..10 GBP band and rejects non-finite input', () => {
    fc.assert(
      fc.property(budgetInput, (input) => {
        const numeric = Number(input)
        const budget = makeConfig({ dakarBudgetGbp: input }).DAKAR_BUDGET_GBP
        if (!Number.isFinite(numeric) || numeric <= 0) expect(budget).toBe(0)
        else if (numeric >= 10) expect(budget).toBe(10)
        else expect(budget).toBe(numeric)
      }),
    )
  })

  test('retry counts and backoff endpoints always remain finite bounded values', () => {
    fc.assert(
      fc.property(retryInput, retryInput, (attempts, backoff) => {
        const config = makeConfig({ hostReviewAttempts: attempts, hostReviewBackoffMinutes: [backoff, backoff] })
        expect(Number.isInteger(config.HOST_REVIEW_ATTEMPTS)).toBe(true)
        expect(config.HOST_REVIEW_ATTEMPTS).toBeGreaterThanOrEqual(1)
        expect(config.HOST_REVIEW_ATTEMPTS).toBeLessThanOrEqual(10)
        expect(config.HOST_REVIEW_BACKOFF_MINUTES[0]).toBeGreaterThanOrEqual(1)
        expect(config.HOST_REVIEW_BACKOFF_MINUTES[1]).toBeLessThanOrEqual(1440)
      }),
    )
  })
})
