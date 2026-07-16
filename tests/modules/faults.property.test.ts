// Property tests for the fault-backoff arithmetic (decomposition milestone 3).
// The example-based suite in `faults.test.ts` pins representative cases; these
// properties span arbitrary inputs to hold the invariants that a constant or
// off-by-one fallback could otherwise satisfy: jitter range/determinism,
// retry-after parsing, retry-after clamping, and provider-over-infra precedence.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  infraRetryBackoffSeconds,
  makeWithInfraRetry,
  parseRetryAfterSeconds,
} from '../../src/workflows/df12-build-odw/faults.ts'

// withInfraRetry logs through the injected ODW `log` primitive; provide it as
// an ambient global the way the loader would.
;(globalThis as Record<string, unknown>).log = () => {}

describe('infraRetryBackoffSeconds properties', () => {
  test('stays within [low, high] and is deterministic for any seed and range', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 3600 }), fc.integer({ min: 0, max: 3600 }), (seed, low, span) => {
        const range: [number, number] = [low, low + span]
        const value = infraRetryBackoffSeconds(seed, range)
        expect(value).toBeGreaterThanOrEqual(range[0])
        expect(value).toBeLessThanOrEqual(range[1])
        // Same seed and range must reproduce the same wait (Math.random() ban).
        expect(infraRetryBackoffSeconds(seed, range)).toBe(value)
      }),
    )
  })
})

describe('parseRetryAfterSeconds properties', () => {
  test('reads the advertised header and phrase shapes for any non-negative amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (n) => {
        expect(parseRetryAfterSeconds(`API Error: 429; retry-after: ${n}`)).toBe(n)
        expect(parseRetryAfterSeconds(`rate limited, try again in ${n} seconds`)).toBe(n)
        expect(parseRetryAfterSeconds(`rate limited, try again in ${n} minutes`)).toBe(n * 60)
      }),
    )
  })

  test('returns 0 when no advertised wait is present', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // Only inputs that carry neither advertised shape; the rejection rate is
        // negligible because random strings almost never spell these keywords.
        fc.pre(!/retry[-\s]?after/i.test(text) && !/try again in/i.test(text))
        expect(parseRetryAfterSeconds(text)).toBe(0)
      }),
    )
  })
})

describe('makeWithInfraRetry properties', () => {
  test('clamps an advertised retry-after into the configured range before sleeping', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 600 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 1, max: 5000 }),
        async (low, span, advertised) => {
          const range: [number, number] = [low, low + span]
          const sleeps: number[] = []
          const withInfraRetry = makeWithInfraRetry(2, range, async (s) => {
            sleeps.push(s)
          })
          const run = async () => {
            throw new Error(`API Error: 429 rate limited; retry-after: ${advertised}`)
          }
          await expect(withInfraRetry(run, 'stage')).rejects.toThrow(/429/)
          // attempts=2 → exactly one backoff before the final rethrow, equal to
          // the advertised wait clamped into [low, high].
          const expected = Math.min(range[1], Math.max(range[0], advertised))
          expect(sleeps).toEqual([expected])
        },
      ),
    )
  })

  test('provider precedence holds when an adapter exit wraps a provider status', async () => {
    const providerStatuses = [429, 500, 502, 503, 504, 529]
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('claude', 'codex', 'gemini', 'qwen', 'kimi'),
        fc.integer({ min: 1, max: 255 }),
        fc.constantFrom(...providerStatuses),
        async (adapter, code, status) => {
          const sleeps: number[] = []
          const withInfraRetry = makeWithInfraRetry(2, [5, 30], async (s) => {
            sleeps.push(s)
          })
          // Ambiguous message: the adapter-exit wrapper matches the infra
          // classifier AND the embedded status matches the provider classifier.
          const message = `adapter '${adapter}' exited with code ${code}: API Error: ${status} overloaded`
          const run = async () => {
            throw new Error(message)
          }
          await expect(withInfraRetry(run, 'stage')).rejects.toThrow(new RegExp(String(status)))
          // Provider-over-infra precedence => the backoff path ran (one sleep in
          // range), not an immediate infra re-run (which never sleeps).
          expect(sleeps.length).toBe(1)
          expect(sleeps[0]).toBeGreaterThanOrEqual(5)
          expect(sleeps[0]).toBeLessThanOrEqual(30)
        },
      ),
    )
  })
})
