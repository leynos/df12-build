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

**This codebase is not common-or-garden TypeScript/JavaScript.** The ODW source
is a restricted dialect that compiles to a single-file workflow artefact. Where
general TS/JS advice below conflicts with the ODW dialect (no runtime imports,
no CommonJS, forbidden temporal/random calls, JSON-Schema validation rather than
a runtime validator library), the ODW rule wins — those points are called out
explicitly.

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
- A new module must be reachable through `main.ts`'s import graph — imported by
  `main.ts` or by a module it transitively imports, each with the explicit
  `.ts` import extension — or `scripts/build-workflow.mjs` fails closed because
  the module's exports never enter the bundle. Do not reuse a top-level export
  name across modules (esbuild renames the collision and the build rejects it),
  and keep the tree acyclic ESM (no import cycles, no CommonJS).
- Do not import ODW primitives (they are ambient in `odw-globals.d.ts`), and do
  not use `Date.now()`, `Math.random()`, or arg-less `new Date()`.
- Run `make all` before committing; it includes `workflow-freshness`,
  `typecheck`, the module and artefact test suites, and `verify-modules`.

## Code style and structure

- **Code is for humans.** Write with clarity and empathy, assuming a tired
  teammate may need to debug it at 3 a.m.
- **Comment _why_, not _what_.** Comments explain assumptions, edge cases,
  trade-offs, or complexity. Do not restate the obvious. The ODW modules lean
  on this heavily — the durability, recovery, and fault-classification helpers
  are only safe to change once the "why" in their comments is understood.
- **Clarity over cleverness.** Concision is valued, but explicit code beats
  terse or obscure idioms.
- **Use functions and composition.** Avoid repetition by extracting reusable
  logic; prefer declarative code over imperative repetition when readability is
  preserved. In the ODW tree, extraction happens through `makeX(deps)`
  factories bound once in `main.ts`, not through shared mutable module state.
- **Small, single-responsibility functions** obedient to command/query
  separation.
- **Name things precisely.** Boolean names prefer `is`, `has`, or `should`.
- **Structure logically and group by feature.** Each `src/workflows/df12-build-odw/`
  module encapsulates one subsystem (config, recovery, host review, assessment,
  the task pipeline, …); keep its helpers, schemas, and tests colocated.
- **en-GB Oxford spelling** (`-ize` / `-yse` / `-our`, the `en-gb-oxendict`
  skill) in all prose, comments, and commits, except references to external
  APIs.
- **Keep modules cohesive rather than counting lines.** Some ODW modules are
  large by necessity (the control loop, the task pipeline); extract when a
  module or function takes on multiple responsibilities. The CodeScene
  code-health gate (`csCheck`, see the users' guide) is the machine signal for
  oversized or complex code — treat its findings, not a fixed line count, as the
  size/complexity threshold.

## Documentation maintenance

- The Markdown files under `docs/` are the knowledge base and source of truth
  for requirements, dependency choices, and architectural decisions. Update the
  relevant file(s) proactively when decisions, requirements, or patterns change
  — documentation must stay accurate and current.
- Behavioural changes to the ODW workflow must update all relevant prompts,
  schemas, docs, and validation notes in the same branch (see the developers'
  guide "ODW workflow contract").
- Documentation uses en-GB Oxford spelling (exception: the `LICENSE` filename,
  left unchanged for community consistency).
- The developers' guide (`docs/developers-guide.md`) is the contributor
  reference; the compilation monograph
  (`docs/odw-compilation-and-compile-time-testing.md`) is the reference for the
  build and compile-time-testing mechanism.

## Change quality and committing

- **Atomicity.** Keep changes small, focused, and atomic — one logical unit of
  work per commit.
- **Quality gates.** Before a change is complete, it must:
  - validate new behaviour with relevant unit and behavioural tests; a bug fix
    ships with a test that fails before the fix and passes after;
  - pass every gate in `make all` — `check-fmt`, `lint`, `typecheck`,
    `markdownlint`, `nixie`, `docs-check`, the module and artefact test
    suites, `workflow-freshness`, and `verify-modules`;
  - keep the generated artefact fresh (`make workflow-build`) and committed
    alongside the source.

    Prefer running the full commit-gate suite through the `scrutineer` subagent,
    which runs the gates sequentially (for build-cache benefit) and returns a
    bounded report.
- **Commit messages.** Imperative mood ("Add …", not "Added …"); a concise
  subject line (≈50 characters), a blank line, then a body wrapping at 72
  characters that explains _what_ and _why_ (rationale, goals, scope); Markdown
  for any formatted body content. Do **not** add AI/bot attribution trailers.
- Only changes that meet every gate should be committed.

## Refactoring heuristics

Assess the code regularly for refactoring opportunities, and act when you see:

- long functions doing too many things;
- duplicated logic in multiple places (DRY violations);
- deeply nested or complex conditionals (high cyclomatic complexity);
- large blocks of logic dedicated to deriving a single value;
- primitive obsession or data clumps (groups of primitives passed around
  together, hinting at a missing type);
- excessive parameters (group related ones into a typed object);
- feature envy (a function more interested in another module's data than its
  own); or
- shotgun surgery (one change requiring many small edits across modules).

Several of these are now machine-enforced: the CodeScene code-health gate
flags Complex Method, Bumpy Road, Primitive Obsession, DRY violations, and
related smells on changed files before CodeRabbit. Clear a flag by refactoring;
only where further refinement would be deleterious, suppress the specific smell
with a justified `@codescene(disable:"…")` comment.

Do refactoring as a **separate, atomic commit after** the functional change,
with behavioural tests passing before and after and the refactor commit itself
passing every gate.

## Markdown guidance

- Validate with `make markdownlint` (or `bunx markdownlint-cli2 "**/*.md"`) and
  validate Mermaid diagrams with `make nixie`.
- `make markdownlint` also refreshes the shared en-GB-oxendict base,
  regenerates `typos.toml`, and checks maintained prose with the pinned `typos`
  release. Put narrow repository-only exceptions in `typos.local.toml`; never
  edit the generated configuration by hand.
- Wrap prose and bullet points at 80 columns; wrap code blocks at 120 columns;
  do not wrap tables or headings.
- Use dashes (`-`) for list bullets and GitHub-flavoured footnotes (`[^1]`) for
  references.

## TypeScript in the ODW dialect

The `src` tree is TypeScript, but it is **not** ordinary application
TypeScript — it is a restricted dialect that type-strips into the single-file
ODW workflow.
Apply the general clarity and strictness goals, subject to these ODW rules:

- **Erasable syntax only.** `tsconfig.json` sets `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, and `isolatedModules` under `strict`. No enums,
  parameter properties, or runtime namespaces; type annotations, `interface`,
  `type`, and `as` casts are fine. Use `import type` / `export type` for
  type-only imports.
- **No CommonJS, no import cycles — the opposite of a CJS build exception.**
  Either makes esbuild emit a module-closure wrapper that fails the build. Keep
  the tree acyclic ESM.
- **The workflow source has no runtime dependencies and imports nothing at
  runtime** except sibling `.ts` modules (with the explicit `.ts` extension) and
  Node builtins via `process.getBuiltinModule('node:…')`. ODW primitives
  (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`,
  `workflow`, `validate`) are ambient (`odw-globals.d.ts`), never imported.
- **Validate agent I/O with JSON Schema, not a validator library.** Structured
  agent output is contracted through the schemas in `schemas.ts` (which ODW
  enforces at the agent boundary). Do not reach for `zod` or similar — the
  dialect forbids the import, and the schema is also the cross-adapter contract.
- **Time and randomness are forbidden, not merely centralized.** `Date.now()`,
  `Math.random()`, and arg-less `new Date()` are banned by ODW's dual-compat
  scan (they break deterministic run resumption under Claude Code). Hash a seed
  instead of `Math.random()`, and shell out to `date` for timestamps.
- **Immutability first.** Prefer `const`, `readonly`, and returning new objects
  over mutating inputs. The recovery/assessment evidence collectors and result
  shapers depend on this.
- **Typed-object parameters and predicate extraction.** Group related parameters
  into typed objects rather than long positional lists; extract predicate
  helpers or lookup tables when branching grows complex, and give exhaustive
  `switch` logic a `never` guard.
- **Module docstrings.** Begin each module with a `/** … @module */` block (a
  top JSDoc comment ending with TypeDoc's bare `@module` tag) describing its
  purpose and responsibilities. `make docs-check` (TypeDoc's `notDocumented`
  validation, zero tolerance) enforces this and a JSDoc block on every
  exported declaration across the tree; JSON Schema constants are tagged
  `@internal` so their `description` fields remain the per-field
  documentation.

## Testing

The workflow cannot be exercised by running it without an ODW runtime and agent
budget, so tests are layered (see the `odw-testing` skill and the compilation
monograph):

- **Module tests** (`tests/modules/`, `make test-modules`) run under `bun test`
  against the individual `src` modules — Gherkin scenarios via
  `@aboviq/bun-test-cucumber`, `fast-check` properties, and the LemmaScript/Dafny
  differential test.
- **Artefact tests** (`tests/*.test.mjs`, `make test-workflow`) run under
  `node --test` against the built `workflows/df12-build-odw.js`, plus the Python
  operator-script tests.
- **Compile-time behaviour** is guarded by `tsc`, the `workflow-parse` gate, the
  build's own fail-closed assertions, and
  `tests/modules/compile-time-contract.test.ts`.
- Keep tests deterministic (the banned temporal/random calls already help);
  prefer fixtures and factories (`tests/fixtures/`, `tests/support/`) over ad hoc
  object literals; drive variations with helpers or compact loops; and pin
  source-invariant assertions against the `src` tree via
  `readWorkflowSource()` / `readModuleSource()`, not the reprinted artefact.
- Do not run format, lint, or test suites in parallel — the build cache rewards
  sequential runs. The `scrutineer` subagent is the sanctioned gate-runner.

## Dependency management

- The devDependencies (`esbuild`, `fast-check`, `lemmascript`,
  `markdownlint-cli2`, `@aboviq/bun-test-cucumber`, `typescript`, `@types/bun`)
  are **build and test tooling only** — the shipped workflow source has no
  runtime dependencies (the dialect forbids runtime imports).
- Use caret ranges (`^x.y.z`) for direct dependencies unless a narrower range is
  justified. Commit the lockfile and rebuild it deliberately on major tool
  upgrades. Prefer small, actively maintained packages and cull unused ones.

These practices keep the codebase high-quality and the generated ODW artefact
trustworthy.
