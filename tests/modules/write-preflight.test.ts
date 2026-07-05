// Module tests for the task-agent writable-root preflight (decomposition
// milestone 6). The probe outcome is the bytes on disk, never the agent's
// claimed ok, and the worktree is untrusted content — so the symlink and
// decoy cases are the load-bearing ones.
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
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
})

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'write-preflight-'))
}

const TARGETS = () => [
  { role: 'plan', adapter: 'claude', options: (options: Record<string, unknown>) => options },
  { role: 'build', adapter: 'codex', options: (options: Record<string, unknown>) => options },
]

describe('probe construction', () => {
  test('paths sanitize the adapter and prompts carry the file and token markers', () => {
    expect(writeProbePath('/wt', 'codex medium!')).toBe('/wt/.df12-write-probe-codex-medium-')
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
})

describe('hostWriteProbe', () => {
  test('succeeds in a writable worktree and fails cleanly elsewhere', async () => {
    expect(await hostWriteProbe(tmp())).toEqual({ ok: true, detail: '' })
    const broken = await hostWriteProbe('/nonexistent/nowhere')
    expect(broken.ok).toBe(false)
    expect(broken.detail).toBeTruthy()
  })
})

describe('makeWritePreflight', () => {
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
