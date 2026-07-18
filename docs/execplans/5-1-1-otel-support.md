# Implement the host-side OpenTelemetry bridge for workshop runs (task 5.1.1)

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: DRAFT

## Purpose / big picture

After this change, an operator can point a small host tool at any Open
Dynamic Workflows (ODW) run directory — live or completed — and see the
workshop as an OpenTelemetry (OTel) trace: one root span for the run, a child
span per workflow phase, and a grandchild span per agent invocation, each
carrying the roadmap task id, branch, adapter, model, and outcome. The tool is
`scripts/odw-otel-bridge`. Running it with a configured OpenTelemetry
Protocol (OTLP) endpoint exports the trace; running it with no endpoint
configured exits cleanly without side effects. The workflow artefact and run
behaviour are untouched.

This delivers roadmap task 5.1.1 (see `docs/roadmap.md` phase 5) and the
decision recorded in `docs/adr-003-opentelemetry-observability.md`.

## Constraints

- Do not modify `src/workflows/df12-build-odw/`, `workflows/df12-build-odw.js`,
  or `workflows/df12-build.js`. The bridge is host-side only; the workflow
  dialect forbids runtime imports and temporal calls, so instrumentation
  cannot live in the artefact.
- Do not write into a run directory. The bridge opens `events.jsonl`
  read-only.
- Telemetry must be advisory: no bridge failure may affect a live run, and
  the bridge must exit with a clear message (not a crash) when the run
  directory or endpoint is absent.
- Export configuration uses only the standard `OTEL_EXPORTER_OTLP_*`
  environment variables plus command-line flags for the run directory.
- Follow `docs/documentation-style-guide.md` for any documentation touched.

## Tolerances (exception triggers)

- Scope: if implementation exceeds roughly 15 files or 1,200 net lines,
  stop and escalate.
- Dependencies: adding `@opentelemetry/*` packages is expected; any other
  new external dependency requires escalation.
- Schema: if `events.jsonl` proves to lack the events needed to reconstruct
  phase or agent spans (see milestone 1), stop and escalate with the
  evidence rather than inventing synthetic events.
- Iterations: if the fixture tests still fail after three fix attempts,
  stop and escalate.
- Interface: if delivering the bridge would require changes to the ODW
  runtime itself, stop and escalate.

## Risks

- Risk: the `events.jsonl` schema is owned by the ODW runtime and may not
  identify phase boundaries or agent parentage explicitly.
  Severity: high. Likelihood: medium.
  Mitigation: milestone 1 characterizes the schema from a real run before
  any bridge code is written; the schema tolerance above catches a dead end
  early.
- Risk: OTel JavaScript SDK versions move quickly and may conflict with the
  repository's Bun toolchain.
  Severity: medium. Likelihood: low.
  Mitigation: pin exact versions in `package.json` and keep the SDK usage
  behind one small exporter module.
- Risk: crashed runs leave dangling start events.
  Severity: low. Likelihood: high.
  Mitigation: the span builder closes unterminated spans with status
  `interrupted` at end of input; a dedicated fixture covers this.

## Progress

- [x] (2026-07-18) ExecPlan drafted alongside ADR 003 and roadmap phase 5.
- [ ] Milestone 1: characterize the `events.jsonl` schema from a recorded run.
- [ ] Milestone 2: red fixture tests for span reconstruction.
- [ ] Milestone 3: green — event parser and span builder.
- [ ] Milestone 4: OTLP exporter and command-line entry point.
- [ ] Milestone 5: live-tail mode, refactor, and documentation.

## Surprises & discoveries

None yet.

## Decision log

- Decision: place the bridge under `scripts/` as a standalone Bun tool
  rather than inside the workflow module tree.
  Rationale: the ODW dialect bans imports; `scripts/` already hosts host-side
  run tooling (`odw-list-runs`, `odw-watch`).
  Date/Author: 2026-07-18, ADR 003.
- Decision: traces first, metrics second. Task 5.1.1 delivers spans only;
  metrics land under task 5.1.2 on the same parser.
  Rationale: keeps each task review-sized and lets the schema findings from
  milestone 1 inform metric design.
  Date/Author: 2026-07-18, roadmap phase 5.

## Outcomes & retrospective

To be completed as milestones land.

## Context and orientation

`df12-build` ships workflow assets that drive a "workshop": a long multi-agent
run against a separate target project. The ODW runtime records each run in a
run directory containing `events.jsonl` (an append-only stream of structured,
timestamped events), `status.json`, `result.json`, and `worker.log`. The
helper scripts `scripts/odw-list-runs` and `scripts/odw-watch` locate and
follow these directories; the `odw-supervision` skill documents the layout.

The workflow itself (`workflows/df12-build-odw.js`, generated from
`src/workflows/df12-build-odw/`) cannot host telemetry: its dialect forbids
runtime imports and temporal calls, and the loader injects no span primitive.
`docs/adr-003-opentelemetry-observability.md` therefore places OTel support in
a host-side bridge that consumes `events.jsonl`. "OTLP" is the OpenTelemetry
Protocol, the wire format collectors accept; the standard environment
variables `OTEL_EXPORTER_OTLP_ENDPOINT` (and friends) configure it.

Repository gates run through the `Makefile`; `bun install --frozen-lockfile`
must run first or `tsc` is missing. Docs-only changes are gated by the
Markdown gates.

## Plan of work

Milestone 1 (prototyping, no production code): obtain or record a completed
run's `events.jsonl` (a bounded dry run via the supervisor playbook is
acceptable), then write a short schema note into this plan's
`Surprises & discoveries`: which event kinds exist, how phase transitions and
agent start/finish pairs are expressed, which fields identify the task id,
branch, adapter, and model, and what a crash-truncated stream looks like. Save
a sanitized copy under `tests/fixtures/otel-bridge/run-complete/events.jsonl`
and a truncated variant `run-interrupted/events.jsonl`. Go/no-go: if phase or
agent parentage cannot be reconstructed, stop per the schema tolerance.

Milestone 2 (red): create `tests/otel-bridge.test.ts` with fixture-driven
tests asserting the span tree built from each fixture: root span name and
status, one child per phase with correct ordering and timestamps, agent spans
with the attribute set from ADR 003, and `interrupted` status on dangling
spans in the truncated fixture. Run the suite and record the expected
failures before any implementation exists.

Milestone 3 (green): implement the pure core in
`scripts/otel-bridge/parse-events.ts` (line-by-line JSON parsing, tolerant of
unknown event kinds, surfacing them as diagnostics) and
`scripts/otel-bridge/build-spans.ts` (event stream to span tree, no SDK
types). Make the milestone 2 tests pass with the smallest implementation.

Milestone 4: implement `scripts/otel-bridge/export.ts` mapping the span tree
onto the pinned `@opentelemetry/*` SDK, and the executable entry point
`scripts/odw-otel-bridge` with `--run-dir <path>` and `--follow` flags. With
no `OTEL_EXPORTER_OTLP_ENDPOINT` set, print what would be exported and exit 0.
Add an exporter test using an in-memory span processor.

Milestone 5: implement `--follow` (tail `events.jsonl` until a terminal event
or interrupt, flushing incrementally), refactor, then document usage in
`docs/users-guide.md` and `docs/developers-guide.md`, and tick 5.1.1 in
`docs/roadmap.md`. Update this plan's living sections throughout.

## Concrete steps

All commands run from the repository root.

    bun install --frozen-lockfile
    bun test tests/otel-bridge.test.ts   # red at milestone 2, green from 3
    make all                             # full gate before each commit

Manual check at milestone 4:

    ./scripts/odw-otel-bridge --run-dir tests/fixtures/otel-bridge/run-complete
    # expect: a dry-run summary listing the run span, phase spans, and agent
    # spans, and exit code 0 (no endpoint configured)

## Validation and acceptance

Red: at milestone 2, `bun test tests/otel-bridge.test.ts` fails because the
bridge modules do not exist; the failure output names the missing modules.

Green: from milestone 3 onward the same command passes; from milestone 4 an
in-memory exporter test proves the SDK mapping. Acceptance for the task:
replaying `run-complete` exports one root span, the expected phase spans in
order, and agent spans with task id, branch, adapter, model, and outcome
attributes; replaying `run-interrupted` marks dangling spans `interrupted`;
running with no endpoint configured touches nothing and exits 0.

Quality criteria: `make all` passes (including Markdown gates for the doc
updates), and the new tests cover both fixtures and the no-endpoint path.

## Idempotence and recovery

The bridge only reads run directories, so every step is re-runnable. Fixtures
are committed, so tests need no live run. If a milestone is interrupted,
re-run `bun test` to establish state and continue from the first unchecked
Progress item.

## Interfaces and dependencies

Pinned dependencies: `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`,
and `@opentelemetry/exporter-trace-otlp-http`, added to `package.json` with
exact versions. In `scripts/otel-bridge/build-spans.ts`, define:

    export interface BridgeSpan {
      name: string
      kind: 'run' | 'phase' | 'agent'
      startTime: string
      endTime: string | null
      status: 'ok' | 'error' | 'interrupted'
      attributes: Record<string, string | number | boolean>
      children: BridgeSpan[]
    }

    export function buildSpanTree(events: ParsedEvent[]): {
      root: BridgeSpan
      diagnostics: string[]
    }

The exporter consumes `BridgeSpan` only; the parser and builder must not
import the OTel SDK so the core stays fixture-testable without a collector.
