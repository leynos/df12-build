/**
 * Host-run CodeRabbit review and host-run commit gates. The control loop
 * invokes the CodeRabbit CLI against committed work (absorbing rate-limit
 * backoff in host wall-clock instead of agent tokens) and re-runs the
 * configured gate commands against committed HEAD, so a gatesGreen claim is
 * verified, never trusted. The run wiring (base branch, attempts, backoff
 * range, findings sink, gate set, gate timeout) binds once via
 * makeHostReview; the parsers and aggregates are direct exports.
 *
 * @module
 */
import { execFileStatus } from './exec.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'
import { authFailureDetail } from './faults.ts'

/**
 * One CodeRabbit `finding` event, kept as its raw wire object (it extends
 * Record so unrecognized fields survive) plus the fields the host reads to gate
 * and to record. Every field is optional because the CLI wire shape is not
 * under our control.
 */
export interface CoderabbitFinding extends Record<string, unknown> {
  /** Wire discriminator; always `'finding'` for this shape. */
  type?: string
  /** CLI severity (critical|major|minor|trivial|info); only critical/major block. */
  severity?: string
  /** Repository-relative file the finding concerns, when the CLI reports one. */
  fileName?: string
  /** Human-readable finding text; the primary blocking-item message source. */
  comment?: string
  /** Machine-oriented fix guidance, used as the message when `comment` is absent. */
  codegenInstructions?: string
  /** Suggested edits; only their count is written to the findings sink. */
  suggestions?: unknown[]
}

/**
 * The parsed result of one CodeRabbit `--agent` NDJSON stream. Callers classify
 * from these fields rather than the process exit code, which is unreliable (the
 * CLI exits 0 even on fatal errors).
 */
export interface CoderabbitParsedOutput {
  /** Every parsed NDJSON event object, in emission order. */
  events: Array<Record<string, unknown>>
  /** Non-JSON stdout lines, retained as fallback evidence for error detail. */
  rawLines: string[]
  /** The `finding` events, narrowed for severity gating and sink recording. */
  findings: CoderabbitFinding[]
  /** The terminal `complete` event, or null when the stream never completed. */
  complete: Record<string, unknown> | null
  /** The first `error` event, or null; drives the rate-limit/auth/error outcomes. */
  error: (Record<string, unknown> & {
    /** Error discriminator; `'rate_limit'` marks a recoverable quota fault. */
    errorType?: string
    /** Error message text, folded into the classifier's error-text scan. */
    message?: string
  }) | null
}

/** Terminal classification of a host CodeRabbit review; see classifyCoderabbitOutcome. */
export type CoderabbitOutcome = 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'

/** The outcome of one host CodeRabbit review pass, returned to the control loop. */
export interface CoderabbitReview {
  /** Terminal classification driving whether findings gate or the run defers. */
  outcome: CoderabbitOutcome
  /** How many attempts ran, including rate-limit backoff retries. */
  attempts: number
  /** The findings collected on the final attempt. */
  findings: CoderabbitFinding[]
  /** Operator-facing failure text; empty for the clean and findings outcomes. */
  detail: string
}

/** The result of running the configured commit gates against committed HEAD. */
export interface HostGateRun {
  /** True only when every configured gate passed. */
  green: boolean
  /** Per-gate outcomes in run order; the run stops at the first failure. */
  results: Array<{
    /** The gate command line as configured. */
    command: string
    /** Whether this gate passed. */
    ok: boolean
    /** Path to the secure per-gate log holding the full output. */
    logFile: string
  }>
  /** Operator-facing failure text with a bounded output tail; empty when green. */
  detail: string
}

/** Injectable seams so host review can be unit-tested without real subprocesses or waits. */
export interface HostReviewDeps {
  /** Process runner; defaults to execFileStatus. */
  exec?: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  /** Backoff sleep in minutes; defaults to the real wall-clock hostSleepMinutes. */
  sleep?: (minutes: number) => Promise<void>
}

/** The run wiring makeHostReview binds once: review target, retry/backoff, findings sink, and the gate set. */
export interface HostReviewConfig {
  /** Base branch the `--type committed` review diffs against. */
  base: string
  /** Maximum CodeRabbit attempts before a rate-limited review is deferred. */
  coderabbitAttempts: number
  /** Inclusive [low, high] minute range for the seeded backoff jitter. */
  coderabbitBackoffMinutes: [number, number]
  /** Path to the durable JSONL findings sink; empty disables it. */
  coderabbitFindingsFile: string
  /** The gate command lines re-run against committed HEAD. */
  commitGates: readonly string[]
  /** Per-gate SIGTERM timeout, in seconds. */
  commitGateTimeoutSeconds: number
  /** Whether the CodeScene code-health check runs. */
  csCheck: boolean
  /** The CodeScene check command line; its first token is the PATH probe. */
  csCheckCommand: string
}

/**
 * Parse a CodeRabbit `--agent` NDJSON stdout stream into structured events,
 * findings, terminal completion, and error. The `--agent` mode emits NDJSON on
 * stdout and exits 0 even on fatal errors, so callers classify from these
 * events, never the exit code; non-JSON lines are retained in `rawLines` as
 * fallback evidence. Wire contract pinned against coderabbit CLI internals;
 * captured live sessions documenting every observed event shape live in
 * docs/coderabbit-wire-contract.md. Summary:
 *   {"type":"review_context"|"status"|"heartbeat"} — progress events
 *   {"type":"finding", severity: critical|major|minor|trivial|info,
 *    fileName, comment?, suggestions?, codegenInstructions?}
 *   {"type":"complete", status, findings: N, message?}
 *   {"type":"error", errorType ("rate_limit" for quota), message,
 *    recoverable, details?/metadata?{waitTime}}
 */
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

/** The severities that turn a CodeRabbit finding into a blocking fix-round item. */
export const CODERABBIT_BLOCKING_SEVERITIES = new Set(['critical', 'major'])

/**
 * The success sentinels a `complete` event's status may carry. Both spellings
 * are observed from the real CLI: 'review_completed' in the captured live
 * sessions (docs/coderabbit-wire-contract.md) and 'reviewed' in the CLI output
 * the host-review tests were written against. Any other terminal status (a
 * cancelled or aborted review) must NOT read as clean.
 */
export const CODERABBIT_SUCCESS_STATUSES = new Set(['review_completed', 'reviewed'])

/**
 * Classify a CodeRabbit review from its parsed events and the exec result,
 * never the exit code. Rate-limit and auth faults are detected from the
 * combined error text; a `complete` event reads clean only when its status is a
 * known success sentinel, so a cancelled or aborted completion is an error, not
 * clean. Returns one of 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'.
 */
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

/** Real wall-clock backoff sleep (minutes); the injectable default for rate-limit waits. */
export async function hostSleepMinutes(minutes: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, minutes * 60000))
}

/**
 * Reduce findings to their blocking (critical/major) items as operator-facing
 * fix-round strings; non-blocking findings are captured for the sink and linter
 * tuning but never gate integration. Each message is bounded to 500 characters.
 */
export function coderabbitBlockingItems(findings: readonly CoderabbitFinding[] | null | undefined): string[] {
  return (findings || [])
    .filter((finding) => CODERABBIT_BLOCKING_SEVERITIES.has(String(finding.severity || '').toLowerCase()))
    .map((finding) => `CodeRabbit (${finding.severity}) ${finding.fileName || 'unknown file'}: ${String(finding.comment || finding.codegenInstructions || 'see the recorded suggestions').slice(0, 500)}`)
}

/**
 * Bounded-cardinality run aggregate for the terminal run summary, plus the last
 * durable-sink write error. Process-wide state, updated by recordCoderabbitReview
 * and the control loop; kept low-cardinality (fixed keys) so operators can read
 * review pressure straight from the result.
 */
export const coderabbitCapture: {
  /** Total host reviews recorded. */
  reviews: number
  /** Total findings recorded across all reviews. */
  findings: number
  /** Reviews that ended rate-limited (deferred rather than gated). */
  rateLimitedRuns: number
  /** Reviews that could not complete and were deferred to a relaunch. */
  deferred: number
  /** Finding counts keyed by lower-cased severity. */
  bySeverity: Record<string, number>
  /** Last findings-sink write error, if any; empty when the sink is healthy. */
  sinkError: string
} = { reviews: 0, findings: 0, rateLimitedRuns: 0, deferred: 0, bySeverity: {}, sinkError: '' }

/** Process-wide host commit-gate counters for the run summary. */
export const hostGateMetrics = {
  /** Total gate executions attempted. */
  runs: 0,
  /** Gate executions that failed. */
  failures: 0,
}

/** Process-wide CodeScene check counters for the run summary. */
export const csCheckMetrics = {
  /** Check executions attempted (excludes skips). */
  runs: 0,
  /** Check executions that reported code-health issues. */
  failures: 0,
  /** Checks skipped because the configured binary was not on PATH. */
  skipped: 0,
}

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

/**
 * Build the secure per-run log path for one gate execution inside the private
 * mkdtemp gate-log directory (see gateLogRoot). The tag and round label are
 * slugged and length-bounded; the raw gate command is deliberately kept out of
 * the filename because it is attacker/operator-controlled text.
 */
export function hostGateLogPath(tag: string, roundLabel: string, index: number): string {
  const slug = (value: unknown) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const path = process.getBuiltinModule('node:path')
  return path.join(gateLogRoot(), `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`)
}

/**
 * Bind the host-review run wiring once (base branch, attempts, backoff range,
 * findings sink, gate set, gate timeout, CodeScene) and return the host-side
 * gate surface. Host-collected evidence here is decisive: the gates and
 * CodeRabbit re-run against committed HEAD, so a gatesGreen claim is verified,
 * never trusted.
 */
export function makeHostReview(config: HostReviewConfig) {
  const {
    base,
    coderabbitAttempts,
    coderabbitBackoffMinutes: backoffRange,
    coderabbitFindingsFile,
    commitGates,
    commitGateTimeoutSeconds,
    csCheck,
    csCheckCommand,
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
        // Respect write backpressure: when the log stream's buffer is full,
        // pause the child's pipes and resume them on 'drain', so a slow disk
        // or a huge gate log cannot over-allocate memory. Never re-pause once
        // killed — a paused pipe would keep the child's 'close' from firing and
        // hang the gate (the timeout path below resumes them for the same
        // reason).
        if (!stream.write(chunk) && !killed) {
          child.stdout?.pause()
          child.stderr?.pause()
        }
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
      // Resume the paused child pipes once the log stream has drained (see the
      // backpressure guard in record()).
      stream.on('drain', () => {
        child.stdout?.resume()
        child.stderr?.resume()
      })
      child.stdout.on('data', record)
      child.stderr.on('data', record)
      const sigterm = setTimeout(() => {
        killed = true
        // Resume any pipes paused by backpressure BEFORE killing: a paused pipe
        // never reaches EOF, so the child's 'close' would not fire and the gate
        // promise would hang behind a full log buffer even after the kill.
        child.stdout?.resume()
        child.stderr?.resume()
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

  // CodeScene code-health check on the committed changed files, streamed to a
  // secure per-run log via the same spawn path as the commit gates. It runs
  // AFTER the commit gates and BEFORE CodeRabbit (deterministic and free).
  // Skips gracefully — like `make verify-modules` without Dafny — when the
  // configured binary is not on PATH, so environments without CodeScene are
  // not blocked. Returns { clean, skipped, detail, logFile }.
  async function runCodeSceneCheck(worktree: string, tag: string, label: string): Promise<{
    /** True when the check passed or was skipped; false only on reported issues. */
    clean: boolean
    /** True when skipped because the CodeScene binary was not on PATH. */
    skipped: boolean
    /** Operator-facing detail with a bounded log tail; empty when clean and not skipped. */
    detail: string
    /** Path to the secure per-run log, or '' when skipped. */
    logFile: string
  }> {
    if (!csCheck) return { clean: true, skipped: true, detail: '', logFile: '' }
    const bin = csCheckCommand.trim().split(/\s+/)[0] || 'cs-check-changed'
    // Pass the probed name as a positional argument ($1), never interpolated
    // into the command string: csCheckCommand is operator config (a trust
    // boundary), so shell metacharacters in the name must not be interpreted.
    const missingSentinel = '__DF12_CODESCENE_BINARY_MISSING__'
    const probe = await execFileStatus(
      'sh',
      ['-c', 'command -v "$1" >/dev/null 2>&1 || { printf "%s\\n" "$2"; exit 127; }', 'sh', bin, missingSentinel],
      { cwd: worktree },
    )
    if (!probe.ok) {
      if (probe.stdout.trim() === missingSentinel) {
        csCheckMetrics.skipped += 1
        log(`[task ${tag}] CodeScene check (${label}) skipped: ${bin} not on PATH`)
        return { clean: true, skipped: true, detail: `${bin} not on PATH`, logFile: '' }
      }
      csCheckMetrics.failures += 1
      const fault = [probe.message, probe.stderr, probe.signal ? `signal ${probe.signal}` : '', probe.killed ? 'probe killed' : '']
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join('; ')
      return {
        clean: false,
        skipped: false,
        detail: `CodeScene availability probe for \`${bin}\` failed: ${fault || 'unknown probe failure'}`,
        logFile: '',
      }
    }
    csCheckMetrics.runs += 1
    const logFile = hostGateLogPath(tag, `cs-${label}`, 0)
    log(`[task ${tag}] CodeScene check (${label}): ${csCheckCommand}`)
    const outcome = await streamGate(csCheckCommand, worktree, logFile)
    if (outcome.ok) return { clean: true, skipped: false, detail: '', logFile }
    csCheckMetrics.failures += 1
    const timedOut = outcome.killed ? ` (killed after the ${commitGateTimeoutSeconds}s timeout)` : ''
    return { clean: false, skipped: false, detail: `CodeScene check \`${csCheckCommand}\` reported code-health issues${timedOut}; full log: ${logFile}; output tail:\n${outcome.tail}`, logFile }
  }

  return {
    /** Deterministic seeded backoff jitter (minutes) for rate-limit retries. */
    coderabbitBackoffMinutes,
    /** Run one host CodeRabbit review against committed changes; backoff is absorbed in wall-clock. */
    runCoderabbitHostReview,
    /** Fold a review's findings into the capture aggregate and the durable sink. */
    recordCoderabbitReview,
    /** Re-run the configured commit gates against committed HEAD; host-verifies a gatesGreen claim. */
    runHostCommitGates,
    /** Run the CodeScene code-health check, skipping gracefully when its binary is absent. */
    runCodeSceneCheck,
  }
}
