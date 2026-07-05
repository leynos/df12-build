// Module tests for the process and filesystem helpers (decomposition
// milestone 3): shell quoting, execFile wrappers, and the absent-vs-fault
// file probe.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'

import {
  execFileStatus,
  execFileText,
  fileState,
  shellQuote,
} from '../../src/workflows/df12-build-odw/exec.ts'

describe('shellQuote', () => {
  test('single-quotes any string so the shell reads it back verbatim', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const quoted = shellQuote(value)
        expect(quoted.startsWith("'")).toBe(true)
        expect(quoted.endsWith("'")).toBe(true)
        // Reverse the quoting: strip the outer quotes and undo the '\'' escape.
        const inner = quoted.slice(1, -1).replaceAll("'\\''", "'")
        expect(inner).toBe(String(value))
      }),
    )
  })
})

describe('execFileText / execFileStatus', () => {
  test('returns stdout on success', async () => {
    expect(await execFileText('printf', ['%s', 'hello'])).toBe('hello')
    expect(await execFileStatus('printf', ['%s', 'hello'])).toEqual({ ok: true, stdout: 'hello', stderr: '' })
  })

  test('a failing command reports ok=false with the message and streams', async () => {
    const status = await execFileStatus('sh', ['-c', 'echo out; echo err >&2; exit 3'])
    expect(status.ok).toBe(false)
    expect(status.stdout.trim()).toBe('out')
    expect(status.stderr.trim()).toBe('err')
    expect(status.message).toMatch(/exit code 3|failed/i)
  })

  test('execFileText rejects with stdout and stderr attached', async () => {
    await expect(execFileText('sh', ['-c', 'exit 7'])).rejects.toMatchObject({ stdout: '', stderr: '' })
  })
})

describe('fileState', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exec-module-'))
  writeFileSync(path.join(dir, 'present.txt'), 'x')

  test('distinguishes present, absent, and empty-path', async () => {
    expect(await fileState('present.txt', dir)).toEqual({ ok: true, exists: true, detail: '' })
    expect(await fileState('missing.txt', dir)).toEqual({ ok: true, exists: false, detail: '' })
    expect(await fileState('', dir)).toEqual({ ok: true, exists: false, detail: '' })
  })

  test('a directory is not a file', async () => {
    expect(await fileState('.', dir)).toEqual({ ok: true, exists: false, detail: '' })
  })

  test('a filesystem fault surfaces as ok=false, not as absent', async () => {
    const state = await fileState('present.txt\0bad', dir)
    expect(state.ok).toBe(false)
    expect(state.exists).toBe(false)
    expect(state.detail).toMatch(/stat failed/)
  })
})
