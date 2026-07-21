// Module tests for fault classification and the bounded infrastructure
// retry (decomposition milestone 3). The classifiers route a failure to
// fatal-auth / provider-fault / infra-fault / failed, which decides whether
// the pool halts, defers, retries, or assesses — so the tables include the
// negatives that must NOT match.
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  authFailureDetail,
  faultMetrics,
  infraRetryBackoffSeconds,
  infrastructureFailureDetail,
  makeWithInfraRetry,
  parseRetryAfterSeconds,
  providerFailureDetail,
  resultFromUnhandledAgentError,
} from '../../src/workflows/df12-build-odw/faults.ts'

// withInfraRetry logs through the injected ODW `log` primitive; provide it
// as an ambient global the way the loader would.
;(globalThis as Record<string, unknown>).log = () => {}

function resetMetrics() {
  faultMetrics.infraRetries = 0
  faultMetrics.providerRetries = 0
  faultMetrics.infraFaults = 0
  faultMetrics.providerFaults = 0
  faultMetrics.authFaults = 0
}

beforeEach(resetMetrics)

// Shared retry spy: records the injected backoff sleeps and binds
// makeWithInfraRetry to an instant sleep stub, so provider-fault tests assert
// wait values with no wall-clock delay. Factored out of the near-identical
// per-test setup in the provider-fault backoff block.
function makeRetrySpy(attempts: number, range: [number, number] = [5, 30]) {
  const sleeps: number[] = []
  const withInfraRetry = makeWithInfraRetry(attempts, range, async (s) => {
    sleeps.push(s)
  })
  return { sleeps, withInfraRetry }
}

// A stage closure that always throws the given message, counting invocations.
function alwaysThrow(message: string) {
  const state = { calls: 0 }
  const run = async () => {
    state.calls += 1
    throw new Error(message)
  }
  return { state, run }
}

describe('failure classifiers', () => {
  const table: Array<[string, string, 'auth' | 'provider' | 'infra' | 'none']> = [
    ['codex 401', 'API Error: 401 Unauthorized', 'auth'],
    ['claude signed out', 'You are signed out. Run claude auth login.', 'auth'],
    ['coderabbit login hint', 'Run `coderabbit auth login` to authenticate', 'auth'],
    ['logged-in false JSON', '{"loggedIn": false}', 'auth'],
    ['token expired', 'the token expired yesterday', 'auth'],
    ['rate limited', 'API Error: 429 rate limit reached', 'provider'],
    ['overloaded', 'model overloaded, try again in a moment', 'provider'],
    ['gateway timeout', '504 gateway timeout from upstream', 'provider'],
    ['adapter timeout', "adapter 'codex' timed out after 3600s", 'infra'],
    ['adapter died', "adapter 'claude' exited with code 137", 'infra'],
    ['schema exhausted', 'reply did not satisfy the schema after 3 attempts', 'infra'],
    ['no JSON', 'no JSON value found in the reply', 'infra'],
    ['ordinary review failure', 'coderabbit found 3 blocking issues', 'none'],
    ['ordinary gate failure', 'make all failed: tests exited 1', 'none'],
    ['prose mentioning auth', 'documented the authorization design', 'none'],
    ['empty', '', 'none'],
  ]

  for (const [name, detail, expected] of table) {
    test(`${name} classifies as ${expected}`, () => {
      expect(authFailureDetail(detail) !== '').toBe(expected === 'auth')
      expect(providerFailureDetail(detail) !== '').toBe(expected === 'provider')
      expect(infrastructureFailureDetail(detail) !== '').toBe(expected === 'infra')
    })
  }
})

describe('makeWithInfraRetry', () => {
  test('retries infrastructure faults up to the attempt budget, then rethrows', async () => {
    const withInfraRetry = makeWithInfraRetry(3)
    let calls = 0
    const failing = async () => {
      calls += 1
      throw new Error("adapter 'codex' timed out after 3600s")
    }
    await expect(withInfraRetry(failing, 'stage')).rejects.toThrow(/timed out/)
    expect(calls).toBe(3)
    expect(faultMetrics.infraRetries).toBe(2)
  })

  test('a product failure is never retried', async () => {
    const withInfraRetry = makeWithInfraRetry(3)
    let calls = 0
    const failing = async () => {
      calls += 1
      throw new Error('review verdict: changes-requested')
    }
    await expect(withInfraRetry(failing, 'stage')).rejects.toThrow(/changes-requested/)
    expect(calls).toBe(1)
    expect(faultMetrics.infraRetries).toBe(0)
  })

  test('a transient fault that recovers returns the eventual value', async () => {
    const withInfraRetry = makeWithInfraRetry(2)
    let calls = 0
    const flaky = async () => {
      calls += 1
      if (calls === 1) throw new Error("adapter 'codex' exited with code 137")
      return 'ok'
    }
    expect(await withInfraRetry(flaky, 'stage')).toBe('ok')
    expect(calls).toBe(2)
  })

  test('infrastructure faults retry without any backoff sleep', async () => {
    const sleeps: number[] = []
    const withInfraRetry = makeWithInfraRetry(3, [5, 30], async (s) => {
      sleeps.push(s)
    })
    let calls = 0
    const failing = async () => {
      calls += 1
      throw new Error("adapter 'codex' timed out after 3600s")
    }
    await expect(withInfraRetry(failing, 'stage')).rejects.toThrow(/timed out/)
    expect(calls).toBe(3)
    expect(faultMetrics.infraRetries).toBe(2)
    expect(faultMetrics.providerRetries).toBe(0)
    expect(sleeps).toEqual([])
  })
})

describe('makeWithInfraRetry provider-fault backoff', () => {
  // Deterministic jitter for the no-retry-after fallback: attempt 1 seeds
  // `stage#1`, so the fallback wait is exactly this value.
  const fallbackJitter = infraRetryBackoffSeconds('stage#1', [5, 30])

  // Always-failing provider/auth faults driven to budget exhaustion (or
  // terminal on the first hit). The shared harness (makeRetrySpy + alwaysThrow)
  // removes the repeated setup; each row's `check` keeps its assertions
  // case-specific (call count, metrics, and exact or range-bounded sleeps).
  const rethrowCases: Array<{
    name: string
    attempts: number
    message: string
    throws: RegExp
    check: (ctx: { sleeps: number[]; calls: number }) => void
  }> = [
    {
      name: 'retries provider rate-limits up to the budget with a bounded backoff, then rethrows',
      attempts: 3,
      message: 'API Error: 429 rate limited',
      throws: /429/,
      check: ({ sleeps, calls }) => {
        expect(calls).toBe(3)
        expect(faultMetrics.providerRetries).toBe(2)
        expect(faultMetrics.infraRetries).toBe(0)
        // One sleep before each of the two re-runs, each within the range.
        expect(sleeps.length).toBe(2)
        for (const wait of sleeps) {
          expect(wait).toBeGreaterThanOrEqual(5)
          expect(wait).toBeLessThanOrEqual(30)
        }
      },
    },
    {
      // Wrapped rate-limit satisfies BOTH infrastructureFailureDetail and
      // providerFailureDetail; provider-over-infra precedence (mirroring
      // resultFromUnhandledAgentError) must keep it on the backoff path rather
      // than an immediate infra re-run against the same closed window.
      name: 'a provider fault wrapped in an adapter exit backs off, not an immediate infra re-run',
      attempts: 3,
      message: "adapter 'claude' exited with code 1: API Error: 529 Overloaded",
      throws: /529/,
      check: ({ sleeps, calls }) => {
        expect(calls).toBe(3)
        expect(faultMetrics.providerRetries).toBe(2)
        expect(faultMetrics.infraRetries).toBe(0)
        expect(sleeps.length).toBe(2)
        for (const wait of sleeps) {
          expect(wait).toBeGreaterThanOrEqual(5)
          expect(wait).toBeLessThanOrEqual(30)
        }
      },
    },
    {
      name: 'an advertised retry-after drives the wait, clamped into the configured range',
      attempts: 2,
      message: 'API Error: 429 rate limited; retry-after: 12',
      throws: /429/,
      check: ({ sleeps }) => expect(sleeps).toEqual([12]),
    },
    {
      name: 'a hostile retry-after is clamped to the range ceiling',
      attempts: 2,
      message: 'rate limited, try again in 999 seconds',
      throws: /rate limited/,
      check: ({ sleeps }) => expect(sleeps).toEqual([30]),
    },
    {
      name: 'without a retry-after the wait falls back to deterministic seeded jitter',
      attempts: 2,
      message: '503 service unavailable',
      throws: /unavailable/,
      check: ({ sleeps }) => expect(sleeps).toEqual([fallbackJitter]),
    },
    {
      // Auth outranks infra: a wrapped credential failure is fatal and must not
      // burn the retry budget even though the adapter-exit wrapper looks like an
      // infrastructure fault.
      name: 'an auth failure wrapped in an adapter exit stays terminal, not retried as infra',
      attempts: 3,
      message: "adapter 'codex' exited with code 1: API Error: 401 Unauthorized",
      throws: /401/,
      check: ({ sleeps, calls }) => {
        expect(calls).toBe(1)
        expect(faultMetrics.providerRetries).toBe(0)
        expect(faultMetrics.infraRetries).toBe(0)
        expect(sleeps).toEqual([])
      },
    },
  ]

  for (const { name, attempts, message, throws, check } of rethrowCases) {
    test(name, async () => {
      const { sleeps, withInfraRetry } = makeRetrySpy(attempts)
      const { state, run } = alwaysThrow(message)
      await expect(withInfraRetry(run, 'stage')).rejects.toThrow(throws)
      check({ sleeps, calls: state.calls })
    })
  }

  test('a transient provider fault that recovers returns the eventual value', async () => {
    const { sleeps, withInfraRetry } = makeRetrySpy(3)
    let calls = 0
    const flaky = async () => {
      calls += 1
      if (calls === 1) throw new Error('model overloaded, try again in a moment')
      return 'recovered'
    }
    expect(await withInfraRetry(flaky, 'stage')).toBe('recovered')
    expect(calls).toBe(2)
    expect(faultMetrics.providerRetries).toBe(1)
    expect(sleeps.length).toBe(1)
  })

  test('auth and product failures stay terminal with zero sleeps', async () => {
    const { sleeps, withInfraRetry } = makeRetrySpy(3)
    const auth = alwaysThrow('API Error: 401 Unauthorized')
    await expect(withInfraRetry(auth.run, 'stage')).rejects.toThrow(/401/)
    const product = alwaysThrow('review verdict: changes-requested')
    await expect(withInfraRetry(product.run, 'stage')).rejects.toThrow(/changes-requested/)
    expect(auth.state.calls + product.state.calls).toBe(2)
    expect(faultMetrics.providerRetries).toBe(0)
    expect(faultMetrics.infraRetries).toBe(0)
    expect(sleeps).toEqual([])
  })
})

describe('backoff helpers', () => {
  test('infraRetryBackoffSeconds is deterministic and stays within range', () => {
    for (const seed of ['stage#1', 'plan#2', 'build#3']) {
      const first = infraRetryBackoffSeconds(seed, [5, 30])
      expect(first).toBe(infraRetryBackoffSeconds(seed, [5, 30]))
      expect(first).toBeGreaterThanOrEqual(5)
      expect(first).toBeLessThanOrEqual(30)
    }
  })

  test('infraRetryBackoffSeconds spreads distinct seeds across the range', () => {
    // A constant in-range fallback would still satisfy the determinism/bounds
    // test above, so pin that different seeds actually yield more than one wait
    // — this is what de-synchronizes sibling tasks that hit the same limit.
    const seeds = ['stage#1', 'stage#2', 'plan#1', 'build#3', 'review#7', 'audit#4']
    const values = new Set(seeds.map((seed) => infraRetryBackoffSeconds(seed, [5, 30])))
    expect(values.size).toBeGreaterThan(1)
  })

  test('parseRetryAfterSeconds reads the common advertised shapes, else 0', () => {
    expect(parseRetryAfterSeconds('retry-after: 30')).toBe(30)
    expect(parseRetryAfterSeconds('Retry-After 45')).toBe(45)
    expect(parseRetryAfterSeconds('please try again in 2 minutes')).toBe(120)
    expect(parseRetryAfterSeconds('try again in 15 seconds')).toBe(15)
    expect(parseRetryAfterSeconds('model overloaded, try again in a moment')).toBe(0)
    expect(parseRetryAfterSeconds('')).toBe(0)
  })
})

describe('resultFromUnhandledAgentError', () => {
  test('routes auth, provider, infra, and unclassified failures distinctly', () => {
    expect(resultFromUnhandledAgentError('1.1', 'Not logged in').status).toBe('fatal-auth')
    expect(resultFromUnhandledAgentError('1.1', 'API Error: 529 overloaded').status).toBe('provider-fault')
    expect(resultFromUnhandledAgentError('1.1', "adapter 'codex' timed out after 60s").status).toBe('infra-fault')
    expect(resultFromUnhandledAgentError('1.1', 'gates failed').status).toBe('failed')
    expect(faultMetrics).toEqual({ infraRetries: 0, providerRetries: 0, infraFaults: 1, providerFaults: 1, authFaults: 1 })
  })

  test('extra fields ride along and proposals default empty', () => {
    const result = resultFromUnhandledAgentError('2.2', 'gates failed', { worktree: '/tmp/wt' })
    expect(result).toEqual({
      id: '2.2',
      status: 'failed',
      stage: 'error',
      detail: 'gates failed',
      proposals: [],
      worktree: '/tmp/wt',
    })
  })
})
