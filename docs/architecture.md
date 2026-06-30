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
- Assess failed or halted task branches that still have a surviving worktree.
- Serialize integration behind a JavaScript merge lock.
- Audit completed work and triage follow-up proposals.

The workflow must keep merge and remediation writes serialized. Parallelism is
allowed for independent task work, but operations that advance `origin/<base>`
must pass through the merge queue.

## Enforcement boundary

`df12-build` mixes host-enforced workflow logic with prompt-enforced agent
contracts. Treat that distinction as a security and reliability boundary. A
JavaScript branch, schema check, merge lock, or returned status is enforced by
the workflow host. A sentence inside an agent prompt is an instruction to an
autonomous CLI process, and only becomes reliable when the adapter sandbox,
GitHub permissions, and operator gates make violating it impossible or visible.

| Boundary | Host-enforced | Prompt-enforced | Runtime support that matters |
| - | - | - | - |
| Task selection | Reads `origin/<base>:<roadmap>`, parses checked tasks, `Requires`, addenda, dry-run/manual-merge suppression, and in-flight ids. | Agents are told to work only on the selected task. | Canonical remote refs must be readable; local working-tree roadmap edits are not selection input. |
| Dry run | `DRY_RUN` returns terminal `dry-run` statuses before implementation, integration, audit writes, or remediation flushes. | Agents still see dry-run wording in prompts that remain reachable, such as planning and review. | Do not grant write-heavy permissions when running exploratory dry runs unless they are needed for worktree creation. |
| Worktree base | The worktree response schema requires `baseSha` and `donkeyInvocation`, and failed setup halts the task. | The worktree agent is instructed to reset and verify against the current `origin/<base>`. | Git credentials and remote freshness are required; the schema proves evidence was returned, not that the shell obeyed absent permissions. |
| Implementation scope | The control loop only advances statuses that satisfy schema and status checks. | Build agents are told to follow the ExecPlan, use skills, keep scope narrow, update the execplan, run gates, and commit atomically. | Sandbox file scope, Git permissions, `make all`, `scrutineer`, and review gates are the real containment for bad edits. |
| Tests and deterministic gates | The workflow consumes `impl.gatesGreen` and review verdicts before integration. | Implementers and fix agents are told to summon `scrutineer` for `make all`, markdown gates, and CodeRabbit. | The adapter must allow command execution, and `scrutineer` must run in the task worktree with the same repository state the commit uses. |
| Code review | Review schemas require verdict and blocker fields; blocker arrays are checked regardless of verdict. | Code-review, expert-review, fallback review, and CodeRabbit instructions define what reviewers should inspect. | Model quality, CodeRabbit availability, and explicit fallback criteria determine whether the review is useful. |
| Partial branch assessment | Failed or halted task results with a surviving branch and worktree pass through an assessment guard. The host gathers branch name, worktree path, base/current commits, changed files, dirty state, recent commits, and command errors, then consumes a schema-bound classification. Assessment output is report-only and cannot update `processed`, merge branches, push, or mark roadmap checkboxes. | The assessment agent is instructed to inspect durable Git and on-disk evidence, read ExecPlans and roadmap state, and classify as `adopt-complete`, `adopt-partial`, `continue-manual`, or `discard`. | Assessment requires readable surviving worktrees and adapter access. It is skipped for auth failures, dry runs, manual-merge-ready branches, successful tasks, and failures before worktree creation. |
| Integration | A JavaScript merge lock serializes integration, and success requires `ok`, `pushed`, `squashMerged`, and roadmap evidence. | The integration agent is told to rebase, gate, squash, push, and avoid the root worktree. | GitHub branch permissions, non-fast-forward push handling, and sandbox write access to the task worktree are decisive. |
| Audit and triage | Audits run only after pushed integrations; triage only deletes pending proposals when `ok` and `pushed` land. | Audit and triage prompts classify debt into addendum, step-task, reroute, editorial, or dropped lanes. | `documentAudit=false` and `autoMerge=false` change write behaviour; roadmap edits still need operator review. |
| Fresh restart | Returned `processed`, `results`, `halted`, `audits`, `remediationTriage`, and `pendingProposals` describe the run outcome. | Operator notes and prompts describe how to recover. | `origin/<base>`, durable sidecar files, and clean worktree hoovering are the only recovery source of truth. |

Any change that moves a contract from host enforcement into prompt text weakens
the system. Document that deliberately, add the missing runtime permission or
gate, or keep the contract in JavaScript.

## Configuration contract

Runtime configuration comes from the ODW `args` object. The checked-in workflow
also has top-of-file defaults, but a sidecar `args.json` is the normal place to
retune a live launch.

The key argument groups are:

- Target-project pointers: `base`, `roadmap`, `designDocs`, and `researchNote`.
- Search routing: `grepaiWorkspace`, `grepaiProject`, and the `project` alias.
- Run bounds: `taskId`, `maxTasks`, `maxParallel`, `maxDesignRounds`,
  `maxReviewRounds`, `dryRun`, `autoMerge`, `documentAudit`, and
  `assessPartialBranches`.
- Agent routing: `buildAdapter`/`buildModel`, `planAdapter`/`planModel`, and
  `reviewAdapter`/`reviewModel`.
- Assessment routing: `assessmentAdapter`/`assessmentModel`, defaulting to the
  review adapter and model.

`grepaiProject` is part of the architecture because sidecar and worktree launch
paths can make `$(get-project)` resolve to the wrong name. The workflow builds a
canonical GrepAI command from the configured workspace and project, then tells
agents to verify branch-local facts directly inside their worktree.

## Documentation contract

The sidecar contract is documented at three levels:

- `docs/users-guide.md` explains how to launch and supervise a run.
- `docs/security-and-permissions.md` explains the required permissions,
  external services, prompt-injection surface, and sandbox profiles.
- `docs/developers-guide.md` explains how contributors change the workflow and
  keep documentation synchronized.
- `docs/adr-001-adopt-odw-sidecar-launches.md` records the architectural
  decision to use ODW sidecar launches for Codex-oriented runs.
- `docs/adr-002-assess-partial-task-branches.md` records the accepted
  assessment stage for preserving useful partial task branches without resuming
  transient agent transcripts.

Changes to launch behaviour, sidecar artefacts, configuration arguments, or
agent-routing defaults must update all affected layers in the same branch.

## Verification contract

This repository has a small `Makefile` for local and hook-driven validation.
Workflow and documentation changes must at least pass:

- `make check-fmt`
- `make markdownlint`
- `make nixie`
- `make typecheck`

Do not start a live `odw run` as a routine documentation gate. A live run can
spawn agents and mutate target-project state, so it is reserved for explicit
execution requests.
