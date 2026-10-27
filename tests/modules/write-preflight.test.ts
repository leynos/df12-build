// Module tests for the task-agent writable-root preflight (decomposition
// milestone 6). The probe outcome is the bytes on disk, never the agent's
// claimed ok, and the worktree is untrusted content — so the symlink and
// decoy cases are the load-bearing ones.
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  WRITE_PROBE_SCHEMA,
  clearProbeArtifact,
  hostWriteProbe,
  makeWritePreflight,
  verifyWriteProbe,
  writeProbePath,
  writeProbePrompt,
  writeProbeToken,
} from '../../src/workflows/df12-build-odw/write-preflight.ts'

const globals = globalThis as Record<string, unknown>

beforeEach(() => {
  globals.log = () => {}
  // bun test shares one process across suites: start each test with no
  // leftover agent mock from a sibling file (matches remediation.test.ts).
  delete globals.agent
})

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'write-preflight-'))
}

const TARGETS = () => [
  { role: 'plan', adapter: 'claude', options: (options: Record<string, unknown>) => options },
  { role: 'build', adapter: 'codex', options: (options: Record<string, unknown>) => options },
]

describe('probe construction', () => {
  test('probe paths distinguish adapter names on case-insensitive filesystems', () => {
    for (const [left, right] of [['Claude', 'claude'], ['codex medium', 'codex!medium']] as const) {
      expect(writeProbePath('/wt', left).toLowerCase()).not.toBe(writeProbePath('/wt', right).toLowerCase())
    }
  })

  test('paths sanitize the adapter and prompts carry the file and token markers', () => {
    expect(writeProbePath('/wt', 'codex medium!')).toMatch(/^\/wt\/\.df12-write-probe-codex-medium--[0-9a-f]{64}$/)
    const token = writeProbeToken('1.2.3', 'codex')
    expect(token).toBe('df12-write-probe v1 task=1.2.3 adapter=codex')
    const prompt = writeProbePrompt('/wt/.probe', token)
    expect(prompt).toContain('PROBE_FILE: /wt/.probe')
    expect(prompt).toContain(`PROBE_TOKEN: ${token}`)
    expect(WRITE_PROBE_SCHEMA.required).toEqual(['ok'])
  })
})

describe('clearProbeArtifact', () => {
  test('removes a symlink itself, never its target, and tolerates absence', async () => {
    const dir = tmp()
    const target = path.join(dir, 'precious.txt')
    writeFileSync(target, 'keep me')
    const link = path.join(dir, 'probe-link')
    symlinkSync(target, link)

    await clearProbeArtifact(link)
    expect(readFileSync(target, 'utf8')).toBe('keep me')
    expect(() => readFileSync(link)).toThrow()

    await clearProbeArtifact(path.join(dir, 'absent')) // no throw
  })
})

describe('verifyWriteProbe', () => {
  test('accepts only a regular file holding the exact token', async () => {
    const dir = tmp()
    const probe = path.join(dir, 'probe')
    writeFileSync(probe, 'df12-token\n')
    expect(await verifyWriteProbe(probe, 'df12-token')).toEqual({ ok: true, detail: '' })

    writeFileSync(probe, 'wrong contents')
    const mismatch = await verifyWriteProbe(probe, 'df12-token')
    expect(mismatch.ok).toBe(false)
    expect(mismatch.detail).toMatch(/mismatch/)

    const missing = await verifyWriteProbe(path.join(dir, 'absent'), 'df12-token')
    expect(missing.ok).toBe(false)
    expect(missing.detail).toMatch(/missing or unreadable/)
  })

  test('rejects symlinks and directories at the probe path', async () => {
    const dir = tmp()
    const target = path.join(dir, 'target.txt')
    writeFileSync(target, 'df12-token')
    const link = path.join(dir, 'probe-link')
    symlinkSync(target, link)
    const linked = await verifyWriteProbe(link, 'df12-token')
    expect(linked.ok).toBe(false)
    expect(linked.detail).toMatch(/not a regular file/)

    const subdir = path.join(dir, 'probe-dir')
    mkdirSync(subdir)
    const asDir = await verifyWriteProbe(subdir, 'df12-token')
    expect(asDir.ok).toBe(false)
  })

  test('rejects a FIFO without waiting for a writer', async () => {
    const fifo = path.join(tmp(), 'probe-fifo')
    execFileSync('mkfifo', [fifo])
    const result = await verifyWriteProbe(fifo, 'df12-token')
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/not a regular file/)
  })
})

describe('hostWriteProbe', () => {
  test('succeeds in a writable worktree and fails cleanly elsewhere', async () => {
    expect(await hostWriteProbe(tmp())).toEqual({ ok: true, detail: '' })
    const broken = await hostWriteProbe('/nonexistent/nowhere')
    expect(broken.ok).toBe(false)
    expect(broken.detail).toBeTruthy()
  })
})

describe('probe options right-sizing', () => {
  for (const schemaAction of ['omit', 'replace'] as const) {
    test(`the probe retains its schema when routing options ${schemaAction} it`, async () => {
      const dir = tmp()
      const tag = '1.2.3'
      const adapter = 'codex'
      const routerInputs: Array<Record<string, unknown>> = []
      const agentOptions: Array<Record<string, unknown>> = []
      try {
        globals.agent = async (_prompt: string, options: Record<string, unknown>) => {
          agentOptions.push(options)
          writeFileSync(writeProbePath(dir, adapter), writeProbeToken(tag, adapter))
          return { ok: true }
        }
        const targets = () => [{
          role: 'build',
          adapter,
          options: (options: Record<string, unknown>) => {
            routerInputs.push(options)
            const routed = {
              adapter,
              model: 'codex-cheap',
              effort: 'minimal',
              phase: options.phase,
              label: options.label,
            }
            return schemaAction === 'omit'
              ? routed
              : { ...routed, schema: { type: 'string' } }
          },
        }]
        const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets })

        expect(await runTaskAgentWritePreflight(dir, tag)).toEqual({ ok: true, failures: [] })
        expect(routerInputs).toHaveLength(1)
        expect(routerInputs[0]?.schema).toBe(WRITE_PROBE_SCHEMA)
        expect(agentOptions).toHaveLength(1)
        expect(agentOptions[0]?.schema).toBe(WRITE_PROBE_SCHEMA)
        expect(agentOptions[0]).toMatchObject({
          adapter,
          model: 'codex-cheap',
          effort: 'minimal',
          phase: 'Worktree',
          label: 'write-probe:codex',
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('the probe keeps the adapter, uses minimal effort, and passes no reasoning model', async () => {
    const seen: Array<Record<string, unknown>> = []
    globals.agent = async (_prompt: string, opts: Record<string, unknown> = {}) => {
      seen.push(opts)
      // Write the token so the host probe passes.
      const file = /PROBE_FILE: (.+)/.exec(_prompt)?.[1] ?? ''
      const token = /PROBE_TOKEN: (.+)/.exec(_prompt)?.[1] ?? ''
      writeFileSync(file, token)
      return { ok: true }
    }
    // Simulate the entry's probe-target wiring: adapter kept, minimal effort,
    // NO inherited plan/build model, optional per-adapter probe model.
    const probeTargets = () => [
      { role: 'plan', adapter: 'claude', options: (o: Record<string, unknown>) => ({ adapter: 'claude', effort: 'minimal', ...o }) },
      { role: 'build', adapter: 'codex', options: (o: Record<string, unknown>) => ({ adapter: 'codex', model: 'codex-cheap', effort: 'minimal', ...o }) },
    ]
    const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets: probeTargets })
    await runTaskAgentWritePreflight(tmp(), '1.2.3')
    // Every probe call carries minimal effort and never a plan/build model.
    for (const opts of seen) {
      expect(opts.effort).toBe('minimal')
      expect(opts.model === 'claude-opus-4-8' || opts.model === 'gpt-5.5').toBe(false)
    }
    // The build adapter's optional cheap probe model rides through.
    expect(seen.some((opts) => opts.model === 'codex-cheap')).toBe(true)
  })
})

describe('makeWritePreflight', () => {
  for (const [label, thrown, expected] of [
    ['error', new Error('adapter failed'), 'adapter failed'],
    ['string', 'adapter disconnected', 'adapter disconnected'],
    ['object', { message: 'adapter unavailable' }, 'adapter unavailable'],
    ['numeric message', { message: 42 }, '42'],
    ['null', null, 'null'],
  ] as const) {
    test(`reports an agent failure thrown as ${label}`, async () => {
      const dir = tmp()
      try {
        globals.agent = async () => { throw thrown }
        const targets = () => [{ role: 'build', adapter: 'codex', options: (options: Record<string, unknown>) => options }]
        const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets })

        const outcome = await runTaskAgentWritePreflight(dir, '1.2.3')
        expect(outcome.ok).toBe(false)
        expect(outcome.failures).toHaveLength(1)
        expect(outcome.failures[0]?.detail).toContain(expected)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('reports a malformed agent reply when the host probe is missing', async () => {
    const dir = tmp()
    try {
      globals.agent = async () => ({ ok: false, detail: 42 })
      const targets = () => [{ role: 'build', adapter: 'codex', options: (options: Record<string, unknown>) => options }]
      const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets })

      const outcome = await runTaskAgentWritePreflight(dir, '1.2.3')
      expect(outcome.ok).toBe(false)
      expect(outcome.failures[0]?.detail).toContain('agent reply has invalid fields')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('accepts a verified probe even when the agent reply is malformed', async () => {
    const dir = tmp()
    try {
      globals.agent = async () => {
        writeFileSync(writeProbePath(dir, 'codex'), writeProbeToken('1.2.3', 'codex'))
        return { ok: 'yes' }
      }
      const targets = () => [{ role: 'build', adapter: 'codex', options: (options: Record<string, unknown>) => options }]
      const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets })

      expect(await runTaskAgentWritePreflight(dir, '1.2.3')).toEqual({ ok: true, failures: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('passes when every adapter really writes its token', async () => {
    const dir = tmp()
    globals.agent = async (prompt: string) => {
      const file = /PROBE_FILE: (.+)/.exec(prompt)?.[1] ?? ''
      const token = /PROBE_TOKEN: (.+)/.exec(prompt)?.[1] ?? ''
      writeFileSync(file, token)
      return { ok: true }
    }
    const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets: TARGETS })
    expect(await runTaskAgentWritePreflight(dir, '1.2.3')).toEqual({ ok: true, failures: [] })
  })

  test('an agent that claims success without writing fails on host evidence', async () => {
    const dir = tmp()
    globals.agent = async () => ({ ok: true })
    const { runTaskAgentWritePreflight } = makeWritePreflight({ enabled: true, targets: TARGETS })
    const outcome = await runTaskAgentWritePreflight(dir, '1.2.3')
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.map((failure) => failure.adapter).sort()).toEqual(['claude', 'codex'])
  })

  test('ensureTaskAgentWriteAccess memoizes one probe per run and honours disabling', async () => {
    const dir = tmp()
    let calls = 0
    globals.agent = async (prompt: string) => {
      calls += 1
      const file = /PROBE_FILE: (.+)/.exec(prompt)?.[1] ?? ''
      const token = /PROBE_TOKEN: (.+)/.exec(prompt)?.[1] ?? ''
      writeFileSync(file, token)
      return { ok: true }
    }
    const { ensureTaskAgentWriteAccess } = makeWritePreflight({ enabled: true, targets: TARGETS })
    const first = await ensureTaskAgentWriteAccess(dir, '1.2.3')
    const second = await ensureTaskAgentWriteAccess(dir, '9.9.9')
    expect(first.ok).toBe(true)
    expect(second).toBe(first)
    expect(calls).toBe(2) // one per adapter, once per run

    const disabled = makeWritePreflight({ enabled: false, targets: TARGETS })
    expect(await disabled.ensureTaskAgentWriteAccess(dir, '1.2.3')).toEqual({ ok: true, skipped: true, failures: [] })
  })
})
