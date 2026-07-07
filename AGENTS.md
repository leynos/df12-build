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

## Editing the ODW module tree

`workflows/df12-build-odw.js` is compiled from `src/workflows/df12-build-odw/`
by `scripts/build-workflow.mjs`, which frames the artefact from a verbatim
`meta.js` banner, a flat esbuild bundle of `main.ts` and its imports, and a
generated `return await workflowMain()` footer, then fails closed on any
loader-contract hazard. Keep these rules when editing the tree; the
[compilation monograph](docs/odw-compilation-and-compile-time-testing.md) and
the developers' guide "Submodule architecture and composition" section explain
why.

- Edit the `src` tree, then run `make workflow-build`, and commit the source
  **and** the regenerated artefact together. Never hand-edit the artefact;
  `make workflow-freshness` fails a stale one.
- `meta.js` is the one file that stays plain JavaScript (verbatim banner, one
  literal `export const meta`). Every other module is erasable-syntax-only
  TypeScript enforced by `make typecheck` (no enums, parameter properties, or
  runtime namespaces).
- `main.ts` is the entry: it binds each `makeX(deps)` subsystem factory once and
  runs the control loop. Compose new subsystems the same way.
- A new module must be imported from `main.ts` (with the explicit `.ts` import
  extension) or the build fails closed on its unused exports. Do not reuse a
  top-level export name across modules (esbuild renames the collision and the
  build rejects it), and keep the tree acyclic ESM (no import cycles, no
  CommonJS).
- Do not import ODW primitives (they are ambient in `odw-globals.d.ts`), and do
  not use `Date.now()`, `Math.random()`, or arg-less `new Date()`.
- Run `make all` before committing; it includes `workflow-freshness`,
  `typecheck`, the module and artefact test suites, and `verify-modules`.
