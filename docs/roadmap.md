# df12-build roadmap

This roadmap translates `docs/failure-resume-design.md` and ADR 002 into a
short delivery sequence for failure resume in the ODW workflow. It does not
promise dates. Each phase carries one GIST idea, each step answers a delivery
question, and each task is intended to be review-sized.

The scope is intentionally narrow: discover surviving branches, report
assessments on fresh launch, allow explicit review-mode resume for clean
`adopt-complete` branches, and then add an explicit accepted-plan reuse path
for open tasks whose durable ExecPlan has already passed design review.
Automatic partial adoption stays deferred.

## 1. Fresh-run recovery discovery

Idea: if the workflow can find surviving task branches from durable Git state
before normal roadmap selection, operators can recover useful work without old
agent transcripts or manual branch archaeology.

This phase delivers assess-only recovery. It should not merge, push, delete, or
mark roadmap items complete.

### 1.1. Settle the recovery controls

This step answers which operator knobs are needed before discovery can run
safely. It informs every later task because recovery defaults must remain
non-mutating.

- [x] 1.1.1. Add `resumePartialBranches`, `resumeMode`, `resumeTaskId`, and
  `resumeMaxCandidates` configuration to the ODW workflow.
  - See `docs/failure-resume-design.md` section "Runtime configuration".
  - Success: default workflow behaviour is unchanged unless
    `resumePartialBranches=true`.
- [x] 1.1.2. Document the recovery arguments in the user guide, architecture
  guide, security guide, developer guide, and supervisor skill.
  - Requires 1.1.1.
  - See `docs/failure-resume-design.md` sections "Runtime configuration" and
    "Security and permissions".
  - Success: operators can distinguish assess-only recovery from review-mode
    resume before launching a run.
- [x] 1.1.3. Enforce writable task-agent roots for real git worktrees.
  - Requires 1.1.1.
  - See `docs/architecture.md` sections "Workflow structure" and "Enforcement
    boundary".
  - Ensure planning, review, implementation, fix, addendum, and integration
    agents can read and write the assigned `roadmap-*` worktree rather than
    only the control checkout.
  - Success: a planner can create `docs/execplans/<branch-leaf>.md` in a
    sibling task worktree, and design review reads that same on-disk artefact
    before judging the plan.

### 1.2. Discover candidates without mutating the target project

This step answers whether the workflow can reconstruct useful recovery
candidates from Git and roadmap state alone. Its output feeds assessment and
later review-mode resume.

- [x] 1.2.1. Implement candidate discovery for `roadmap-*` branches and live
  worktrees.
  - Requires 1.1.1.
  - See `docs/failure-resume-design.md` section "Recovery candidate discovery".
  - Success: fixture tests map branch names to dotted roadmap ids, skip
    completed roadmap tasks, and preserve deterministic ordering.
- [x] 1.2.2. Return a top-level `recovery` summary in assess-only mode.
  - Requires 1.2.1.
  - See `docs/failure-resume-design.md` section "Returned result shape".
  - Success: an assess-only run reports candidates, skipped branches, and
    assessment outcomes without changing `processed`.

### 1.3. Reuse ADR 002 assessment for recovered candidates

This step answers whether fresh-run discovery can share the existing
assessment contract instead of creating a second recovery classifier.

- [x] 1.3.1. Route discovered candidates through the existing assessment
  evidence collector and schema.
  - Requires 1.2.1.
  - See `docs/failure-resume-design.md` section "Assessment reuse" and
    `docs/adr-002-assess-partial-task-branches.md`.
  - Note: the assessment feature now also salvages task-scoped
    `docs/execplans/*.md` artefacts for `continue-manual` and `adopt-partial`
    classifications, and for infra-fault handoffs (schema-retry exhaustion)
    (PR #57); see the salvage section of
    `docs/developers-guide.md`.
  - Success: recovered candidates produce the same classification enum and
    evidence fields as in-run failed task assessments.
- [x] 1.3.2. Add no-mutation regression coverage for assess-only recovery.
  - Requires 1.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: tests prove assess-only recovery does not mark roadmap tasks,
    push, merge, delete branches, or add ids to `processed`.

## 2. Explicit review-mode resume

Idea: if clean `adopt-complete` branches can re-enter the existing review and
integration path, the workflow can finish work that survived a system failure
without weakening gates or branch protection.

This phase adds one mutating recovery path. It must remain opt-in and use the
existing review and integration machinery.

### 2.1. Gate resume eligibility before review

This step answers which recovered branches are safe enough to spend review and
integration effort on. Its output prevents dirty or ambiguous branches from
being treated as complete work.

- [x] 2.1.1. Implement the recovery decision table for `resumeMode`.
  - Requires phase 1.
  - See `docs/failure-resume-design.md` section "Resume decisions".
  - Success: only clean, committed, task-scoped `adopt-complete` candidates
    with validation evidence can enter review-mode resume.
- [x] 2.1.2. Return explicit skip reasons for candidates that cannot enter
  review-mode resume.
  - Requires 2.1.1.
  - See `docs/failure-resume-design.md` sections "Returned result shape" and
    "Failure modes".
  - Success: operators can tell whether a candidate was skipped for dirt,
    missing validation, completed roadmap state, auth failure, or ambiguity.

### 2.2. Re-enter the existing review and integration path

This step answers whether resume can finish a recovered branch without a custom
merge path. Reuse is the safety property: the same gates should apply to
ordinary and recovered work.

- [x] 2.2.1. Build a synthetic implementation result for eligible recovered
  branches.
  - Requires 2.1.1.
  - See `docs/failure-resume-design.md` section "Review-mode resume path".
  - Success: recovered branches can enter review without re-running the
    implementation agent.
- [x] 2.2.2. Route eligible recovered branches through existing review,
  CodeRabbit, expert review, and integration logic.
  - Requires 2.2.1.
  - See `docs/failure-resume-design.md` sections "Review-mode resume path" and
    "Security and permissions".
  - Success: a recovered branch lands only through the existing merge lock and
    roadmap update path.

### 2.3. Prove the end-to-end recovery combinations

This step answers whether the recovery controls interact safely with ordinary
workflow modes. It covers the small combination surface that matters for v1.

- [x] 2.3.1. Add fixture-driven combination tests for recovery modes.
  - Requires 2.2.2.
  - Cover `resumePartialBranches=false`, assess-only, review-mode clean
    `adopt-complete`, dirty branch, completed roadmap task, and auth preflight
    failure.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: the same fixture suite proves both non-mutating assess-only and
    opt-in review-mode behaviour.
- [x] 2.3.2. Run a bounded operator-approved ODW smoke test against a throwaway
  target repository.
  - Requires 2.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: `resumeMode="assess"` reports an existing branch, and
    `resumeMode="review"` attempts only the eligible branch.

## 3. Accepted ExecPlan reuse for unbuilt tasks

Idea: if the workflow can recognize a durable, fresh, accepted ExecPlan for an
open roadmap task, it can avoid repeating planning work while preserving the
same implementation, review, and integration gates.

This phase handles plan-state continuation, not branch-state continuation. It
must sit after normal deterministic selection and fail closed to the ordinary
plan/design loop whenever plan acceptance or freshness cannot be proven.

### 3.1. Define durable accepted-plan evidence

This step answers what evidence is strong enough to skip the planner and design
reviewer. Its output informs the host-side checks and the ExecPlan-writing
contract.

- [ ] 3.1.1. Define the accepted ExecPlan metadata contract.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` section "Accepted ExecPlan reuse".
  - Include the roadmap task id, approval status, approving design-review
    evidence, source roadmap commit, design-input fingerprint, and validation
    commands.
  - Success: a workflow can distinguish a durable accepted plan from a stale
    draft, an uncommitted plan, or a transcript-only approval.
- [ ] 3.1.2. Document the accepted-plan reuse controls.
  - Requires 3.1.1.
  - See `docs/failure-resume-design.md` sections "Runtime configuration" and
    "Accepted ExecPlan reuse".
  - Cover `reuseAcceptedExecPlans`, `acceptedPlanMode`, freshness failure
    behaviour, and the fallback to ordinary planning.
  - Success: operators can run report-only plan verification before allowing a
    build from an accepted plan.

### 3.2. Adopt fresh plans after deterministic selection

This step answers whether the workflow can reuse an accepted plan without
changing roadmap frontier semantics. Selection should remain pure; plan
adoption happens only after an ordinary open task is selected.

- [ ] 3.2.1. Add the post-selection accepted-plan adoption gate.
  - Requires 3.1.1.
  - See `docs/failure-resume-design.md` section "Accepted ExecPlan reuse".
  - Success: the workflow checks the matching ExecPlan for the selected task
    and falls back to the normal plan/design loop when the plan is absent,
    unapproved, stale, or ambiguous.
- [ ] 3.2.2. Route accepted plans into the existing implementation path.
  - Requires 3.2.1.
  - See `docs/failure-resume-design.md` sections "Accepted ExecPlan reuse" and
    "Review-mode resume path".
  - Success: `acceptedPlanMode="build"` can launch implementation from a fresh
    accepted plan while preserving CodeRabbit, expert review, merge-lock,
    roadmap-marking, and audit behaviour.

### 3.3. Prove accepted-plan reuse combinations

This step answers whether the plan-reuse controls interact safely with normal
selection, dry runs, and recovery resume.

- [ ] 3.3.1. Add fixture-driven tests for accepted-plan adoption.
  - Requires 3.2.2.
  - Cover disabled reuse, report-only verification, build-mode adoption,
    missing plan, stale task text, changed design inputs, and uncommitted plan
    files.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: tests prove accepted-plan reuse never changes task selection and
    never skips implementation or review gates.
- [ ] 3.3.2. Run a bounded operator-approved ODW smoke test for plan reuse.
  - Requires 3.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: a throwaway target repository with an accepted plan enters
    implementation in build mode, while a stale plan falls back to planning.

## 4. Deferred recovery extensions

Idea: if the first recovery slice remains boring and operator-controlled, later
automation can be evaluated on product value rather than used to fix v1 safety
gaps.

These tasks are intentionally outside the quick build path.

### 4.1. Evaluate partial adoption after dogfooding

This step keeps `adopt-partial` useful without making it automatic before the
manual path has evidence.

- [ ] 4.1.1. Decide whether `adopt-partial` should create addenda, recovery
  ExecPlans, or manual merge proposals.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` section "Deferred decisions".
  - Success: an ADR records whether any partial adoption path should become
    automatic.

### 4.2. Evaluate cleanup automation separately

This step separates resume from destructive cleanup so operators can trust the
first recovery slice.

- [ ] 4.2.1. Decide whether `discard` branches can be deleted by a managed
  sweeper.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` sections "Failure modes" and
    "Deferred decisions".
  - Success: deletion, stash handling, and branch-retention policy are recorded
    before any automated cleanup lands.

## 5. Workshop observability

Idea: if the workflow host mints a durable identity for every agent dispatch,
and both provider CLIs export their native OpenTelemetry signals to a local
collector that stores them beside a versioned relational projection,
operators can cross-reference workflow nodes and agent telemetry exactly,
even under parallelism, retries, and recovery.

This phase implements ADR 003. Correlation is identity-first: labels,
phases, and timestamps are evidence, never primary join keys. Telemetry is
advisory and must never alter workflow control flow.

### 5.1. Observability contract and telemetry collector

This step answers what identity and schema contract every producer must
share before any instrumentation lands. Its output is the narrow waist that
ODW, df12-build, the providers, and sibling workflows all depend on, so it
must settle before the substrate work starts.

- [ ] 5.1.1. Define the workflow observability contract.
  - See `docs/adr-003-opentelemetry-observability.md` sections "Identity
    model", "Attribute namespaces and span model", and "Cross-workflow
    contract".
  - Cover the identity model (correlation id, workflow invocation id, node
    attempt id, agent invocation and process ids, CLI attempt), the
    three-layer attribute namespace (`gen_ai.*`, `leynos.*`, and
    `df12.*`/`dakar.*`), logical node keys, the span topology, the
    `WorkflowObservabilityContextV1` envelope, correlation headers, binding
    confidence levels, and the metrics cardinality policy.
  - Success: a versioned contract document plus JSON Schemas exist, and
    fixture tests validate conforming and non-conforming envelopes and
    identity keys deterministically.
- [ ] 5.1.2. Implement the `workflow-telemetryd` OTLP receiver over SQLite.
  Requires 5.1.1.
  - See ADR 003 section "Collector and store".
  - Accept OTLP/HTTP JSON on `/v1/traces`, `/v1/logs`, and `/v1/metrics`;
    validate correlation headers against registered invocations; store raw
    `otel_*` records in one transaction per batch; spool to JSONL on write
    rejection; expose health and dropped-record counters.
  - Success: fixture OTLP posts shaped like Claude and Codex exports land in
    the raw tables with their bindings, and a rejected write spools and
    replays without loss.
- [ ] 5.1.3. Add the canonical relational projection. Requires 5.1.2.
  - See ADR 003 section "Collector and store".
  - Create `correlation`, `workflow_invocation`, `workflow_invocation_edge`,
    `workflow_node_attempt`, `agent_invocation`, `agent_process`,
    `telemetry_binding`, and `artifact`, with confidence-tagged bindings and
    canonical `gen_ai.*` field mapping.
  - Success: fixture ingestion yields exact-confidence joins from a node
    attempt through agent invocations to provider spans, sessions, requests,
    and tool calls.

### 5.2. ODW correlation substrate

This step answers whether ODW can generate identity at dispatch and carry it
into agent processes. The work lands upstream in the ODW runtime, so this
step also learns whether the ODW maintenance loop can absorb the contract
without breaking existing workflows.

- [ ] 5.2.1. Extend ODW with dispatch identity and telemetry context.
  Requires 5.1.1.
  - See ADR 003 sections "Identity model" and "Migration plan".
  - Generate agent invocation and process ids and CLI attempt numbers; add
    them to `agent_started`, `agent_finished`, and `agent_failed` events;
    add a per-invocation environment layer to the adapter bridge; inject
    `TRACEPARENT`/`TRACESTATE`; add a host-side `span()` primitive using
    asynchronous context propagation, leaving `phase()` as a presentation
    cursor.
  - Success: an ODW run emits agent events carrying the new identifiers, and
    a probe child process observes the injected per-invocation environment.

### 5.3. Workflow and provider instrumentation

This step answers whether df12-build's stages can be expressed as nodes with
exact agent bindings, using the substrate rather than bespoke wiring.

- [ ] 5.3.1. Instrument df12-build nodes with a `withNode` helper.
  Requires 5.2.1.
  - See ADR 003 section "Migration plan".
  - Wrap selection and recovery decisions, worktree creation and
    writable-root checks, plan and design-review rounds, ExecPlan work
    items, host gates, CodeScene and CodeRabbit, review and fix rounds,
    integration lock wait separately from integration execution, and audit,
    triage, and assessment; write the immutable run manifest at launch;
    express recovery lineage as span links to prior attempts.
  - Success: a dry run produces the expected node-attempt records for each
    stage, with parallel reviewers under one review node.
- [ ] 5.3.2. Wire provider exporters for exact correlation. Requires 5.2.1
  and 5.1.2.
  - See ADR 003 section "Propagation".
  - Claude: enable telemetry and beta traces, direct OTLP to the local
    receiver, inherit trace context, and disable session and account metric
    attributes. Codex: configure OTLP/HTTP JSON exporters with
    per-invocation headers; preserve native trace ids as binding edges.
  - Success: a bounded live smoke run shows Claude spans parented under ODW
    `invoke_agent` spans and Codex records bound by headers at `exact`
    confidence.

### 5.4. Operator query surfaces

This step answers whether the store supports the acceptance test: from one
task id, reach every downstream execution fact without archaeology.

- [ ] 5.4.1. Add query views and the `df12-obs` CLI. Requires 5.1.3 and
  5.3.2.
  - See ADR 003 section "Migration plan".
  - Create `v_task_timeline`, `v_agent_usage`, `v_failure_chain`, and
    `v_recovery_lineage`, plus CLI verbs for runs, tasks, invocations, tool
    calls, commits, failures, and lineage.
  - Success: from a roadmap task id an operator reaches node attempts, agent
    invocations, provider sessions, model requests, token and cost records,
    tool calls, errors, commits, and recovery lineage through the CLI alone.

### 5.5. Cross-workflow correlation

This step answers whether the contract genuinely generalizes beyond
df12-build by carrying identity and sink through a Dakar call.

- [ ] 5.5.1. Pass the observability context through Dakar calls.
  Requires 5.1.3.
  - See ADR 003 section "Cross-workflow contract".
  - Add `--correlation-id`, `--telemetry-sink`, and
    `--observability-context` to the Dakar CLI with the documented
    precedence; propagate identity through workflow arguments and inherited
    environment; record `workflow_invocation_edge` rows; echo resolved
    identity and telemetry status in results and review history; preserve
    candidate provenance by adding `sourceCandidateIds` to synthesized
    findings.
  - Success: a fixture query resolves a df12-build node attempt to the Dakar
    finder and verifier invocations behind an accepted finding.
