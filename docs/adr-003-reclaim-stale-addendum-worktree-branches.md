# ADR 003: Reclaim stale merged addendum worktree branches

## Status

Accepted and implemented for the ODW workflow.

## Date

2026-07-07.

## Context and problem statement

`createWorktree` builds a task branch from `slugForTask`
(`roadmap-<id>[-addendum]`), a deterministic name with no unique suffix, and
runs `git worktree add -b <branch> <path> origin/<base>`. Deterministic naming
is load-bearing: `branchToRoadmapId`, recovery discovery, and the selection
hold-set all reverse a branch name back to its roadmap task, so a per-run
counter suffix is not an option.

The determinism has a sharp edge for addendum passes. When a completed addendum
round from a prior run leaves its `roadmap-<id>-addendum` branch behind — the
worktree hoovered but the branch never deleted — the next selection of that
task re-derives the same branch name. `git worktree add -b` then fails because
the branch already exists, and `runTask` turns the throw into a
`failed`/`worktree` halt. A harmless, fully-merged leftover therefore blocks
real addendum work (issue #42).

The obvious fixes are unsafe or insufficient. Uniquifying the name breaks the
deterministic-naming contract above. Skipping the task on
`candidateRoadmapComplete` does not help: selection only offers the task
because open sub-tasks remain, so the completeness oracle returns false and the
leftover still blocks the frontier.

## Decision outcome

Detect the colliding branch inside `createWorktree` and decide its fate through
a pure, unit-tested disposition helper (`worktree-collision.ts`,
`decideWorktreeDisposition`) kept out of the formally-verified
recovery-decision twin. The rule is **reclaim-when-safe, fail-closed
otherwise**:

- no pre-existing branch -> `create` (the unchanged `git worktree add -b`
  path);
- an existing branch whose tip is a merged ancestor of `origin/<base>` and
  whose worktree (if any) is clean -> `reclaim`;
- an existing branch with unmerged commits, or a dirty worktree, -> `fail` with
  a descriptive note, preserving today's `failed`/`worktree` halt semantics.

`candidateRoadmapComplete` is treated only as a corroborating signal on the
`reclaim` path; it never licenses discarding unmerged or uncommitted work.

Reclaim uses only sandbox-permitted git commands (see the supervisor skill's
environment safety-net constraints): `git worktree prune`, `git branch -f
<branch> origin/<base>`, plain `git worktree add`, and `git -C <path> reset
--hard origin/<base>` — never `git worktree remove --force` or `git branch -D`.
The existing HEAD-versus-base verification runs afterwards, so a reclaimed
worktree is proven to sit on `origin/<base>` before any agent writes to it.

## Scope and the deferred sweeper

This automation is deliberately scoped to branches **fully merged into
`origin/<base>` with a clean worktree**. It reclaims a specific deterministic
name on demand, at the moment of collision; it never enumerates, deletes, or
sweeps branches speculatively. The general question of whether `discard`
branches may be deleted by a managed sweeper — including deletion, stash
handling, and branch-retention policy — remains open under roadmap item 4.2.1
and is explicitly out of scope here.

## Consequences

- A stale, merged addendum branch no longer halts the run; the addendum pass
  proceeds on a branch reset to `origin/<base>`.
- Any leftover that still carries unmerged commits or uncommitted work is left
  untouched and still halts the run for operator judgement — no work is
  destroyed automatically.
- The decision logic is a pure function with exhaustive unit coverage
  (`tests/modules/worktree-collision.test.ts`); the real-git leftover state it
  reasons over is modelled by the `withStaleAddendumBranch` fixture option in
  `tests/fixtures/recovery-repo.mjs`.
