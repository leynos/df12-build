/**
 * @file Host-side git operations against a task worktree — reading `git status
 * --porcelain=v1`, recognising the workflow's own review artefacts, and making
 * path-scoped machine commits — are a distinct concern from the ExecPlan
 * durability contract that orchestrates them. Keeping them here leaves
 * execplan-durability.ts free to express the contract itself.
 */
import { execFileStatus } from './exec.ts'

/** The pass/fail result of a path-scoped host commit. */
export interface CommitVerdict {
  ok: boolean
  detail: string
}

/**
 * Strip a git `status --porcelain=v1` line down to its path, unquoting the
 * C-style quoting git applies to paths with unusual characters.
 */
export function porcelainPath(line: string): string {
  return line.slice(3).replace(/^"(.*)"$/, '$1')
}

/**
 * Test whether a path is the deterministic review sibling of an ExecPlan.
 * Anything outside that convention stays foreign and still declines salvage.
 */
export function isReviewSibling(relPath: string, planRelPath: string): boolean {
  const path = process.getBuiltinModule('node:path')
  if (path.dirname(relPath) !== path.dirname(planRelPath)) return false
  const stem = path.basename(planRelPath).replace(/\.md$/, '')
  if (!stem) return false
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}\\.review-r\\d+\\.md$`).test(path.basename(relPath))
}

/** Read `git status --porcelain=v1` as its non-empty lines. */
export async function porcelainLines(worktree: string): Promise<{ ok: boolean; lines: string[]; detail: string }> {
  const status = await execFileStatus('git', ['-C', worktree, 'status', '--porcelain=v1'])
  if (!status.ok) return { ok: false, lines: [], detail: `git status failed: ${(status.message || status.stderr || '').trim()}` }
  return { ok: true, lines: String(status.stdout).split(/\r?\n/).filter(Boolean), detail: '' }
}

/**
 * Make a path-scoped control-loop commit with a deterministic machine identity.
 */
export async function addAndCommit(worktree: string, paths: string[], message: string): Promise<CommitVerdict> {
  const add = await execFileStatus('git', ['-C', worktree, 'add', '--', ...paths])
  if (!add.ok) return { ok: false, detail: `git add failed: ${(add.message || add.stderr || '').trim()}` }
  const commit = await execFileStatus('git', [
    '-C', worktree,
    '-c', 'user.name=df12-build',
    '-c', 'user.email=df12-build@workflow.invalid',
    'commit', '-m', message, '--', ...paths,
  ])
  if (!commit.ok) return { ok: false, detail: `git commit failed: ${(commit.message || commit.stderr || '').trim()}` }
  return { ok: true, detail: '' }
}
