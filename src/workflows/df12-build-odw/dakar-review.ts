/**
 * Dakar protocol adapter for host-side committed-diff reviews.
 *
 * This module validates untrusted Dakar JSON at the transport boundary and
 * owns the per-attempt state-root lifecycle. It deliberately contains no
 * retry or workflow policy.
 *
 * @module
 */
import type { ExecStatus } from './exec.ts'
import { authFailureDetail } from './faults.ts'
import {
  boundedTail,
  type HostReviewConfig,
  type HostReviewDeps,
  type HostReviewAttempt,
  type ReviewErrorCategory,
  type ReviewFinding,
} from './host-review-contracts.ts'

/** One untrusted finding from Dakar's compatibility projection. */
export interface DakarFinding extends Record<string, unknown> {
  /** Dakar severity before normalization. */
  severity?: string
  /** Repository-relative path. */
  path?: string
  /** Optional one-based source line. */
  line?: number
  /** Short finding title. */
  title?: string
  /** Finding explanation. */
  detail?: string
  /** Evidence supporting the finding. */
  evidence?: string
}

/** Dakar's single-document stdout contract before boundary validation. */
export interface DakarDocument extends Record<string, unknown> {
  /** Whether Dakar completed its review protocol successfully. */
  ok?: boolean
  /** Whether Dakar intentionally skipped review. */
  skipped?: boolean
  /** Terminal verdict such as `pass` or `changes-requested`. */
  verdict?: string
  /** Dakar execution stage, including the exact deferred stage. */
  stage?: string
  /** Reviewer-supplied error detail. */
  error?: string
  /** Untrusted findings projection validated at the host boundary. */
  findings?: DakarFinding[]
}

/** Map validated Dakar severities onto the retained blocking vocabulary. */
export const DAKAR_SEVERITY_MAP: Record<string, string> = {
  critical: 'critical', high: 'major', medium: 'minor', low: 'trivial',
}

const DAKAR_SEVERITIES = new Set(Object.keys(DAKAR_SEVERITY_MAP))
const DAKAR_REQUIRED_FINDING_FIELDS = ['path', 'title', 'detail', 'evidence'] as const
const DAKAR_PARENT_TIMEOUT_GRACE_MS = 5_000

/** Redact explicitly supplied values from untrusted Dakar protocol text. */
function redactDakarDetail(detail: string, sensitiveValues: readonly string[] = []): string {
  let redacted = detail
  for (const value of sensitiveValues) {
    if (value) redacted = redacted.split(value).join('[REDACTED]')
  }
  return redacted
}

/** Collect configured argv values that must never be retained in diagnostics. */
function dakarDiagnosticRedactions(invocation: readonly string[], extraValues: readonly string[] = []): string[] {
  const values = [...extraValues]
  for (const [index, argument] of invocation.entries()) {
    if (index === 0 || /^--[A-Za-z][A-Za-z0-9-]*$/.test(argument)) continue
    const inlineOption = /^(--[^\s=]+)=(.+)$/.exec(argument)
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(argument)
    const inlineValue = inlineOption?.[2]
    const assignmentValue = assignment?.[1]
    if (inlineValue !== undefined) values.push(argument, inlineValue)
    else if (assignmentValue !== undefined) values.push(argument, assignmentValue)
    else values.push(argument)
  }
  return values
}

/** Dakar-only state-root lifecycle used by one isolated reviewer attempt. */
export interface DakarAttemptDeps {
  /** Optional state-root allocation service used by deterministic tests. */
  dakarStateRoots?: DakarStateRoots
  /** Deprecated cleanup seam retained for compatibility with older callers. */
  removeDakarStateRoot?: (stateRoot: string, options: { recursive: true; force: true }) => void
}

/** Fresh Dakar state-root service, injectable for filesystem-failure tests. */
export interface DakarStateRoots {
  /** Create the fresh state root for one Dakar attempt. */
  create: () => string
  /** Remove a state root after the corresponding attempt settles. */
  remove: (stateRoot: string, options: { recursive: true; force: true }) => void
}

/** Validated Dakar findings suitable for severity mapping. */
export interface DakarFindingValidation {
  /** Indicates that every finding passed structural validation. */
  ok: true
  /** Findings safe to map into the neutral contract. */
  findings: DakarFinding[]
}

/** Rejected Dakar findings accompanied by a bounded diagnostic. */
export interface DakarFindingValidationFailure {
  /** Indicates that one or more findings were malformed. */
  ok: false
  /** Bounded explanation of the first invalid finding. */
  detail: string
}

/** Locate Dakar's terminal JSON object despite leading progress noise. */
export function parseDakarDocument(stdout: unknown): DakarDocument | null {
  const text = String(stdout || '')
  const terminalEnd = text.lastIndexOf('}')
  if (terminalEnd === -1) return null
  let depth = 0
  let inString = false
  for (let index = terminalEnd; index >= 0; index--) {
    const character = text[index]
    if (character === '"') {
      let slashes = 0
      for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes += 1
      if (slashes % 2 === 0) inString = !inString
      continue
    }
    if (inString) continue
    if (character === '}') depth += 1
    if (character !== '{') continue
    depth -= 1
    if (depth !== 0) continue
    let preceding = index - 1
    while (preceding >= 0 && /\s/.test(text[preceding] ?? '')) preceding -= 1
    if ((text[preceding] ?? '') === '[') return null
    const document = text.slice(index, terminalEnd + 1)
    if (document.length > 64_000) return null
    try {
      const parsed = JSON.parse(document)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as DakarDocument : null
    } catch {
      return null
    }
  }
  return null
}

/** Map one validated Dakar finding onto the retained findings contract. */
export function mapDakarFinding(finding: DakarFinding, sensitiveValues: readonly string[] = []): ReviewFinding {
  const severity = DAKAR_SEVERITY_MAP[String(finding.severity || '').toLowerCase()] || 'info'
  const filePath = redactDakarDetail(String(finding.path || ''), sensitiveValues).slice(0, 2000)
  const title = redactDakarDetail(String(finding.title || ''), sensitiveValues)
  const detail = redactDakarDetail(String(finding.detail || ''), sensitiveValues)
  const evidence = redactDakarDetail(String(finding.evidence || ''), sensitiveValues)
  const hasLine = finding.line !== undefined && finding.line !== null && String(finding.line) !== ''
  const locator = hasLine ? ` (${filePath}:${finding.line})` : ''
  return { type: 'finding', severity, fileName: filePath, comment: `${title} — ${detail}${locator}`.slice(0, 2000), codegenInstructions: `${detail}\nEvidence: ${evidence}`.slice(0, 2000), suggestions: [] }
}

/** Validate a non-empty, structurally complete change-requested collection. */
export function validateChangesRequestedFindings(raw: unknown): DakarFindingValidation | DakarFindingValidationFailure {
  const findings = Array.isArray(raw) ? raw : null
  if (!findings || findings.length === 0) return { ok: false, detail: 'Dakar returned changes-requested without any findings; refusing to treat a reviewer rejection as non-blocking' }
  for (const [index, finding] of findings.entries()) {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) return { ok: false, detail: boundedTail(`Dakar returned a malformed finding at index ${index}; expected an object`) }
    const item = finding as Record<string, unknown>
    if (typeof item.severity !== 'string' || !DAKAR_SEVERITIES.has(item.severity.toLowerCase())) return { ok: false, detail: boundedTail(`Dakar returned an invalid finding at index ${index}; unsupported severity`) }
    const invalidField = DAKAR_REQUIRED_FINDING_FIELDS.find((field) => typeof item[field] !== 'string')
    if (invalidField) return { ok: false, detail: boundedTail(`Dakar returned an invalid finding at index ${index}; ${invalidField} must be a string`) }
    if (item.line !== undefined && (!Number.isInteger(item.line) || Number(item.line) < 1)) return { ok: false, detail: boundedTail(`Dakar returned an invalid finding at index ${index}; line must be a positive integer`) }
  }
  return { ok: true, findings: findings as DakarFinding[] }
}

/** Reject clean verdicts that would silently discard untrusted findings. */
export function validateCleanDakarFindings(raw: unknown): string {
  if (raw === undefined) return ''
  if (!Array.isArray(raw)) return 'Dakar returned a clean verdict with a malformed findings field'
  return raw.length > 0 ? 'Dakar returned a clean verdict with findings; refusing to discard reviewer findings' : ''
}

/** Classify and fail-closed validate one Dakar process result. */
export function classifyDakarReview(execResult: ExecStatus, sensitiveValues: readonly string[] = []): HostReviewAttempt {
  /** Prefer the process timeout signal over a protocol-derived fallback. */
  const category = (fallback: ReviewErrorCategory): ReviewErrorCategory => execResult.killed ? 'timeout' : fallback
  const doc = parseDakarDocument(execResult.stdout)
  if (!doc) {
    const detail = boundedTail(redactDakarDetail([execResult.stderr, execResult.message].filter(Boolean).join('\n'), sensitiveValues)) || 'dakar-review produced no parsable JSON output'
    return { outcome: 'error', findings: [], detail, errorCategory: category('invalid-output') }
  }
  if (doc.ok === false) {
    const stage = boundedTail(redactDakarDetail(String(doc.stage ?? 'unknown'), sensitiveValues), 200)
    if (String(doc.stage) === 'deferred') return { outcome: 'rate-limited', findings: [], detail: `Dakar review deferred (stage: ${stage}) — ${boundedTail(redactDakarDetail(String(doc.error || 'no detail'), sensitiveValues))}`, errorCategory: category('deferred') }
    const detail = `stage: ${stage} — ${boundedTail(redactDakarDetail(String(doc.error || 'no detail'), sensitiveValues))}`
    if (authFailureDetail([doc.error, execResult.stderr, execResult.message].filter(Boolean).join('\n'))) {
      return { outcome: 'auth', findings: [], detail, errorCategory: category('auth') }
    }
    return { outcome: 'error', findings: [], detail, errorCategory: category('execution') }
  }
  if (doc.ok === true && (doc.skipped === true || doc.verdict === 'pass')) {
    const invalidFindings = validateCleanDakarFindings(doc.findings)
    return invalidFindings ? { outcome: 'error', findings: [], detail: invalidFindings, errorCategory: category('invalid-output') } : { outcome: 'clean', findings: [], detail: '', errorCategory: category('none') }
  }
  if (doc.ok === true && doc.verdict === 'changes-requested') {
    const validation = validateChangesRequestedFindings(doc.findings)
    return validation.ok ? { outcome: 'findings', findings: validation.findings.map((finding) => mapDakarFinding(finding, sensitiveValues)), detail: '', errorCategory: category('none') } : { outcome: 'error', findings: [], detail: validation.detail, errorCategory: category('invalid-output') }
  }
  return { outcome: 'error', findings: [], detail: `unrecognized Dakar review shape (ok=${doc.ok}, verdict=${boundedTail(redactDakarDetail(String(doc.verdict ?? 'none'), sensitiveValues), 200)})`, errorCategory: category('invalid-output') }
}

/** Bind one Dakar attempt to configuration while leaving host seams injectable. */
export function makeDakarAttempt(config: Pick<HostReviewConfig, 'base' | 'dakarInvocation' | 'dakarSensitiveValues' | 'reviewTimeoutSeconds' | 'dakarBudgetGbp'>): (worktree: string, exec: NonNullable<HostReviewDeps['exec']>, deps: DakarAttemptDeps) => Promise<HostReviewAttempt> {
  const invocation = config.dakarInvocation || []
  const executable = invocation[0] || 'dakar-review'
  const prefixArgs = invocation.slice(1)
  const sensitiveValues = dakarDiagnosticRedactions(invocation, config.dakarSensitiveValues)
  return async function runDakarAttempt(worktree, exec, deps) {
    const fs = process.getBuiltinModule('node:fs')
    const os = process.getBuiltinModule('node:os')
    const path = process.getBuiltinModule('node:path')
    const stateRoots = deps.dakarStateRoots || { create: () => fs.mkdtempSync(path.join(os.tmpdir(), 'df12-dakar-state-')), remove: deps.removeDakarStateRoot || fs.rmSync }
    let stateRoot: string
    try {
      stateRoot = stateRoots.create()
    } catch (error) {
      return { outcome: 'error', findings: [], detail: boundedTail((error as Error | null)?.message || String(error)), errorCategory: 'execution' }
    }
    const args = ['--repo-root', worktree, '--base', config.base, '--state-root', stateRoot, '--timeout', String(config.reviewTimeoutSeconds), ...(config.dakarBudgetGbp > 0 ? ['--budget-gbp', String(config.dakarBudgetGbp)] : [])]
    try {
      const review = classifyDakarReview(await exec(executable, [...prefixArgs, ...args], {
        cwd: worktree,
        timeoutMs: config.reviewTimeoutSeconds * 1000 + DAKAR_PARENT_TIMEOUT_GRACE_MS,
      }), sensitiveValues)
      return review
    } catch (error) {
      const message = boundedTail(redactDakarDetail((error as Error | null)?.message || String(error), sensitiveValues))
      const redacted = new Error(message)
      redacted.name = (error as Error | null)?.name || 'Error'
      throw redacted
    } finally {
      try {
        stateRoots.remove(stateRoot, { recursive: true, force: true })
      } catch (error) {
        log(`[Dakar] could not remove temporary state root: ${boundedTail((error as Error | null)?.message || String(error), 500)}`)
      }
    }
  }
}
