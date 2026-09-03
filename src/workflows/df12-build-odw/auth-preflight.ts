/**
 * Injectable authentication and host-review readiness preflight. The module
 * keeps environment and process access at the workflow boundary while
 * reporting bounded, redacted operator diagnostics for each required tool.
 *
 * @module
 */
import { authFailureDetail } from './faults.ts'
import { boundedTail } from './host-review-contracts.ts'
import type { ExecOptions, ExecStatus } from './exec.ts'

/** One fatal prerequisite failure returned before workflow execution. */
export interface AuthPreflightFailure {
  /** Adapter or host reviewer whose prerequisite failed. */
  tool: string
  /** Redacted command or environment name checked by the preflight. */
  command: string
  /** Bounded diagnostic suitable for the workflow result and logs. */
  detail: string
}

/** Configuration needed to determine which authentication checks apply. */
export interface AuthPreflightConfig {
  /** Whether all authentication checks are enabled for this run. */
  enabled: boolean
  /** Whether the selected host reviewer must be ready before work starts. */
  requireHostReviewAuth: boolean
  /** Agent adapters that require authentication for this run. */
  requiredAdapters: ReadonlySet<string>
  /** Selected host-review adapter. */
  reviewTool: 'dakar' | 'coderabbit'
  /** Already validated Dakar executable and fixed arguments. */
  dakarInvocation: readonly string[]
}

/** Read configuration from the host environment at the workflow boundary. */
export interface EnvironmentReader {
  /** Return the configured value for `name`, or `undefined` when absent. */
  get: (name: string) => string | undefined
}

/** Injectable host boundaries used by the deterministic preflight. */
export interface AuthPreflightDeps {
  /** Execute one harmless readiness probe. */
  exec: (command: string, commandArgs: readonly string[], options?: ExecOptions) => Promise<ExecStatus>
  /** Read one environment value without coupling the preflight to process.env. */
  environment: EnvironmentReader
  /** Start the workflow's auth-preflight phase. */
  phase: (name: string) => void
  /** Emit a bounded operator-facing preflight message. */
  log: (message: string) => void
  /** Increment the bounded host-review authentication-failure counter. */
  recordHostReviewAuthFailure: () => void
}

function statusDetail(status: ExecStatus): string {
  return boundedTail([status.stdout, status.stderr, status.message].filter(Boolean).join('\n').trim())
}

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/
const AUTH_PROBE_TIMEOUT_MS = 10_000

// Fixed arguments may carry API tokens or paths. Retain only conventional
// long-option names so the failure record proves which binary was checked
// without retaining secret values.
function redactedDakarProbeCommand(invocation: readonly string[]): string {
  const executable = invocation.find((argument) => !ENVIRONMENT_ASSIGNMENT.test(argument)) || 'dakar-review'
  const optionNames = invocation.slice(1)
    .filter((argument) => /^--[A-Za-z][A-Za-z0-9-]*$/.test(argument))
    .slice(0, 12)
  return [executable, ...optionNames, '--version'].join(' ')
}

/** Remove configured Dakar argument values from an execution-status diagnostic. */
function redactedDakarStatusDetail(status: ExecStatus, invocation: readonly string[], sensitiveValues: readonly string[] = []): string {
  let detail = [status.stdout, status.stderr, status.message].filter(Boolean).join('\n').trim()
  for (const [index, value] of invocation.entries()) {
    const inlineOption = /^(--[^\s=]+)=(.+)$/.exec(value)
    const inlineValue = inlineOption?.[2]
    if (inlineOption && inlineValue !== undefined) {
      detail = detail.split(value).join('[REDACTED]')
      detail = detail.split(inlineValue).join('[REDACTED]')
      continue
    }
    const assignment = ENVIRONMENT_ASSIGNMENT.exec(value)
    const assignmentValue = assignment?.[1]
    if (assignment && assignmentValue !== undefined) {
      detail = detail.split(value).join('[REDACTED]')
      detail = detail.split(assignmentValue).join('[REDACTED]')
      continue
    }
    if (index === 0) continue
    if (!value || /^--[A-Za-z][A-Za-z0-9-]*$/.test(value)) continue
    detail = detail.split(value).join('[REDACTED]')
  }
  for (const value of sensitiveValues) {
    if (value) detail = detail.split(value).join('[REDACTED]')
  }
  return boundedTail(detail.trim())
}

/** Bind the configured auth and reviewer readiness checks to host primitives. */
export function makeAuthPreflight(config: AuthPreflightConfig, deps: AuthPreflightDeps): () => Promise<AuthPreflightFailure[]> {
  return async function runAuthPreflight(): Promise<AuthPreflightFailure[]> {
    if (!config.enabled) return []
    deps.phase('Auth Preflight')
    const failures: AuthPreflightFailure[] = []

    const codex = await deps.exec('codex', ['login', 'status'], { timeoutMs: AUTH_PROBE_TIMEOUT_MS })
    const codexOutput = statusDetail(codex)
    if (!codex.ok || authFailureDetail(codexOutput)) {
      failures.push({
        tool: 'codex',
        command: 'codex login status',
        detail: authFailureDetail(codexOutput) || codexOutput || 'Codex auth status check failed',
      })
    }

    if (config.requiredAdapters.has('claude')) {
      const claude = await deps.exec('claude', ['auth', 'status'], { timeoutMs: AUTH_PROBE_TIMEOUT_MS })
      const claudeOutput = statusDetail(claude)
      if (!claude.ok || authFailureDetail(claudeOutput)) {
        failures.push({
          tool: 'claude',
          command: 'claude auth status',
          detail: authFailureDetail(claudeOutput) || claudeOutput || 'Claude auth status check failed',
        })
      }
    }

    if (config.requireHostReviewAuth) {
      if (config.reviewTool === 'dakar') {
        const openaiKey = deps.environment.get('OPENAI_API_KEY')
        const dakarWords = config.dakarInvocation.filter((argument) => !ENVIRONMENT_ASSIGNMENT.test(argument))
        const dakarExecutable = dakarWords[0] || 'dakar-review'
        const dakar = await deps.exec(dakarExecutable, [...dakarWords.slice(1), '--version'], { timeoutMs: AUTH_PROBE_TIMEOUT_MS })
        const dakarOutput = redactedDakarStatusDetail(dakar, config.dakarInvocation, typeof openaiKey === 'string' ? [openaiKey] : [])
        if (!dakar.ok) {
          deps.recordHostReviewAuthFailure()
          failures.push({
            tool: 'dakar',
            command: redactedDakarProbeCommand(config.dakarInvocation),
            detail: dakarOutput || `${dakarExecutable} is unavailable or its version probe failed`,
          })
        }
        const pi = await deps.exec('pi', ['--version'], { timeoutMs: AUTH_PROBE_TIMEOUT_MS })
        const piOutput = redactedDakarStatusDetail(pi, config.dakarInvocation, typeof openaiKey === 'string' ? [openaiKey] : [])
        if (!pi.ok) {
          deps.recordHostReviewAuthFailure()
          failures.push({ tool: 'dakar', command: 'pi --version', detail: piOutput || 'pi is unavailable or its version probe failed' })
        }
        if (typeof openaiKey !== 'string' || openaiKey.trim() === '') {
          deps.recordHostReviewAuthFailure()
          failures.push({
            tool: 'dakar',
            command: 'OPENAI_API_KEY (env)',
            detail: 'OPENAI_API_KEY is unset or empty; the Dakar host review needs it to reach the OpenAI-backed reviewer',
          })
        }
      } else {
        const coderabbit = await deps.exec('coderabbit', ['auth', 'status'], { timeoutMs: AUTH_PROBE_TIMEOUT_MS })
        const coderabbitOutput = statusDetail(coderabbit)
        if (!coderabbit.ok || authFailureDetail(coderabbitOutput)) {
          deps.recordHostReviewAuthFailure()
          failures.push({
            tool: 'coderabbit',
            command: 'coderabbit auth status',
            detail: authFailureDetail(coderabbitOutput) || coderabbitOutput || 'CodeRabbit auth status check failed',
          })
        }
      }
    }

    if (failures.length) {
      deps.log(`[auth] fatal preflight failure: ${failures.map((failure) => `${failure.tool}: ${failure.detail.split(/\r?\n/)[0]}`).join('; ')}`)
    } else {
      const passed = ['Codex']
      if (config.requiredAdapters.has('claude')) passed.push('Claude')
      if (config.requireHostReviewAuth) {
        const dakarExecutable = config.dakarInvocation.find((argument) => !ENVIRONMENT_ASSIGNMENT.test(argument)) || 'dakar-review'
        passed.push(config.reviewTool === 'dakar' ? `Dakar (${dakarExecutable}, pi, OPENAI_API_KEY)` : 'CodeRabbit')
      }
      deps.log(`[auth] preflight passed for ${passed.join(', ')}`)
    }
    return failures
  }
}
