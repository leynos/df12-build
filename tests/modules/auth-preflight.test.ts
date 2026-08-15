/** @file Tests the injected authentication and host-review readiness preflight. */
import { describe, expect, test } from 'bun:test'

import { makeAuthPreflight } from '../../src/workflows/df12-build-odw/auth-preflight.ts'
import type { ExecStatus } from '../../src/workflows/df12-build-odw/exec.ts'

function status(overrides: Partial<ExecStatus> = {}): ExecStatus {
  return { ok: true, stdout: '', stderr: '', ...overrides }
}

describe('makeAuthPreflight', () => {
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
          return command === 'dakar-review' ? status({ ok: false, message: 'not found' }) : status()
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
    expect(failures[0].command).toBe('dakar-review --profile --version')
    expect(failures[0].command).not.toContain('super-secret')
    expect(failures[0].command).not.toContain('private-profile')
  })
})
