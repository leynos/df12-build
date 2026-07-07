// Module tests for fault classification and the bounded infrastructure
// retry (decomposition milestone 3). The classifiers route a failure to
// fatal-auth / provider-fault / infra-fault / failed, which decides whether
// the pool halts, defers, retries, or assesses — so the tables include the
// negatives that must NOT match.
import { beforeEach, describe, expect, test } from 'bun:test'

import {
  authFailureDetail,
  faultMetrics,
  infrastructureFailureDetail,
  makeWithInfraRetry,
  providerFailureDetail,
  resultFromUnhandledAgentError,
} from '../../src/workflows/df12-build-odw/faults.ts'

// withInfraRetry logs through the injected ODW `log` primitive; provide it
// as an ambient global the way the loader would.
;(globalThis as Record<string, unknown>).log = () => {}

function resetMetrics() {
  faultMetrics.infraRetries = 0
  faultMetrics.infraFaults = 0
  faultMetrics.providerFaults = 0
  faultMetrics.authFaults = 0
}

beforeEach(resetMetrics)

describe('failure classifiers', () => {
  const table: Array<[string, string, 'auth' | 'provider' | 'infra' | 'none']> = [
    ['codex 401', 'API Error: 401 Unauthorized', 'auth'],
    ['claude signed out', 'You are signed out. Run claude auth login.', 'auth'],
    ['coderabbit login hint', 'Run `coderabbit auth login` to authenticate', 'auth'],
    ['logged-in false JSON', '{"loggedIn": false}', 'auth'],
    ['token expired', 'the token expired yesterday', 'auth'],
    ['coderabbit login timeout', 'Automatic login timed out. Use the printed fallback URL to finish authentication.', 'auth'],
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
    ['benign timeout prose', 'the HTTP request timeout was raised to 30 seconds', 'none'],
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
})

describe('resultFromUnhandledAgentError', () => {
  test('routes auth, provider, infra, and unclassified failures distinctly', () => {
    expect(resultFromUnhandledAgentError('1.1', 'Not logged in').status).toBe('fatal-auth')
    expect(resultFromUnhandledAgentError('1.1', 'API Error: 529 overloaded').status).toBe('provider-fault')
    expect(resultFromUnhandledAgentError('1.1', "adapter 'codex' timed out after 60s").status).toBe('infra-fault')
    expect(resultFromUnhandledAgentError('1.1', 'gates failed').status).toBe('failed')
    expect(faultMetrics).toEqual({ infraRetries: 0, infraFaults: 1, providerFaults: 1, authFaults: 1 })
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
