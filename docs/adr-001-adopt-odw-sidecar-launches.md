# ADR 001: Adopt ODW sidecar launches for Codex-oriented df12-build runs

## Status

Accepted.

## Date

2026-06-28.

## Context and problem statement

The Codex-oriented `df12-build` workflow needs durable run-control state while
it drives long-running roadmap work in another repository. Earlier launch
patterns could place live workflow copies, configuration, or operator notes in
locations that are vulnerable to cleanup or branch switching, including
`.claude/`, `/tmp`, the target project source tree, and workflow-owned
`...worktrees/roadmap-*` directories.

ODW runs also execute outside the host agent's context. A workflow may spawn
agents, create target-project worktrees, commit, merge, push, audit, and file
remediation. That makes the launch contract part of the architecture rather
than a minor operator preference.

## Decision outcome

Adopt a `.workshop` sidecar outside the target project's Git worktree for
ODW/Codex launches.

The sidecar contains:

- `df12-build-odw.js`, the copied workflow script that the live run executes.
- `odw.config.json`, the ODW runtime and adapter configuration.
- `args.json`, the project-specific workflow arguments.
- `operator-notes.md`, the durable run notes and recovery trail.

The target project is passed to ODW with `--source`. The target project's
`origin/<base>` remains the source of truth for product state and fresh-restart
recovery. Sidecar-local script patches are allowed only as live-run recovery or
tuning changes; reusable changes must be promoted back to this repository
through a normal branch.

## Consequences

Positive consequences:

- Live run-control artefacts survive target-project cleanup, branch switches,
  and workflow worktree cleanup.
- Operators can relaunch from a known sidecar copy while the target project
  remains the product source of truth.
- `args.json` becomes the normal retuning surface for base branch, roadmap,
  GrepAI routing, run bounds, and Codex adapter/model choices.
- Documentation can name one launch model instead of keeping separate ODW and
  legacy launch paths equally authoritative.

Negative consequences:

- Operators must manage one extra directory per workshop.
- Sidecar-local patches can drift from the repository if they are not recorded
  in `operator-notes.md` and promoted back deliberately.
- Contributors must update user, developer, and design documentation when they
  change launch semantics or configuration arguments.

## Options considered

### Keep launch artefacts in the target project

Rejected. A long-running roadmap workflow may clean, rebase, branch, or create
worktrees around the target project. Keeping durable run-control state there
blurs the source-of-truth boundary and makes recovery depend on checkout state.

### Keep launch artefacts in `.claude/` or `/tmp`

Rejected. These locations are convenient scratch areas, but they are not durable
operator state. Cleanup can delete the workflow copy, configuration, or notes
needed to understand a halted run.

### Use only the checked-in workflow path

Rejected as the live-run contract. The repository copy is the reusable source,
but a live run still needs colocated `odw.config.json`, `args.json`, and
operator notes. A sidecar keeps those artefacts together without mutating the
workflow repository or target project.

### Use a `.workshop` sidecar

Accepted. It separates reusable workflow source, target-project product state,
and live run-control state while matching ODW's explicit `--source`,
`--config`, and `--args` launch model.

## Verification

Changes to the sidecar contract are verified by documentation linting and an ODW
wrapper parse check for the workflow source. A live `odw run` is not part of the
default verification contract because it can spawn agents and mutate
target-project state.
