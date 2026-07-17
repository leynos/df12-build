/**
 * Host-collected git evidence. The assessor and the recovery decision
 * tables treat this module's output as decisive over anything an agent
 * reports, so collection must be honest about faults: every failed git
 * command lands in collectionErrors instead of silently reading as "clean"
 * or "no changes".
 *
 * @module
 */
import { execFileStatus } from './exec.ts'

/** A single `git diff --name-status` / porcelain-status entry: what changed, and its path(s). */
export interface NameStatusEntry {
  /** The raw git status letter (e.g. `M`, `A`, `D`, `R`, or `??` normalized to a single letter). */
  status: string
  /** The (current) path affected. */
  path: string
  /** The prior path, present only for renames. */
  oldPath?: string
}

/** The result of one {@link gitEvidence} probe: whether the underlying git command succeeded, its parsed value, and the error text on failure. */
export interface GitEvidenceValue<T> {
  /** True when the git command exited successfully. */
  ok: boolean
  /** The parsed output; still populated (parsed from stdout) even when `ok` is false, so callers can inspect partial output. */
  value: T
  /** Present only when `ok` is false: the combined command message, stderr, and stdout. */
  error?: string
}

/** The full set of host-verified git facts collected for one task's assessment; decisive over any agent-reported claim. */
export interface AssessmentEvidence {
  /** The roadmap task id under assessment. */
  taskId: string
  /** The roadmap task title under assessment. */
  taskTitle: string
  /** The task's branch name, from the worktree record when known, otherwise read via `rev-parse --abbrev-ref HEAD`. */
  branchName: string
  /** The task worktree's absolute path. */
  worktreePath: string
  /** The commit the task branch started from; empty when unknown (some probes are skipped without it). */
  baseCommit: string
  /** The worktree's current `HEAD` sha; empty when the `rev-parse HEAD` probe failed. */
  currentCommit: string
  /** `'clean'` or `'dirty'` from `git status --porcelain=v1`; `'unknown'` when that probe itself failed. */
  dirtyState: 'clean' | 'dirty' | 'unknown'
  /** The sorted union of every changed path across committed, dirty, and staged changes. */
  changedFiles: string[]
  /** Paths changed between `baseCommit` and `HEAD` (committed work), when `baseCommit` is known. */
  committedChanges: NameStatusEntry[]
  /** Unstaged working-tree changes, merged with untracked/modified porcelain entries not already present in the diff. */
  dirtyChanges: NameStatusEntry[]
  /** Paths staged in the index (`git diff --cached --name-status`). */
  stagedChanges: NameStatusEntry[]
  /** Up to 20 one-line summaries of commits between `baseCommit` and `HEAD`, when `baseCommit` is known. */
  recentCommits: string[]
  /** Every git command that failed during collection, in fixed probe order; empty when all probes succeeded. */
  collectionErrors: string[]
}

/**
 * Parse `git diff --name-status` output (tab-separated status/path[/oldPath]
 * lines) into structured entries. A rename line has three fields (status,
 * old path, new path); other statuses have two. Blank lines and entries
 * without a resolvable path are dropped.
 */
export function parseNameStatus(output: unknown): NameStatusEntry[] {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split(/\t+/)
      return secondPath
        ? { status, path: secondPath, oldPath: firstPath }
        : { status, path: firstPath || '' }
    })
    .filter((entry) => entry.path)
}

/**
 * Parse `git status --porcelain=v1` output into working-tree entries,
 * keeping only untracked (`??`) and unstaged-modified paths — the index
 * column (first character) is ignored so staged-only changes (already
 * captured by the `--cached` diff) are not double-reported here.
 */
export function parsePorcelainDirty(output: unknown): NameStatusEntry[] {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const status = line.slice(0, 2)
      const pathText = line.slice(3).trim()
      if (!pathText) return []
      if (status === '??') return [{ status, path: pathText }]
      if (status[1] && status[1] !== ' ') return [{ status: status[1], path: pathText }]
      return []
    })
}

/**
 * Run a single read-only git command in `worktreePath` and wrap its outcome
 * as evidence: `value` is always parsed from stdout (even on failure, so
 * partial output is not discarded), and `error` carries the combined
 * message/stderr/stdout only when the command failed. The default parser
 * trims the raw text; pass `parse` for structured output (e.g.
 * {@link parseNameStatus}).
 */
export async function gitEvidence<T = string>(
  worktreePath: string,
  commandArgs: readonly string[],
  parse: (text: string) => T = ((text: string) => String(text || '').trim()) as unknown as (text: string) => T,
): Promise<GitEvidenceValue<T>> {
  const result = await execFileStatus('git', ['-C', worktreePath, ...commandArgs])
  if (result.ok) {
    return { ok: true, value: parse(result.stdout) }
  }
  return {
    ok: false,
    value: parse(result.stdout),
    error: [result.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim(),
  }
}

/**
 * Collect the full {@link AssessmentEvidence} for a task by running the
 * seven independent read-only git probes in parallel and folding their
 * results (and any failures) into the deterministic shapes the assessor and
 * recovery decision tables depend on. Never throws: an unreachable worktree
 * or missing base commit surfaces as `collectionErrors` and an `'unknown'`
 * dirty state rather than an exception.
 */
export async function collectAssessmentEvidence(
  task: { id?: string; title?: string } | null | undefined,
  wt: { worktreePath?: string; baseSha?: string; branch?: string } | null | undefined,
): Promise<AssessmentEvidence> {
  const worktreePath = wt?.worktreePath || ''
  const baseCommit = wt?.baseSha || ''
  const branchName = wt?.branch || ''
  const errors: string[] = []

  // The seven probes are independent read-only git commands, so they start
  // together; the error accumulation below keeps its fixed order so
  // collectionErrors stays deterministic.
  const [current, branch, status, committed, dirty, staged, commits] = await Promise.all([
    gitEvidence(worktreePath, ['rev-parse', 'HEAD']),
    branchName
      ? Promise.resolve<GitEvidenceValue<string>>({ ok: true, value: branchName })
      : gitEvidence(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitEvidence(worktreePath, ['status', '--porcelain=v1']),
    baseCommit
      ? gitEvidence(worktreePath, ['diff', '--name-status', `${baseCommit}...HEAD`], parseNameStatus)
      : Promise.resolve({ ok: false, value: [] as NameStatusEntry[], error: 'missing base commit' }),
    gitEvidence(worktreePath, ['diff', '--name-status'], parseNameStatus),
    gitEvidence(worktreePath, ['diff', '--cached', '--name-status'], parseNameStatus),
    baseCommit
      ? gitEvidence(worktreePath, ['log', '--oneline', '--max-count=20', `${baseCommit}..HEAD`], (text) => String(text || '').trim().split(/\r?\n/).filter(Boolean))
      : Promise.resolve({ ok: false, value: [] as string[], error: 'missing base commit' }),
  ])
  if (!current.ok) errors.push(`rev-parse HEAD: ${current.error}`)
  if (!branch.ok) errors.push(`rev-parse --abbrev-ref HEAD: ${branch.error}`)
  if (!status.ok) errors.push(`status --porcelain=v1: ${status.error}`)
  if (!committed.ok) errors.push(`diff base...HEAD: ${committed.error}`)
  if (!dirty.ok) errors.push(`diff --name-status: ${dirty.error}`)
  if (!staged.ok) errors.push(`diff --cached --name-status: ${staged.error}`)
  if (!commits.ok) errors.push(`log base..HEAD: ${commits.error}`)

  const untrackedOrModified = parsePorcelainDirty(status.value)
  // Dedupe against the diff paths in O(n) with a Set rather than a nested scan.
  const dirtyPaths = new Set(dirty.value.map((item) => item.path))
  const dirtyChanges = [
    ...dirty.value,
    ...untrackedOrModified.filter((entry) => !dirtyPaths.has(entry.path)),
  ]
  const allChanged = new Set([
    ...committed.value.map((entry) => entry.path),
    ...dirtyChanges.map((entry) => entry.path),
    ...staged.value.map((entry) => entry.path),
  ])

  return {
    taskId: task?.id || '',
    taskTitle: task?.title || '',
    branchName: branch.value || branchName,
    worktreePath,
    baseCommit,
    currentCommit: current.value || '',
    dirtyState: status.ok ? (String(status.value || '').trim() ? 'dirty' : 'clean') : 'unknown',
    changedFiles: [...allChanged].sort(),
    committedChanges: committed.value,
    dirtyChanges,
    stagedChanges: staged.value,
    recentCommits: commits.value,
    collectionErrors: errors.filter(Boolean),
  }
}

/**
 * Read a worktree file without letting untrusted content redirect the read
 * outside the checkout (see write-preflight.ts). O_NOFOLLOW rejects a symlink
 * at the FINAL component; when a worktree root is given, realpath containment
 * additionally rejects a symlinked PARENT directory that would resolve the
 * ancestry outside the root. Callers treat any failure as an unreadable file.
 */
export async function readFileText(filePath: string, rootDir?: string): Promise<string> {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const { constants } = process.getBuiltinModule('node:fs')
  if (rootDir) {
    // Resolve every symlink in the parent chain and require it to stay inside
    // the (also-resolved) worktree root. realpath throws ENOENT for a missing
    // parent, which the caller maps to an absent plan.
    const realRoot = await fs.realpath(rootDir)
    const realParent = await fs.realpath(path.dirname(filePath))
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`ExecPlan path escapes the worktree via a parent symlink: ${filePath}`)
    }
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

/**
 * Distinguish "not a directory" from "the filesystem would not answer",
 * mirroring fileState (exec.ts): ENOENT/ENOTDIR mean absent; any other stat
 * error is a fault the caller must surface rather than conflate with a
 * missing directory.
 */
export async function directoryExists(pathValue: unknown): Promise<{
  /** True when the check itself completed (even if the path is absent); false only on an unexpected stat fault. */
  ok: boolean
  /** True when `pathValue` names an existing directory. */
  exists: boolean
  /** Populated only when `ok` is false: the stat error detail. */
  detail: string
}> {
  if (!pathValue) return { ok: true, exists: false, detail: '' }
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    const stat = await fs.stat(String(pathValue))
    return { ok: true, exists: stat.isDirectory(), detail: '' }
  } catch (error) {
    const failure = error as (Error & { code?: string }) | null
    if (failure && (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')) {
      return { ok: true, exists: false, detail: '' }
    }
    return { ok: false, exists: false, detail: `stat failed for ${String(pathValue)}: ${(failure && failure.message) || String(error)}` }
  }
}
