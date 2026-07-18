# Define the workflow observability contract (task 5.1.1)

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: DRAFT

## Purpose / big picture

After this change, every producer in the observability design of
`docs/adr-003-opentelemetry-observability.md` — the Open Dynamic Workflows
(ODW) runtime, the df12-build workflow, the Claude Code and Codex
command-line interfaces (CLIs), the `workflow-telemetryd` collector, and
sibling workflows such as Dakar — has one written contract to build against:
which identifiers exist, who mints them, which attribute names carry them,
what the context envelope passed between workflows looks like, and which
correlation headers a collector must validate. The contract is observable as
a versioned design document plus machine-readable JSON Schemas, with fixture
tests that fail on non-conforming envelopes and identity keys. Nothing else
in roadmap phase 5 (steps 5.2 through 5.5) can start safely before this
narrow waist is fixed, because ODW, the collector, and Dakar all consume it.

This delivers roadmap task 5.1.1 (see `docs/roadmap.md` phase 5).

## Constraints

- Do not modify `src/workflows/df12-build-odw/`, `workflows/df12-build-odw.js`,
  or `workflows/df12-build.js`; this task defines the contract only.
  Instrumentation lands under later tasks (5.2.1 and 5.3.x).
- The contract must match ADR 003 exactly where the ADR is explicit: three
  distinct identifiers (correlation id, workflow invocation id, node attempt
  id), agent invocation and process ids below them, the three-layer
  namespace (`gen_ai.*`, `leynos.*`, `df12.*`/`dakar.*`), binding confidence
  levels (`exact`, `derived`, `heuristic`), a collector-endpoint sink (never
  a database path), and credentials only as environment-variable references.
- Do not repurpose reserved convention fields: `gen_ai.agent.id` is not an
  invocation id, Claude's `workflow.run_id` is not an ODW run id, and
  `gen_ai.conversation.id` is never fabricated.
- Metrics guidance in the contract must keep high-cardinality identifiers
  out of metric dimensions.
- Follow `docs/documentation-style-guide.md` (this repository lints Markdown
  with indented code blocks, en-GB Oxford spelling, and wrapped paragraphs).

## Tolerances (exception triggers)

- Scope: if delivery exceeds roughly 12 files or 1,500 net lines, stop and
  escalate.
- Dependencies: one JSON Schema validator development dependency (for
  example `ajv`) is expected; any further new dependency requires
  escalation.
- Conflict: if writing the contract exposes a contradiction inside ADR 003
  (for example between the identity model and the Dakar envelope), stop,
  record it in the `Decision Log`, and escalate rather than resolving it
  silently.
- Iterations: if the fixture tests still fail after three fix attempts, stop
  and escalate.
- Ambiguity: naming marked "outstanding" in ADR 003 (namespace and header
  prefixes) is decided provisionally here and recorded; if the choice would
  leak into an external interface beyond documents and schemas, escalate
  instead.

## Risks

- Risk: the contract over-specifies details that ODW upstream (step 5.2)
  cannot implement, forcing a version bump immediately.
  Severity: medium. Likelihood: medium.
  Mitigation: mark fields that depend on upstream behaviour as provisional
  in the contract, and keep the envelope and event extensions versioned
  (`schemaVersion: 1`) from the start.
- Risk: the Generative AI (GenAI) semantic conventions shift under the
  contract while still in Development status.
  Severity: low. Likelihood: high.
  Mitigation: the contract names convention fields only in the canonical
  projection section and requires queries to target the projection, exactly
  as ADR 003 prescribes.
- Risk: JSON Schema alone cannot express some rules (for example header
  consistency with envelope fields).
  Severity: low. Likelihood: medium.
  Mitigation: encode such rules as fixture tests beside the schemas and
  state them normatively in the contract text.

## Progress

- [x] (2026-07-18) ExecPlan drafted alongside ADR 003 and roadmap phase 5.
- [x] (2026-07-18) ExecPlan rewritten after the source design conversation
  replaced the events-bridge approach with the correlation-first gateway;
  task 5.1.1 re-scoped from "build a bridge" to "define the contract".
- [ ] Milestone 1: draft `docs/workflow-observability-contract.md`.
- [ ] Milestone 2: red fixture tests for envelope and identity validation.
- [ ] Milestone 3: green — schemas and fixtures under `schemas/observability/`.
- [ ] Milestone 4: cross-references, contents, and gate pass.

## Surprises & discoveries

- Observation: the initial draft of this plan proposed a post-hoc
  `events.jsonl` → OTLP bridge.
  Evidence: the design conversation behind ADR 003 rejects temporal
  correlation as unsound under parallelism and retries.
  Impact: the bridge survives only as a `heuristic`-confidence import path;
  this task now defines the identity contract instead.

## Decision log

- Decision: task 5.1.1 delivers the contract document and schemas, not any
  collector or instrumentation code.
  Rationale: ODW upstream (5.2.1), the collector (5.1.2), and Dakar (5.5.1)
  all consume the same identity model; fixing it first prevents three
  divergent interpretations.
  Date/Author: 2026-07-18, roadmap phase 5.
- Decision: schemas live under `schemas/observability/` with the envelope at
  `workflow-observability-context.v1.json`, versioned in the filename.
  Rationale: the envelope crosses workflow boundaries, so consumers must be
  able to pin an exact version.
  Date/Author: 2026-07-18, this plan.

## Outcomes & retrospective

To be completed as milestones land.

## Context and orientation

`df12-build` ships workflow assets that drive a "workshop": a long
multi-agent run in which the ODW runtime dispatches Codex and Claude Code
processes against a target project. ADR 003
(`docs/adr-003-opentelemetry-observability.md`) decides how this system
becomes observable: ODW mints an opaque agent invocation id at dispatch,
Claude inherits trace context through the `TRACEPARENT` environment
variable, Codex carries the identity in OpenTelemetry Protocol (OTLP)
exporter headers, and a local collector (`workflow-telemetryd`) stores raw
telemetry plus a relational projection in SQLite under the durable
`.workshop` sidecar. "OTLP" is the OpenTelemetry wire protocol; a "binding"
is a recorded association between a provider identifier (session, request,
tool call) and an ODW invocation, tagged with a confidence level.

This task writes the contract those components share. Deliverables live in
this repository: a normative document, JSON Schemas, fixtures, and tests.
Repository gates run through the `Makefile`; `bun install --frozen-lockfile`
must run first or `tsc` is missing. Markdown gates (`make markdownlint`,
`make nixie`) cover the documents; `bun test` runs the module test suites.

## Plan of work

Milestone 1 (document): write
`docs/workflow-observability-contract.md` with numbered sections covering,
in order: the identity model (each identifier's name, minting authority,
format — UUIDv7 for concrete executions, readable keys such as
`task/1.2.3/normal/plan/round/1` for logical nodes, hashed work-item keys);
the `leynos.*` attribute registry as a captioned table (attribute, type,
cardinality class, where it may appear — span, log, resource, metric); the
span topology and naming rules; the `WorkflowObservabilityContextV1`
envelope field by field, including sink shape and the environment-reference
rule for credentials; the correlation header set and the collector's
validation obligations; ODW agent-event extensions
(`agent_invocation_id`, `agent_process_id`, `cli_attempt`, and companions);
binding types and confidence levels; and the metrics cardinality policy
(allowed dimensions, forbidden identifiers). Mark normative sections
explicitly, and mark provisional fields that await upstream ODW behaviour.

Milestone 2 (red): add `tests/observability-contract.test.ts` with
fixture-driven cases before the schemas exist: valid envelopes (full parent
context; minimal correlation-only; sink absent), invalid envelopes (missing
`schemaVersion`, inline credential material in `sink`, database-path sink,
unknown `confidence` value), and logical-node-key strings that must match or
fail a documented pattern. Run the suite and record the expected failures.

Milestone 3 (green): create `schemas/observability/` containing
`workflow-observability-context.v1.json`, `agent-event-extensions.v1.json`,
and `telemetry-binding.v1.json`, plus the fixtures under
`tests/fixtures/observability-contract/`. Wire the validator (single new
development dependency, exact-pinned) and make the milestone 2 tests pass
with the smallest schemas that honour the contract document.

Milestone 4 (integrate): cross-link the contract from ADR 003 and from
roadmap step 5.1; update `docs/developers-guide.md` with a short pointer;
run the full gates; update this plan's living sections and mark 5.1.1
complete in `docs/roadmap.md` only when every milestone is checked.

## Concrete steps

All commands run from the repository root.

    bun install --frozen-lockfile
    bun test tests/observability-contract.test.ts   # red at milestone 2
    make markdownlint && make nixie                  # document gates
    make all                                         # full gate before commit

Expected red transcript at milestone 2:

    error: Cannot find module "../schemas/observability/..."
    # or assertion failures naming the missing schema files

## Validation and acceptance

Red: at milestone 2, `bun test tests/observability-contract.test.ts` fails
because the schemas and fixtures do not exist; failures name the missing
files.

Green: from milestone 3 the same command passes. Acceptance for the task:
the three valid fixture envelopes validate; each invalid fixture is
rejected with the documented reason (including the inline-credential and
database-path-sink cases); logical node keys match the documented pattern
and malformed keys fail; and `make all` passes, proving the contract
document survives the Markdown and spelling gates.

Quality criteria: every identifier, attribute, header, and event field named
in ADR 003's decision sections appears in the contract document exactly
once as a normative definition, and the schemas carry `schemaVersion` 1.

## Idempotence and recovery

All deliverables are documents, schemas, fixtures, and tests; every step is
re-runnable. If a milestone is interrupted, re-run the test suite to
establish state and continue from the first unchecked `Progress` item.

## Interfaces and dependencies

One development dependency: a JSON Schema draft 2020-12 validator (for
example `ajv`), exact-pinned in `package.json`. No runtime code ships. The
schema files under `schemas/observability/` are the machine-readable
interface later tasks consume:

    schemas/observability/workflow-observability-context.v1.json
    schemas/observability/agent-event-extensions.v1.json
    schemas/observability/telemetry-binding.v1.json

The envelope schema must define, at minimum: `schemaVersion` (const 1),
`correlationId` (required), `workflowInvocationId` (optional),
`parent.workflowInvocationId` and `parent.nodeAttemptId` (optional,
together), `trace.traceparent` and `trace.tracestate` (optional), `sink`
(kind `otlp-http`, endpoint URI, protocol `http/json`, optional `authRef`
restricted to environment references), and an `attributes` map of scalar
values.

## Revision note

2026-07-18: rewritten in full. The original plan implemented a post-hoc
`events.jsonl` → OTLP bridge; the source design conversation behind ADR 003
replaced that approach with a correlation-first gateway, and task 5.1.1 is
now the contract-definition task that precedes collector, ODW, and Dakar
work. All sections were rewritten to match; no implementation had started,
so no code is affected.
