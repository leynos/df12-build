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
| Implementation scope | With `perWorkItemBuild` on (the default), the host reads the committed ExecPlan's `## Progress` checklist and dispatches one builder turn per unticked work item, verifying a fully committed worktree and committed checklist movement after every turn (one named bounce, then fail-closed; `maxWorkItemRounds` bounds the loop). The control loop only advances statuses that satisfy schema and status checks. | Build agents are told to implement exactly one work item, use skills, keep scope narrow, tick the item in the execplan, run gates, and commit atomically. | Sandbox file scope, Git permissions, the host-run gates, and review gates are the real containment for bad edits. |
| ExecPlan durability | The host verifies the plan exists committed and clean at `HEAD` after every planner round (host-committing a plan-only dirty draft, bouncing anything else), owns the `APPROVED` status flip as a deterministic commit, and fails an implementation that leaves uncommitted state. Agent-supplied plan paths are contained within the worktree before any filesystem or git access. | Planner, reviewer, and builder prompts state the durability contract. | Git identity is hermetic for machine commits; only `ENOENT`/`ENOTDIR` read as "absent" — other I/O faults fail closed. |
| Tests and deterministic gates | With `hostCommitGates` on (the default), the host re-runs the configured `commitGates` commands against committed `HEAD` at the start of every dual-review round and once per addendum. These runs are serialized pool-wide, with per-command timeouts and logs streamed to a secure per-run directory (mode 0700, files opened exclusively without following symlinks so a planted symlink cannot clobber or leak them). A red gate goes to a fix round with the host evidence and never spends reviewer agents. With `hostGatesBetweenWorkItems` on (the default), the gates ALSO re-run after each committed work item during the per-work-item build — before the between-item CodeRabbit review — so a committed red work item is caught at the item boundary, not only at the review stage. With `csCheck` on (the default), a CodeScene code-health check (`csCheckCommand`, default `cs-check-changed`) runs as a second deterministic gate on the committed changed files, AFTER the commit gates and BEFORE CodeRabbit; a regression short-circuits to a fix round without spending CodeRabbit quota or reviewer-agent tokens, and the check skips gracefully when its binary is absent. `impl.gatesGreen` is a claim, not the decision. | Implementers and fix agents are told to summon `scrutineer` for `make all` and markdown gates, and warned that the host re-runs the gates. | The gate commands must be runnable by the host process in the task worktree; `commitGateTimeoutSeconds` kills a hung gate. |
| Code review | Review schemas require verdict and blocker fields; blocker arrays are checked regardless of verdict. Each review round spends cheapest-first (deterministic gates free, CodeRabbit a fixed quota, reviewer agents the scarcest tokens): host gates, then CodeRabbit, then the reviewer agents, short-circuiting to a fix round the moment a cheaper stage blocks so a red gate or a CodeRabbit blocking finding never spends reviewer-agent tokens that round. With `coderabbitHostReview` on (the default), the host runs `coderabbit review --agent --type committed` per review round and per addendum, parses the NDJSON events (never exit codes), feeds `critical`/`major` findings into fix rounds, absorbs rate-limit backoff in host wall-clock, and defers with a documented open issue (falling through to the decisive reviewer agents) when the limit outlives `coderabbitAttempts`. With `coderabbitBetweenWorkItems` on (the default), that host review ALSO runs after each committed work item during the per-work-item build — a deterministic gate between build turns — and fails closed: unresolved blocking findings fail the work item, and a terminal deferral halts the task for assessment rather than continuing unreviewed. | Code-review, expert-review, and fallback review instructions define what reviewers should inspect; agents are told not to run CodeRabbit themselves. | Model quality and CodeRabbit auth/quota determine usefulness; a CodeRabbit auth failure halts as `fatal-auth`. |
| Task-agent write preflight | The host verifies the probe token on disk and fails the task at stage `worktree-write` when any probed adapter cannot write into the worktree; the stage is excluded from partial-branch assessment. | Probe agents are asked to write one exact token file and nothing else. | Adapter sandbox scope is what the probe measures; disabling `worktreeWritePreflight` removes the enforcement, not the requirement. |
| Fresh-run recovery | Discovery, roadmap-id mapping, completed-task skipping, the candidate cap, resume eligibility, and the fail-closed downgrade to `continue-manual` are host JavaScript. Continue mode (`resumeMode="continue"`) dispatches deterministically from the committed ExecPlan `Status` with no judgement agent; a plan the host cannot read reports `plan-unreadable` instead of resuming. Resume can only land through the shared dual-review + merge-lock integration path, `processed` gains an id only from a pushed integration, and held ids are excluded from selection deterministically; unresolved survivors surface as `recovery.unresolved` and a `needs-operator-recovery` halt. | The recovery assessment agent classifies durable branch evidence; reviewers and the integration agent handle a resumed branch exactly like ordinary work. | `resumePartialBranches` and `resumeMode` gate the pass; auth preflight failure blocks it entirely; review-mode and continue-mode resume need the same write and push permissions as ordinary integration. |
| Partial branch assessment | Failed or halted task results with a surviving branch and worktree pass through an assessment guard. The host gathers branch name, worktree path, base/current commits, changed files, dirty state, recent commits, and command errors, then consumes a schema-bound classification. Assessment output is report-only and cannot update `processed`, merge branches, push, or mark roadmap checkboxes. | The assessment agent is instructed to inspect durable Git and on-disk evidence, read ExecPlans and roadmap state, and classify as `adopt-complete`, `adopt-partial`, `continue-manual`, or `discard`. | Assessment requires readable surviving worktrees and adapter access. It is skipped for auth failures, provider faults, dry runs, manual-merge-ready branches, successful tasks, and failures before worktree creation. |
| Integration | A JavaScript merge lock serializes integration, and success requires `ok`, `pushed`, `squashMerged`, and roadmap evidence. Addenda whose implementation evidence is complete but whose `ok` field is false become `manual-merge-ready`, never auto-merged. | The integration agent is told to rebase, gate, squash, push, and avoid the root worktree. | GitHub branch permissions, non-fast-forward push handling, and sandbox write access to the task worktree are decisive. |
| Audit and triage | Audits run only after pushed integrations; triage only deletes pending proposals when `ok` and `pushed` land. | Audit and triage prompts classify debt into addendum, step-task, reroute, editorial, or dropped lanes. | `documentAudit=false` and `autoMerge=false` change write behaviour; provider-fault halts leave pending proposals unwritten; roadmap edits still need operator review. |
| Infrastructure faults | Adapter deaths (timeout, kill, schema-retry exhaustion) classify as `infra-fault`, distinct from product failure: `withInfraRetry` re-runs the stage agent up to `stageAttempts`, no assessment agent is spawned, remediation triage skips its writes, and integration is never retried (its push is not idempotent). Bounded `faultMetrics` counters land in the result. | The halt detail directs the operator to relaunch with `resumeMode: "continue"`. | The ODW adapter `timeout` bounds how long a hung stream costs before the retry can begin. |
| Fresh restart | Returned `processed`, `results`, `halted`, `assessments`, `recovery` (with `unresolved`), `audits`, `remediationTriage`, `pendingProposals`, and the enforcement echoes (`commitGates`, `hostGates`, `coderabbit`, `workItemBuild`, `stageAttempts`, `faultMetrics`) describe the run outcome. | Operator notes and prompts describe how to recover. | `origin/<base>`, durable sidecar files, and clean worktree hoovering are the only recovery source of truth. |

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
- Host enforcement: `commitGates` (the deterministic gate command list),
  `hostCommitGates`/`hostGatesBetweenWorkItems`/`commitGateTimeoutSeconds`
  (host-run gate verification, including between work-item build turns),
  `csCheck`/`csCheckCommand` (the CodeScene code-health gate that runs after
  the commit gates and before CodeRabbit),
  `coderabbitHostReview`/`coderabbitBetweenWorkItems`/`coderabbitAttempts`/
  `coderabbitBackoffMinutes`/`coderabbitFindingsFile` (host-run CodeRabbit
  review, between-work-item gating, and findings capture),
  `perWorkItemBuild`/`maxWorkItemRounds` (the host-driven work-item build
  loop), and `stageAttempts` (bounded in-run retry of stage agents on
  infrastructure faults).
- Recovery controls: `resumePartialBranches` (opt-in fresh-run discovery),
  `resumeMode` (`assess` reports only; `review` may resume eligible
  `adopt-complete` branches through ordinary integration; `continue`
  dispatches deterministically from the committed ExecPlan `Status`),
  `resumeTaskId`, `resumeMaxCandidates`, and `worktreeWritePreflight` (the
  host-verified task-agent write probe).
- Agent routing: `buildAdapter`/`buildModel`, `planAdapter`/`planModel`, and
  `reviewAdapter`/`reviewModel`.
- Assessment routing: `assessmentAdapter`/`assessmentModel` with
  `assessmentEscalationModel`.
- Triage routing: `triageAdapter`/`triageModel` with `triageEscalationModel`.

The default routing separates execution from judgement. Build-side stages
default to Codex: worktree creation, implementation, fix rounds, and
integration use the build adapter/model defaults. Planning and review
judgement default to Claude Code with `claude-opus-4-8`: the plan stage uses
`planAdapter`/`planModel`, while design review, code review, expert review,
addendum fallback review, and audit use `reviewAdapter`/`reviewModel`.

Model spend is right-sized to each task's cognitive load, not left at the
Opus/high defaults:

- The write-preflight probe writes one exact token to one exact path, so it
  keeps the plan/build ADAPTER but runs at `writeProbeEffort` (`minimal` by
  default) and never inherits `planModel`/`buildModel`; set
  `writeProbeModelByAdapter` for a cheaper per-adapter probe model.
- Partial-branch assessment is report-only, so a deterministic fast-classifier
  handles the clear cases (empty branch, evidence-collection failure) with zero
  tokens, and only genuinely ambiguous branches reach a model — at
  `assessmentModel` (a medium default, `claude-sonnet-5`, not the review
  model), escalating to `assessmentEscalationModel` only for a strong
  adopt-complete candidate (a branch that committed an ExecPlan).
- Remediation triage is mostly de-duplication plus hypothesis routing, so a
  deterministic pre-pass collapses exact-duplicate proposals and the routing
  agent runs at `triageModel` (a medium default, `gpt-5.5`), escalating to
  `triageEscalationModel` (`gpt-5.5@high`) only when the proposals span
  multiple audit/review sources (potential cross-phase or conflicting routing).

A sidecar that wants a different assessment or triage route must say so in
`args.json`.

Auth preflight is adapter-aware. The workflow always checks Codex auth because
build-side stages depend on it, checks CodeRabbit auth when implementation can
run, and checks Claude auth whenever any configured stage uses the `claude`
adapter. Auth failures are terminal workflow failures rather than ordinary
task failures or partial-branch recovery candidates.

ODW adapter timeout is also part of the runtime contract. With the default
host-run CodeRabbit review, agents never wait on CodeRabbit — the host
absorbs rate-limit backoff in its own wall-clock — and with the default
per-work-item build each builder turn covers one work item, so adapter
timeouts only need to cover honest stage work: roughly 3600 seconds for the
build adapter and 4500–5400 seconds for planning and review judgement. Only
the legacy `coderabbitHostReview=false` flow asks implementation agents to
wait through rate-limit backoff with `vsleep` (three retries of up to 90
minutes each), and only then does the timeout need to reach 21600 seconds.

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
