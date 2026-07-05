# Agent Instructions

This repository contains two related workflow implementations with different
runtime targets.

- `workflows/df12-build.js` is the Claude Code-targeted workflow. Treat it as
  the Claude Code implementation surface, and do not assume Open Dynamic
  Workflows runtime behaviour when editing it.
- `workflows/df12-build-odw.js` is the Open Dynamic Workflows (ODW) flow. It
  currently targets Codex CLI adapters and follows the ODW workflow contract.
  It is a GENERATED artefact: edit the TypeScript module tree under
  `src/workflows/df12-build-odw/` instead (`meta.js` is the one file that
  stays plain JavaScript), then run `make workflow-build` to regenerate it
  (and commit both). `make workflow-freshness` fails when the committed
  artefact is stale, and `make typecheck` enforces erasable-syntax-only
  TypeScript across the tree.

Before editing, reviewing, or validating either workflow file, load and follow
the `odw-authoring` skill so the workflow dialect, injected primitives, schema
contracts, workspace mode, and validation expectations are understood.
