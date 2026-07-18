# Workflow observability contract (version 1)

## Status and scope

- Status: normative for version 1 of the observability fabric.
- Audience: implementers of the `workflow-telemetryd` collector, the Open
  Dynamic Workflows (ODW) correlation substrate, the df12-build node
  instrumentation, and sibling workflows such as `leynos/dakar`.
- Precedence: `docs/adr-003-opentelemetry-observability.md` is the governing
  decision. Where this contract and the ADR disagree, the ADR wins and this
  document must be corrected.

This document fixes the shared identity model, attribute names, span
topology, cross-workflow envelope, correlation headers, event extensions,
binding records, and metrics policy that every producer in the fabric builds
against. It is the narrow waist that ODW (roadmap step 5.2), the collector
(step 5.1.2 onward), and Dakar (step 5.5) all depend upon; those steps must
not diverge from the definitions below.

Sections marked _(normative)_ define requirements. Sections marked
_(informative)_ explain intent and may be revised without a version bump.
Fields marked _provisional_ depend on upstream ODW behaviour that does not
yet exist; they may change before ODW implements them, but their names are
reserved now so consumers can code to them.

The three machine-readable schemas that accompany this document live under
`schemas/observability/`. They are the authoritative shape; the prose here
explains and constrains them but the schema files are what consumers
validate against.

## 1. Terminology _(informative)_

- OpenTelemetry (OTel): the observability framework whose traces, logs, and
  metrics the providers emit.
- OpenTelemetry Protocol (OTLP): the wire protocol the collector accepts;
  version 1 uses the HTTP JavaScript Object Notation (JSON) transport.
- Span: one timed operation in a trace, optionally the parent of child
  spans.
- Binding: a recorded association between a provider identifier (for example
  a session, request, or tool call) and an ODW agent invocation, tagged with
  a confidence level.
- Envelope: the `WorkflowObservabilityContextV1` object one workflow passes
  to another so telemetry from the child joins the parent's correlation.
- Workshop: one long multi-agent run driving a target project.

## 2. Identity model _(normative)_

Correlation is identity-first. Phase names, labels, timestamps, process
identifiers, and prompt text are evidence only; they must never be used as
primary join keys, because parallelism and retries make temporal matching
unsound.

Concrete executions are identified by Universally Unique Identifier version 7
(UUIDv7) values. Stable logical identities use readable keys or content
hashes. The identifiers, and which component mints each, are fixed as
follows.

| Identifier             | Minted by                | Format                | Meaning                                                                                           |
| ---------------------- | ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| `correlationId`        | Originating workflow     | UUIDv7 or stable key  | The logical objective (one unit of roadmap work) across workflows, retries, and process restarts. |
| `workflowInvocationId` | Each workflow            | UUIDv7                | One concrete invocation of a workflow (df12-build, Dakar, others).                                |
| `nodeAttemptId`        | The workflow host        | UUIDv7                | One execution of a node inside a workflow invocation.                                             |
| `agentInvocationId`    | ODW, before dispatch     | UUIDv7                | One call to the ODW `agent()` primitive. The central join key.                                    |
| `agentProcessId`       | ODW, per spawned process | UUIDv7                | One spawned command-line-interface (CLI) execution.                                               |
| `cliAttempt`           | ODW                      | Integer, from 1       | The process or schema-retry attempt number within an invocation.                                  |
| `nodeLogicalId`        | The workflow host        | Node key (section 10) | The stable semantic identity of a node, independent of when it ran.                               |

_Table 1: The identity model. Concrete executions use UUIDv7; logical
identities use readable keys or hashes._

The distinctions carry weight and must not be collapsed:

- A logical node identity (`nodeLogicalId`) says _what_ operation this is.
- A node attempt (`nodeAttemptId`) says _when_ this operation ran.
- An agent invocation (`agentInvocationId`) says _which_ ODW dispatch served
  the node.
- An agent process (`agentProcessId`) says _which_ CLI execution produced
  the native telemetry.

A schema retry starts a new process, and therefore a new `agentProcessId` and
an incremented `cliAttempt`, under the same `agentInvocationId`. Work-item
node keys hash normalized checklist text rather than relying on index
position, so an edited execution plan (ExecPlan) cannot silently make
"work item 3" refer to something else.

Reserved-field rules, restated from ADR 003 so consumers do not reintroduce
them:

- `gen_ai.agent.id` must not carry `agentInvocationId`; the convention
  reserves it for a stable agent resource.
- Claude's `workflow.run_id` must not be overloaded for an ODW run; it names
  a run of Claude Code's own Workflow tool.
- `gen_ai.conversation.id` must never be fabricated; record provider
  conversation identifiers as bindings (section 9) instead.

## 3. Naming domains _(normative)_

The fabric spans four surfaces, and each keeps the casing its consumers
already use. Implementers must not "unify" these; a single casing would
misrepresent at least one surface.

- Cross-process envelope: camelCase (`workflowInvocationId`). It is a
  TypeScript and JSON interface passed between processes.
- ODW event extensions: snake_case (`agent_invocation_id`). They extend the
  existing snake_case JSON Lines (JSONL) event stream.
- OTel attributes: dotted lower snake within the `leynos.*` namespace
  (`leynos.agent.invocation.id`). This follows OTel attribute conventions.
- Binding rows: snake_case (`binding_type`). They mirror the SQLite columns
  in ADR 003.

The same logical identifier therefore appears under three spellings —
`agentInvocationId` in the envelope, `agent_invocation_id` in an event, and
`leynos.agent.invocation.id` on a span. This is intentional and the mapping
is one-to-one.

## 4. The `leynos.*` attribute registry _(normative)_

Workflow-neutral identity travels on spans and logs under the `leynos.*`
namespace. Workflow-specific detail uses `df12.*` or `dakar.*`; provider
detail uses the standard `gen_ai.*`, `service.*`, `error.*`, and `vcs.*`
namespaces. The cardinality class governs where an attribute may appear:
`high` attributes are identifier-like and are forbidden as metric dimensions
(section 11); `low` attributes are bounded and may be used as metric
dimensions.

| Attribute                                | Type   | Cardinality | May appear on               |
| ---------------------------------------- | ------ | ----------- | --------------------------- |
| `leynos.telemetry.schema.version`        | int    | low         | span, log, resource         |
| `leynos.correlation.id`                  | string | high        | span, log                   |
| `leynos.workflow.name`                   | string | low         | span, log, resource, metric |
| `leynos.workflow.version`                | string | low         | span, log, resource         |
| `leynos.workflow.invocation.id`          | string | high        | span, log                   |
| `leynos.workflow.parent_invocation.id`   | string | high        | span, log                   |
| `leynos.workflow.parent_node_attempt.id` | string | high        | span, log                   |
| `leynos.workflow.node.logical_id`        | string | high        | span, log                   |
| `leynos.workflow.node.attempt_id`        | string | high        | span, log                   |
| `leynos.workflow.node.kind`              | string | low         | span, log, metric           |
| `leynos.workflow.node.attempt`           | int    | low         | span, log                   |
| `leynos.agent.invocation.id`             | string | high        | span, log                   |
| `leynos.agent.process.id`                | string | high        | span, log                   |
| `leynos.agent.cli_attempt`               | int    | low         | span, log                   |

_Table 2: The `leynos.*` attribute registry. High-cardinality attributes are
forbidden as metric dimensions._

## 5. Span topology and naming _(normative)_

Span names stay low-cardinality; task-specific detail goes in attributes, not
in the span name. Version 1 uses these operation names, aligned with the
GenAI semantic conventions where one applies:

- `invoke_workflow` for a workflow root span, with `gen_ai.workflow.name`
  set (for example `df12-build`).
- `invoke_agent` for one ODW agent dispatch, with `gen_ai.agent.name` set
  (for example `df12.planner`).
- `plan` for a planning node whose child is the plan-generating operation.
- `df12.*` stage spans (for example `df12.review`, `df12.integrate`) for
  workflow-internal phases that are not themselves agent dispatches.

Every span in the fabric carries the `leynos.*` identity attributes for its
level: a workflow root carries the correlation and invocation identifiers, a
node span adds the node attempt and logical identifiers, and an agent span
adds the agent invocation and process identifiers. Provider spans inherit
identity through trace parenting (Claude) or header binding (Codex), so they
need not repeat the `leynos.*` attributes.

Because the GenAI agent and workflow conventions are still at Development
status, queries must target the schema-versioned relational projection
(ADR 003), not the raw convention field names, so a convention rename cannot
break stored history.

## 6. The workflow observability context envelope _(normative)_

A workflow that calls another passes a `WorkflowObservabilityContextV1`
envelope. Its authoritative shape is
`schemas/observability/workflow-observability-context.v1.json`. The fields
are:

- `schemaVersion` (required): the constant integer `1`.
- `correlationId` (required): the logical objective identifier (section 2).
- `workflowInvocationId` (optional): a pre-allocated invocation identifier
  for the child. When absent, the child mints its own.
- `parent` (optional): the calling node's identity, as
  `parent.workflowInvocationId` and `parent.nodeAttemptId`. Both are required
  when `parent` is present.
- `trace` (optional): W3C trace context, as `trace.traceparent` (required
  when `trace` is present) and optional `trace.tracestate`. The
  `traceparent` value must match the W3C format
  `version-traceid-spanid-flags`.
- `sink` (optional): the telemetry destination, described in section 7. When
  absent, telemetry is disabled and the run proceeds normally.
- `attributes` (optional): a flat map of scalar (string, number, or boolean)
  values propagated onto the child's spans.

The envelope is closed: no properties beyond those above are permitted, so a
typo or a smuggled credential field is rejected rather than ignored.

An example full-parent envelope, as passed from a df12-build node to a Dakar
call:

    {
      "schemaVersion": 1,
      "correlationId": "0198e5a1-0000-7000-8000-000000000001",
      "workflowInvocationId": "0198e5a1-0000-7000-8000-0000000000c1",
      "parent": {
        "workflowInvocationId": "0198e5a1-0000-7000-8000-0000000000d1",
        "nodeAttemptId": "0198e5a1-0000-7000-8000-0000000000e1"
      },
      "trace": {
        "traceparent":
          "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
      },
      "sink": {
        "kind": "otlp-http",
        "endpoint": "otlp+http://127.0.0.1:4318",
        "protocol": "http/json"
      }
    }

## 7. The sink and credential rule _(normative)_

The sink is a collector endpoint, never a database path. The collector owns
decoding, header validation, redaction, projection, backpressure, and
migrations; a workflow must not open the SQLite store directly.

- `sink.kind` is the constant `otlp-http`.
- `sink.endpoint` is an OTLP collector uniform resource identifier (URI) with
  the scheme `otlp+http://` or `otlp+https://`. A filesystem path or a
  `file://`, `sqlite:`, or bare `http://` value is invalid. The
  `otlp+unix://` scheme is reserved for a future transport (ADR 003
  outstanding decision) and is not valid in version 1.
- `sink.protocol` is the constant `http/json`.
- `sink.authRef` (optional) references a credential by environment variable,
  as `authRef.kind` (constant `environment`) and `authRef.variable` (an
  uppercase environment variable name). Credentials must never travel inline
  in the envelope, because a child workflow's arguments can be persisted in
  run artefacts.

## 8. Correlation headers and collector validation _(normative)_

Because Codex has no documented inbound trace-context handling, identity
reaches the collector as OTLP exporter request headers. ODW sets these on
every provider export:

- `x-df12-workshop-id`
- `x-df12-run-id`
- `x-df12-node-attempt-id`
- `x-df12-agent-invocation-id`
- `x-df12-agent-process-id`
- `x-df12-cli-attempt`
- `x-df12-schema-version`

The collector must, on every received batch:

1. Read the headers and reject a batch whose `x-df12-schema-version` it does
   not support.
2. Validate `x-df12-agent-invocation-id` against a registered invocation;
   an unregistered invocation is recorded as a diagnostic, not silently
   dropped.
3. Attach the resolved binding to every record in the batch at `exact`
   confidence (section 9).
4. Preserve native provider trace identifiers unchanged; a Codex trace is
   linked to the ODW invocation as a correlation edge, never rewritten.

For Claude, ODW additionally injects W3C trace context so the
`claude_code.interaction` span parents under the ODW `invoke_agent` span; the
headers still carry identity so logs and metrics, which may lack trace
context, remain joinable.

## 9. Telemetry bindings and confidence _(normative)_

A binding row records how a provider identifier maps to an ODW invocation.
Its authoritative shape is
`schemas/observability/telemetry-binding.v1.json`. Binding rows use
snake_case (section 3). The fields are `binding_type`, `binding_value`,
`agent_invocation_id`, optional `agent_process_id`, optional `trace_id` and
`span_id` (lower-hex of 32 and 16 characters respectively), `source`,
`confidence`, `first_seen_ns`, and `last_seen_ns`. The two nanosecond
timestamps are carried as decimal strings, not JSON numbers, because a
nanosecond count since the epoch exceeds the range JSON numbers represent
exactly (2^53); the SQLite store holds them as 64-bit integers.

The `binding_type` is a dotted, namespaced key. The registry for version 1
includes:

    codex.conversation_id
    claude.session.id
    claude.prompt.id
    anthropic.request_id
    gen_ai.response.id
    gen_ai.tool.call.id
    vcs.commit
    df12.execplan.path

The `confidence` is one of `exact`, `derived`, or `heuristic`. The `source`
determines the permitted confidence, and the schema enforces the mapping:

- `source` of `trace-context` or `otlp-header` implies `confidence` of
  `exact`.
- `source` of `events-jsonl` (the post-hoc historical import path) implies
  `confidence` of `heuristic`.
- `derived` confidence is reserved for a binding computed from other exact
  bindings.

## 10. Logical node key grammar _(normative)_

A `nodeLogicalId` is a slash-separated path of lower-case segments. Each
segment matches `[a-z0-9]` optionally followed by more of
`[a-z0-9._-]` and ending in `[a-z0-9]`; there are at least two segments; there
is no leading, trailing, or doubled slash; and dotted roadmap identifiers
(for example `1.2.3`) appear as a single segment. The canonical regular
expression is:

    ^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$

Representative valid keys:

    task/1.2.3/normal/plan/round/1
    task/1.2.3/normal/implement/work-item/7c29e8a1
    task/1.2.3/normal/review/round/2/code-review
    task/1.2.3/normal/integrate

Keys that must be rejected include an empty or doubled segment
(`task//plan`), a leading or trailing slash (`/task/1.2.3` or
`task/1.2.3/`), an upper-case segment (`Task/1.2.3`), a single segment
(`task`), and a segment containing a space.

## 11. Metrics cardinality policy _(normative)_

Metrics use only bounded dimensions. High-cardinality identifiers stay on
spans, logs, and relational rows, where they support exact navigation without
creating one time series per value.

Permitted metric dimensions:

    leynos.workflow.name
    leynos.workflow.node.kind
    df12.task.kind
    adapter
    provider
    model
    outcome
    error.type
    gate.name
    resumed

Forbidden as metric dimensions:

    correlation id
    run id
    task id
    node attempt id
    agent invocation id
    conversation id
    session id
    prompt id
    request id
    tool call id
    commit hash

Claude's session and account attributes must be excluded from metric series
(`OTEL_METRICS_INCLUDE_SESSION_ID=false` and companions) while remaining on
logs and resources.

## 12. ODW agent-event extensions _(normative, provisional)_

ODW (roadmap step 5.2) will extend its `agent_started`, `agent_finished`, and
`agent_failed` JSONL events with the identity fields below. Their
authoritative shape is
`schemas/observability/agent-event-extensions.v1.json`. The fields use
snake_case and are additive: existing event fields (`label`, `phase`,
`adapter`, and so on) are unchanged. The extension fields are `run_id`,
`node_attempt_id`, `agent_invocation_id`, `agent_process_id`, and
`cli_attempt`. These fields are provisional until ODW implements them; the
names are reserved here so the collector and later steps can code to them.

## 13. Schema files and versioning _(normative)_

Version 1 ships three schema files under `schemas/observability/`:

    workflow-observability-context.v1.json
    agent-event-extensions.v1.json
    telemetry-binding.v1.json

Each is a JSON Schema draft 2020-12 document whose `$id` ends in `.v1.json`,
pinning the version in both the file name and the identifier. A breaking
change ships a new `.v2.json` file beside the version-1 file rather than
editing it in place, so a consumer can pin an exact version. The envelope
instance additionally carries `schemaVersion: 1`, so a receiver can reject an
unsupported envelope version without consulting the file name.

## 14. References _(informative)_

- `docs/adr-003-opentelemetry-observability.md`: the governing decision.
- `docs/roadmap.md` phase 5: the delivery sequence this contract unblocks.
- `docs/execplans/5-1-1-otel-support.md`: the plan that produced this
  contract.
