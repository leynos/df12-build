/**
 * Secure deterministic host gates and CodeScene execution.
 *
 * Gate processes stream to private logs, retain only bounded tails for the
 * workflow result, and terminate their complete process groups on timeout.
 *
 * @module
 */
import { execFileStatus } from './exec.ts'
import { tokenizeShellCommand } from './shell-command.ts'
import {
  boundedTail,
  type CodeSceneCheckResult,
  type CodeSceneMetrics,
  type HostGateMetrics,
  type HostGateRun,
} from './host-review-contracts.ts'

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
}

/** Return the executable word of a safely tokenized configured command. */
export function codeSceneExecutable(command: string): string {
  const tokens = tokenizeShellCommand(command)
  if (!tokens || tokens.hasUnquotedControlOperator) return ''
  return tokens.words.slice(tokens.leadingAssignments.length)[0]?.value || ''
}

/** Create an isolated sanitized gate-log path service for one caller. */
function makeGateLogPath(): (tag: string, roundLabel: string, index: number) => string {
  const fs = process.getBuiltinModule('node:fs')
  const os = process.getBuiltinModule('node:os')
  const path = process.getBuiltinModule('node:path')
  const gateLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'df12-gates-'))
  /** Normalize untrusted labels before incorporating them in a file name. */
  const slug = (value: unknown) => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return (tag, roundLabel, index) => path.join(gateLogRoot, `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`)
}

/** Build a sanitized private gate-log path for direct compatibility callers. */
export function hostGateLogPath(tag: string, roundLabel: string, index: number): string {
  return makeGateLogPath()(tag, roundLabel, index)
}

/** Bind secure gate execution to run-scoped metrics and configuration. */
export function makeHostGates(config: HostGateConfig, metrics: { hostGates: HostGateMetrics; codeScene: CodeSceneMetrics }): {
  /** Run every configured commit gate in order. */
  runHostCommitGates: (worktree: string, tag: string, roundLabel: string) => Promise<HostGateRun>
  /** Run CodeScene after commit gates when configured. */
  runCodeSceneCheck: (worktree: string, tag: string, label: string) => Promise<CodeSceneCheckResult>
} {
  const fs = process.getBuiltinModule('node:fs')
  const logPath = config.gateLogPath || makeGateLogPath()

  /** Stream one shell gate to its secure log and return its bounded terminal tail. */
  function streamGate(command: string, cwd: string, logFile: string): Promise<{ ok: boolean; killed: boolean; tail: string }> {
    const { spawn } = process.getBuiltinModule('node:child_process')
    return new Promise((resolve) => {
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
      let fd: number
      try { fd = fs.openSync(logFile, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600) } catch (error) { resolve({ ok: false, killed: false, tail: `gate log write failed: ${(error as Error).message}` }); return }
      const stream = fs.createWriteStream(logFile, { fd, autoClose: true })
      const tail: string[] = []
      let carry = ''
      let killed = false
      let settled = false
      let sigterm: ReturnType<typeof setTimeout> | undefined
      let sigkill: ReturnType<typeof setTimeout> | undefined
      let forcedSettle: ReturnType<typeof setTimeout> | undefined
      const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      /** Stream a chunk to disk while retaining only the final bounded lines. */
      const record = (chunk: Buffer) => {
        if (!stream.write(chunk) && !killed) { child.stdout?.pause(); child.stderr?.pause() }
        carry += chunk.toString('utf8')
        const lines = carry.split(/\r?\n/)
        carry = lines.pop() || ''
        for (const line of lines) { tail.push(line); if (tail.length > 12) tail.shift() }
      }
      /** Resolve exactly once after flushing the secure output stream. */
      const finish = (ok: boolean, extra = '', force = false) => {
        if (settled) return
        settled = true
        if (carry) tail.push(carry)
        if (extra) tail.push(extra)
        /** Deliver the bounded terminal result to the caller. */
        const settle = () => resolve({ ok, killed, tail: tail.slice(-12).join('\n').trim() })
        stream.end(settle)
        if (force) setTimeout(settle, 100).unref()
      }
      /** Terminate the isolated process group so descendants cannot outlive a timeout. */
      const terminateGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
        if (typeof child.pid === 'number') {
          try { process.kill(-child.pid, signal); return } catch { /* Fall through to the child. */ }
        }
        child.kill(signal)
      }
      stream.on('error', (error) => finish(false, `gate log write failed: ${(error as Error).message}`))
      stream.on('drain', () => { child.stdout?.resume(); child.stderr?.resume() })
      child.stdout.on('data', record)
      child.stderr.on('data', record)
      sigterm = setTimeout(() => {
        killed = true
        child.stdout?.resume(); child.stderr?.resume()
        terminateGroup('SIGTERM')
        sigkill = setTimeout(() => { terminateGroup('SIGKILL'); forcedSettle = setTimeout(() => finish(false, 'gate process group did not close after SIGKILL', true), 1000); forcedSettle.unref() }, 2000)
        sigkill.unref()
      }, config.commitGateTimeoutSeconds * 1000)
      /** Cancel timeout escalation once the gate has reached a terminal event. */
      const clearTimers = () => { if (sigterm) clearTimeout(sigterm); if (sigkill) clearTimeout(sigkill); if (forcedSettle) clearTimeout(forcedSettle) }
      child.on('close', (code) => { clearTimers(); finish(code === 0 && !killed) })
      child.on('error', (error) => { clearTimers(); finish(false, `spawn failed: ${(error as Error).message}`) })
    })
  }

  /** Execute every configured deterministic commit gate in declaration order. */
  async function runHostCommitGates(worktree: string, tag: string, roundLabel: string): Promise<HostGateRun> {
    const results: HostGateRun['results'] = []
    for (const [index, command] of config.commitGates.entries()) {
      metrics.hostGates.runs += 1
      log(`[task ${tag}] host gate ${index + 1}/${config.commitGates.length} (${roundLabel}): ${command}`)
      const logFile = logPath(tag, roundLabel, index)
      const outcome = await streamGate(command, worktree, logFile)
      results.push({ command, ok: outcome.ok, logFile })
      if (!outcome.ok) {
        metrics.hostGates.failures += 1
        const timeout = outcome.killed ? ` (killed after the ${config.commitGateTimeoutSeconds}s gate timeout)` : ''
        return { green: false, results, detail: `host gate \`${command}\` failed${timeout}; full log: ${logFile}; output tail:\n${outcome.tail}` }
      }
    }
    return { green: true, results, detail: '' }
  }

  /** Execute or skip CodeScene using the same secure streaming gate path. */
  async function runCodeSceneCheck(worktree: string, tag: string, label: string): Promise<CodeSceneCheckResult> {
    if (!config.csCheck) return { clean: true, skipped: true, detail: '', logFile: '' }
    const bin = codeSceneExecutable(config.csCheckCommand) || 'cs-check-changed'
    const missing = '__DF12_CODESCENE_BINARY_MISSING__'
    const probe = await execFileStatus('sh', ['-c', 'command -v "$1" >/dev/null 2>&1 || { printf "%s\\n" "$2"; exit 127; }', 'sh', bin, missing], { cwd: worktree })
    if (!probe.ok) {
      if (probe.stdout.trim() === missing) { metrics.codeScene.skipped += 1; log(`[task ${tag}] CodeScene check (${label}) skipped: ${bin} not on PATH`); return { clean: true, skipped: true, detail: `${bin} not on PATH`, logFile: '' } }
      metrics.codeScene.probeFailures += 1
      const fault = [probe.message, probe.stderr, probe.signal ? `signal ${probe.signal}` : '', probe.killed ? 'probe killed' : ''].map((part) => String(part || '').trim()).filter(Boolean).join('; ')
      return { clean: false, skipped: false, detail: `CodeScene availability probe for \`${bin}\` failed: ${boundedTail(fault) || 'unknown probe failure'}`, logFile: '' }
    }
    metrics.codeScene.runs += 1
    const logFile = logPath(tag, `cs-${label}`, 0)
    log(`[task ${tag}] CodeScene check (${label}): ${config.csCheckCommand}`)
    const outcome = await streamGate(config.csCheckCommand, worktree, logFile)
    if (outcome.ok) return { clean: true, skipped: false, detail: '', logFile }
    metrics.codeScene.failures += 1
    const timeout = outcome.killed ? ` (killed after the ${config.commitGateTimeoutSeconds}s timeout)` : ''
    return { clean: false, skipped: false, detail: `CodeScene check \`${config.csCheckCommand}\` reported code-health issues${timeout}; full log: ${logFile}; output tail:\n${outcome.tail}`, logFile }
  }

  return { runHostCommitGates, runCodeSceneCheck }
}
