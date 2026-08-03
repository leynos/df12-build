/**
 * @file Host-run Dakar and CodeRabbit review adapters plus deterministic host
 * commit gates. Review retries, backoff, findings capture, and gate execution
 * bind once through `makeHostReview`; parsers and bounded aggregates remain
 * directly testable exports.
 */
import { execFileStatus } from './exec.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'
import { authFailureDetail } from './faults.ts'

/** Normalized finding shape produced by every host-review adapter. */
export interface ReviewFinding extends Record<string, unknown> {
  type?: string
  severity?: string
  fileName?: string
  comment?: string
  codegenInstructions?: string
  suggestions?: unknown[]
}

/** Parsed CodeRabbit NDJSON events and terminal records. */
export interface CoderabbitParsedOutput {
  events: Array<Record<string, unknown>>
  rawLines: string[]
  findings: ReviewFinding[]
  complete: Record<string, unknown> | null
  error: (Record<string, unknown> & { errorType?: string; message?: string }) | null
}

/** Tool-neutral terminal outcome vocabulary. */
export type ReviewOutcome = 'clean' | 'findings' | 'rate-limited' | 'auth' | 'error'

/** Bounded reason attached to terminal host-review telemetry. */
export type ReviewErrorCategory = 'none' | 'deferred' | 'timeout' | 'auth' | 'invalid-output' | 'execution'

/** One completed host-review result after bounded retries. */
export interface HostReviewResult {
  reviewer: 'dakar' | 'coderabbit'
  outcome: ReviewOutcome
  attempts: number
  elapsedMs: number
  errorCategory: ReviewErrorCategory
  findings: ReviewFinding[]
  detail: string
}

/** Public compatibility aliases for integrations compiled against older names. */
export type CoderabbitFinding = ReviewFinding
export type CoderabbitOutcome = ReviewOutcome
export type CoderabbitReview = HostReviewResult

/** Aggregate result from the configured deterministic host gates. */
export interface HostGateRun {
  green: boolean
  results: Array<{ command: string; ok: boolean; logFile: string }>
  detail: string
}

/** Injectable execution, sleep, and Dakar cleanup seams for deterministic tests. */
export interface HostReviewDeps {
  exec?: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  sleep?: (minutes: number) => Promise<void>
  removeDakarStateRoot?: (stateRoot: string, options: { recursive: true; force: true }) => void
  nowMs?: () => number
}

/** Bound configuration shared by reviewer adapters and host gates. */
export interface HostReviewConfig {
  base: string
  // The host review tool. 'dakar' (the default) runs the Dakar CLI and maps its
  // JSON verdict onto the CoderabbitReview contract; 'coderabbit' keeps the
  // retained NDJSON path. The CoderabbitReview shape and run-task call sites are
  // deliberately unchanged — the tool-neutral rename is a separate refactor.
  reviewTool: 'dakar' | 'coderabbit'
  dakarCommand: string
  reviewTimeoutSeconds: number
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

/** One untrusted finding from Dakar's compatibility projection. */
export interface DakarFinding extends Record<string, unknown> {
  severity?: string
  path?: string
  line?: number
  title?: string
  detail?: string
  evidence?: string
}

/** Dakar's single-document stdout contract before boundary validation. */
export interface DakarDocument extends Record<string, unknown> {
  ok?: boolean
  skipped?: boolean
  verdict?: string
  stage?: string
  error?: string
  findings?: DakarFinding[]
}

/** Map validated Dakar severities onto the retained blocking vocabulary. */
export const DAKAR_SEVERITY_MAP: Record<string, string> = {
  critical: 'critical',
  high: 'major',
  medium: 'minor',
  low: 'trivial',
}

const DAKAR_SEVERITIES = new Set(Object.keys(DAKAR_SEVERITY_MAP))
const DAKAR_REQUIRED_FINDING_FIELDS = ['path', 'title', 'detail', 'evidence'] as const

// Keep a bounded tail of operator/CLI-controlled text so a runaway error stream
// cannot bloat the review detail or the durable findings sink.
function boundedTail(text: unknown, limit = 2000): string {
  const value = String(text || '')
  return value.length > limit ? value.slice(-limit) : value
}

/** Locate Dakar's terminal JSON object despite leading progress noise. */
export function parseDakarDocument(stdout: unknown): DakarDocument | null {
  const text = String(stdout || '')
  for (
    let start = text.lastIndexOf('{');
    start !== -1;
    start = start === 0 ? -1 : text.lastIndexOf('{', start - 1)
  ) {
    try {
      const doc = JSON.parse(text.slice(start))
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as DakarDocument
    } catch {
      // A brace in progress noise or a nested object is not the terminal document root.
    }
  }
  return null
}

/** Map one validated Dakar finding onto the retained findings contract. */
export function mapDakarFinding(finding: DakarFinding): ReviewFinding {
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

// A rejection without valid findings would produce no blocking items and let
// the fix-round gate continue, so validate the collection before mapping it.
function validateChangesRequestedFindings(raw: unknown):
  | { ok: true; findings: DakarFinding[] }
  | { ok: false; detail: string } {
  const findings = Array.isArray(raw) ? raw : null
  if (!findings || findings.length === 0) {
    return {
      ok: false,
      detail: 'Dakar returned changes-requested without any findings; refusing to treat a reviewer rejection as non-blocking',
    }
  }
  for (const [index, finding] of findings.entries()) {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      return {
        ok: false,
        detail: boundedTail(`Dakar returned a malformed finding at index ${index}; expected an object`, 2000),
      }
    }
    const item = finding as Record<string, unknown>
    if (typeof item.severity !== 'string' || !DAKAR_SEVERITIES.has(item.severity)) {
      return {
        ok: false,
        detail: boundedTail(`Dakar returned an invalid finding at index ${index}; unsupported severity`, 2000),
      }
    }
    const invalidField = DAKAR_REQUIRED_FINDING_FIELDS.find((field) => typeof item[field] !== 'string')
    if (invalidField) {
      return {
        ok: false,
        detail: boundedTail(`Dakar returned an invalid finding at index ${index}; ${invalidField} must be a string`, 2000),
      }
    }
    if (item.line !== undefined && (!Number.isInteger(item.line) || Number(item.line) < 1)) {
      return {
        ok: false,
        detail: boundedTail(`Dakar returned an invalid finding at index ${index}; line must be a positive integer`, 2000),
      }
    }
  }
  return { ok: true, findings: findings as DakarFinding[] }
}

function validateCleanDakarFindings(raw: unknown): string {
  if (raw === undefined) return ''
  if (!Array.isArray(raw)) return 'Dakar returned a clean verdict with a malformed findings field'
  if (raw.length > 0) return 'Dakar returned a clean verdict with findings; refusing to discard reviewer findings'
  return ''
}

/** Classify and fail-closed validate one Dakar process result. */
export function classifyDakarReview(execResult: ExecStatus): { outcome: ReviewOutcome; findings: ReviewFinding[]; detail: string } {
  const doc = parseDakarDocument(execResult.stdout)
  if (!doc) {
    const detail = boundedTail([execResult.stderr, execResult.message].filter(Boolean).join('\n')) || 'dakar-review produced no parsable JSON output'
    return { outcome: 'error', findings: [], detail }
  }
  if (doc.ok === false) {
    const stage = boundedTail(doc.stage ?? 'unknown', 200)
    if (String(doc.stage) === 'deferred') {
      // 'dakar' + 'deferred' markers let assessment.ts recognize this as a
      // recoverable review deferral, mirroring the CodeRabbit rate-limit path.
      return { outcome: 'rate-limited', findings: [], detail: `Dakar review deferred (stage: ${stage}) — ${boundedTail(doc.error || 'no detail')}` }
    }
    return { outcome: 'error', findings: [], detail: `stage: ${stage} — ${boundedTail(doc.error || 'no detail')}` }
  }
  if (doc.ok === true) {
    if (doc.skipped === true || doc.verdict === 'pass') {
      const invalidFindings = validateCleanDakarFindings(doc.findings)
      if (invalidFindings) return { outcome: 'error', findings: [], detail: invalidFindings }
      return { outcome: 'clean', findings: [], detail: '' }
    }
    if (doc.verdict === 'changes-requested') {
      const validation = validateChangesRequestedFindings(doc.findings)
      if (!validation.ok) return { outcome: 'error', findings: [], detail: validation.detail }
      return { outcome: 'findings', findings: validation.findings.map(mapDakarFinding), detail: '' }
    }
  }
  return { outcome: 'error', findings: [], detail: `unrecognized Dakar review shape (ok=${doc.ok}, verdict=${boundedTail(doc.verdict ?? 'none', 200)})` }
}

/**
 * Parse CodeRabbit's NDJSON event stream; exit status is not its verdict.
 *
 * The CLI's --agent mode emits NDJSON events on stdout and exits 0 even on
 * fatal errors, so classification parses events, never exit codes. The wire
 * contract and captured live sessions are documented in
 * docs/coderabbit-wire-contract.md.
 *
 * Event types are progress (`review_context`, `status`, `heartbeat`), finding,
 * complete, and error records. Findings carry severity and file/detail fields;
 * terminal records carry status or error metadata.
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

/** Severities that enter the shared blocking-items gate. */
export const CODERABBIT_BLOCKING_SEVERITIES = new Set(['critical', 'major'])

/**
 * Success sentinels observed in CodeRabbit terminal completion events.
 *
 * Both spellings are observed from the real CLI. Any other terminal status,
 * including a cancelled or aborted review, must not read as clean.
 */
export const CODERABBIT_SUCCESS_STATUSES = new Set(['review_completed', 'reviewed'])

/** Classify parsed CodeRabbit events into the shared outcome vocabulary. */
export function classifyCoderabbitOutcome(
  execResult: { ok?: boolean; stderr?: string; message?: string },
  parsed: CoderabbitParsedOutput,
): ReviewOutcome {
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

/** Sleep for a host-side review backoff without consuming agent tokens. */
export async function hostSleepMinutes(minutes: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, minutes * 60000))
}

/** Convert blocking normalized findings into bounded fix-round items. */
export function reviewBlockingItems(reviewer: string, findings: readonly ReviewFinding[] | null | undefined): string[] {
  const name = boundedTail(reviewer, 40) || 'host reviewer'
  return (findings || [])
    .filter((finding) => CODERABBIT_BLOCKING_SEVERITIES.has(String(finding.severity || '').toLowerCase()))
    .map((finding) => `${name} (${finding.severity}) ${finding.fileName || 'unknown file'}: ${String(finding.comment || finding.codegenInstructions || 'see the recorded suggestions').slice(0, 500)}`)
}

/** Bounded process-local host-review metrics. */
export const hostReviewMetrics: {
  runs: number
  findings: number
  retries: number
  deferred: number
  timeouts: number
  errors: number
  authFailures: number
  sinkFailures: number
  bySeverity: Record<'critical' | 'major' | 'minor' | 'trivial' | 'info' | 'unknown', number>
  sinkError: string
} = {
  runs: 0,
  findings: 0,
  retries: 0,
  deferred: 0,
  timeouts: 0,
  errors: 0,
  authFailures: 0,
  sinkFailures: 0,
  bySeverity: { critical: 0, major: 0, minor: 0, trivial: 0, info: 0, unknown: 0 },
  sinkError: '',
}

/** Compatibility aliases retained for external module consumers. */
export const coderabbitCapture = hostReviewMetrics
export function coderabbitBlockingItems(findings: readonly ReviewFinding[] | null | undefined): string[] {
  return reviewBlockingItems('CodeRabbit', findings)
}

/** Process-local deterministic host-gate counters. */
export const hostGateMetrics = { runs: 0, failures: 0 }

/** Process-local CodeScene gate counters. */
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

/** Build a sanitized path inside the private per-process gate-log directory. */
export function hostGateLogPath(tag: string, roundLabel: string, index: number): string {
  const slug = (value: unknown) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const path = process.getBuiltinModule('node:path')
  return path.join(gateLogRoot(), `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`)
}

/** Bind reviewer dispatch, retry, findings recording, and host-gate execution. */
export function makeHostReview(config: HostReviewConfig) {
  const {
    base,
    reviewTool,
    dakarCommand,
    reviewTimeoutSeconds,
    dakarBudgetGbp,
    coderabbitAttempts,
    coderabbitBackoffMinutes: backoffRange,
    coderabbitFindingsFile: findingsFile,
    commitGates,
    commitGateTimeoutSeconds,
    csCheck,
    csCheckCommand,
  } = config
  const dakarInvocation = dakarCommand.trim().split(/\s+/).filter(Boolean)
  const dakarExecutable = dakarInvocation[0] || 'dakar-review'
  const dakarPrefixArgs = dakarInvocation.slice(1)
  let findingsSinkTail = Promise.resolve()

  // Deterministic jitter in [low, high] minutes: Math.random() is banned for
  // Claude Code workflow dual-compatibility (ODW scanDualCompat), and a seeded
  // spread keeps sibling tasks from hammering the quota in lockstep.
  function reviewBackoffMinutes(seed: unknown): number {
    let hash = 5381
    for (const ch of String(seed)) hash = ((hash * 33) ^ (ch.codePointAt(0) as number)) >>> 0
    const [low, high] = backoffRange
    return low + (hash % (high - low + 1))
  }

  // One CodeRabbit attempt: exec the NDJSON --agent review and classify from the
  // event stream (never the exit code). Detail is empty on a clean/findings
  // outcome; otherwise it carries the first parsable error text.
  async function runCoderabbitAttempt(worktree: string, exec: NonNullable<HostReviewDeps['exec']>): Promise<{ outcome: ReviewOutcome; findings: ReviewFinding[]; detail: string; timedOut: boolean }> {
    const result = await exec('coderabbit', ['review', '--agent', '--type', 'committed', '--base', base], {
      cwd: worktree,
      timeoutMs: reviewTimeoutSeconds * 1000,
    })
    const parsed = parseCoderabbitAgentOutput(result.stdout)
    const outcome = classifyCoderabbitOutcome(result, parsed)
    const detail = outcome === 'clean' || outcome === 'findings'
      ? ''
      : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join('; ') || 'coderabbit produced no parsable outcome').trim()
    return { outcome, findings: parsed.findings, detail: boundedTail(detail), timedOut: Boolean(result.killed) }
  }

  // One Dakar attempt: exec the Dakar CLI against the committed diff and map its
  // single JSON document onto the CoderabbitReview single-attempt shape. A fresh
  // ephemeral state root per attempt keeps the gate stateless — Dakar otherwise
  // records reviewed heads and would skip already-seen commits across runs, so a
  // shared state root would silently turn re-reviews into no-ops.
  async function runDakarAttempt(worktree: string, exec: NonNullable<HostReviewDeps['exec']>, removeStateRoot?: HostReviewDeps['removeDakarStateRoot']): Promise<{ outcome: ReviewOutcome; findings: ReviewFinding[]; detail: string; timedOut: boolean }> {
    const fs = process.getBuiltinModule('node:fs')
    const os = process.getBuiltinModule('node:os')
    const path = process.getBuiltinModule('node:path')
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'df12-dakar-state-'))
    const commandArgs = [
      '--repo-root', worktree,
      '--base', base,
      '--state-root', stateRoot,
      '--timeout', String(reviewTimeoutSeconds),
      ...(dakarBudgetGbp > 0 ? ['--budget-gbp', String(dakarBudgetGbp)] : []),
    ]
    try {
      const result = await exec(dakarExecutable, [...dakarPrefixArgs, ...commandArgs], {
        cwd: worktree,
        timeoutMs: reviewTimeoutSeconds * 1000,
      })
      return { ...classifyDakarReview(result), timedOut: Boolean(result.killed) }
    } finally {
      try {
        const cleanup = removeStateRoot || fs.rmSync
        cleanup(stateRoot, { recursive: true, force: true })
      } catch (error) {
        const detail = boundedTail((error as Error | null)?.message || String(error), 500)
        log(`[Dakar] could not remove temporary state root: ${detail}`)
      }
    }
  }

  // Run one host review against the worktree's COMMITTED changes, absorbing
  // rate-limit/deferral backoff in host wall-clock (zero agent tokens). Returns
  // { outcome, attempts, findings, detail }. The retry/backoff loop wraps BOTH
  // tools' 'rate-limited' outcomes identically; the per-tool attempt differs
  // only in the CLI and the parse. The tool-neutral rename of this function (and
  // the CoderabbitReview type) is deliberately DEFERRED so run-task.ts and its
  // tests keep calling this exact name and contract. deps are injectable for
  // tests.
  async function runHostReview(worktree: string, label: string, deps: HostReviewDeps = {}): Promise<HostReviewResult> {
    const exec = deps.exec || execFileStatus
    const sleep = deps.sleep || hostSleepMinutes
    const nowMs = deps.nowMs || (() => Number(process.hrtime.bigint() / 1_000_000n))
    const reviewer = reviewTool
    const reviewerName = reviewer === 'dakar' ? 'Dakar' : 'CodeRabbit'
    const boundedLabel = boundedTail(label, 120)
    const startedMs = nowMs()
    let terminalAttempt = 1
    try {
      for (let attempt = 1; ; attempt++) {
        terminalAttempt = attempt
        log(`[${boundedLabel}] ${reviewerName} host review attempt ${attempt} of ${coderabbitAttempts}`)
        const single = reviewer === 'dakar'
          ? await runDakarAttempt(worktree, exec, deps.removeDakarStateRoot)
          : await runCoderabbitAttempt(worktree, exec)
        if (single.outcome === 'rate-limited' && attempt < coderabbitAttempts) {
          const minutes = reviewBackoffMinutes(`${boundedLabel}#${attempt}`)
          log(`[${boundedLabel}] ${reviewerName} rate limited/deferred; host backs off ${minutes} minutes before attempt ${attempt + 1} of ${coderabbitAttempts} (wall-clock only, no agent tokens)`)
          await sleep(minutes)
          continue
        }
        const errorCategory: ReviewErrorCategory = single.timedOut
          ? 'timeout'
          : single.outcome === 'rate-limited'
            ? 'deferred'
            : single.outcome === 'auth'
              ? 'auth'
              : single.outcome === 'error'
                ? (single.detail.includes('parsable') || single.detail.includes('unrecognized') || single.detail.includes('malformed') ? 'invalid-output' : 'execution')
                : 'none'
        const review: HostReviewResult = {
          reviewer,
          outcome: single.outcome,
          attempts: attempt,
          elapsedMs: Math.max(0, Math.trunc(nowMs() - startedMs)),
          errorCategory,
          findings: single.findings,
          detail: boundedTail(single.detail),
        }
        hostReviewMetrics.runs += 1
        hostReviewMetrics.retries += attempt - 1
        if (review.outcome === 'rate-limited') hostReviewMetrics.deferred += 1
        if (review.outcome === 'auth') hostReviewMetrics.authFailures += 1
        if (review.outcome === 'error') hostReviewMetrics.errors += 1
        if (review.errorCategory === 'timeout') hostReviewMetrics.timeouts += 1
        log(`[host-review] terminal ${JSON.stringify({ reviewer, label: boundedLabel, attempts: attempt, elapsedMs: review.elapsedMs, outcome: review.outcome, errorCategory: review.errorCategory })}`)
        return review
      }
    } catch (error) {
      const elapsedMs = Math.max(0, Math.trunc(nowMs() - startedMs))
      hostReviewMetrics.runs += 1
      hostReviewMetrics.retries += terminalAttempt - 1
      hostReviewMetrics.errors += 1
      log(`[host-review] terminal ${JSON.stringify({ reviewer, label: boundedLabel, attempts: terminalAttempt, elapsedMs, outcome: 'error', errorCategory: 'execution' })}`)
      throw error
    }
  }

  async function recordHostReview(label: string, review: HostReviewResult): Promise<void> {
    for (const finding of review.findings) {
      hostReviewMetrics.findings += 1
      const rawSeverity = String(finding.severity || 'unknown').toLowerCase()
      const severity = rawSeverity in hostReviewMetrics.bySeverity ? rawSeverity as keyof typeof hostReviewMetrics.bySeverity : 'unknown'
      hostReviewMetrics.bySeverity[severity] += 1
    }
    if (!findingsFile || !review.findings.length) return
    const append = async () => {
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
        await fs.appendFile(findingsFile, `${lines.join('\n')}\n`, 'utf8')
      } catch (error) {
        hostReviewMetrics.sinkFailures += 1
        hostReviewMetrics.sinkError = boundedTail((error as Error | null)?.message || String(error), 500)
        log(`[${boundedTail(label, 120)}] could not append ${review.reviewer} host-review findings to ${findingsFile}: ${hostReviewMetrics.sinkError}`)
      }
    }
    const pending = findingsSinkTail.then(append, append)
    findingsSinkTail = pending.then(() => undefined, () => undefined)
    await pending
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
      // synchronous open below and settles the gate before a child is spawned.
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
      const openFlags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
      let fd: number
      try {
        fd = fs.openSync(logFile, openFlags, 0o600)
      } catch (error) {
        resolve({ ok: false, killed: false, tail: `gate log write failed: ${(error as Error).message}` })
        return
      }
      const stream = fs.createWriteStream(logFile, { fd, autoClose: true })
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

  return {
    reviewBackoffMinutes,
    runHostReview,
    recordHostReview,
    runHostCommitGates,
    runCodeSceneCheck,
    // Public compatibility aliases. Workflow policy uses only neutral names.
    coderabbitBackoffMinutes: reviewBackoffMinutes,
    runCoderabbitHostReview: runHostReview,
    recordCoderabbitReview: recordHostReview,
  }
}
