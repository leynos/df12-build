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
- `docs/odw-compilation-and-compile-time-testing.md` for how the ODW artefact
  is compiled from the module tree and how compile-time behaviour is tested.
- `skills/df12-build-supervisor/SKILL.md` for the detailed operator playbook.
- `workflows/df12-build-odw.js` for the ODW/Codex workflow implementation.
- `workflows/df12-build.js` for the baseline roadmap workflow that the ODW
  variant was derived from.

## Repository shape

The repository contains workflow scripts, skill documentation, docs, operator
scripts, focused test suites, a project roadmap with ExecPlans, and a small
validation `Makefile`. Development dependencies (esbuild, fast-check,
bun-test-cucumber, LemmaScript, TypeScript, and Bun's type definitions) are
managed with `bun` via `package.json`.

Relevant paths:

- `src/workflows/df12-build-odw/`: source of truth for the ODW workflow — a
  literal `meta.js` banner (plain JavaScript, concatenated verbatim), the
  typed `main.ts` entry (configuration unpacking, factory bindings, and the
  worker-pool control loop), and one TypeScript module per subsystem:
  `config.ts`, `schemas.ts`, `types.ts`, `roadmap.ts`, `exec.ts`,
  `faults.ts`, `git-evidence.ts`, `recovery-decision.ts`,
  `recovery-discovery.ts`, `prompts.ts`, `write-preflight.ts`,
  `execplan-durability.ts`, `assessment.ts`, `remediation.ts`,
  `host-review.ts` (host-run CodeRabbit NDJSON parsing/classification and
  the host commit gates), and `run-task.ts`, with the injected ODW
  primitives declared in
  `odw-globals.d.ts`. TypeScript is restricted to erasable syntax by
  compiler flags (`erasableSyntaxOnly`, `verbatimModuleSyntax`).
- `workflows/df12-build-odw.js`: GENERATED ODW/Codex workflow artefact, built
  by `make workflow-build` (see `scripts/build-workflow.mjs`); this is the
  single file the sidecar copies and ODW loads.
- `verify/recovery-decision.model.ts`: LemmaScript-annotated verified twin of
  the recovery decision tables, checked into Dafny by `make verify-modules`,
  with its generated `.dfy.gen`/`.dfy` proof files alongside.
- `workflows/df12-build.js`: baseline workflow.
- `skills/df12-build-supervisor/SKILL.md`: operator skill.
- `scripts/blinkentrees`, `scripts/git-commit-feed`, `scripts/odw-list-runs`,
  and `scripts/odw-watch`: operator monitoring scripts (documented in the user
  guide's "Monitoring runs" section).
- `tests/`: Node suites for the ODW workflow plus
  `tests/run-odw-script-tests.py` for the operator scripts.
- `tests/modules/`: bun-run suites for the individual src modules — Gherkin
  features (bun-test-cucumber), fast-check properties, and the differential
  test pinning the verified twin to production.
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

`workflows/df12-build-odw.js` is an ODW script, not a conventional Node
module, and it is generated: edit `src/workflows/df12-build-odw/` and run
`make workflow-build` (the `workflow-freshness` gate fails a stale artefact).
The build frames the artefact from a verbatim `meta.js` banner, a flat
esbuild bundle of `main.ts` and its imports, and a generated
`return await workflowMain()` footer, and it fails closed on anything the
ODW loader would reject. Within the src tree, keep the ODW script contract
intact:

- Keep `meta` as a literal `export const meta = { ... }` object.
- Do not import ODW primitives. `args`, `agent`, `parallel`, `phase`, `log`,
  and `budget` are injected by ODW.
- Use schemas where JavaScript consumes agent output as structured data.
- Keep phase and label names explicit enough to make the dashboard useful.
- Keep target-project mutation inside agent prompts and real git worktrees;
  ODW copy isolation is not a persistent handoff mechanism for this workflow.
- Serialize operations that advance `origin/<base>` through the merge lock.
- Build every agent-created inspection worktree (post-integration audit,
  remediation triage) through the shared `worktreeSafetyNet(base)` helper
  exported from `prompts.ts`. It carries the verified fetch → base-arg →
  reset → re-verify sequence: fetch `origin/<base>`, create the worktree with
  `git donkey <slug> <base>` — the configured base MUST be passed because git
  donkey's no-argument default is always `main`
  (`git_donkey.donkey.choose_base_branch` returns `"main"` for a null origin
  arg), which would root a non-`main` base on the wrong tree or fail when the
  repo has no `main` — then `git reset --hard origin/<base>` inside the new
  worktree and re-verify the base sha. Audit and triage share this one helper
  so their worktree discipline cannot drift.
- Keep partial-branch assessment report-only. Assessment helpers may gather
  deterministic git evidence in the ODW host script, but classification output
  must not directly merge, push, cherry-pick, mark roadmap checkboxes, or alter
  `processed`.
- Skip assessment for auth failures, dry runs, successful tasks,
  manual-merge-ready branches, and failures before worktree creation.
- Keep the dry-run short-circuit as the first control-flow statement after
  the task-log line in `runTask`. The guard is the first control-flow
  statement after the task-log line — before `createWorktree` and the
  writable-root/write-access preflight — and returns a terminal
  `{ status: 'dry-run', stage: 'pre-worktree' }` result, so no branch,
  worktree, or probe write is created. It covers both the normal and addendum
  lanes, preceding the `task.isAddendum` split; the earlier addendum-specific
  and post-design dry-run exits were removed because this single
  head-of-function guard makes them unreachable. Recovery/continue-mode resume
  keeps its own separate dry-run handling over pre-existing worktrees. The
  guard must remain the first control-flow statement after the task-log line
  to preserve the no-mutation guarantee. This boundary is documented
  consistently in `docs/architecture.md`'s `## Enforcement boundary` table
  (the "Dry run" row) and `docs/users-guide.md`'s `## Workflow arguments`
  section (`dryRun`).
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
- Satisfy the integration completeness gate. Both normal and addendum lanes
  share `integrationIncomplete()`, which requires `ok`, `rebased`,
  `squashMerged`, `pushed`, and `roadmapMarkedDone` to all be truthy in the
  `INTEGRATE_SCHEMA` result; any falsy field halts the task at
  `stage: integrate`. `rebased` is mandatory so a squash-merged, pushed
  branch that was never rebased onto BASE cannot be treated as integrated.

Changes to workflow behaviour must update all relevant prompts, schemas, docs,
and validation notes in the same branch.

## Submodule architecture and composition

`workflows/df12-build-odw.js` is compiled from the module tree under
`src/workflows/df12-build-odw/` by `scripts/build-workflow.mjs`. The compiler
frames the artefact from a verbatim `meta.js` banner, a flat esbuild bundle of
`main.ts` and its imports, and a generated `return await workflowMain()` footer,
then fails closed on every loader-contract hazard it can detect. The
[compilation monograph](odw-compilation-and-compile-time-testing.md) is the
reference for *why* the mechanism is shaped this way; this section is the set of
rules a contributor must keep when editing the tree.

- **`meta.js` stays plain JavaScript, forever.** It is concatenated verbatim
  (never parsed by the bundler) so the `export const meta` literal reaches the
  artefact byte-for-byte. It must contain exactly one literal
  `export const meta`; do not convert it to TypeScript or compute the metadata.
- **`main.ts` is the entry.** It unpacks the run configuration once, binds each
  subsystem factory (`makeConfig`, `makeTaskPipeline`, `makeHostReview`,
  `makeRecoveryDiscovery`, `makePrompts`, `makeAssessment`, `makeRemediation`, …)
  exactly once, and runs the worker-pool control loop.
- **Compose through `makeX(deps)` factories.** Configuration flows one way, from
  `main.ts` into the factories. This keeps each module's public surface small,
  keeps the top-level namespace collision-free, and preserves the call-site
  shapes the source-invariant tests pin.
- **Share cross-module prompt authorities by injection, not import.** Some
  modules stay deliberately import-free so the bundle graph stays flat and
  acyclic; `remediation.ts` is one. When such a module needs a helper that lives
  elsewhere, `main.ts` threads it in through the factory's `deps` rather than the
  module importing it. The audit and triage prompts share one worktree-creation
  authority this way: `prompts.ts` exports `worktreeSafetyNet`, `auditPrompt`
  calls it directly, and `main.ts` passes the same function into
  `makeRemediation` as `RemediationDeps.worktreeSafetyNet` (mirroring how
  `preamble` is injected) so `triagePrompt` reuses it verbatim. One authority,
  two call sites, no drift — and `remediation.ts` keeps its import-free
  invariant.
- **No two modules may export the same top-level name.** esbuild renames a
  colliding top-level symbol (`foo` → `foo2`), which silently rewires a flat
  artefact — the build's rename-survival check fails closed on it. Use unique
  helper names and the factory surface.
- **A new module only ships once `main.ts` imports from it.** If nothing in the
  import graph reaches it, its exported names never enter the bundle and the
  rename-survival check fails, rather than shipping an artefact that omits the
  new code. Author-and-wire in the same change.
- **Keep the tree acyclic ESM.** An import cycle or CommonJS makes esbuild emit
  a module-closure wrapper (`__esm(`, `__commonJS(`, …), which the build rejects.
- **TypeScript restricted to erasable syntax.** `tsconfig.json` sets
  `erasableSyntaxOnly` (no enums, parameter properties, or runtime namespaces),
  `verbatimModuleSyntax`, and `isolatedModules`; `make typecheck` enforces them.
  Because esbuild does not resolve `.js` to `.ts`, **relative imports carry the
  explicit `.ts` extension** (`from './config.ts'`). The injected ODW primitives
  are declared ambiently in `odw-globals.d.ts` and never imported.
- **The artefact is generated and committed.** Edit the source and run
  `make workflow-build`; never hand-edit `workflows/df12-build-odw.js`. The
  `workflow-freshness` gate fails a stale artefact.
- **Source-invariant tests read the source, not the artefact.** esbuild
  normalizes quotes and strips comments, so pin invariants against the `src`
  tree via `readWorkflowSource()` / `readModuleSource()`
  (`tests/support/workflow-source.mjs`); scope to one module when an ordered
  match must not span module boundaries.

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

Artefact salvage for failing branches is handled by two layers.
`salvageTaskArtefacts` (`execplan-durability.ts`) is the primitive: it accepts
a list of candidate paths, filters to those matching `TASK_ARTEFACT_PATTERN`
(`docs/execplans/*.md`), re-checks that convention on the NORMALIZED path (so
`docs/execplans/../../README.md` is rejected after normalization), containment-
checks via `execplanRelPath` (rejects `../` escapes and absolute paths outside
the worktree), and lstat-probes via `fileState` so a symlink at the path is
never followed. Only the verified paths are committed onto the branch under a
deterministic machine identity (`df12-build`). Every git failure or ineligible
state is recorded as a reason on the returned `SalvageOutcome`
(`{ committed, skipped, sha, detail }`) rather than raised; the assessment
wrappers below additionally run the call inside a catch that records any
unexpected throw as `salvage errored`, so a failing task is never turned into a
run-halting error. `sha` is the salvage
commit SHA; it is `''` when nothing was committed OR when the post-commit HEAD
read failed (in which case `detail` explains the `rev-parse` failure).
`salvageAssessmentArtefacts` and `salvageInfraFaultArtefacts` (`assessment.ts`)
wire this primitive into the assessment path: the former runs for `continue-
manual` or `adopt-partial` model verdicts, using the branch's dirty and staged
changes from host evidence as candidates; the latter runs for `infra-fault`
results (schema-retry exhaustion, adapter death) where no model assessment is
spawned. Both record the outcome on `result.salvage`
(`{ classification, committed, skipped, sha, detail }`) and surface it in the
top-level `salvages` array. Salvage never runs for `adopt-complete` or `discard`
(those leave `result.salvage` unset), and it skips when collection-error
evidence is untrustworthy or when no worktree path is present in the assessment
evidence. Both wrappers are part of the assessment stage, so neither salvages
when partial-branch assessment is disabled (`assessPartialBranches=false`):
`salvageInfraFaultArtefacts` early-returns the result unchanged when
`assessPartialBranches` is false (or the result has no task branch), and
`salvageAssessmentArtefacts` is only reached after the model assessment, which
does not run when the stage is disabled — so neither path attempts salvage.

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

Recovery assessment carries two distinct evidence channels, typed by
`RecoveryAssessmentFields` in `recovery-decision.ts`: blocking
`missingEvidence` and advisory `residualRisk` (read via the
`advisoryResidualRisk` helper). `recoveryResumeEligibility` decides resume
eligibility on `missingEvidence` alone and never consults `residualRisk`;
the advisory risk is instead carried forward into the resumed code-review,
expert-review, and integration prompts as a non-blocking section.

Host-run CodeRabbit review (`coderabbitHostReview`, default on) moves the
CLI invocation from agent prompts to the control loop: `coderabbit review
--agent --type committed --base <base>` (a FIXED host invocation; the
`coderabbitReviewCommand` knob applies only to the legacy agent-run mode and
does NOT override it) runs BETWEEN each per-work-item build turn
(`coderabbitBetweenWorkItems`, default on) as a deterministic gate on each
committed work item, and again per dual-review round and per addendum.

The review stage spends by a strict cost hierarchy — deterministic gates are
free, CodeRabbit is a fixed weekly quota, and the reviewer agents (code
review and expert review) spend the scarcest resource, tokens. So each
dual-review round runs cheapest-first: host gates, then CodeRabbit, then the
reviewer agents, and short-circuits to a fix round as soon as a cheaper stage
blocks. A red gate or a CodeRabbit blocking finding drives a fix WITHOUT
dispatching the reviewer agents that round; the agents run only once the gates
and CodeRabbit are clean (a CodeRabbit deferral falls through to them, since
they remain the decisive review). The workflow deliberately trades wall-clock
(re-running gates, CodeRabbit and its backoff) for tokens, which do not
replenish.

Its NDJSON events are parsed host-side (the CLI exits 0 even on fatal errors, so
classification must read events, never exit codes — see
`docs/coderabbit-wire-contract.md` for captured live sessions documenting
every observed event shape and the success-status set), `critical`/`major`
findings drive a bounded fix loop, and rate-limit backoff sleeps in host
wall-clock with deterministic jitter (`Math.random()`, `Date.now()`, and
arg-less `new Date()` are banned by ODW's `scanDualCompat` for Claude Code
dual-compatibility — hash a seed instead, and shell out to `date` for
timestamps). The between-item gate fails closed: unresolved blocking findings
fail the work item (`code-review`), and a terminal deferral (rate limit or
CLI fault after the retries) HALTS the task for assessment rather than
silently continuing — so "between each stage" is a real gate, not a label.
Test loaders and the simulation driver force `coderabbitHostReview: false` so
fixture runs can never invoke the real CLI and burn review quota; the
pipeline seam is covered by a fake NDJSON-emitting `coderabbit` on `PATH`,
and the between-item gate by an injected `runCoderabbitHostReview`.

Every fix round — gate fix, dual-review fix, and between-item fix — is
followed by `verifyWorktreeCommitted`; a fix that leaves the worktree dirty
fails the task closed (`FIX DURABILITY`) because uncommitted fix output is
unreviewable and lost at the squash merge.

Host-run commit gates (`hostCommitGates`, default on) apply the same
philosophy to gate greenness: `runHostCommitGates` executes the configured
`commitGates` commands via `sh -c` in the task worktree, serialized pool-wide
behind `hostGateLock` (width 1, for build-cache friendliness), with a
per-command timeout (`commitGateTimeoutSeconds`) and output streamed to logs
in a secure per-run directory (`mkdtempSync`, mode `0700`, e.g.
`/tmp/df12-gates-XXXXXX/gate-<task>-<round>-N.out`) — an unpredictable name
plus an `O_EXCL|O_NOFOLLOW`, mode-`0600` open, so a local symlink cannot
clobber or leak the logs, and the raw gate command is kept out of the
filename. Gates run via `spawn`, streaming stdout/stderr to
the log as they run (evidence is visible during a long gate, and there is no
`maxBuffer` ceiling for a noisy `make all` to trip) while a bounded
ring-buffer keeps the last lines for the structured `detail` tail; the
timeout fires `SIGTERM` and escalates to `SIGKILL`. In the dual-review loop
the gates run FIRST each round — a red branch goes to a fix round with the
host evidence without spending reviewer agents; in the addendum lane an
unreproducible green claim fails the addendum before any review. With
`hostGatesBetweenWorkItems` on (the default), the gates ALSO re-run after each
committed work item during the per-work-item build, BEFORE the between-item
CodeRabbit review, so a committed work item whose gates are really red is
caught at the item boundary (bounded fix loop, then fail-closed) rather than
only at the dual-review stage — closing the window where an intermediate red
commit could persist across work items on the agent's `gatesGreen` claim
alone.

`runCodeSceneCheck` (`csCheck`, default on) is a SECOND deterministic gate,
run after the commit gates and before CodeRabbit at every gate point (each
work item, each dual-review round, and the addendum lane). It runs
`csCheckCommand` (default `cs-check-changed`, an operator-provided wrapper)
through the same secure-log spawn path as the commit gates, on the committed
changed files. A code-health regression short-circuits to a fix round — free
gates before the quota-limited CodeRabbit and the token-spending reviewer
agents — and the build/fix prompts carry the smell glossary plus the
`@codescene(disable:"...")` suppression escape hatch (`CS_CHECK_GUIDANCE`).
Like `make verify-modules` without Dafny, it skips gracefully (clean, not
failed) when the binary is absent. Test loaders
and the simulation driver force `hostCommitGates: false` (fixture repos have
no `Makefile`); pipeline coverage uses a scripted fake gate command, and the
streaming path is covered by a module test with output past the old buffer
ceiling.

`make verify-modules` skips when Dafny is absent, so local runs stay friendly;
CI must run `make verify-modules-strict`, which FAILS when Dafny is not on
`PATH`, so the LemmaScript/Dafny proof is a real PR gate rather than
advisory. The CI job installs Dafny (see the toolchain notes).

The per-work-item build loop (`perWorkItemBuild`, default on) makes the
committed ExecPlan's `## Progress` checklist the build's control surface:
`parseExecplanState` returns the checklist as `items[]`, the planner prompt
pins the `- [ ] WI-<n>: <title>` convention, and `runWorkItemBuildLoop`
dispatches one `implement:<id> wi<n>` builder turn per unticked item,
verifying `verifyWorktreeCommitted` plus committed checklist movement after
every turn (one bounce with the defect named, two consecutive no-progress
turns fail closed; `maxWorkItemRounds` bounds the loop). A plan with no
checklist returns `null` from the loop and the stage falls back to the
single-turn `implementPrompt` build. Test loaders and the simulation driver
force `perWorkItemBuild: false` because scripted implement agents do not
tick Progress items; loop coverage uses fixture plans with real ticks.

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

Assessment and triage are model-tiered rather than pinned to `REVIEW_MODEL`
because most of their work is cheap. `ASSESSMENT_MODEL` has its own medium
default (`claude-sonnet-5`, not the review model): a deterministic
fast-classifier resolves the clear cases with zero tokens, and only a genuine
adopt candidate escalates to `ASSESSMENT_ESCALATION_MODEL` (defaulting to
`REVIEW_MODEL`). `TRIAGE_MODEL` likewise runs at a medium default after a
deterministic dedup pre-pass, escalating to `TRIAGE_ESCALATION_MODEL` only when
the deduped proposals span more than one audit/review source. Each escalation
model is an independent override, so a sidecar can tune the cheap tier and the
escalation tier separately.

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

`make all` reaches `make spelling` through the Markdown gate. The spelling
target refreshes the shared en-GB-oxendict base when newer, regenerates
`typos.toml`, and checks maintained prose with the pinned `typos` release. Put
narrow repository-only exceptions in `typos.local.toml`; never edit the
generated configuration by hand.

Run the module suites (bun) or the whole-workflow suites (node, against a
fresh artefact) separately when iterating:

```bash
make test-modules
make test-workflow
```

`make verify-modules` re-checks the LemmaScript decision-table model with
Dafny; it skips (loudly) when `dafny` is not on `PATH`.

Run focused assessment tests while changing partial-branch recovery (rebuild
the artefact first if the src tree changed):

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

The `docs-check` target (run by `make all`, wrapping `bun run docs:check`) is
the zero-tolerance documentation gate: TypeDoc's `notDocumented` validation
expands the configured `src/workflows/df12-build-odw/` entry point. The
`typedoc.json` configuration excludes declaration files, `meta.js`, and
internal, private and protected reflections. Every included module must open
with a `/** … @module */` block and every included exported declaration must
carry a JSDoc block; validation warnings are errors, the run emits no
documentation artefacts, and a failure prints the qualified name and location
of each undocumented declaration. JSON Schema constants are tagged `@internal`
(their `description` fields are the per-field documentation), so TypeDoc does
not recurse into the schema literals:

```bash
make docs-check
```

Do not use a live `odw run` as a routine gate. Run it only when the task
explicitly asks for execution or smoke testing, because it can spawn agents and
mutate target-project state.
