# Architectural decision record (ADR) 003: OpenTelemetry observability for workshop runs

## Status

Proposed.

## Date

2026-07-18.

## Context and problem statement

A df12-build workshop run is a long-lived, multi-agent process. Today its
observability surface is narrow: the workflow emits narrator lines through the
Open Dynamic Workflows (ODW) `log()` primitive, and the ODW runtime records
durable run artefacts (`events.jsonl`, `status.json`, `result.json`, and
`worker.log`) under the run directory. Operators inspect these with `odw
status`, `odw logs`, the dashboard, and the helper scripts
`scripts/odw-list-runs` and `scripts/odw-watch`.

This surface answers "what is the run doing right now" but not "how did the
run behave over time". There is no way to see a workshop as a trace (run,
phases, agent invocations, and merge-lock waits as nested timed spans), to
chart failure and retry rates across runs, or to feed run telemetry into the
same OpenTelemetry (OTel) tooling used for other df12 services.

Instrumenting the workflow script directly is not possible. The ODW workflow
dialect forbids runtime imports, so the OTel software development kit (SDK)
cannot be bundled into `workflows/df12-build-odw.js`, and the dialect bans
`Date.now()`, `Math.random()`, and arg-less `new Date()`, which the SDK
requires. The loader injects no span or trace primitive; `log()` and
`events.jsonl` are the only in-run observability channels. The compilation
monograph (`docs/odw-compilation-and-compile-time-testing.md`) records this
constraint.

The decision, therefore, is where OTel support should live given that the
workflow itself cannot host it.

## Decision drivers

- The ODW dialect bans imports and temporal or random calls inside the
  workflow artefact, so instrumentation cannot run in-process.
- `events.jsonl` already records structured, timestamped run events durably
  in the run directory, surviving workflow crashes.
- Telemetry must never be able to fail, slow, or mutate a live workshop run;
  observability is advisory, not a gate.
- Operators should configure export through the standard
  `OTEL_EXPORTER_OTLP_*` environment variables rather than bespoke settings.
- The bridge must work both live (tailing a running workshop) and post hoc
  (replaying a completed run directory).

## Options considered

### Option A: instrument the workflow script directly

Bundle OTel instrumentation into the compiled workflow artefact. Rejected:
the dialect forbids runtime imports and the temporal calls the SDK depends
on, `scripts/build-workflow.mjs` fails closed on loader-contract hazards, and
an in-process exporter would couple run success to collector availability.

### Option B: host-side bridge that translates `events.jsonl` into OTLP

Add a standalone host tool (outside the workflow artefact) that reads a run
directory's `events.jsonl`, reconstructs the run → phase → agent hierarchy,
and exports OpenTelemetry Protocol (OTLP) traces and metrics to a configured
endpoint. The tool tails a live run or replays a finished one. The workflow
artefact is untouched, so telemetry cannot perturb a run.

### Option C: OpenTelemetry Collector `filelog` receiver

Point a stock OTel Collector at `events.jsonl` using the `filelog` receiver
and transform processors. No new code, but the output is logs rather than
traces: the collector cannot reconstruct span parentage or durations from
paired start and finish events, and the transform configuration is brittle
against event-schema drift.

| Topic                     | Option A        | Option B         | Option C       |
| ------------------------- | --------------- | ---------------- | -------------- |
| Feasible under ODW rules  | No              | Yes              | Yes            |
| Trace hierarchy           | Native          | Reconstructed    | None (logs)    |
| Risk to live runs         | High            | None             | None           |
| New code required         | Blocked         | Small host tool  | Config only    |
| Works on completed runs   | No              | Yes              | Partially      |

_Table 1: Comparison of instrumentation placements._

## Decision outcome / proposed direction

Adopt Option B. Build a host-side bridge, `scripts/odw-otel-bridge`, that
consumes a run directory's `events.jsonl` and exports OTLP traces and metrics.
The bridge maps the run to a root span, each workflow phase to a child span,
and each agent invocation to a grandchild span carrying attributes such as the
roadmap task id, branch name, adapter, model, outcome, and token spend.
Metrics cover agent invocation counts, failure and retry counts, token totals,
and merge-lock wait time. Export is configured through the standard
`OTEL_EXPORTER_OTLP_*` environment variables; when no endpoint is configured
the bridge exits without side effects. Option C remains available to
operators who only need raw event logs in a collector.

## Goals and non-goals

- Goals:
  - Export a complete trace for a workshop run, live or after the fact,
    without modifying the workflow artefact.
  - Emit run-level metrics suitable for cross-run dashboards.
  - Keep telemetry failure isolated from workshop outcomes.
- Non-goals:
  - Instrumenting the Claude Code-targeted `workflows/df12-build.js`.
  - Propagating trace context into target-project builds or agent
    subprocesses.
  - Shipping or operating a collector, storage backend, or dashboards.

## Known risks and limitations

- The `events.jsonl` schema is owned by the ODW runtime, not this repository;
  schema drift can silently degrade span reconstruction. The bridge must
  version-check what it can and surface unknown event kinds as bridge-level
  diagnostics rather than dropping them silently.
- Timestamps come from event records, so span durations inherit whatever
  precision the runtime records.
- A post-hoc replay of a crashed run may lack terminal events; the bridge
  must close dangling spans with an explicit `interrupted` status rather
  than fabricating end times.

## Outstanding decisions

- Whether the bridge is written for Bun (matching the repository toolchain)
  or Node, and whether the OTel SDK dependency lives in the existing
  `package.json` or a tool-local one.
- Which metric names and attribute keys to standardize; these should follow
  OTel semantic conventions where an applicable convention exists.
- Whether `scripts/odw-watch` should learn to launch the bridge alongside a
  watched run.
