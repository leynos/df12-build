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
  // The host review tool. 'dakar' (the default) runs the Dakar CLI and maps its
  // JSON verdict onto the CoderabbitReview contract; 'coderabbit' keeps the
  // retained NDJSON path. The CoderabbitReview shape and run-task call sites are
  // deliberately unchanged — the tool-neutral rename is a separate refactor.
  reviewTool: 'dakar' | 'coderabbit'
  dakarCommand: string
  dakarTimeoutSeconds: number
  // 0 means "omit --budget-gbp and let Dakar apply its own default budget".
  dakarBudgetGbp: number
  coderabbitAttempts: number
  coderabbitBackoffMinutes: [number, number]
  coderabbitFindingsFile: string
  commitGates: readonly string[]
  commitGateTimeoutSeconds: number
  csCheck: boolean
  csCheckCommand: string
}

// Dakar emits ONE JSON document on stdout (not NDJSON). The document carries a
// tri-state result: `ok` (did the run itself complete), `skipped` (nothing was
// unreviewed), `verdict` (pass | changes-requested), and — when ok is false —
// a `stage` plus `error`. `stage: 'deferred'` is Dakar's budget/quota backoff
// signal, mapped onto the CodeRabbit rate-limit path so the existing host
// backoff loop and run-task deferral handling apply verbatim.
export interface DakarFinding extends Record<string, unknown> {
  severity?: string
  path?: string
  line?: number | string
  title?: string
  detail?: string
  evidence?: string
}

export interface DakarDocument extends Record<string, unknown> {
  ok?: boolean
  skipped?: boolean
  verdict?: string
  stage?: string
  error?: string
  findings?: DakarFinding[]
}

// Dakar severities onto the CodeRabbit severity vocabulary. critical+high map to
// CodeRabbit's blocking critical+major (see CODERABBIT_BLOCKING_SEVERITIES), so
// coderabbitBlockingItems blocks on exactly Dakar's critical+high. Unknown
// severities fall through to the non-blocking 'info' bucket.
export const DAKAR_SEVERITY_MAP: Record<string, string> = {
  critical: 'critical',
  high: 'major',
  medium: 'minor',
  low: 'trivial',
}

// Keep a bounded tail of operator/CLI-controlled text so a runaway error stream
// cannot bloat the review detail or the durable findings sink.
function boundedTail(text: unknown, limit = 2000): string {
  const value = String(text || '')
  return value.length > limit ? value.slice(-limit) : value
}

// Slice from the first '{' and parse the remainder as one JSON document; any
// leading progress noise before the document is ignored. Returns null on a
// missing brace or a parse failure, which the classifier reads as 'error'.
export function parseDakarDocument(stdout: unknown): DakarDocument | null {
  const text = String(stdout || '')
  const start = text.indexOf('{')
  if (start === -1) return null
  try {
    const doc = JSON.parse(text.slice(start))
    return doc && typeof doc === 'object' ? (doc as DakarDocument) : null
  } catch {
    return null
  }
}

export function mapDakarFinding(finding: DakarFinding): CoderabbitFinding {
  const severity = DAKAR_SEVERITY_MAP[String(finding.severity || '').toLowerCase()] || 'info'
  const filePath = String(finding.path || '')
  const title = String(finding.title || '')
  const detail = String(finding.detail || '')
  const evidence = String(finding.evidence || '')
  const hasLine = finding.line !== undefined && finding.line !== null && String(finding.line) !== ''
  const locator = hasLine ? ` (${filePath}:${finding.line})` : ''
  return {
    type: 'finding',
    severity,
    fileName: filePath,
    comment: `${title} — ${detail}${locator}`.slice(0, 2000),
    codegenInstructions: `${detail}\nEvidence: ${evidence}`.slice(0, 2000),
    suggestions: [],
  }
}

// Map one Dakar run onto the single-attempt shape the shared retry loop consumes
// ({ outcome, findings, detail }). Order matters: an unparsable/absent document
// is an error first; then ok===false splits into deferred (rate-limited) vs a
// stage error; then ok===true resolves skipped/pass (clean) and
// changes-requested (findings). Any other shape fails closed as an error.
export function classifyDakarReview(execResult: ExecStatus): { outcome: CoderabbitOutcome; findings: CoderabbitFinding[]; detail: string } {
  const doc = parseDakarDocument(execResult.stdout)
  if (!doc) {
    const detail = boundedTail([execResult.stderr, execResult.message].filter(Boolean).join('\n')) || 'dakar-review produced no parsable JSON output'
    return { outcome: 'error', findings: [], detail }
  }
  if (doc.ok === false) {
    if (String(doc.stage) === 'deferred') {
      // 'dakar' + 'deferred' markers let assessment.ts recognize this as a
      // recoverable review deferral, mirroring the CodeRabbit rate-limit path.
      return { outcome: 'rate-limited', findings: [], detail: `Dakar review deferred (stage: deferred) — ${boundedTail(doc.error || 'no detail')}` }
    }
    return { outcome: 'error', findings: [], detail: `stage: ${doc.stage ?? 'unknown'} — ${boundedTail(doc.error || 'no detail')}` }
  }
  if (doc.ok === true) {
    if (doc.skipped === true || doc.verdict === 'pass') return { outcome: 'clean', findings: [], detail: '' }
    if (doc.verdict === 'changes-requested') {
      const findings = (Array.isArray(doc.findings) ? doc.findings : []).map(mapDakarFinding)
      return { outcome: 'findings', findings, detail: '' }
    }
  }
  return { outcome: 'error', findings: [], detail: `unrecognized Dakar review shape (ok=${doc.ok}, verdict=${boundedTail(doc.verdict ?? 'none', 200)})` }
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

export const csCheckMetrics = { runs: 0, failures: 0, skipped: 0 }

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
    reviewTool,
    dakarCommand,
    dakarTimeoutSeconds,
    dakarBudgetGbp,
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

  // One CodeRabbit attempt: exec the NDJSON --agent review and classify from the
  // event stream (never the exit code). Detail is empty on a clean/findings
  // outcome; otherwise it carries the first parsable error text.
  async function runCoderabbitAttempt(worktree: string, exec: NonNullable<HostReviewDeps['exec']>): Promise<{ outcome: CoderabbitOutcome; findings: CoderabbitFinding[]; detail: string }> {
    const result = await exec('coderabbit', ['review', '--agent', '--type', 'committed', '--base', base], { cwd: worktree })
    const parsed = parseCoderabbitAgentOutput(result.stdout)
    const outcome = classifyCoderabbitOutcome(result, parsed)
    const detail = outcome === 'clean' || outcome === 'findings'
      ? ''
      : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join('; ') || 'coderabbit produced no parsable outcome').trim()
    return { outcome, findings: parsed.findings, detail }
  }

  // One Dakar attempt: exec the Dakar CLI against the committed diff and map its
  // single JSON document onto the CoderabbitReview single-attempt shape. A fresh
  // ephemeral state root per attempt keeps the gate stateless — Dakar otherwise
  // records reviewed heads and would skip already-seen commits across runs, so a
  // shared state root would silently turn re-reviews into no-ops.
  async function runDakarAttempt(worktree: string, exec: NonNullable<HostReviewDeps['exec']>): Promise<{ outcome: CoderabbitOutcome; findings: CoderabbitFinding[]; detail: string }> {
    const fs = process.getBuiltinModule('node:fs')
    const os = process.getBuiltinModule('node:os')
    const path = process.getBuiltinModule('node:path')
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'df12-dakar-state-'))
    const commandArgs = [
      '--repo-root', worktree,
      '--base', base,
      '--state-root', stateRoot,
      '--timeout', String(dakarTimeoutSeconds),
      ...(dakarBudgetGbp > 0 ? ['--budget-gbp', String(dakarBudgetGbp)] : []),
    ]
    const result = await exec(dakarCommand, commandArgs, { cwd: worktree })
    return classifyDakarReview(result)
  }

  // Run one host review against the worktree's COMMITTED changes, absorbing
  // rate-limit/deferral backoff in host wall-clock (zero agent tokens). Returns
  // { outcome, attempts, findings, detail }. The retry/backoff loop wraps BOTH
  // tools' 'rate-limited' outcomes identically; the per-tool attempt differs
  // only in the CLI and the parse. The tool-neutral rename of this function (and
  // the CoderabbitReview type) is deliberately DEFERRED so run-task.ts and its
  // tests keep calling this exact name and contract. deps are injectable for
  // tests.
  async function runCoderabbitHostReview(worktree: string, label: string, deps: HostReviewDeps = {}): Promise<CoderabbitReview> {
    const exec = deps.exec || execFileStatus
    const sleep = deps.sleep || hostSleepMinutes
    const toolName = reviewTool === 'dakar' ? 'Dakar' : 'CodeRabbit'
    for (let attempt = 1; ; attempt++) {
      log(`[${label}] ${toolName} host review attempt ${attempt} of ${coderabbitAttempts}`)
      const single = reviewTool === 'dakar'
        ? await runDakarAttempt(worktree, exec)
        : await runCoderabbitAttempt(worktree, exec)
      if (single.outcome === 'rate-limited' && attempt < coderabbitAttempts) {
        const minutes = coderabbitBackoffMinutes(`${label}#${attempt}`)
        log(`[${label}] ${toolName} rate limited/deferred; host backs off ${minutes} minutes before attempt ${attempt + 1} of ${coderabbitAttempts} (wall-clock only, no agent tokens)`)
        await sleep(minutes)
        continue
      }
      return { outcome: single.outcome, attempts: attempt, findings: single.findings, detail: single.detail }
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
  async function runCodeSceneCheck(worktree: string, tag: string, label: string): Promise<{ clean: boolean; skipped: boolean; detail: string; logFile: string }> {
    if (!csCheck) return { clean: true, skipped: true, detail: '', logFile: '' }
    const bin = csCheckCommand.trim().split(/\s+/)[0] || 'cs-check-changed'
    // Pass the probed name as a positional argument ($1), never interpolated
    // into the command string: csCheckCommand is operator config (a trust
    // boundary), so shell metacharacters in the name must not be interpreted.
    const probe = await execFileStatus('sh', ['-c', 'command -v "$1"', 'sh', bin], { cwd: worktree })
    if (!probe.ok) {
      csCheckMetrics.skipped += 1
      log(`[task ${tag}] CodeScene check (${label}) skipped: ${bin} not on PATH`)
      return { clean: true, skipped: true, detail: `${bin} not on PATH`, logFile: '' }
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

  return { coderabbitBackoffMinutes, runCoderabbitHostReview, recordCoderabbitReview, runHostCommitGates, runCodeSceneCheck }
}
