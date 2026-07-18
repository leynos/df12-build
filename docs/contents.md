# Documentation contents

This file is the index for the `df12-build` documentation set. Use it to find
the right document for a task, whether launching a workshop, changing the
workflow assets, or understanding why the system is shaped the way it is.

- [Documentation contents](contents.md): this index; start here to locate any
  other document.

## Guides

- [User guide](users-guide.md): for operators driving a target project through
  a workshop; covers launching, monitoring, and recovering a run.
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
- [Security and permissions](security-and-permissions.md): sets out the
  capabilities a workshop can exercise and how they are constrained.
- [ODW compilation and compile-time testing](odw-compilation-and-compile-time-testing.md):
  explains how the shipped workflow artefact is produced from the TypeScript
  module tree and why the compilation is shaped that way.
- [CodeRabbit wire contract](coderabbit-wire-contract.md): pins the parser and
  outcome classification to the NDJSON event stream that `coderabbit review
  --agent` emits.
- [Documentation style guide](documentation-style-guide.md): the conventions
  every document in this repository follows.

## Decision records

- [ADR 001: Adopt ODW sidecar launches](adr-001-adopt-odw-sidecar-launches.md):
  records the decision to launch Codex-oriented runs from a sidecar directory.
- [ADR 002: Assess partial task branches](adr-002-assess-partial-task-branches.md):
  records the decision to assess surviving task branches before a fresh
  restart.

## Plans

- [Execution plans](execplans/): self-contained execution plans for larger
  pieces of work.
  - [ADR 002 partial task branch assessment](execplans/adr-002-partial-task-branch-assessment.md):
    the plan behind the partial-branch assessment behaviour.
  - [ODW compilation](execplans/odw-compilation.md): the plan behind the
    compile-time testing and artefact build.
