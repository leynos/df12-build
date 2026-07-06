// Host-run CodeRabbit review and host-run commit gates. The control loop
// invokes the CodeRabbit CLI against committed work (absorbing rate-limit
// backoff in host wall-clock instead of agent tokens) and re-runs the
// configured gate commands against committed HEAD, so a gatesGreen claim is
// verified, never trusted. The run wiring (base branch, attempts, backoff
// range, findings sink, gate set, gate timeout) binds once via
// makeHostReview; the parsers and aggregates are direct exports.
import { execFileStatus } from './exec.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'
import { authFailureDetail } from './faults.ts'

export interface CoderabbitFinding extends Record<string, unknown> {
  type?: string
  severity?: string
  fileName?: string
  comment?: string
  codegenInstructions?: string
  suggestions?: unknown[]
}

export interface CoderabbitParsedOutput {
  events: Array<Record<string, unknown>>
  rawLines: string[]
  findings: CoderabbitFinding[]
  complete: Record<string, unknown> | null
  error: (Record<string, unknown> & { errorType?: string; message?: string }) | null
}

export type CoderabbitOutcome = 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'

export interface CoderabbitReview {
  outcome: CoderabbitOutcome
  attempts: number
  findings: CoderabbitFinding[]
  detail: string
}

export interface HostGateRun {
  green: boolean
  results: Array<{ command: string; ok: boolean; logFile: string }>
  detail: string
}

export interface HostReviewDeps {
  exec?: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  sleep?: (minutes: number) => Promise<void>
}

export interface HostReviewConfig {
  base: string
  coderabbitAttempts: number
  coderabbitBackoffMinutes: [number, number]
  coderabbitFindingsFile: string
  commitGates: readonly string[]
  commitGateTimeoutSeconds: number
}

// The CLI's --agent mode emits NDJSON events on stdout and exits 0 even on
// fatal errors, so classification parses events, never exit codes. Wire
// contract pinned against coderabbit CLI internals; captured live sessions
// documenting every observed event shape live in
// docs/coderabbit-wire-contract.md. Summary:
//   {"type":"review_context"|"status"|"heartbeat"} — progress events
//   {"type":"finding", severity: critical|major|minor|trivial|info,
//    fileName, comment?, suggestions?, codegenInstructions?}
//   {"type":"complete", status, findings: N, message?}
//   {"type":"error", errorType ("rate_limit" for quota), message,
//    recoverable, details?/metadata?{waitTime}}
export function parseCoderabbitAgentOutput(stdout: unknown): CoderabbitParsedOutput {
  const events: Array<Record<string, unknown>> = []
  const rawLines: string[] = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed)
      if (event && typeof event === 'object') {
        events.push(event)
        continue
      }
    } catch {
      // fall through: keep the raw line as evidence
    }
    rawLines.push(trimmed)
  }
  return {
    events,
    rawLines,
    findings: events.filter((event) => event.type === 'finding') as CoderabbitFinding[],
    complete: events.find((event) => event.type === 'complete') || null,
    error: (events.find((event) => event.type === 'error') as CoderabbitParsedOutput['error']) || null,
  }
}

export const CODERABBIT_BLOCKING_SEVERITIES = new Set(['critical', 'major'])

// The success sentinels a `complete` event's status may carry. Both spellings
// are observed from the real CLI: 'review_completed' in the captured live
// sessions (docs/coderabbit-wire-contract.md) and 'reviewed' in the CLI output
// the host-review tests were written against. Any other terminal status (a
// cancelled or aborted review) must NOT read as clean.
export const CODERABBIT_SUCCESS_STATUSES = new Set(['review_completed', 'reviewed'])

// One of: 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'.
export function classifyCoderabbitOutcome(
  execResult: { ok?: boolean; stderr?: string; message?: string },
  parsed: CoderabbitParsedOutput,
): CoderabbitOutcome {
  const errorText = [parsed.error?.message || '', execResult.stderr || '', execResult.message || ''].join('\n')
  if (parsed.error?.errorType === 'rate_limit' || /\brate.?limit|review limit reached/i.test(errorText)) return 'rate-limited'
  if (authFailureDetail(errorText)) return 'auth'
  if (parsed.error || (!execResult.ok && !parsed.complete)) return 'error'
  if (parsed.findings.length) return 'findings'
  // A complete event is success only when its status is a known success
  // sentinel (see CODERABBIT_SUCCESS_STATUSES); a non-success terminal
  // completion (e.g. a cancelled/aborted review) must not read as clean.
  if (parsed.complete) return CODERABBIT_SUCCESS_STATUSES.has(String(parsed.complete.status)) ? 'clean' : 'error'
  return 'error'
}

export async function hostSleepMinutes(minutes: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, minutes * 60000))
}

// Blocking severities become fix-round items; the rest are captured for the
// findings sink and linter tuning but never gate integration.
export function coderabbitBlockingItems(findings: readonly CoderabbitFinding[] | null | undefined): string[] {
  return (findings || [])
    .filter((finding) => CODERABBIT_BLOCKING_SEVERITIES.has(String(finding.severity || '').toLowerCase()))
    .map((finding) => `CodeRabbit (${finding.severity}) ${finding.fileName || 'unknown file'}: ${String(finding.comment || finding.codegenInstructions || 'see the recorded suggestions').slice(0, 500)}`)
}

// Bounded-cardinality run-result aggregate plus the optional durable JSONL
// sink for linter tuning.
export const coderabbitCapture: {
  reviews: number
  findings: number
  rateLimitedRuns: number
  deferred: number
  bySeverity: Record<string, number>
  sinkError: string
} = { reviews: 0, findings: 0, rateLimitedRuns: 0, deferred: 0, bySeverity: {}, sinkError: '' }

export const hostGateMetrics = { runs: 0, failures: 0 }

// Per-process gate-log directory, created lazily with mkdtempSync so its name
// is unpredictable and its mode is 0700: a local attacker cannot pre-plant a
// symlink at a guessable path to clobber or leak the logs. Combined with the
// O_EXCL|O_NOFOLLOW open in streamGate, this closes the predictable-/tmp-path
// symlink hazard. The raw gate command is kept OUT of the filename (it is
// attacker/operator-controlled text); uniqueness comes from the private dir.
let gateLogDirCache: string | null = null
function gateLogRoot(): string {
  if (!gateLogDirCache) {
    const fs = process.getBuiltinModule('node:fs')
    const os = process.getBuiltinModule('node:os')
    const path = process.getBuiltinModule('node:path')
    gateLogDirCache = fs.mkdtempSync(path.join(os.tmpdir(), 'df12-gates-'))
  }
  return gateLogDirCache
}

export function hostGateLogPath(tag: string, roundLabel: string, index: number): string {
  const slug = (value: unknown) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const path = process.getBuiltinModule('node:path')
  return path.join(gateLogRoot(), `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`)
}

export function makeHostReview(config: HostReviewConfig) {
  const {
    base,
    coderabbitAttempts,
    coderabbitBackoffMinutes: backoffRange,
    coderabbitFindingsFile,
    commitGates,
    commitGateTimeoutSeconds,
  } = config

  // Deterministic jitter in [low, high] minutes: Math.random() is banned for
  // Claude Code workflow dual-compatibility (ODW scanDualCompat), and a seeded
  // spread keeps sibling tasks from hammering the quota in lockstep.
  function coderabbitBackoffMinutes(seed: unknown): number {
    let hash = 5381
    for (const ch of String(seed)) hash = ((hash * 33) ^ (ch.codePointAt(0) as number)) >>> 0
    const [low, high] = backoffRange
    return low + (hash % (high - low + 1))
  }

  // Run one host review against the worktree's COMMITTED changes, absorbing
  // rate-limit backoff in host wall-clock (zero agent tokens). Returns
  // { outcome, attempts, findings, detail }. deps are injectable for tests.
  async function runCoderabbitHostReview(worktree: string, label: string, deps: HostReviewDeps = {}): Promise<CoderabbitReview> {
    const exec = deps.exec || execFileStatus
    const sleep = deps.sleep || hostSleepMinutes
    const commandArgs = ['review', '--agent', '--type', 'committed', '--base', base]
    for (let attempt = 1; ; attempt++) {
      log(`[${label}] CodeRabbit host review attempt ${attempt} of ${coderabbitAttempts}`)
      const result = await exec('coderabbit', commandArgs, { cwd: worktree })
      const parsed = parseCoderabbitAgentOutput(result.stdout)
      const outcome = classifyCoderabbitOutcome(result, parsed)
      if (outcome === 'rate-limited' && attempt < coderabbitAttempts) {
        const minutes = coderabbitBackoffMinutes(`${label}#${attempt}`)
        log(`[${label}] CodeRabbit rate limited; host backs off ${minutes} minutes before attempt ${attempt + 1} of ${coderabbitAttempts} (wall-clock only, no agent tokens)`)
        await sleep(minutes)
        continue
      }
      const detail = outcome === 'clean' || outcome === 'findings'
        ? ''
        : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join('; ') || 'coderabbit produced no parsable outcome').trim()
      return { outcome, attempts: attempt, findings: parsed.findings, detail }
    }
  }

  async function recordCoderabbitReview(label: string, review: CoderabbitReview): Promise<void> {
    coderabbitCapture.reviews += 1
    if (review.outcome === 'rate-limited') coderabbitCapture.rateLimitedRuns += 1
    for (const finding of review.findings) {
      coderabbitCapture.findings += 1
      const severity = String(finding.severity || 'unknown').toLowerCase()
      coderabbitCapture.bySeverity[severity] = (coderabbitCapture.bySeverity[severity] || 0) + 1
    }
    if (!coderabbitFindingsFile || !review.findings.length) return
    // Wall-clock stamp shelled out to `date`: Date.now()/new Date() are banned
    // for Claude Code workflow dual-compatibility (ODW scanDualCompat).
    const stamp = await execFileStatus('date', ['-u', '+%Y-%m-%dT%H:%M:%SZ'])
    const ts = stamp.ok ? stamp.stdout.trim() : ''
    const lines = review.findings.map((finding) => JSON.stringify({
      ts,
      label,
      severity: String(finding.severity || ''),
      file: String(finding.fileName || ''),
      comment: String(finding.comment || '').slice(0, 2000),
      codegenInstructions: String(finding.codegenInstructions || '').slice(0, 2000),
      suggestions: Array.isArray(finding.suggestions) ? finding.suggestions.length : 0,
    }))
    try {
      const fs = process.getBuiltinModule('node:fs/promises')
      await fs.appendFile(coderabbitFindingsFile, `${lines.join('\n')}\n`, 'utf8')
    } catch (error) {
      coderabbitCapture.sinkError = ((error as Error | null) && (error as Error).message) || String(error)
      log(`[${label}] could not append CodeRabbit findings to ${coderabbitFindingsFile}: ${coderabbitCapture.sinkError}`)
    }
  }

  // The control loop executes the configured gate commands itself against the
  // worktree's committed HEAD — deterministic, zero agent tokens, and uniform
  // across adapters — so a red branch never spends reviewer agents and a false
  // gatesGreen claim is caught with the host's own log as evidence. Full
  // output is teed to a /tmp log per gate; the returned detail carries a
  // bounded tail.
  async function runHostCommitGates(worktree: string, tag: string, roundLabel: string): Promise<HostGateRun> {
    const results: Array<{ command: string; ok: boolean; logFile: string }> = []
    for (const [index, command] of commitGates.entries()) {
      hostGateMetrics.runs += 1
      log(`[task ${tag}] host gate ${index + 1}/${commitGates.length} (${roundLabel}): ${command}`)
      const logFile = hostGateLogPath(tag, roundLabel, index)
      const outcome = await streamGate(command, worktree, logFile)
      if (!outcome.ok) {
        hostGateMetrics.failures += 1
        const timedOut = outcome.killed ? ` (killed after the ${commitGateTimeoutSeconds}s gate timeout)` : ''
        results.push({ command, ok: false, logFile })
        return {
          green: false,
          results,
          detail: `host gate \`${command}\` failed${timedOut}; full log: ${logFile}; output tail:\n${outcome.tail}`,
        }
      }
      results.push({ command, ok: true, logFile })
    }
    return { green: true, results, detail: '' }
  }

  // Run one gate with spawn, streaming stdout+stderr straight to the log as
  // it runs (no maxBuffer ceiling, evidence visible during long gates) while
  // keeping a bounded ring buffer of the last TAIL_LINES lines for the
  // structured result. A SIGTERM fires at the configured timeout, escalating
  // to SIGKILL if the child ignores it.
  function streamGate(command: string, cwd: string, logFile: string): Promise<{ ok: boolean; killed: boolean; tail: string }> {
    const TAIL_LINES = 12
    const { spawn } = process.getBuiltinModule('node:child_process')
    const fs = process.getBuiltinModule('node:fs')
    return new Promise((resolve) => {
      // Exclusive, no-follow open (mode 0600): O_EXCL fails if anything already
      // exists at the path (a planted symlink/file cannot be clobbered), and
      // O_NOFOLLOW refuses to traverse a symlink. Any such fault surfaces on the
      // stream 'error' listener below and settles the gate as failed.
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
      // createWriteStream accepts numeric open flags at runtime; the ambient
      // type only allows a string, so cast the OR-ed constants.
      const openFlags = (O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW) as unknown as string
      const stream = fs.createWriteStream(logFile, { flags: openFlags, mode: 0o600 })
      const tail: string[] = []
      let carry = ''
      let killed = false
      // finish() is settled-once: the child's 'close' and 'error' are mutually
      // exclusive, but the log stream is an independent emitter that can fault
      // at any time, so more than one settle path can race. The guard keeps
      // stream.end() (and resolve) from running twice.
      let settled = false
      const record = (chunk: Buffer) => {
        stream.write(chunk)
        carry += chunk.toString('utf8')
        const lines = carry.split(/\r?\n/)
        carry = lines.pop() || ''
        for (const line of lines) {
          tail.push(line)
          if (tail.length > TAIL_LINES) tail.shift()
        }
      }
      const finish = (ok: boolean, extraTail?: string) => {
        if (settled) return
        settled = true
        if (carry) {
          tail.push(carry)
          if (tail.length > TAIL_LINES) tail.shift()
        }
        if (extraTail) tail.push(extraTail)
        stream.end(() => resolve({ ok, killed, tail: tail.slice(-TAIL_LINES).join('\n').trim() }))
      }
      // A log open/write fault (ENOSPC, EACCES on the path) emits 'error' on
      // the stream; without this listener Node would treat it as an uncaught
      // exception and crash the run. Route it into a failed gate result.
      stream.on('error', (error) => finish(false, `gate log write failed: ${(error as Error).message}`))
      const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', record)
      child.stderr.on('data', record)
      const sigterm = setTimeout(() => {
        killed = true
        child.kill('SIGTERM')
        // Escalate if the child ignores SIGTERM; unref so it never holds the loop.
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }, commitGateTimeoutSeconds * 1000)
      child.on('close', (code) => {
        clearTimeout(sigterm)
        finish(code === 0 && !killed)
      })
      child.on('error', (error) => {
        clearTimeout(sigterm)
        finish(false, `spawn failed: ${(error as Error).message}`)
      })
    })
  }

  return { coderabbitBackoffMinutes, runCoderabbitHostReview, recordCoderabbitReview, runHostCommitGates }
}
