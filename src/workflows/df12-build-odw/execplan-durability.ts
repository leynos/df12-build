// Host-enforced ExecPlan durability — prose alone does not hold: live runs
// showed planners returning uncommitted drafts and reviewers approving
// without committing the status flip. The control loop therefore verifies
// durable state at every stage boundary, the same philosophy as the
// write-probe: prompts request, the host verifies.
import { execFileStatus } from './exec.ts'
import { parseExecplanState } from './recovery-decision.ts'

export interface DurabilityVerdict {
  ok: boolean
  detail: string
}

// Contain an agent-supplied ExecPlan path within the task worktree. Plan
// paths come back from planner agents — untrusted, prompt-injectable data
// under the documented threat model — so an absolute path outside the
// worktree or a ../ escape must fail closed BEFORE any filesystem or git
// access. Returns { ok, relPath, detail }.
export function execplanRelPath(worktree: string, planPath: unknown): { ok: boolean; relPath: string; detail: string } {
  const path = process.getBuiltinModule('node:path')
  const raw = String(planPath || '')
  const rel = path.isAbsolute(raw) ? path.relative(worktree, raw) : path.normalize(raw)
  if (!raw || !rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, relPath: '', detail: `ExecPlan path escapes the assigned worktree: ${raw || '<empty>'}` }
  }
  return { ok: true, relPath: rel, detail: '' }
}

// A plan is durable only when it exists at HEAD with no uncommitted
// modifications. Returns { ok, detail }.
export async function verifyExecplanCommitted(worktree: string, planPath: unknown): Promise<DurabilityVerdict> {
  const contained = execplanRelPath(worktree, planPath)
  if (!contained.ok) return { ok: false, detail: contained.detail }
  const relPath = contained.relPath
  const inHead = await execFileStatus('git', ['-C', worktree, 'cat-file', '-e', `HEAD:${relPath}`])
  if (!inHead.ok) return { ok: false, detail: `the plan file ${relPath} is not committed at HEAD` }
  const status = await execFileStatus('git', ['-C', worktree, 'status', '--porcelain=v1', '--', relPath])
  if (!status.ok) {
    return { ok: false, detail: `git status failed for ${relPath}: ${(status.message || status.stderr || '').trim()}` }
  }
  if (String(status.stdout).trim()) return { ok: false, detail: `the plan file ${relPath} has uncommitted modifications` }
  return { ok: true, detail: '' }
}

// The APPROVED flip is deterministic bookkeeping, so the control loop owns
// it: the design reviewer stays read-only, and the committed Status
// transition can never be skipped by an agent ignoring prose. Commits ONLY
// the plan path; idempotent when the committed status is already APPROVED.
export async function commitExecplanApproval(worktree: string, planPath: unknown, tag: string): Promise<DurabilityVerdict> {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const contained = execplanRelPath(worktree, planPath)
  if (!contained.ok) return { ok: false, detail: contained.detail }
  const relPath = contained.relPath
  const absPath = path.join(worktree, relPath)
  try {
    // The worktree is untrusted content (see write-preflight.ts): open both
    // the read and the rewrite with O_NOFOLLOW so a committed symlink at the
    // plan path can never redirect host I/O outside the worktree. ELOOP
    // surfaces through the catch below as a status-update failure.
    const { constants } = process.getBuiltinModule('node:fs')
    let text: string
    const readHandle = await fs.open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      text = await readHandle.readFile({ encoding: 'utf8' })
    } finally {
      await readHandle.close()
    }
    if (parseExecplanState(text).status !== 'approved') {
      const updated = /^Status:.*$/m.test(text)
        ? text.replace(/^Status:.*$/m, 'Status: APPROVED')
        : `${text.trimEnd()}\n\nStatus: APPROVED\n`
      const writeHandle = await fs.open(absPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
      try {
        await writeHandle.writeFile(updated, { encoding: 'utf8' })
      } finally {
        await writeHandle.close()
      }
    }
  } catch (error) {
    return { ok: false, detail: `could not update the plan status: ${((error as Error | null) && (error as Error).message) || String(error)}` }
  }
  const status = await execFileStatus('git', ['-C', worktree, 'status', '--porcelain=v1', '--', relPath])
  if (!status.ok) {
    return { ok: false, detail: `git status failed for ${relPath}: ${(status.message || status.stderr || '').trim()}` }
  }
  if (!String(status.stdout).trim()) return { ok: true, detail: 'already committed as APPROVED' }
  const add = await execFileStatus('git', ['-C', worktree, 'add', '--', relPath])
  if (!add.ok) return { ok: false, detail: `git add failed: ${(add.message || add.stderr || '').trim()}` }
  // Deterministic identity: this is a machine commit by the control loop, and
  // it must succeed even on hosts with no global git identity configured.
  const commit = await execFileStatus('git', [
    '-C', worktree,
    '-c', 'user.name=df12-build',
    '-c', 'user.email=df12-build@workflow.invalid',
    'commit', '-m', `Approve ExecPlan for task ${tag}`, '--', relPath,
  ])
  if (!commit.ok) return { ok: false, detail: `git commit failed: ${(commit.message || commit.stderr || '').trim()}` }
  return { ok: true, detail: '' }
}

// Live runs showed planners repeatedly returning with the drafted plan dirty
// — each bounce burnt a 30–90 minute planner round on pure git bookkeeping.
// Making the drafted plan durable is deterministic bookkeeping (the same
// philosophy as the APPROVED flip), so when the plan file is the ONLY
// uncommitted path the host commits it, path-scoped, and proceeds. Any other
// dirty path still bounces to the planner: the plan may depend on work the
// host must not guess at. A failed host commit surfaces the underlying git
// error — the strongest evidence when the environment, not the agent, is
// what blocks committing. Returns { ok, detail }.
export async function commitExecplanDraft(worktree: string, relPath: string, tag: string): Promise<DurabilityVerdict> {
  const status = await execFileStatus('git', ['-C', worktree, 'status', '--porcelain=v1'])
  if (!status.ok) return { ok: false, detail: `git status failed: ${(status.message || status.stderr || '').trim()}` }
  const lines = String(status.stdout).split(/\r?\n/).filter(Boolean)
  if (!lines.length) return { ok: false, detail: 'nothing to commit: the worktree is already clean' }
  const foreign = lines.filter((line) => line.slice(3).replace(/^"(.*)"$/, '$1') !== relPath)
  if (foreign.length) {
    const sample = foreign.slice(0, 8).map((line) => line.trim()).join('; ')
    return { ok: false, detail: `the worktree holds ${foreign.length} uncommitted path(s) beyond the plan file (${sample}${foreign.length > 8 ? '; …' : ''})` }
  }
  const add = await execFileStatus('git', ['-C', worktree, 'add', '--', relPath])
  if (!add.ok) return { ok: false, detail: `git add failed: ${(add.message || add.stderr || '').trim()}` }
  const commit = await execFileStatus('git', [
    '-C', worktree,
    '-c', 'user.name=df12-build',
    '-c', 'user.email=df12-build@workflow.invalid',
    'commit', '-m', `Draft ExecPlan for task ${tag}`, '--', relPath,
  ])
  if (!commit.ok) return { ok: false, detail: `git commit failed: ${(commit.message || commit.stderr || '').trim()}` }
  return { ok: true, detail: '' }
}

// Every path a successful implementation leaves uncommitted is unreviewable
// (the dual review judges committed work) and is silently lost at the squash
// merge. Returns { ok, detail } with a bounded path sample.
export async function verifyWorktreeCommitted(worktree: string): Promise<DurabilityVerdict> {
  const status = await execFileStatus('git', ['-C', worktree, 'status', '--porcelain=v1'])
  if (!status.ok) {
    return { ok: false, detail: `git status failed: ${(status.message || status.stderr || '').trim()}` }
  }
  const lines = String(status.stdout).split(/\r?\n/).filter(Boolean)
  if (!lines.length) return { ok: true, detail: '' }
  const sample = lines.slice(0, 8).map((line) => line.trim()).join('; ')
  return { ok: false, detail: `${lines.length} uncommitted path(s): ${sample}${lines.length > 8 ? '; …' : ''}` }
}
