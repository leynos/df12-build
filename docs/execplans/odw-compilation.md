# Decompose the ODW workflow into a typed module tree

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: IN PROGRESS

## Purpose / big picture

`workflows/df12-build-odw.js` is the Open Dynamic Workflows (ODW) workflow
that drives a df12-house roadmap to completion. It began life as a single
~3,200-line JavaScript file because the ODW loader demands one file whose only
export is a literal `export const meta`, executed as an async function body
with primitives (`agent`, `parallel`, `log`, `args`, and friends) injected as
parameters. A build pipeline now exists (see "Context and orientation") that
generates that artefact from a module tree under
`src/workflows/df12-build-odw/`, and one subsystem (the recovery decision
tables) has been peeled out as a pilot.

This plan finishes the job: decompose the remaining ~2,900 lines of helpers
into focused modules, translating each module to TypeScript as it is peeled,
so that every subsystem is directly importable, unit-testable, and
type-checked, while the generated artefact keeps passing the real ODW loader
and every existing test suite. When the plan completes, a contributor can:

- run `make test-modules` and see every subsystem tested by direct import
  (no string surgery over the artefact),
- run `make typecheck` and see `tsc` verify the whole src tree, including
  correct usage of the injected ODW primitives,
- run `make all` and see the generated artefact proven fresh, loader-clean,
  and behaviourally unchanged by the whole-workflow suites.

## Constraints

- `workflows/df12-build-odw.js` remains a generated artefact framed as:
  verbatim `meta.js` banner, flat esbuild bundle, generated
  `return await workflowMain()` footer. Its loader contract must never
  regress: exactly one `export const meta` literal, no other import or
  export tokens, no `import.meta` or dynamic `import(`, parses under the
  loader wrap. `scripts/build-workflow.mjs` enforces this fail-closed and
  must keep doing so.
- `src/workflows/df12-build-odw/meta.js` stays plain JavaScript forever. It
  is concatenated into the artefact verbatim, without transpilation, so it
  must be valid loader-dialect JavaScript as written.
- Never mix a behavioural refactor with a peel or a translation. A milestone
  that needs code to change shape before it can move (for example, threading
  configuration explicitly) makes that change inside `main` first, gates it
  green, and only then relocates the code verbatim.
- `workflows/df12-build.js` (the Claude Code variant) is out of scope and
  must not be modified.
- TypeScript in the src tree is restricted to erasable syntax only: type
  annotations, interfaces, type aliases, generics, and `import type`. No
  enums, no namespaces, no parameter properties, no `export =`/`import =`.
  The enforcement mechanism is described in "Plan of work", stage A.
- Top-level declaration names must stay unique across all src modules.
  esbuild renames colliding names when flattening the bundle (for example
  `foo` and `foo2`), which would silently break the helper-surface slicing
  tests that extract helpers from the artefact by name.
- Module top-level code must not reference the injected ODW primitives
  (`args`, `agent`, `log`, ...). Only function bodies may, and only in
  modules whose tests provide them (via parameters or `globalThis`). The
  entry (`main.js`, later `main.ts`) is the sole place where top-level code
  may touch `args`.
- All existing gates stay green at every milestone boundary: `make all`
  (check-fmt, lint, typecheck, markdownlint, nixie, test-modules,
  test-workflow, workflow-freshness, verify-modules) exits 0.
- en-GB Oxford spelling in documentation and commit messages.

## Tolerances (exception triggers)

- Scope: if a single milestone's diff (excluding the regenerated artefact and
  lockfile) exceeds roughly 800 net lines, stop and escalate; propose a
  split.
- Behaviour: if any whole-workflow suite (`tests/*.test.mjs`) fails after a
  peel for a reason other than a repointed path or a source-invariant regex
  whose matched text moved files, stop. That is a behavioural diff, not
  churn.
- Typing: if honestly typing a subsystem requires redesigning its runtime
  shape (not just naming its existing shape), stop and escalate with the
  options. Landing a module with a small number of documented `unknown`s and
  narrowing guards is acceptable; landing wrong-but-quiet types is not.
- Dependencies: adding any runtime dependency, or any dev dependency beyond
  `typescript`, requires escalation. The artefact must remain dependency-free
  at runtime.
- Iterations: if a milestone's gates still fail after three fix attempts,
  stop, record the failure mode in the Decision Log, and escalate.
- Test churn: if a milestone forces edits to more than two existing artefact
  test files beyond repointing paths or updating source-invariant regex
  anchors, stop and escalate — the module boundary is probably wrong.

## Risks

- Risk: esbuild renames a top-level symbol on collision, and an
  artefact-slicing test fails far from the offending module.
  Severity: medium. Likelihood: medium.
  Mitigation: the uniqueness constraint above, plus a build-script assertion
  added in stage A that fails the build when the bundle contains an
  esbuild-style renamed identifier (a known top-level name followed by a
  numeric suffix).
- Risk: threading configuration into prompt builders (milestone 5) changes
  call-site text that source-invariant regexes anchor on.
  Severity: low. Likelihood: high.
  Mitigation: budgeted in that milestone; update the anchors in the same
  commit and keep them keyed to structural tokens.
- Risk: a hard-to-type subsystem (agent result shapes flowing through the
  pipeline stages) stalls translation.
  Severity: medium. Likelihood: medium.
  Mitigation: the typing tolerance above; shared result types are named once
  in `types.ts` (milestone 1) so later modules reuse rather than reinvent.
- Risk: `tsc` and esbuild disagree about a construct (esbuild accepts, tsc
  rejects, or vice versa).
  Severity: low. Likelihood: low.
  Mitigation: `erasableSyntaxOnly` plus `isolatedModules` confines the tree
  to the intersection both tools handle; the build and typecheck gates run
  together in `make all`.

## Progress

Completed before this plan (the spike this plan extends):

- [x] (2026-07-05) Build pipeline: `scripts/build-workflow.mjs`, Makefile
  targets `workflow-build` and `workflow-freshness`; artefact accepted by
  the real ODW loader with zero dual-compat warnings.
- [x] (2026-07-05) Source split: `src/workflows/df12-build-odw/meta.js`
  (banner) and `main.js` (helpers plus `workflowMain`); source-invariant
  tests repointed at the src tree via `readWorkflowSource()`.
- [x] (2026-07-05) Pilot peel: `recovery-decision.js` with Gherkin, property,
  and Dafny-verified differential tests; `test-modules`, `test-workflow`,
  and `verify-modules` Makefile targets.

Planned work:

- [x] (2026-07-05 18:40Z) Stage A / milestone 0: TypeScript infrastructure
  and pilot conversion. `typescript` 6.0.3 pinned; tsconfig gained
  `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`, and
  `allowImportingTsExtensions`; `odw-globals.d.ts` declares the injected
  primitives; `tsc --noEmit` wired into `make typecheck`;
  `recovery-decision.js` converted to `.ts` with interface types; the
  build script now fails when a module's exported top-level name is
  missing or renamed in the bundle. Enforcement spot-checked in-tree: an
  `enum` fails typecheck with TS1294, and reverts cleanly. `make all`
  green including Dafny (4 verified, 0 errors).
- [ ] Milestone 1: schemas and shared types (`schemas.ts`, `types.ts`).
- [ ] Milestone 2: roadmap parsing and selection (`roadmap.ts`).
- [ ] Milestone 3: process and failure-classification helpers
  (`exec.ts`, `faults.ts`).
- [ ] Milestone 4: git evidence and recovery discovery (`git-evidence.ts`,
  `recovery-discovery.ts`).
- [ ] Milestone 5: configuration record and prompt builders (`config.ts`,
  `prompts.ts`).
- [ ] Milestone 6: write preflight (`write-preflight.ts`).
- [ ] Milestone 7: ExecPlan durability and containment
  (`execplan-durability.ts`).
- [ ] Milestone 8: assessment and remediation triage (`assessment.ts`,
  `remediation.ts`).
- [ ] Milestone 9: dual review, integration, and the per-task pipeline
  (`integration.ts`, `run-task.ts`).
- [ ] Milestone 10: convert `main.js` to `main.ts`; retire artefact slicing
  from tests that can now import modules; close out the plan.

## Surprises & discoveries

- Observation: `node --test` on Node 22+ type-strips and executes `.ts`
  files, so it discovers bun-only suites unless scoped.
  Evidence: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` failures during the
  spike's gate run.
  Impact: `test-workflow` is scoped to `tests/*.test.mjs`; keep it that way.
- Observation: esbuild's reprinting (quote normalization, comment stripping)
  breaks regexes over the artefact.
  Evidence: six source-invariant tests failed against the first bundled
  artefact.
  Impact: source-invariant tests read the src tree; artefact tests key on
  names and behaviour only.
- Observation: esbuild does not resolve a `./module.js` import to a
  `module.ts` file on disk, so converting a module means updating its
  importers to the `.ts` extension in the same commit
  (`allowImportingTsExtensions` makes tsc accept this).
  Evidence: milestone 0 pilot conversion.
  Impact: each later conversion touches its importers' import lines; the
  build fails loudly if one is missed, so this is churn, not risk.
- Observation: `tsc` excess-property checking rejects object literals with
  fields a narrow structural parameter type does not name, even though the
  runtime ignores them.
  Evidence: `recoveryContinueDecision(candidate, evidence, { status,
  ticked: 0, unticked: 0 }, ...)` failed TS2353 against
  `planState: { status: string }`.
  Impact: peeled function signatures should name the full shape callers
  actually pass, with optional fields, not just the fields the body reads.

## Decision log

- Decision: translate to TypeScript at decomposition time (one touch per
  module), not as a second pass.
  Rationale: typing a module is the same intellectual work as discovering
  its interface during extraction; a second pass would touch every module,
  regex, and review twice for no added safety, since erasable-only TS
  cannot change runtime behaviour and the same gates run either way.
  Date/Author: 2026-07-05, Claude with pmcintosh.
- Decision: enforce the TS feature restriction with compiler flags
  (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`) rather
  than a lint rule set.
  Rationale: `erasableSyntaxOnly` is TypeScript's own definition of
  "annotations only" — it rejects enums, namespaces with runtime code,
  parameter properties, and `import =`/`export =` at compile time, with no
  extra tooling; the build script's fail-closed bundle checks remain as the
  second, independent line of defence.
  Date/Author: 2026-07-05, Claude with pmcintosh.
- Decision: `meta.js` stays JavaScript permanently.
  Rationale: it is concatenated verbatim into the artefact without any
  transpilation step, so it must be loader-dialect JS as written.
  Date/Author: 2026-07-05, Claude with pmcintosh.

## Outcomes & retrospective

To be completed as milestones land.

## Context and orientation

Read `AGENTS.md` and `docs/developers-guide.md` first. The moving parts:

- `src/workflows/df12-build-odw/meta.js` — the literal
  `export const meta = { ... }` banner, concatenated verbatim into the
  artefact. Plain JavaScript, never transpiled.
- `src/workflows/df12-build-odw/main.js` — everything else today: a
  configuration block reading the injected `args`, ~100 top-level helper
  functions and schema constants, and `async function workflowMain()`
  wrapping the worker-pool control loop. Its internal section banners
  (lines beginning `// ----`) name the subsystems this plan peels:
  Configuration; Shared preamble; Schemas; Deterministic roadmap selection;
  Prompt builders; Fresh-run recovery discovery; Task-agent writable-root
  preflight; Host-enforced ExecPlan durability; Dual review + serialized
  integration; Per-task pipeline; the control loop.
- `src/workflows/df12-build-odw/recovery-decision.js` — the pilot peeled
  module (pure decision tables). Milestone 0 converts it to `.ts`.
- `scripts/build-workflow.mjs` — bundles `main.js` with esbuild
  (`format: 'esm'`, no-export entry, tree shaking disabled), frames the
  artefact, and fails closed on loader-contract hazards.
- `workflows/df12-build-odw.js` — the generated artefact. The sidecar
  copies this one file; ODW loads it.
- `tests/*.test.mjs` — whole-workflow suites (helper-surface slicing over
  the artefact, control-loop simulation, mock-adapter smoke through the
  real `odw` binary). Run by `make test-workflow`.
- `tests/modules/` — bun-run module suites: Gherkin features via
  `@aboviq/bun-test-cucumber` (preloaded by `bunfig.toml` through
  `tests/modules/cucumber-plugin.ts`), fast-check properties, and the
  differential test pinning the Dafny-verified twin in
  `verify/recovery-decision.model.ts` to production. Run by
  `make test-modules`.
- `Makefile` — `make all` runs every gate; `make workflow-freshness` fails
  when the committed artefact is stale.

Terms: a "peel" is a verbatim relocation of code from `main.js` into a new
module plus the import wiring; "erasable syntax" is TypeScript that deletes
cleanly to JavaScript (annotations, interfaces, `import type`), producing
byte-identical runtime behaviour; the "slicing tests" compile the artefact's
prefix (everything above the re-inserted control-loop marker) with `new
Function` and return named helpers.

## Plan of work

### Stage A (milestone 0): TypeScript infrastructure and pilot conversion

Add `typescript` as a dev dependency (`bun add -d typescript`). Extend
`tsconfig.json` with the enforcement flags:

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  }
}
```

This is the proposed checking mechanism for restricting TypeScript to the
prescribed features, and it has three layers:

1. `erasableSyntaxOnly` makes `tsc` reject every construct that generates
   runtime code — enums, namespaces with bodies, parameter properties,
   `import =`/`export =` — so the tree is annotations-only by compiler
   error, not by convention.
2. `verbatimModuleSyntax` forces type-only imports to be written
   `import type`, keeping the runtime import graph explicit so the bundler
   and the reader agree about what executes.
3. `scripts/build-workflow.mjs` keeps its independent fail-closed checks on
   the bundle output (no import/export tokens, no module wrappers, no
   `import.meta`, single `workflowMain`, loader wrap parses), so even a
   construct that slipped past `tsc` cannot reach the artefact. Stage A
   also adds the renamed-identifier assertion described under Risks.

Create `src/workflows/df12-build-odw/odw-globals.d.ts` declaring the
injected primitives (`agent`, `parallel`, `pipeline`, `phase`, `log`,
`args`, `budget`, `workflow`, `validate`) with honest signatures, so
primitive misuse is a type error everywhere in the tree.

Wire `bunx tsc --noEmit` (via the pinned dev dependency, not a floating
`bunx` download) into the Makefile `typecheck` target alongside the
existing `workflow-parse`.

Convert `recovery-decision.js` to `recovery-decision.ts` (annotations only),
update the import in `main.js` and in the three `tests/modules/` suites,
rebuild, and confirm every gate. This proves the whole TS path against the
existing gates before any new subsystem moves.

### Stage B/C pattern for every subsequent milestone

Each milestone follows the same red-green shape:

- Red: create the milestone's module test file under `tests/modules/`
  importing from the module path that does not exist yet, with table-driven
  cases derived from the subsystem's existing artefact-level tests plus any
  gaps found while reading it. `bun test tests/modules` fails with a module
  resolution error — that is the red state, and it fails for the expected
  reason.
- Green: peel the subsystem verbatim into the new `.ts` module, add
  annotations, wire imports in `main.js`, rebuild the artefact, and run
  `make all`. The new tests pass; the artefact suites prove behaviour
  unchanged.
- Refactor: only test-side cleanup (for example, converting an
  artefact-slicing test to a direct import) — never runtime-shape changes.

Where a subsystem's behaviour is contract-like (decision tables, parsers),
also add a Gherkin feature under `tests/modules/features/` following the
existing `recovery-decision.feature` pattern, and consider a fast-check
property where a round-trip or invariant exists. Extending the verified-twin
approach (LemmaScript/Dafny) to further subsystems is optional and only
where a genuine safety theorem exists; do not manufacture proofs.

### Milestone ordering and boundaries

Milestones are ordered so that pure, dependency-light modules move first and
anything depending on the configuration record moves after milestone 5.
Boundaries below name the section banners in today's `main.js`; confirm
exact line ranges by grep at execution time, since earlier milestones shift
them.

1. Milestone 1 — `schemas.ts` and `types.ts`: the schema constants
   (`PLAN_SCHEMA` through `ASSESSMENT_SCHEMA`,
   `ASSESSMENT_CLASSIFICATIONS`) move to `schemas.ts`. `types.ts` names the
   shared runtime shapes (task, worktree record, stage results, fault
   metrics) as interfaces for later milestones to import with
   `import type`. Schema contract tests move to direct import.
2. Milestone 2 — `roadmap.ts`: `TASK_LINE_RE` through `parseRoadmap`,
   `isComplete`, `isTaskFullyComplete`, selection and blocked-reporting
   helpers. Pure text-in, data-out; prime fast-check territory.
3. Milestone 3 — `exec.ts` and `faults.ts`: `execFileText`,
   `execFileStatus`, `fileState`, `shellQuote` in `exec.ts`;
   `authFailureDetail`, `providerFailureDetail`,
   `infrastructureFailureDetail`, and `withInfraRetry` in `faults.ts`.
   `withInfraRetry` mutates `faultMetrics`, so the metrics object moves to
   `faults.ts` and `main.js` imports it.
4. Milestone 4 — `git-evidence.ts` and `recovery-discovery.ts`: the
   evidence collectors and `discoverRecoveryCandidates` plus
   `readExecplanState`. These reference configuration constants
   (`RESUME_TASK_ID`, `RESUME_MAX_CANDIDATES`, `BASE`); the peel makes them
   explicit parameters — a shape change, so it lands as its own
   refactor-in-place commit first (see Constraints), gated green, then the
   move.
5. Milestone 5 — `config.ts` and `prompts.ts`: introduce
   `makeConfig(args)` returning a frozen configuration record with today's
   defaulting logic; `main.js` computes `const cfg = makeConfig(args)` at
   the top. The preamble and prompt builders then move to `prompts.ts`
   taking the record (or the specific fields) explicitly. This is the
   milestone with the largest call-site churn and the source-invariant
   regex updates budgeted under Risks.
6. Milestone 6 — `write-preflight.ts`: `WRITE_PROBE_SCHEMA` and the
   writable-root gate helpers.
7. Milestone 7 — `execplan-durability.ts`: `execplanRelPath` containment
   and the host-enforced durability helpers (`verifyExecplanCommitted`,
   `verifyWorktreeCommitted`, `commitExecplanDraft`,
   `commitExecplanApproval`). Security-sensitive: the containment tests
   move to direct import in the same milestone and must cover the escape
   cases (`../`, absolute paths) before the move (red includes them).
8. Milestone 8 — `assessment.ts` and `remediation.ts`: assessment prompt
   builders, `shouldAssessFailure`, evidence shaping, and the remediation
   triage helpers.
9. Milestone 9 — `integration.ts` and `run-task.ts`: the shared dual-review
   and serialized-integration path, then `runTask`. These orchestrate
   agents; their tests are simulation-style (scripted `agent` stubs) and
   already exist at artefact level, so the milestone's red stage is thin —
   mostly converting those suites to import the modules and provide
   primitives explicitly.
10. Milestone 10 — rename `main.js` to `main.ts` (annotations only; the
    entry keeps the configuration call, module wiring, `workflowMain`, and
    the control loop), update the build entry point, retire any remaining
    artefact-slicing in tests whose helpers now live in modules, update
    `AGENTS.md`, `docs/developers-guide.md`, and this plan's living
    sections, and record the retrospective.

## Concrete steps

All commands run from the repository root
(`/home/leynos/Projects/df12-build.worktrees/odw-compilation` or the branch's
checkout). Per milestone:

```bash
bun test tests/modules            # red: new suite fails to resolve module
# ...peel + annotate + wire imports...
make workflow-build               # regenerate the artefact
bun test tests/modules            # green: module suites pass
make all                          # every gate, including freshness + Dafny
```

Expected tail of a green `make all`:

```plaintext
Dafny program verifier finished with 4 verified, 0 errors
```

(with the verifier count growing only if new twins are added). Commit each
milestone separately with a file-based commit message, gates green, and the
regenerated artefact staged alongside its sources. Delegate full gate runs
to the `scrutineer` subagent where available.

## Validation and acceptance

Done means, at the final milestone:

- `src/workflows/df12-build-odw/` contains `meta.js` (JS), `main.ts`, and
  the modules named above, each with direct-import tests under
  `tests/modules/`.
- `make typecheck` runs `tsc --noEmit` over the tree with
  `erasableSyntaxOnly` and `verbatimModuleSyntax` on, exiting 0; adding
  `enum Foo {}` to any src module makes it exit non-zero (spot-check this
  once, then revert).
- `make all` exits 0: 96+ whole-workflow tests, 21 operator-script tests,
  all module suites, artefact freshness, and Dafny verification.
- The built artefact still loads through the real ODW loader
  (`loadWorkflowScript` from the local ODW checkout accepts it; the smoke
  suite drives it through the `odw` binary) with zero `scanDualCompat`
  warnings.
- No behavioural change: the whole-workflow suites are the oracle; any
  assertion change in them beyond path repointing and regex re-anchoring
  was escalated, not absorbed.

## Idempotence and recovery

Every step is re-runnable: the build regenerates the artefact
deterministically, and `git diff` plus `make workflow-freshness` expose any
drift. If a milestone goes wrong mid-way, `git checkout -- .` restores the
last committed state; nothing in the plan mutates state outside the
repository except `bun add -d typescript` (lockfile, committed) and test
fixtures under temporary directories.

## Interfaces and dependencies

Dev dependencies after stage A: `esbuild`, `typescript`, `fast-check`,
`lemmascript`, `@aboviq/bun-test-cucumber`, `@types/bun`. No runtime
dependencies, ever — the artefact runs inside ODW's wrapper with only
injected primitives and `process.getBuiltinModule`.

The ambient declaration file must exist at
`src/workflows/df12-build-odw/odw-globals.d.ts` and declare at minimum:

```typescript
declare function agent(prompt: string, opts?: AgentOptions): Promise<unknown>
declare function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
declare function phase(title: string): void
declare function log(message: string): void
declare const args: Record<string, unknown> | undefined
declare const budget: { total: number | null; spent(): number; remaining(): number }
```

with `AgentOptions` naming `label`, `phase`, `schema`, `adapter`, `model`,
and `agentType`. Signatures must match ODW's `src/primitives.ts` semantics
(an `agent` failure throws; `parallel` resolves failed slots to `null`).

## Revision note

2026-07-05: initial draft, written after the build-pipeline spike landed on
this branch (see Progress for what that spike already delivered).
