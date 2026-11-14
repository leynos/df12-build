# Documentation contents

This file is the index for the `df12-build` documentation set. Use it to find
the right document for a task, whether launching a workshop, changing the
workflow assets, or understanding why the system is shaped the way it is.

- [Documentation contents](contents.md): this index; start here to locate any
  other document.

## Guides

- [User guide](users-guide.md): for operators driving a target project through
  a workshop; covers launching, monitoring, and recovering a run.
- [Migrate to Dakar host review](migrate-to-dakar-host-review.md): for existing
  operators moving from the previous CodeRabbit default or retaining it
  explicitly.
- [Developers guide](developers-guide.md): for contributors changing the
  workflow assets or documentation; covers build, test, lint, and extension
  workflows.
- [Repository layout](repository-layout.md): explains the shape of the tree and
  the responsibilities of its major paths for new contributors.

## Design and reference

- [Architecture](architecture.md): describes the state boundaries, workflow
  structure, and configuration contract of the ODW workflow.
- [Failure resume design](failure-resume-design.md): explains how the workflow
  assesses surviving task branches and resumes work after interruption.
- [Workflow observability contract](workflow-observability-contract.md): the
  normative version-1 identity model, attribute registry, envelope, headers,
  and binding schemas that the observability fabric builds against.
- [Security and permissions](security-and-permissions.md): sets out the
  capabilities a workshop can exercise and how they are constrained.
- [ODW compilation and compile-time testing](odw-compilation-and-compile-time-testing.md):
  explains how the shipped workflow artefact is produced from the TypeScript
  module tree and why the compilation is shaped that way.
- [CodeRabbit wire contract](coderabbit-wire-contract.md): pins the parser and
  outcome classification to the NDJSON event stream that
  `coderabbit review --agent` emits.
- [Documentation style guide](documentation-style-guide.md): the conventions
  every document in this repository follows.

## Decision records

- [ADR 0001: Adopt ODW sidecar launches](adrs/adr-0001-adopt-odw-sidecar-launches-for-codex-oriented-df12-build-runs.md):
  records the decision to launch Codex-oriented runs from a sidecar directory.
- [ADR 0002: Assess partial task branches](adrs/adr-0002-assess-partial-task-branches-before-fresh-restart.md):
  records the decision to assess surviving task branches before a fresh restart.
- [ADR 0003: Correlation-first OpenTelemetry observability](adrs/adr-0003-correlation-first-opentelemetry-observability-for-workshop-runs.md):
  records the accepted decision to correlate workflow nodes and agent telemetry
  through dispatch-time identity, a local OTLP collector, and a SQLite store.
- [ADR 0004: Oxlint source rules](adrs/adr-0004-oxlint-rules-for-odw-source.md):
  records the pinned Unicorn and deslop profiles for authored ODW source and
  the workflow artefact exclusion.
- [ADR 0005: Adopt the documentation style guide for ADR and RFC naming](adrs/adr-0005-adopt-documentation-style-guide-for-adr-and-rfc-naming.md):
  adopts the guide's naming conventions while preserving accepted decision
  history.

## Plans

- [Execution plans](execplans/): self-contained execution plans for larger
  pieces of work.
  - [ADR 0002 partial task branch assessment](execplans/adr-002-partial-task-branch-assessment.md):
    the plan behind the partial-branch assessment behaviour.
  - [ODW compilation](execplans/odw-compilation.md): the plan behind the
    compile-time testing and artefact build.
  - [Workflow observability contract (5.1.1)](execplans/5-1-1-otel-support.md):
    the plan for defining the identity and schema contract behind ADR 0003.
