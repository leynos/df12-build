/** @file Tests the injected authentication and host-review readiness preflight. */
import { describe, expect, test } from 'bun:test'

import { makeAuthPreflight } from '../../src/workflows/df12-build-odw/auth-preflight.ts'
import type { ExecStatus } from '../../src/workflows/df12-build-odw/exec.ts'

/** Return a test result after making the expected failure presence explicit. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected preflight failure')
  return value
}

function status(overrides: Partial<ExecStatus> = {}): ExecStatus {
  return { ok: true, stdout: '', stderr: '', ...overrides }
}

describe('makeAuthPreflight', () => {
  test('applies only the credential probes selected by the effective review mode', async () => {
    const cases = [
      { name: 'disabled', enabled: false, reviewTool: 'dakar' as const, key: undefined, failures: 0, calls: [] as string[], authFailures: 0, passed: false },
      { name: 'CodeRabbit', enabled: true, reviewTool: 'coderabbit' as const, key: undefined, failures: 0, calls: ['codex', 'coderabbit'], authFailures: 0, passed: true },
      { name: 'missing Dakar key', enabled: true, reviewTool: 'dakar' as const, key: undefined, failures: 1, calls: ['codex', 'dakar-review', 'pi'], authFailures: 1, passed: false },
      { name: 'blank Dakar key', enabled: true, reviewTool: 'dakar' as const, key: '', failures: 1, calls: ['codex', 'dakar-review', 'pi'], authFailures: 1, passed: false },
      { name: 'ready Dakar', enabled: true, reviewTool: 'dakar' as const, key: 'present', failures: 0, calls: ['codex', 'dakar-review', 'pi'], authFailures: 0, passed: true },
    ]
    for (const item of cases) {
      const calls: string[] = []
      const logs: string[] = []
      let authFailures = 0
      const run = makeAuthPreflight(
        { enabled: item.enabled, requireHostReviewAuth: true, requiredAdapters: new Set(), reviewTool: item.reviewTool, dakarInvocation: ['dakar-review'] },
        {
          exec: async (command) => { calls.push(command); return status() },
          environment: { get: () => item.key }, phase: () => {}, log: (message) => logs.push(message),
          recordHostReviewAuthFailure: () => { authFailures += 1 },
        },
      )
      expect(await run(), item.name).toHaveLength(item.failures)
      expect(calls, item.name).toEqual(item.calls)
      expect(authFailures, item.name).toBe(item.authFailures)
      expect(logs.some((message) => message.includes('preflight passed')), item.name).toBe(item.passed)
    }
  })

  test('uses injected environment and process seams while redacting Dakar argument values', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let authFailures = 0
    const run = makeAuthPreflight(
      {
        enabled: true,
        requireHostReviewAuth: true,
        requiredAdapters: new Set(),
        reviewTool: 'dakar',
        dakarInvocation: ['dakar-review', '--api-key=super-secret', '--profile', 'private-profile'],
      },
      {
        exec: async (command, args) => {
          calls.push({ command, args: [...args] })
          return command === 'dakar-review' ? status({ ok: false, message: 'dakar-review --api-key=super-secret --profile private-profile failed' }) : status()
        },
        environment: { get: (name) => name === 'OPENAI_API_KEY' ? 'test-key' : undefined },
        phase: () => {},
        log: () => {},
        recordHostReviewAuthFailure: () => { authFailures += 1 },
      },
    )

    const failures = await run()

    expect(calls).toEqual([
      { command: 'codex', args: ['login', 'status'] },
      { command: 'dakar-review', args: ['--api-key=super-secret', '--profile', 'private-profile', '--version'] },
      { command: 'pi', args: ['--version'] },
    ])
    expect(authFailures).toBe(1)
    expect(failures).toHaveLength(1)
    const failure = required(failures[0])
    expect(failure.command).toBe('dakar-review --profile --version')
    expect(failure.command).not.toContain('super-secret')
    expect(failure.command).not.toContain('private-profile')
    expect(failure.detail).not.toContain('super-secret')
    expect(failure.detail).not.toContain('private-profile')
  })

  test('reports an unavailable pi dependency after the Dakar probe', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const logs: string[] = []
    let authFailures = 0
    const run = makeAuthPreflight(
      {
        enabled: true,
        requireHostReviewAuth: true,
        requiredAdapters: new Set(),
        reviewTool: 'dakar',
        dakarInvocation: ['dakar-review'],
      },
      {
        exec: async (command, args) => {
          calls.push({ command, args: [...args] })
          return command === 'pi' ? status({ ok: false, stderr: 'pi probe diagnostic' }) : status()
        },
        environment: { get: () => 'present' },
        phase: () => {},
        log: (message) => logs.push(message),
        recordHostReviewAuthFailure: () => { authFailures += 1 },
      },
    )

    const failures = await run()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ tool: 'dakar', command: 'pi --version' })
    expect(failures[0]?.detail).toContain('pi probe diagnostic')
    expect(calls).toEqual([
      { command: 'codex', args: ['login', 'status'] },
      { command: 'dakar-review', args: ['--version'] },
      { command: 'pi', args: ['--version'] },
    ])
    expect(authFailures).toBe(1)
    expect(logs.join('\n')).not.toContain('[auth] preflight passed')
  })

  test('redacts an inline Dakar option value when probe output omits its option name', async () => {
    const run = makeAuthPreflight(
      {
        enabled: true,
        requireHostReviewAuth: true,
        requiredAdapters: new Set(),
        reviewTool: 'dakar',
        dakarInvocation: ['dakar-review', '--api-key=super-secret'],
      },
      {
        exec: async (command) => command === 'dakar-review'
          ? status({ ok: false, message: 'credential rejected: super-secret' })
          : status(),
        environment: { get: () => 'test-key' },
        phase: () => {},
        log: () => {},
        recordHostReviewAuthFailure: () => {},
      },
    )

    const failures = await run()

    expect(failures).toHaveLength(1)
    expect(required(failures[0]).detail).toBe('credential rejected: [REDACTED]')
  })

  test('redacts a leading Dakar environment assignment and its bare echoed value', async () => {
    const messages: string[] = []
    const secret = 'super-secret'
    const run = makeAuthPreflight(
      {
        enabled: true,
        requireHostReviewAuth: true,
        requiredAdapters: new Set(),
        reviewTool: 'dakar',
        dakarInvocation: [`TOKEN=${secret}`, 'dakar-review'],
      },
      {
        exec: async (command) => command === 'dakar-review'
          ? status({ ok: false, message: `probe failed with ${secret}` })
          : status(),
        environment: { get: () => 'test-key' },
        phase: () => {},
        log: (message) => messages.push(message),
        recordHostReviewAuthFailure: () => {},
      },
    )

    const failures = await run()

    expect(failures).toHaveLength(1)
    const failure = required(failures[0])
    expect(failure.command).not.toContain(secret)
    expect(failure.detail).toBe('probe failed with [REDACTED]')
    expect(messages.join('\n')).not.toContain(secret)
  })

  test('redacts an echoed OPENAI_API_KEY while reporting the configured executable on success', async () => {
    const logs: string[] = []
    const secret = 'openai-key-that-must-not-escape'
    const failing = makeAuthPreflight(
      { enabled: true, requireHostReviewAuth: true, requiredAdapters: new Set(), reviewTool: 'dakar', dakarInvocation: ['custom-dakar'] },
      {
        exec: async (command) => command === 'custom-dakar' ? status({ ok: false, stderr: `failed with ${secret}` }) : status(),
        environment: { get: () => secret }, phase: () => {}, log: (message) => logs.push(message), recordHostReviewAuthFailure: () => {},
      },
    )
    const failures = await failing()
    const failure = required(failures[0])
    expect(failure.detail).toContain('[REDACTED]')
    expect(failure.detail).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)

    const passing = makeAuthPreflight(
      { enabled: true, requireHostReviewAuth: true, requiredAdapters: new Set(['claude']), reviewTool: 'dakar', dakarInvocation: ['custom-dakar'] },
      {
        exec: async () => status(), environment: { get: () => 'present' }, phase: () => {}, log: (message) => logs.push(message), recordHostReviewAuthFailure: () => {},
      },
    )
    expect(await passing()).toEqual([])
    expect(logs.at(-1)).toContain('Dakar (custom-dakar, pi, OPENAI_API_KEY)')
    expect(logs.at(-1)).toContain('Claude')
  })

  test('reports a failed Codex probe even without additional required adapters', async () => {
    const run = makeAuthPreflight(
      { enabled: true, requireHostReviewAuth: false, requiredAdapters: new Set(), reviewTool: 'coderabbit', dakarInvocation: ['dakar-review'] },
      {
        exec: async () => status({ ok: false, stderr: 'not logged in' }), environment: { get: () => undefined }, phase: () => {}, log: () => {}, recordHostReviewAuthFailure: () => {},
      },
    )
    await expect(run()).resolves.toMatchObject([{ tool: 'codex' }])
  })
})
