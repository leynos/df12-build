// Host-collected git evidence. The assessor and the recovery decision tables
// treat this module's output as decisive over anything an agent reports, so
// collection must be honest about faults: every failed git command lands in
// collectionErrors instead of silently reading as "clean" or "no changes".
import { execFileStatus } from './exec.ts'

export interface NameStatusEntry {
  status: string
  path: string
  oldPath?: string
}

export interface GitEvidenceValue<T> {
  ok: boolean
  value: T
  error?: string
}

export interface AssessmentEvidence {
  taskId: string
  taskTitle: string
  branchName: string
  worktreePath: string
  baseCommit: string
  currentCommit: string
  dirtyState: 'clean' | 'dirty' | 'unknown'
  changedFiles: string[]
  committedChanges: NameStatusEntry[]
  dirtyChanges: NameStatusEntry[]
  stagedChanges: NameStatusEntry[]
  recentCommits: string[]
  collectionErrors: string[]
}

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

// Read a worktree file without letting untrusted content redirect the read
// outside the checkout (see write-preflight.ts). O_NOFOLLOW rejects a symlink
// at the FINAL component; when a worktree root is given, realpath containment
// additionally rejects a symlinked PARENT directory that would resolve the
// ancestry outside the root. Callers treat any failure as an unreadable file.
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

// Distinguish "not a directory" from "the filesystem would not answer",
// mirroring fileState (exec.ts): ENOENT/ENOTDIR mean absent; any other stat
// error is a fault the caller must surface rather than conflate with a
// missing directory. Returns { ok, exists, detail }.
export async function directoryExists(pathValue: unknown): Promise<{ ok: boolean; exists: boolean; detail: string }> {
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
