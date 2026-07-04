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

- Run fresh-run recovery when `resumePartialBranches=true`: discover surviving
  `roadmap-*` branches from durable Git state, assess them through the ADR 002
  contract, and either report them (assess mode) or route eligible clean
  `adopt-complete` branches into the ordinary review and integration path
  (review mode). Discovered ids are held out of normal selection for the rest
  of the run.
- Select the next unblocked roadmap task or addendum pass.
- Create a task worktree rooted on the current integration branch, then prove
  once per run that the planning and build adapters can actually write inside
  a sibling task worktree (the host verifies a probe file on disk).
- Plan the task and run adversarial design review.
- Implement, gate, and review the task.
- Assess failed or halted task branches that still have a surviving worktree.
- Serialize integration behind a JavaScript merge lock.
- Audit completed work and triage follow-up proposals.

The workflow must keep merge and remediation writes serialized. Parallelism is
allowed for independent task work, but operations that advance `origin/<base>`
must pass through the merge queue.

Task agents must execute with a writable filesystem root that includes their
assigned task worktree. Prompt text that says "cd into the worktree" is not
sufficient when the adapter sandbox was launched with a different writable
root. The workflow must either launch each task agent from the assigned
worktree or grant the adapter an explicit writable scope covering the sibling
`...worktrees/roadmap-*` directory. Otherwise planners can return
`execplanPath` values that reviewers cannot read from disk, and the design loop
burns rounds on a workflow-environment fault rather than a task defect.

The workflow enforces this boundary with a host-verified writable-root
preflight (`worktreeWritePreflight`, enabled by default). After the first task
worktree is created, each adapter that must write into task worktrees is asked
to write an exact token file inside the worktree, and the workflow host checks
the bytes on disk before deleting the probe. A failed probe fails the task at
stage `worktree-write` — excluded from partial-branch assessment because it is
a launch or sandbox fault — and every concurrent task shares the memoized
verdict, so a broken environment drains the pool quickly instead of burning
design rounds task by task.

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
| Task-agent writable root | Every task-phase `agent()` call must run with write access to the assigned task worktree before its output can be trusted as a durable side effect. | Agents are told to `cd` into the worktree and write ExecPlans, code, gate logs, commits, and integration state there. | Adapter sandbox scope is decisive. If the sandbox root is the control checkout while task worktrees are siblings, writes to `...worktrees/roadmap-*` can fail even when prompts and `workdir` values look correct. |
| Implementation scope | The control loop only advances statuses that satisfy schema and status checks. | Build agents are told to follow the ExecPlan, use skills, keep scope narrow, update the execplan, run gates, and commit atomically. | Sandbox file scope, Git permissions, `make all`, `scrutineer`, and review gates are the real containment for bad edits. |
| Tests and deterministic gates | The workflow consumes `impl.gatesGreen` and review verdicts before integration. | Implementers and fix agents are told to summon `scrutineer` for `make all`, markdown gates, and CodeRabbit. | The adapter must allow command execution, and `scrutineer` must run in the task worktree with the same repository state the commit uses. |
| Code review | Review schemas require verdict and blocker fields; blocker arrays are checked regardless of verdict. | Code-review, expert-review, fallback review, and CodeRabbit instructions define what reviewers should inspect. | Model quality, CodeRabbit availability, and explicit fallback criteria determine whether the review is useful. |
| Task-agent write preflight | The host verifies the probe token on disk and fails the task at stage `worktree-write` when any probed adapter cannot write into the worktree; the stage is excluded from partial-branch assessment. | Probe agents are asked to write one exact token file and nothing else. | Adapter sandbox scope is what the probe measures; disabling `worktreeWritePreflight` removes the enforcement, not the requirement. |
| Fresh-run recovery | Discovery, roadmap-id mapping, completed-task skipping, the candidate cap, resume eligibility, and the fail-closed downgrade to `continue-manual` are host JavaScript. Resume can only land through the shared dual-review + merge-lock integration path, `processed` gains an id only from a pushed integration, and held ids are excluded from selection deterministically. | The recovery assessment agent classifies durable branch evidence; reviewers and the integration agent handle a resumed branch exactly like ordinary work. | `resumePartialBranches` and `resumeMode` gate the pass; auth preflight failure blocks it entirely; review-mode resume needs the same write and push permissions as ordinary integration. |
| Partial branch assessment | Failed or halted task results with a surviving branch and worktree pass through an assessment guard. The host gathers branch name, worktree path, base/current commits, changed files, dirty state, recent commits, and command errors, then consumes a schema-bound classification. Assessment output is report-only and cannot update `processed`, merge branches, push, or mark roadmap checkboxes. | The assessment agent is instructed to inspect durable Git and on-disk evidence, read ExecPlans and roadmap state, and classify as `adopt-complete`, `adopt-partial`, `continue-manual`, or `discard`. | Assessment requires readable surviving worktrees and adapter access. It is skipped for auth failures, provider faults, dry runs, manual-merge-ready branches, successful tasks, and failures before worktree creation. |
| Integration | A JavaScript merge lock serializes integration, and success requires `ok`, `pushed`, `squashMerged`, and roadmap evidence. Addenda whose implementation evidence is complete but whose `ok` field is false become `manual-merge-ready`, never auto-merged. | The integration agent is told to rebase, gate, squash, push, and avoid the root worktree. | GitHub branch permissions, non-fast-forward push handling, and sandbox write access to the task worktree are decisive. |
| Audit and triage | Audits run only after pushed integrations; triage only deletes pending proposals when `ok` and `pushed` land. | Audit and triage prompts classify debt into addendum, step-task, reroute, editorial, or dropped lanes. | `documentAudit=false` and `autoMerge=false` change write behaviour; provider-fault halts leave pending proposals unwritten; roadmap edits still need operator review. |
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
- Search routing: `searchBackend`, `grepaiWorkspace`, `grepaiProject`,
  `memtraceRepoId`, and the `project` alias.
- Run bounds: `taskId`, `maxTasks`, `maxParallel`, `maxPlanningParallel`,
  `maxBuildParallel`, `maxDesignRounds`, `maxReviewRounds`, `dryRun`,
  `autoMerge`, `documentAudit`, and `assessPartialBranches`.
- Recovery controls: `resumePartialBranches` (opt-in fresh-run discovery),
  `resumeMode` (`assess` reports only; `review` may resume eligible
  `adopt-complete` branches through ordinary integration), `resumeTaskId`,
  `resumeMaxCandidates`, and `worktreeWritePreflight` (the host-verified
  task-agent write probe).
- Agent routing: `buildAdapter`/`buildModel`, `planAdapter`/`planModel`, and
  `reviewAdapter`/`reviewModel`.
- Assessment routing: `assessmentAdapter`/`assessmentModel`, defaulting to the
  review adapter and model.

The default routing separates execution from judgement. Build-side stages
default to Codex: worktree creation, implementation, fix rounds, integration,
remediation, and triage use the build or triage adapter/model defaults.
Planning and review judgement default to Claude Code with
`claude-opus-4-8`: the plan stage uses `planAdapter`/`planModel`, while design
review, code review, expert review, addendum fallback review, and audit use
`reviewAdapter`/`reviewModel`. Partial-branch assessment inherits the review
route unless `assessmentAdapter`/`assessmentModel` are set explicitly, so a
sidecar that wants Codex assessment must say so in `args.json`.

Auth preflight is adapter-aware. The workflow always checks Codex auth because
build-side stages depend on it, checks CodeRabbit auth when implementation can
run, and checks Claude auth whenever any configured stage uses the `claude`
adapter. Auth failures are terminal workflow failures rather than ordinary
task failures or partial-branch recovery candidates.

ODW adapter timeout is also part of the runtime contract. The implementation
prompt can legitimately ask agents to wait through CodeRabbit rate-limit
backoff with `vsleep`, including three retries of up to 90 minutes each. A
sidecar `odw.config.json` that keeps the default one-hour timeout is therefore
misconfigured for a full workshop run.

`searchBackend` selects the canonical code-search guidance passed to task
agents. It defaults to `grepai`, or to `memtrace` when `memtraceRepoId` is set.
`grepaiProject` and `memtraceRepoId` are part of the architecture because
sidecar and worktree launch paths can make automatic project discovery resolve
to the wrong name. The workflow builds canonical GrepAI or Memtrace guidance
from those configured values, then tells agents to verify branch-local facts
directly inside their worktree.

## Documentation contract

The sidecar contract is documented at three levels:

- `docs/users-guide.md` explains how to launch and supervise a run.
- `docs/security-and-permissions.md` explains the required permissions,
  external services, prompt-injection surface, and sandbox profiles.
- `docs/developers-guide.md` explains how contributors change the workflow and
  keep documentation synchronized.
- `docs/adr-001-adopt-odw-sidecar-launches.md` records the architectural
  decision to use ODW sidecar launches for Codex- and Claude-oriented runs.
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
