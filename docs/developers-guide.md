# df12-build developers guide

This guide is for contributors changing `df12-build` workflow assets or
documentation. It complements the user-facing launch instructions in
`docs/users-guide.md` and the operator runbook in the `df12-build-supervisor`
skill.

## Normative references

Read these before changing launch or workflow behaviour:

- `docs/architecture.md` for the repository, target-project, and sidecar state
  boundaries.
- `docs/security-and-permissions.md` for runtime permissions, external service
  access, prompt-injection risk, and sandbox recommendations.
- `docs/adr-001-adopt-odw-sidecar-launches.md` for the accepted sidecar launch
  decision.
- `docs/adr-002-assess-partial-task-branches.md` for the accepted partial
  branch assessment and adoption model.
- `docs/users-guide.md` for the public launch flow and configuration surface.
- `skills/df12-build-supervisor/SKILL.md` for the detailed operator playbook.
- `workflows/df12-build-odw.js` for the ODW/Codex workflow implementation.
- `workflows/df12-build.js` for the baseline roadmap workflow that the ODW
  variant was derived from.

## Repository shape

The repository contains workflow scripts, skill documentation, docs, operator
scripts, focused test suites, a project roadmap with ExecPlans, and a small
validation `Makefile`. It does not contain a package manifest.

Relevant paths:

- `workflows/df12-build-odw.js`: ODW/Codex workflow.
- `workflows/df12-build.js`: baseline workflow.
- `skills/df12-build-supervisor/SKILL.md`: operator skill.
- `scripts/blinkentrees`, `scripts/git-commit-feed`, `scripts/odw-list-runs`,
  and `scripts/odw-watch`: operator monitoring scripts (documented in the user
  guide's "Monitoring runs" section).
- `tests/`: Node suites for the ODW workflow plus
  `tests/run-odw-script-tests.py` for the operator scripts.
- `docs/roadmap.md`: this repository's own GIST roadmap.
- `docs/execplans/`: ExecPlans for landed roadmap work.
- `docs/failure-resume-design.md`: the failure-resume design the recovery
  phases implement.
- `docs/users-guide.md`: user-facing launch guide.
- `docs/security-and-permissions.md`: runtime permissions and sandbox guide.
- `docs/developers-guide.md`: contributor-facing maintenance guide.
- `docs/architecture.md`: design-level sidecar and workflow contract.
- `docs/adr-001-adopt-odw-sidecar-launches.md`: accepted launch decision.
- `docs/adr-002-assess-partial-task-branches.md`: accepted recovery assessment
  decision.

Tick the matching roadmap task and update the relevant ExecPlan whenever a
branch lands planned work.

## ODW workflow contract

`workflows/df12-build-odw.js` is an ODW script, not a conventional Node module.
Keep the ODW script contract intact:

- Keep `meta` as a literal `export const meta = { ... }` object.
- Do not import ODW primitives. `args`, `agent`, `parallel`, `phase`, `log`,
  and `budget` are injected by ODW.
- Use schemas where JavaScript consumes agent output as structured data.
- Keep phase and label names explicit enough to make the dashboard useful.
- Keep target-project mutation inside agent prompts and real git worktrees;
  ODW copy isolation is not a persistent handoff mechanism for this workflow.
- Serialize operations that advance `origin/<base>` through the merge lock.
- Keep partial-branch assessment report-only. Assessment helpers may gather
  deterministic git evidence in the ODW host script, but classification output
  must not directly merge, push, cherry-pick, mark roadmap checkboxes, or alter
  `processed`.
- Skip assessment for auth failures, dry runs, successful tasks,
  manual-merge-ready branches, and failures before worktree creation.
- Keep fresh-run recovery fail-closed. Assess mode must stay non-mutating (the
  no-mutation regression suite pins this), review-mode resume may only land
  through `runDualReviewAndIntegration` and the merge lock, and eligibility
  must be decided by host JavaScript over host-collected evidence — never by
  agent prose alone.
- Keep the task-agent write preflight host-verified: the probe outcome is the
  bytes on disk, not the agent's claimed `ok`.
- Contain agent-supplied paths before host filesystem or git access.
  `execplanRelPath` rejects absolute paths outside the worktree and `../`
  escapes and returns `{ ok, relPath, detail }`; every host read or write of
  an ExecPlan must go through it and fail the task closed on escape. Planner
  output is untrusted, prompt-injectable data.
- Keep host I/O helpers honest about faults. `fileState` and
  `readExecplanState` treat only `ENOENT`/`ENOTDIR` as "absent"; any other
  stat or read error surfaces as `{ ok: false, detail }` or ExecPlan status
  `unreadable`, and the continue/recovery boundary reports it
  (`plan-unreadable`, `execplan-stat-error`) instead of dispatching over
  durable work.

Changes to workflow behaviour must update all relevant prompts, schemas, docs,
and validation notes in the same branch.

## Recovery, fault, and result contract

Fresh-run recovery has three `resumeMode` levels. `assess` is report-only.
`review` may route a clean, evidenced `adopt-complete` branch back into
`runDualReviewAndIntegration`. `continue` skips judgement agents entirely:
`recoveryContinueDecision` dispatches on host git evidence plus the committed
ExecPlan `Status:` line (`DRAFT`/missing to plan, `APPROVED`/`IN PROGRESS` to
implement, `COMPLETE` to review, `BLOCKED` and every hygiene failure to a
report). The committed ExecPlan is the durable source of truth, and the host
enforces that durability at stage boundaries (`verifyExecplanCommitted`,
`verifyWorktreeCommitted`, `commitExecplanApproval`). A plan-only dirty
worktree after a planner round is salvaged host-side (`commitExecplanDraft`
commits just the plan path) instead of bouncing; any other dirty path still
bounces to the planner with the salvage-refusal evidence.

Failure classification is layered: `authFailureDetail` (fatal-auth), then
`providerFailureDetail` (provider-fault), then `infrastructureFailureDetail`
(infra-fault, pinned to ODW's own adapter-timeout / exit-code / schema-retry
error strings), and only then ordinary `failed`. Infra faults are agent-process
deaths carrying no branch evidence: `withInfraRetry` re-runs the stage agent up
to `stageAttempts` total attempts (default 2), and a persistent fault
terminates as `infra-fault` with no assessment agent and no remediation triage
writes. Never wrap the integration agent in `withInfraRetry` — its push to
`origin/<base>` is not idempotent, and a source-invariant test pins both call
sites as unwrapped.

The run result exposes the contract for operators and tests: `commitGates`
(the effective deterministic gate list; agents must never assume `make all`
aggregates a project's gates), `stageAttempts`, bounded-cardinality
`faultMetrics` (`infraRetries`, `infraFaults`, `providerFaults`,
`authFaults` — fixed keys only, never keyed by task id or error text),
`recovery.unresolved`, and the `needs-operator-recovery` terminal `halted`
state when survivor branches still block the roadmap frontier. See
`docs/failure-resume-design.md` for the full design and
`docs/users-guide.md` for the operator-facing description.

Adapter and model routing are part of the workflow contract. The ODW workflow
currently uses Codex defaults for build-side work, and Claude Code with
`claude-opus-4-8` for planning and review judgement. `planAgentOptions` covers
the plan stage. `reviewAgentOptions` covers design review, code review, expert
review, addendum fallback review, and audit. Because partial-branch assessment
defaults to the review adapter, keep `assessmentAdapter` explicit in examples
or operator notes when that stage must remain on Codex.

## Sidecar tooling contract

ODW/Codex launches use a `.workshop` sidecar outside the target project's Git
worktree. The sidecar must hold the copied workflow script, `odw.config.json`,
`args.json`, and `operator-notes.md`.

Contributor rules:

- Do not document `.claude/`, `/tmp`, the target source tree, or
  `...worktrees/roadmap-*` as durable launch locations.
- Treat `origin/<base>` in the target project as the product source of truth.
- Treat sidecar-local workflow patches as temporary recovery changes until they
  are promoted back to this repository.
- When adding or renaming an argument, update `docs/users-guide.md`,
  `docs/architecture.md`, this guide, and the supervisor skill as needed.
- When changing adapter/model routing, update both the code defaults and the
  configuration examples and routing-contract prose that describe them.

## Documentation maintenance

Keep documentation layers aligned:

- User guide: what an operator runs and which files they maintain.
- Developer guide: how contributors change the workflow and docs safely.
- Architecture: state boundaries, workflow structure, configuration contract,
  enforcement boundary, configuration contract, and verification contract.
- Security guide: file, Git, network, and GitHub permissions; external
  services; prompt-injection surface; and sandbox profiles.
- ADRs: accepted decisions and alternatives for durable architectural choices.
- Supervisor skill: detailed runbook procedures, failure diagnosis, and
  cleanup guidance.

Use en-GB Oxford spelling in prose and commit messages. Prefer `artefact`,
`behaviour`, `configuration`, and `synchronized` spelling where those words
appear in documentation.

## Validation

Run the repo-wide validation targets before committing workflow or
documentation changes:

```bash
make all
```

Run focused assessment tests while changing partial-branch recovery:

```bash
node --test tests/df12-build-odw-assessment.test.mjs
```

Run the recovery suites while changing fresh-run recovery, the resume decision
table, or the write preflight. The combination suite executes the whole
control loop in a subprocess against fixture repositories, and the smoke suite
drives the real `odw` runtime with deterministic mock adapters (it skips when
`odw` is not installed):

```bash
node --test tests/df12-build-odw-recovery.test.mjs
node --test tests/df12-build-odw-write-preflight.test.mjs
node --test tests/df12-build-odw-recovery-combinations.test.mjs
node --test tests/df12-build-odw-recovery-smoke.test.mjs
```

The operator scripts have their own behavioural suite (run by `make test`
via `uv`):

```bash
uv run tests/run-odw-script-tests.py
```

The `typecheck` target runs an ODW-style wrapper parse check for both workflow
files. This validates host-authored workflow syntax without spawning agents:

```bash
make typecheck
```

Do not use a live `odw run` as a routine gate. Run it only when the task
explicitly asks for execution or smoke testing, because it can spawn agents and
mutate target-project state.
