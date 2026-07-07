// Host-enforced ExecPlan durability — prose alone does not hold: live runs
// showed planners returning uncommitted drafts and reviewers approving
// without committing the status flip. The control loop therefore verifies
// durable state at every stage boundary, the same philosophy as the
// write-probe: prompts request, the host verifies.
import { execFileStatus, fileState } from './exec.ts'
import { parseExecplanState } from './recovery-decision.ts'

export interface DurabilityVerdict {
  ok: boolean
  detail: string
}

export interface SalvageOutcome {
  // Task-scoped artefact paths committed onto the branch (relative to the
  // worktree), the paths skipped with a reason, and the resulting commit sha
  // ('' when nothing was committed). `detail` is empty on a clean success and
  // otherwise carries the "nothing to salvage" or git-failure reason.
  committed: string[]
  skipped: Array<{ path: string; reason: string }>
  sha: string
  detail: string
}

// Task-scoped planning/review artefacts follow the canonical ExecPlan
// convention: Markdown under docs/execplans/ (the ExecPlan itself, the
// roadmap-<id> plan, and adjacent review-file variants). Anything else a
// failing branch leaves dirty is out of scope for salvage — the host must not
// guess at arbitrary uncommitted work.
const TASK_ARTEFACT_PATTERN = /^docs\/execplans\/.+\.md$/

export function isTaskArtefactPath(candidate: unknown): boolean {
  return TASK_ARTEFACT_PATTERN.test(String(candidate || ''))
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

// Salvage useful, task-scoped planning/review artefacts a failing branch left
// uncommitted, by committing them onto the branch's OWN history — never
// merging, pushing, or ticking the roadmap — so they survive any later
// agent-driven worktree cleanup (the issue: a planner writes an ExecPlan or a
// review file, then fails schema parsing, and the untracked artefact is lost).
// Each candidate is filtered to the artefact convention, contained
// (execplanRelPath), and probed (fileState — a regular file, symlinks rejected)
// BEFORE any git call, matching the anti-spoof discipline the rest of this
// module uses on untrusted worktree content. A git failure or an ineligible
// state is a recorded reason, never a throw, so salvage can never convert a
// failed task into a run-halting error. Returns committed paths, skipped paths
// with reasons, and the salvage commit sha (or a "nothing to salvage" detail
// when no eligible artefact is dirty).
export async function salvageTaskArtefacts(worktree: string, candidatePaths: readonly string[], tag: string): Promise<SalvageOutcome> {
  const skipped: Array<{ path: string; reason: string }> = []
  const verified: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidatePaths) {
    const raw = String(candidate || '')
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    if (!isTaskArtefactPath(raw)) {
      skipped.push({ path: raw, reason: 'not a task-scoped docs/execplans/*.md artefact' })
      continue
    }
    // Containment before any filesystem or git access: a dirty path that
    // resolves outside the worktree (a ../ escape smuggled past the pattern)
    // fails closed here.
    const contained = execplanRelPath(worktree, raw)
    if (!contained.ok) {
      skipped.push({ path: raw, reason: contained.detail })
      continue
    }
    // fileState lstat-probes and requires a REGULAR file, so a committed or
    // planted symlink at the artefact path reads as absent and is skipped —
    // git never follows it out of the worktree.
    const probe = await fileState(contained.relPath, worktree)
    if (!probe.ok) {
      skipped.push({ path: contained.relPath, reason: probe.detail })
      continue
    }
    if (!probe.exists) {
      skipped.push({ path: contained.relPath, reason: 'no regular file at the path (absent, or a symlink)' })
      continue
    }
    verified.push(contained.relPath)
  }
  if (!verified.length) {
    return { committed: [], skipped, sha: '', detail: 'nothing to salvage: no eligible task-scoped artefacts are dirty' }
  }
  const add = await execFileStatus('git', ['-C', worktree, 'add', '--', ...verified])
  if (!add.ok) return { committed: [], skipped, sha: '', detail: `git add failed: ${(add.message || add.stderr || '').trim()}` }
  // Deterministic machine identity, mirroring commitExecplanDraft: the commit
  // must succeed even on hosts with no global git identity configured.
  const commit = await execFileStatus('git', [
    '-C', worktree,
    '-c', 'user.name=df12-build',
    '-c', 'user.email=df12-build@workflow.invalid',
    'commit', '-m', `Salvage task artefacts for task ${tag}`, '--', ...verified,
  ])
  if (!commit.ok) return { committed: [], skipped, sha: '', detail: `git commit failed: ${(commit.message || commit.stderr || '').trim()}` }
  const head = await execFileStatus('git', ['-C', worktree, 'rev-parse', 'HEAD'])
  return { committed: verified, skipped, sha: head.ok ? String(head.stdout).trim() : '', detail: '' }
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
