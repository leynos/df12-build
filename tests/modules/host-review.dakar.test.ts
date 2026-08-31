/** @file Tests Dakar parsing, execution, cleanup, and command validation. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { classifyCoderabbitOutcome, parseCoderabbitAgentOutput, parseDakarDocument, reviewerDisplayName } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ReviewOutcome } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ExecOptions } from '../../src/workflows/df12-build-odw/exec.ts'
import { hostReview, recordingExec, required } from '../fixtures/host-review.ts'

describe('classifyCoderabbitOutcome terminal completion', () => {
  test('both observed success statuses (review_completed, reviewed) are clean', () => {
    for (const status of ['review_completed', 'reviewed']) {
      const parsed = parseCoderabbitAgentOutput(`{"type":"complete","status":"${status}","findings":0}`)
      expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('clean')
    }
  })

  test('a non-success terminal completion is an error, not clean', () => {
    const parsed = parseCoderabbitAgentOutput('{"type":"complete","status":"review_cancelled","findings":0}')
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('error')
  })

  test('findings still classify as findings regardless of completion status', () => {
    const parsed = parseCoderabbitAgentOutput(
      ['{"type":"finding","severity":"major","fileName":"a.ts"}', '{"type":"complete","status":"review_completed","findings":1}'].join('\n'),
    )
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('findings')
  })

  test('a rate_limit error still classifies as rate-limited', () => {
    const parsed = parseCoderabbitAgentOutput('{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded"}')
    expect(classifyCoderabbitOutcome({ ok: true, stderr: '', message: '' }, parsed)).toBe('rate-limited')
  })
})

describe('parseDakarDocument', () => {
  test('locates the terminal verdict after noise containing stray braces', () => {
    expect(
      parseDakarDocument('finder {warming cache}\n{"ok":true,"verdict":"pass","findings":[]}\n'),
    ).toEqual({ ok: true, verdict: 'pass', findings: [] })
  })

  test('continues past a nested finding object to the terminal root', () => {
    const document = {
      ok: true,
      verdict: 'changes-requested',
      findings: [{ severity: 'high', path: 'src/a.ts', title: 'Fix it', detail: 'Broken', evidence: 'test' }],
    }
    expect(parseDakarDocument(JSON.stringify(document))).toEqual(document)
  })

  test('returns null when no valid terminal object exists', () => {
    expect(parseDakarDocument('no document')).toBeNull()
    expect(parseDakarDocument('{not json}')).toBeNull()
    expect(parseDakarDocument('[{"ok":true}]')).toBeNull()
  })

  test('rejects oversized nested malformed noise without retrying every brace', () => {
    expect(parseDakarDocument(`${'{'.repeat(64_001)}${'}'.repeat(64_001)}`)).toBeNull()
  })
})


const g = globalThis as Record<string, unknown>
g.log = () => {}

test('reviewer display names cover every supported host reviewer', () => {
  expect(reviewerDisplayName('dakar')).toBe('Dakar')
  expect(reviewerDisplayName('coderabbit')).toBe('CodeRabbit')
})

describe('runDakarHostReview', () => {
  const junk: string[] = []
  afterEach(() => {
    g.log = () => {}
    for (const target of junk.splice(0)) if (target) rmSync(target, { recursive: true, force: true })
  })

  // The dispatcher keys on config.reviewTool; only the Dakar branch is under
  // test here. A single JSON document on stdout (from the first '{') carries the
  // verdict, findings, and deferral stage.
  const dakarJson = (doc: Record<string, unknown>) => `noise before json\n${JSON.stringify(doc)}\n`

  test('the argv names the state root under tmpdir and omits the budget flag by default', async () => {
    const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = []
    const cleanupCalls: Array<{ stateRoot: string; options: { recursive: true; force: true } }> = []
    let stateRoot = ''
    const exec = async (command: string, args: readonly string[], options: ExecOptions = {}) => {
      calls.push({ command, args: [...args], options })
      stateRoot = required(args[args.indexOf('--state-root') + 1])
      expect(existsSync(stateRoot)).toBe(true)
      return { ok: true, stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }), stderr: '' }
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    const review = await runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (target, options) => {
        cleanupCalls.push({ stateRoot: target, options })
        rmSync(target, options)
      },
    })
    expect(review.outcome).toBe('clean')
    const { command, args, options } = required(calls[0])
    expect(command).toBe('dakar-review')
    expect(required(args[args.indexOf('--repo-root') + 1])).toBe('/work/tree')
    expect(required(args[args.indexOf('--base') + 1])).toBe('main')
    expect(required(args[args.indexOf('--timeout') + 1])).toBe('3600')
    expect(options).toEqual({ cwd: '/work/tree', timeoutMs: 3_605_000 })
    expect(stateRoot.startsWith(path.join(tmpdir(), 'df12-dakar-state-'))).toBe(true)
    expect(existsSync(stateRoot)).toBe(false)
    expect(cleanupCalls).toEqual([{ stateRoot, options: { recursive: true, force: true } }])
    expect(args).not.toContain('--budget-gbp')
  })

  test('a multi-word command separates its executable and prefix arguments', async () => {
    const { calls, exec } = recordingExec({
      stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }),
    })
    const { runCoderabbitHostReview } = hostReview({
      reviewTool: 'dakar',
      dakarCommand: 'uv run dakar-review',
      reviewTimeoutSeconds: 120,
    })
    await runCoderabbitHostReview('/work/tree', 'label', { exec })
    expect(required(calls[0]).command).toBe('uv')
    expect(required(calls[0]).args.slice(0, 2)).toEqual(['run', 'dakar-review'])
    expect(required(calls[0]).options.timeoutMs).toBe(125_000)
  })

  test('the state root is removed when reviewer execution throws', async () => {
    const cleanupCalls: Array<{ stateRoot: string; options: { recursive: true; force: true } }> = []
    let stateRoot = ''
    const exec = async (_command: string, args: readonly string[]) => {
      stateRoot = required(args[args.indexOf('--state-root') + 1])
      expect(existsSync(stateRoot)).toBe(true)
      throw new Error('Dakar execution failed')
    }
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    await expect(runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (target, options) => {
        cleanupCalls.push({ stateRoot: target, options })
        rmSync(target, options)
        throw new Error('cleanup failed')
      },
    })).rejects.toThrow('Dakar execution failed')
    expect(existsSync(stateRoot)).toBe(false)
    expect(cleanupCalls).toEqual([{ stateRoot, options: { recursive: true, force: true } }])
  })

  test('rejects an unquoted control operator in the configured Dakar command', () => {
    expect(() => hostReview({ reviewTool: 'dakar', dakarCommand: 'dakar-review; echo unsafe' }))
      .toThrow(/unquoted control operators/)
  })

  test('rejects a leading environment assignment in the configured Dakar command', () => {
    expect(() => hostReview({ reviewTool: 'dakar', dakarCommand: 'TOKEN=secret dakar-review' }))
      .toThrow(/Invalid dakarCommand/)
  })

  test('rejects a supplied invocation that can bypass Dakar command validation', () => {
    expect(() => hostReview({ reviewTool: 'dakar', dakarInvocation: ['env', 'TOKEN=secret', 'dakar-review'] }))
      .toThrow(/Invalid dakarCommand/)
  })

  test('a state-root creation failure becomes a terminal host-review error', async () => {
    let removed = false
    const { runHostReview } = hostReview({ reviewTool: 'dakar', reviewAttempts: 1 })
    const review = await runHostReview('/work/tree', 'label', {
      dakarStateRoots: {
        create: () => { throw new Error('temporary directory unavailable') },
        remove: () => { removed = true },
      },
    })
    expect(review.outcome).toBe('error')
    expect(review.errorCategory).toBe('execution')
    expect(review.detail).toContain('temporary directory unavailable')
    expect(removed).toBe(false)
  })

  test('a cleanup failure does not replace a successful review result', async () => {
    const logs: string[] = []
    g.log = (message: unknown) => logs.push(String(message))
    const { exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }) })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar' })
    const review = await runCoderabbitHostReview('/work/tree', 'label', {
      exec,
      removeDakarStateRoot: (stateRoot, options) => {
        rmSync(stateRoot, options)
        throw new Error(`cleanup failed ${'x'.repeat(1000)}`)
      },
    })
    expect(review.outcome).toBe('clean')
    const cleanupLog = logs.find((line) => line.startsWith('[Dakar] could not remove temporary state root: ')) as string
    expect(cleanupLog).toStartWith('[Dakar] could not remove temporary state root: ')
    expect(cleanupLog.length).toBeLessThanOrEqual(550)
  })

  test('redacts an inherited OpenAI key echoed by Dakar', async () => {
    const previousKey = process.env.OPENAI_API_KEY
    const secret = 'openai-key-that-must-not-escape-review'
    process.env.OPENAI_API_KEY = secret
    try {
      const { exec } = recordingExec({
        stdout: dakarJson({ ok: false, stage: 'review', error: `Dakar echoed ${secret}` }),
      })
      const review = await hostReview({ reviewTool: 'dakar' }).runHostReview('/work/tree', 'redacted', { exec })
      expect(review.detail).toContain('[REDACTED]')
      expect(review.detail).not.toContain(secret)
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
    }
  })

  test('a configured budget adds the --budget-gbp flag', async () => {
    const { calls, exec } = recordingExec({ stdout: dakarJson({ ok: true, verdict: 'pass', findings: [] }) })
    const { runCoderabbitHostReview } = hostReview({ reviewTool: 'dakar', dakarBudgetGbp: 3 })
    await runCoderabbitHostReview('/work/tree', 'label', { exec })
    const { args } = required(calls[0])
    expect(required(args[args.indexOf('--budget-gbp') + 1])).toBe('3')
    junk.push(required(args[args.indexOf('--state-root') + 1]))
  })
})
