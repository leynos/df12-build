/**
 * Secure deterministic host gates and CodeScene execution.
 *
 * This module owns the process, secure-log, timer, and temporary-root ports
 * used by host gates. The ports make failures deterministic in tests while the
 * production defaults retain isolated process groups and no-follow log files.
 *
 * @module
 */
import { execFileStatus } from './exec.ts'
import { redactedShellCommand, tokenizeShellCommand } from './shell-command.ts'
import {
  boundedTail,
  NOOP_HOST_REVIEW_TRACER,
  type CodeSceneCheckResult,
  type CodeSceneMetrics,
  type HostGateLogRoot,
  type HostGateMetrics,
  type HostGateRun,
  type HostReviewSpan,
  type HostReviewTraceContext,
  type HostReviewTracer,
} from './host-review-contracts.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'

/** Configuration bound by the host-gate factory. */
export interface HostGateConfig {
  /** Commands run against the committed worktree. */
  commitGates: readonly string[]
  /** Maximum run time for each gate in seconds. */
  commitGateTimeoutSeconds: number
  /** Whether CodeScene is enabled. */
  csCheck: boolean
  /** Operator-configured CodeScene command. */
  csCheckCommand: string
  /** Optional isolated log-path service used by deterministic tests. */
  gateLogPath?: (tag: string, roundLabel: string, index: number) => string
  /** Optional gate-log root lifecycle used by the host execution boundary. */
  gateLogRoot?: HostGateLogRoot
}

/** Minimal readable process stream needed by the secure gate pump. */
export interface HostGateReadable {
  /** Subscribe to stream data events. */
  on: (event: 'data', listener: (chunk: unknown) => void) => unknown
  /** Pause a backpressured process pipe. */
  pause?: () => void
  /** Resume a process pipe before group termination. */
  resume?: () => void
}

/** Minimal detached child-process contract needed by gate lifecycle code. */
export interface HostGateChild {
  /** Process-group leader PID when the host supplied one. */
  pid?: number
  /** Standard output pump. */
  stdout?: HostGateReadable
  /** Standard error pump. */
  stderr?: HostGateReadable
  /** Subscribe to close and spawn-error events. */
  on: (event: 'close' | 'error', listener: (value: number | Error | null) => void) => unknown
  /** Fallback single-process signal operation. */
  kill: (signal: 'SIGTERM' | 'SIGKILL') => unknown
}

/** Secure output stream contract used by the gate log sink. */
export interface HostGateLog {
  /** Write one process-output chunk and report backpressure. */
  write: (chunk: unknown) => boolean
  /** Flush and close the stream before settling the gate. */
  end: (callback: () => void) => void
  /** Subscribe to stream errors and drain notifications. */
  on: (event: 'error' | 'drain', listener: (error?: Error) => void) => unknown
}

/** Opaque timer handle returned by a host timer implementation. */
export interface HostGateTimer {
  /** Allow the event loop to exit while this timer remains pending. */
  unref?: () => void
}

/**
 * Purpose-shaped host-gate I/O and lifecycle ports.
 *
 * Production defaults are secure Node implementations. Tests may inject only
 * the faulting boundary they need; no mutable Node module bag crosses this API.
 */
export interface HostGateDeps {
  /** Probe a CodeScene executable without running the full gate. */
  probeCodeScene?: (command: string, args: readonly string[], options: ExecOptions) => Promise<ExecStatus>
  /** Create an isolated, detached shell child for a gate command. */
  spawnGate?: (command: string, cwd: string) => HostGateChild
  /** Signal the complete gate process group, falling back to its leader. */
  terminateProcessGroup?: (child: HostGateChild, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Allocate and open an exclusive no-follow mode-0600 gate log. */
  openSecureLog?: (path: string) => HostGateLog
  /** Create the private temporary root used by lazily allocated gate logs. */
  createLogRoot?: () => string
  /** Remove a private temporary gate-log root after workflow completion. */
  removeLogRoot?: (root: string, options: { recursive: true; force: true }) => void
  /** Schedule timeout escalation or forced settlement. */
  setTimer?: (callback: () => void, delayMs: number) => HostGateTimer
  /** Cancel a prior timeout escalation or forced-settlement timer. */
  clearTimer?: (timer: HostGateTimer) => void
  /** Monotonic clock used only for bounded elapsed-time span attributes. */
  nowMs?: () => number
  /** Vendor-neutral tracing port for gate and CodeScene boundary spans. */
  tracer?: HostReviewTracer
  /** Stable workflow correlation supplied by the composition boundary. */
  traceContext?: HostReviewTraceContext
  /** Selected reviewer identifier, recorded only as a bounded static attribute. */
  reviewer?: 'dakar' | 'coderabbit'
}

/** Maximum retained unterminated output while a gate continues streaming to disk. */
export const GATE_CARRY_LIMIT = 16_384

/** Return the executable word of a safely tokenized configured command. */
export function codeSceneExecutable(command: string): string | null {
  const tokens = tokenizeShellCommand(command)
  if (!tokens || tokens.hasUnquotedControlOperator) return null
  return tokens.words[tokens.executableWordIndex]?.value || ''
}

/** Calculate a sanitized private gate-log path within a caller-owned root. */
export function hostGateLogPath(root: string, tag: string, roundLabel: string, index: number): string {
  /** Prevent untrusted task labels from escaping the allocated private root. */
  const slug = (value: unknown) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const path = process.getBuiltinModule('node:path')
  return path.join(root, `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`)
}

/** Build production defaults without exposing Node modules to callers. */
function productionHostGateDeps(): Required<Pick<HostGateDeps, 'probeCodeScene' | 'spawnGate' | 'terminateProcessGroup' | 'openSecureLog' | 'createLogRoot' | 'removeLogRoot' | 'setTimer' | 'clearTimer' | 'nowMs'>> {
  const fs = process.getBuiltinModule('node:fs')
  const os = process.getBuiltinModule('node:os')
  const path = process.getBuiltinModule('node:path')
  const { spawn } = process.getBuiltinModule('node:child_process')
  return {
    probeCodeScene: execFileStatus,
    spawnGate: (command, cwd) => spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as HostGateChild,
    /** Prefer signalling the detached group so background descendants are reaped. */
    terminateProcessGroup: (child, signal) => {
      if (typeof child.pid === 'number') {
        try { process.kill(-child.pid, signal); return } catch { /* A race can reap the group before escalation. */ }
      }
      child.kill(signal)
    },
    /** Refuse pre-existing or symlinked paths before a gate writes untrusted output. */
    openSecureLog: (logFile) => {
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
      const fd = fs.openSync(logFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
      return fs.createWriteStream(logFile, { fd, autoClose: true }) as unknown as HostGateLog
    },
    createLogRoot: () => fs.mkdtempSync(path.join(os.tmpdir(), 'df12-gates-')),
    removeLogRoot: (root, options) => fs.rmSync(root, options),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  }
}

/** Allocate a lazy temporary-root path service with cleanup failure containment. */
function makeGateLogPaths(lifecycle: HostGateLogRoot | undefined, deps: Required<Pick<HostGateDeps, 'createLogRoot' | 'removeLogRoot'>>): { path: (tag: string, roundLabel: string, index: number) => string; dispose: () => void } {
  let gateLogRoot = ''
  /** Allocate the root on first gate use so disabled gates do not touch disk. */
  const root = () => {
    if (!gateLogRoot) gateLogRoot = lifecycle?.create() || deps.createLogRoot()
    return gateLogRoot
  }
  return {
    path: (tag, roundLabel, index) => hostGateLogPath(root(), tag, roundLabel, index),
    /** Contain root-removal errors so cleanup cannot replace workflow results. */
    dispose: () => {
      if (!gateLogRoot) return
      try { (lifecycle?.remove || deps.removeLogRoot)(gateLogRoot, { recursive: true, force: true }) } catch (error) {
        log(`[host gates] could not remove temporary log root: ${boundedTail((error as Error | null)?.message || String(error), 500)}`)
      }
      gateLogRoot = ''
    },
  }
}

/** Bind secure gate execution to run-scoped metrics, tracing, and configuration. */
export function makeHostGates(config: HostGateConfig, metrics: { hostGates: HostGateMetrics; codeScene: CodeSceneMetrics }, injected: HostGateDeps = {}): {
  /** Run every configured commit gate in order. */
  runHostCommitGates: (worktree: string, tag: string, roundLabel: string) => Promise<HostGateRun>
  /** Run CodeScene after commit gates when configured. */
  runCodeSceneCheck: (worktree: string, tag: string, label: string) => Promise<CodeSceneCheckResult>
  /** Remove any temporary root allocated by this gate surface. */
  disposeHostGateLogs: () => void
} {
  const production = productionHostGateDeps()
  const deps = { ...production, ...injected }
  const generatedLogPaths = makeGateLogPaths(config.gateLogRoot, deps)
  const logPath = config.gateLogPath || generatedLogPaths.path
  const tracer = deps.tracer || NOOP_HOST_REVIEW_TRACER
  const baseContext = deps.traceContext || { runId: 'host-review' }

  /** Start a bounded gate span and measure elapsed time without payload data. */
  function span(name: string, taskId: string, attributes: Record<string, string | number | boolean>): { handle: HostReviewSpan; startedMs: number } {
    const startedMs = deps.nowMs()
    return { handle: tracer.startSpan(name, { runId: boundedTail(baseContext.runId, 120) || 'host-review', ...(taskId ? { taskId: boundedTail(taskId, 120) } : {}) }, { reviewer: deps.reviewer || 'unknown', ...attributes }), startedMs }
  }

  /** Finish a gate span with fixed-category outcome and duration attributes. */
  function endSpan(active: { handle: HostReviewSpan; startedMs: number }, attributes: Record<string, string | number | boolean>): void {
    active.handle.end({ elapsedMs: Math.max(0, Math.trunc(deps.nowMs() - active.startedMs)), ...attributes })
  }

  /** Stream one shell gate to its secure log and return its bounded terminal tail. */
  function streamGate(command: string, cwd: string, logFile: string): Promise<{ ok: boolean; killed: boolean; tail: string }> {
    return new Promise((resolve) => {
      let stream: HostGateLog
      try { stream = deps.openSecureLog(logFile) } catch (error) { resolve({ ok: false, killed: false, tail: `gate log write failed: ${boundedTail((error as Error | null)?.message || String(error), 500)}` }); return }
      let child: HostGateChild
      try { child = deps.spawnGate(command, cwd) } catch (error) { stream.end(() => {}); resolve({ ok: false, killed: false, tail: `spawn failed: ${boundedTail((error as Error | null)?.message || String(error), 500)}` }); return }
      const tail: string[] = []
      let carry = ''
      let killed = false
      let settled = false
      let streamFailure = ''
      let sigterm: HostGateTimer | undefined
      let sigkill: HostGateTimer | undefined
      let forcedSettle: HostGateTimer | undefined
      /** Cancel every escalation timer after the gate reaches one terminal path. */
      const clearTimers = () => { if (sigterm) deps.clearTimer(sigterm); if (sigkill) deps.clearTimer(sigkill); if (forcedSettle) deps.clearTimer(forcedSettle) }
      /** Resolve exactly once after flushing the secure output stream. */
      const finish = (ok: boolean, extra = '', force = false) => {
        if (settled) return
        settled = true
        clearTimers()
        if (carry) tail.push(carry)
        if (extra) tail.push(extra)
        let delivered = false
        /** Deliver the terminal bounded tail at most once despite close races. */
        const settle = () => { if (delivered) return; delivered = true; resolve({ ok, killed, tail: tail.slice(-12).join('\n').trim() }) }
        stream.end(settle)
        if (force) { const timer = deps.setTimer(settle, 100); timer.unref?.() }
      }
      /** Stream a chunk while retaining only bounded terminal lines in memory. */
      const record = (chunk: unknown) => {
        if (!stream.write(chunk) && !killed) { child.stdout?.pause?.(); child.stderr?.pause?.() }
        carry += String(chunk)
        const lines = carry.split(/\r?\n/)
        carry = lines.pop() || ''
        if (carry.length > GATE_CARRY_LIMIT) carry = carry.slice(-GATE_CARRY_LIMIT)
        for (const line of lines) { tail.push(line); if (tail.length > 12) tail.shift() }
      }
      /** Signal the detached process group then force settlement if it never closes. */
      const terminate = (reason: string) => {
        if (settled) return
        killed = true
        child.stdout?.resume?.(); child.stderr?.resume?.()
        deps.terminateProcessGroup(child, 'SIGTERM')
        /** Escalate only after the grace period lets SIGTERM reap normal children. */
        sigkill = deps.setTimer(() => {
          deps.terminateProcessGroup(child, 'SIGKILL')
          forcedSettle = deps.setTimer(() => finish(false, reason, true), 1000)
          forcedSettle.unref?.()
        }, 2000)
        sigkill.unref?.()
      }
      /** Treat a log stream fault as a gate failure and reap its child group. */
      const abortForStreamFailure = (error: Error) => {
        if (settled) return
        streamFailure = `gate log write failed: ${boundedTail(error.message, 500)}`
        clearTimers()
        terminate(streamFailure)
      }
      stream.on('error', (error) => abortForStreamFailure(error || new Error('unknown gate log failure')))
      stream.on('drain', () => { child.stdout?.resume?.(); child.stderr?.resume?.() })
      child.stdout?.on('data', record)
      child.stderr?.on('data', record)
      sigterm = deps.setTimer(() => terminate('gate process group did not close after SIGKILL'), config.commitGateTimeoutSeconds * 1000)
      child.on('close', (code) => finish(code === 0 && !killed, streamFailure))
      child.on('error', (error) => finish(false, streamFailure || `spawn failed: ${boundedTail((error as Error | null)?.message || String(error), 500)}`))
    })
  }

  /** Execute every configured deterministic commit gate in declaration order. */
  async function runHostCommitGates(worktree: string, tag: string, roundLabel: string): Promise<HostGateRun> {
    const results: HostGateRun['results'] = []
    for (const [index, command] of config.commitGates.entries()) {
      const displayedCommand = redactedShellCommand(command)
      const active = span('host-review.gate', tag, { attempt: index + 1 })
      metrics.hostGates.runs += 1
      log(`[task ${tag}] host gate ${index + 1}/${config.commitGates.length} (${roundLabel}): ${displayedCommand}`)
      const logFile = logPath(tag, roundLabel, index)
      const outcome = await streamGate(command, worktree, logFile)
      results.push({ command: displayedCommand, ok: outcome.ok, logFile })
      endSpan(active, { outcome: outcome.ok ? 'clean' : 'error', errorCategory: outcome.killed ? 'timeout' : outcome.ok ? 'none' : 'execution', timeout: outcome.killed })
      if (!outcome.ok) {
        metrics.hostGates.failures += 1
        const timeout = outcome.killed ? ` (killed after the ${config.commitGateTimeoutSeconds}s gate timeout)` : ''
        return { green: false, results, detail: `host gate \`${displayedCommand}\` failed${timeout}; full log: ${logFile}; output tail:\n${outcome.tail}` }
      }
    }
    return { green: true, results, detail: '' }
  }

  /** Execute or skip CodeScene using the same secure streaming gate path. */
  async function runCodeSceneCheck(worktree: string, tag: string, label: string): Promise<CodeSceneCheckResult> {
    const active = span('host-review.codescene', tag, { attempt: 1 })
    if (!config.csCheck) { endSpan(active, { outcome: 'clean', errorCategory: 'none', timeout: false, retry: false }); return { clean: true, skipped: true, detail: '', logFile: '' } }
    const redactedCommand = redactedShellCommand(config.csCheckCommand)
    const bin = codeSceneExecutable(config.csCheckCommand)
    if (bin === null || !bin) {
      metrics.codeScene.probeFailures += 1
      const detail = bin === null ? `CodeScene command could not be parsed safely: ${redactedCommand}` : `CodeScene command has no executable: ${redactedCommand}`
      endSpan(active, { outcome: 'error', errorCategory: 'invalid-output', timeout: false, retry: false })
      return { clean: false, skipped: false, detail, logFile: '' }
    }
    const missing = '__DF12_CODESCENE_BINARY_MISSING__'
    const probe = await deps.probeCodeScene('sh', ['-c', 'command -v "$1" >/dev/null 2>&1 || { printf "%s\\n" "$2"; exit 127; }', 'sh', bin, missing], { cwd: worktree, timeoutMs: 10_000 })
    if (!probe.ok) {
      if (probe.stdout.trim() === missing) {
        metrics.codeScene.skipped += 1
        log(`[task ${tag}] CodeScene check (${label}) skipped: ${bin} not on PATH`)
        endSpan(active, { outcome: 'clean', errorCategory: 'none', timeout: false, retry: false })
        return { clean: true, skipped: true, detail: `${bin} not on PATH`, logFile: '' }
      }
      metrics.codeScene.probeFailures += 1
      const fault = [probe.message, probe.stderr, probe.signal ? `signal ${probe.signal}` : '', probe.killed ? 'probe killed' : ''].map((part) => String(part || '').trim()).filter(Boolean).join('; ')
      endSpan(active, { outcome: 'error', errorCategory: probe.killed ? 'timeout' : 'execution', timeout: Boolean(probe.killed), retry: false })
      return { clean: false, skipped: false, detail: `CodeScene availability probe for \`${redactedCommand}\` failed: ${boundedTail(fault) || 'unknown probe failure'}`, logFile: '' }
    }
    metrics.codeScene.runs += 1
    const logFile = logPath(tag, `cs-${label}`, 0)
    log(`[task ${tag}] CodeScene check (${label}): ${redactedCommand}`)
    const outcome = await streamGate(config.csCheckCommand, worktree, logFile)
    endSpan(active, { outcome: outcome.ok ? 'clean' : 'error', errorCategory: outcome.killed ? 'timeout' : outcome.ok ? 'none' : 'execution', timeout: outcome.killed, retry: false })
    if (outcome.ok) return { clean: true, skipped: false, detail: '', logFile }
    metrics.codeScene.failures += 1
    const timeout = outcome.killed ? ` (killed after the ${config.commitGateTimeoutSeconds}s timeout)` : ''
    return { clean: false, skipped: false, detail: `CodeScene check \`${redactedCommand}\` reported code-health issues${timeout}; full log: ${logFile}; output tail:\n${outcome.tail}`, logFile }
  }

  return { runHostCommitGates, runCodeSceneCheck, disposeHostGateLogs: generatedLogPaths.dispose }
}
