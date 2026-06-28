# df12-build architecture

`df12-build` is a repository for workflow assets and operator guidance. It does
not own target-project source code. The workflow assets run against another
project that follows the df12 house conventions: a GIST roadmap, design
documentation, repository gates, `AGENTS.md`, and the df12 skill/toolchain.

## System boundary

The system has three separate state domains:

- The `df12-build` repository contains versioned workflow source and
  documentation.
- The target project repository contains product source, roadmap state, task
  branches, and integration history.
- The `.workshop` sidecar contains durable run-control state for one workshop
  invocation.

Only the first domain is edited in this repository. The ODW workflow is
designed to operate on the target project through `--source`, and to keep live
run artefacts outside both repositories.

## Sidecar contract

ODW/Codex launches use a `.workshop` sidecar adjacent to the target project. The
sidecar holds the copied workflow script, ODW runtime configuration, workflow
arguments, and operator notes for the live run. This keeps long-running
workshops recoverable when `.claude/`, `/tmp`, the target project checkout, or
workflow-owned worktrees are cleaned or switched.

The sidecar is not a product source of truth. `origin/<base>` in the target
project remains the recovery point. Any sidecar script patch that proves useful
during a live run must be promoted back to `df12-build` through a normal branch
before it becomes a reusable workflow change.

## Workflow structure

`workflows/df12-build-odw.js` is an ODW workflow script. It relies on ODW's
injected globals, including `args`, `agent`, `parallel`, `phase`, `log`, and
`budget`. It deliberately creates and supervises real target-project git
worktrees through agent prompts instead of relying on ODW copy isolation as a
handoff mechanism.

The workflow follows this high-level sequence:

- Select the next unblocked roadmap task or addendum pass.
- Create a task worktree rooted on the current integration branch.
- Plan the task and run adversarial design review.
- Implement, gate, and review the task.
- Serialize integration behind a JavaScript merge lock.
- Audit completed work and triage follow-up proposals.

The workflow must keep merge and remediation writes serialized. Parallelism is
allowed for independent task work, but operations that advance `origin/<base>`
must pass through the merge queue.

## Configuration contract

Runtime configuration comes from the ODW `args` object. The checked-in workflow
also has top-of-file defaults, but a sidecar `args.json` is the normal place to
retune a live launch.

The key argument groups are:

- Target-project pointers: `base`, `roadmap`, `designDocs`, and `researchNote`.
- Search routing: `grepaiWorkspace`, `grepaiProject`, and the `project` alias.
- Run bounds: `taskId`, `maxTasks`, `maxParallel`, `maxDesignRounds`,
  `maxReviewRounds`, `dryRun`, `autoMerge`, and `documentAudit`.
- Agent routing: `buildAdapter`/`buildModel`, `planAdapter`/`planModel`, and
  `reviewAdapter`/`reviewModel`.

`grepaiProject` is part of the architecture because sidecar and worktree launch
paths can make `$(get-project)` resolve to the wrong name. The workflow builds a
canonical GrepAI command from the configured workspace and project, then tells
agents to verify branch-local facts directly inside their worktree.

## Documentation contract

The sidecar contract is documented at three levels:

- `docs/users-guide.md` explains how to launch and supervise a run.
- `docs/developers-guide.md` explains how contributors change the workflow and
  keep documentation synchronized.
- `docs/adr-001-adopt-odw-sidecar-launches.md` records the architectural
  decision to use ODW sidecar launches for Codex-oriented runs.

Changes to launch behaviour, sidecar artefacts, configuration arguments, or
agent-routing defaults must update all affected layers in the same branch.

## Verification contract

This repository has no `Makefile` or package manifest. Until a broader gate
stack exists, workflow and documentation changes must at least pass:

- `git diff --check $(git merge-base HEAD origin/main)..HEAD`
- `markdownlint-cli2 <changed markdown files>`
- An ODW wrapper parse check for `workflows/df12-build-odw.js`

Do not start a live `odw run` as a routine documentation gate. A live run can
spawn agents and mutate target-project state, so it is reserved for explicit
execution requests.
