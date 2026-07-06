# Decompose the ODW workflow into a typed module tree

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: COMPLETE

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
- [x] (2026-07-05 20:10Z) Milestone 1: schemas and shared types. All eight
  agent schema constants plus `ASSESSMENT_CLASSIFICATIONS` peeled to
  `schemas.ts`; `types.ts` names `RoadmapTask`, `SelectedTask`,
  `RecoveryCandidate`, and `FaultMetrics`. New direct-import contract
  suite `tests/modules/schemas.test.ts` (red-then-green): closed-object
  and required-exists checks over every schema, enum ↔ ADR 002
  classification, mock-satisfiability of `dirtyState`. Milestone 0's
  CodeRabbit review returned zero findings before this milestone began.
- [x] (2026-07-05 21:05Z) Milestone 2: roadmap parsing and selection peeled
  to `roadmap.ts` (regexes, `parseRoadmap`, `completedIds`,
  `selectRoadmapTask`, `roadmapTaskIndex`, `candidateRoadmapComplete` and
  friends). `taskMatchesOnlyTask`/`selectRoadmapTask` were parameterized
  on `onlyTask` (single control-loop call site updated to pass
  `ONLY_TASK`). New red-then-green module suites: an eight-scenario
  Gherkin feature for selection semantics (earliest-unblocked, Requires
  gating, step-range expansion, addendum lane, taken exclusion, taskId
  filter) and fast-check properties (step-range expansion, generated
  roadmap round-trips, phase-prefix completion, selection invariants).
  Milestone 1's CodeRabbit review returned zero findings first.
- [x] (2026-07-05 22:00Z) Milestone 3: `exec.ts` (execFile wrappers,
  `shellQuote`, `fileState`) and `faults.ts` (classifiers, `faultMetrics`,
  `resultFromUnhandledAgentError`, retry). `withInfraRetry` became a
  factory — `makeWithInfraRetry(attempts)` in the module, bound once in
  `main.js` as `const withInfraRetry = makeWithInfraRetry(STAGE_ATTEMPTS)`
  — so all nine multiline call sites and the source-invariant regexes
  stayed untouched, and no top-level name collides with a module export
  (which the build's rename assertion would reject). Red-then-green
  suites: sixteen-row classifier table with negatives, retry-budget and
  never-retry-product behaviour, error-routing, `shellQuote` reverse
  property, and `fileState` absent-vs-fault cases. Milestone 2's
  CodeRabbit review returned zero findings first.
- [x] (2026-07-05 23:00Z) Milestone 4: `git-evidence.ts` (name-status and
  porcelain parsers, `gitEvidence`, `collectAssessmentEvidence`,
  `readFileText`, `directoryExists`) and `recovery-discovery.ts`
  (`makeRecoveryDiscovery`, `readExecplanState`,
  `RECOVERY_HOLD_REASONS`, `recoveryExecplanPath`,
  `syntheticRecoveryImpl`). The planned refactor-in-place commit was
  superseded: discovery limits bind through the
  `makeRecoveryDiscovery({ base, resumeTaskId, resumeMaxCandidates })`
  factory (the milestone 3 pattern), preserving the artefact test at
  `tests/df12-build-odw-recovery.test.mjs:218` that drives
  `discoverRecoveryCandidates(text, dir)` with config flowing from the
  factory args. Red-then-green suites reuse the shared recovery fixture
  repo: discovery mapping/skip reasons, resumeTaskId filter, candidate
  cap, broken-root error path, ExecPlan missing-vs-unreadable, canonical
  plan resolution, and the synthetic implementation bridge. Milestone 3's
  CodeRabbit review returned zero findings first.
- [x] (2026-07-05 23:55Z) Milestone 5: `config.ts` (`makeConfig(args)` — a
  record whose fields keep the historical constant names, so `main.js`
  destructures it in one statement and every reference survives; the
  projectRoot chdir side effect stays in the entry) and `prompts.ts`
  (`makePrompts(config)` destructures those names at factory top so the
  fourteen prompt-builder bodies moved verbatim, generated by script from
  main.js with typed signatures substituted). New suites: the full args
  contract (defaults, taskId single-laning, resumeMaxCandidates clamps,
  resumeMode validation, dryRun waiving CodeRabbit auth, search-backend
  routing, commit-gate derivation, auth-required set) and data-flow
  prompt tests (round state, blocking items, execplan paths, configured
  gates and base branch reaching the text — never prose). One
  under-destructure (`COMMIT_GATES`) was caught by the artefact slicing
  suites, not tsc — see Surprises. Milestone 4's CodeRabbit review
  returned zero findings first.
- [x] (2026-07-06 00:35Z) Milestone 6: `write-preflight.ts` — probe
  construction, `clearProbeArtifact`, `verifyWriteProbe` (O_NOFOLLOW
  handle discipline), `hostWriteProbe`, and `makeWritePreflight({
  enabled, targets })` returning `runTaskAgentWritePreflight` and the
  memoized `ensureTaskAgentWriteAccess` with their original two-argument
  shapes (the artefact suites call them directly, so signatures were
  load-bearing). `writeProbeTargets` stays in the entry — it routes
  planner/builder adapters from run configuration. Red-then-green module
  suite covers the untrusted-worktree cases: symlink removal without
  touching the target, symlink/directory rejection at the probe path,
  claim-without-write failing on host evidence, and one-probe-per-run
  memoization. Milestone 5's CodeRabbit review returned zero findings
  first.
- [x] (2026-07-06 01:15Z) Milestone 7: `execplan-durability.ts` —
  `execplanRelPath` containment, `verifyExecplanCommitted`,
  `commitExecplanApproval`, `commitExecplanDraft`, and
  `verifyWorktreeCommitted`, all direct exports (no config coupling).
  The red suite covered the escape shapes first (`../` variants,
  absolute paths outside the worktree, empty/`.`/`..`), plus durability
  verdicts against real repos: committed-clean, dirty, missing-at-HEAD,
  the idempotent APPROVED flip (including the append-when-absent path),
  plan-only draft salvage vs foreign-dirty bounce, and the bounded dirty
  sample. Milestone 6's CodeRabbit review returned zero findings first.
- [x] (2026-07-06 02:05Z) Milestone 8: `assessment.ts` (deferred-review
  classifiers, `implementationAuthFailureDetail`, the manual-merge
  handoff guard as direct exports; `makeAssessment({ preamble,
  assessPartialBranches, assessmentAgentOptions, withInfraRetry })`
  returning the two ADR 002 prompts, `assessRecoveryCandidate`,
  `shouldAssessFailure`, and `attachAssessment`) and `remediation.ts`
  (`TRIAGE_SCHEMA`, `stepOf` direct; `makeRemediation({ preamble, base,
  roadmap, triageAgentOptions })` returning `triagePrompt`/`runTriage`).
  Red-then-green suites: classifier tables with negatives, the handoff
  guard matrix, the assessment gate matrix (excluded stages/statuses and
  fault-shaped details), attach-with-evidence over a fixture repo
  (including null-reply and thrown-agent paths), triage lane contract,
  and the triage agent wiring. Milestone 7's CodeRabbit review returned
  zero findings first.
- [x] (2026-07-06 03:10Z) Milestone 9: the shared pipeline stages, dual
  review + serialized integration, and `runTask` peeled into a single
  `run-task.ts` (one subsystem, one module — a separate `integration.ts`
  would have split `runDualReviewAndIntegration` from the stages it is
  interleaved with). `summarizeReviewVerdict`/`summarizeFixReport` are
  direct exports; `makeTaskPipeline(deps)` binds the run wiring
  (twenty-two dependencies: config caps, nine prompt builders, three
  agent-option routers, two stage locks, retry, assessment, write gate,
  worktree creation) once after the semaphores. `readWorkflowSource()`
  in the three invariant suites now concatenates the whole src tree so
  regexes keep matching as helpers migrate; one regex needed a
  re-anchor for the TypeScript result cast (`(await buildLock(...)`).
  New scripted-primitive module suite: happy path, fix-round loop,
  bounded review halt with assessment, fatal-auth bypass of assessment,
  the dirty-worktree durability gate, addendum manual-merge handoff,
  and the recovery-resume kind tag through the shared integration path.
  main.js is down to 1,006 lines (config unpacking, bindings, auth
  preflight, worktree creation, recovery glue, control loop).
  Milestone 8's CodeRabbit review returned zero findings first.
- [x] (2026-07-06 04:20Z) Milestone 10: `main.js` renamed to `main.ts` and
  fully annotated under strict + erasableSyntaxOnly (typed control-loop
  state, generic mutex/semaphore, `TaskOutcome`/`RecoveryRunSummary`
  records, error narrowing in every catch). The tsc blind spot recorded
  in Surprises is closed: the entry is now checked. Two invariant regexes
  gained optional `as …` groups to tolerate result casts. The artefact
  slicing suites were deliberately retained rather than retired (see
  Decision Log). Final acceptance: the real ODW loader accepts the
  artefact (13 phases, compiled `run`, zero dual-compat warnings), 231
  module tests, 96 artefact tests, 21 operator-script tests, `make all`
  green including Dafny.

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
- Observation: `tsc` does not check identifier references inside `main.js`
  (`allowJs` with `checkJs: false`), so a missed name in the config
  destructure produced no compile error and surfaced only as a
  `ReferenceError` in the artefact slicing suites.
  Evidence: milestone 5's dropped `COMMIT_GATES` binding — 28 artefact
  tests failed while `tsc` stayed silent.
  Impact: after any edit to `main.js`, the artefact suites are the real
  gate; treat tsc silence as covering only the `.ts` modules until
  milestone 10 converts the entry.
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
- Decision: when a helper closes over a run-configuration constant, prefer
  exporting a factory (`makeWithInfraRetry(attempts)`) bound once in the
  entry over threading the constant through every call site.
  Rationale: call sites keep their shape (no source-invariant regex churn,
  no multiline edits), and a same-named local binding in the entry plus a
  same-named module export would collide in the flat bundle and trip the
  rename assertion; the factory avoids both.
  Date/Author: 2026-07-05, Claude.
- Decision: the build-script rename assertion requires every src module to
  be imported by the bundle, so new modules must be wired into `main.js`
  in the same change that creates them (a module authored ahead of its
  import fails `make workflow-build`).
  Rationale: observed during milestone 3; this is fail-closed in the right
  direction — an orphaned module is a mistake, not a state to preserve.
  Date/Author: 2026-07-05, Claude.
- Decision: milestone 9 delivered one module (`run-task.ts`) instead of the
  drafted `integration.ts` + `run-task.ts` split.
  Rationale: `runDualReviewAndIntegration` is interleaved with the stage
  helpers and `runTask` through shared summarizers, locks, and result
  shapes; splitting them would have created a circular seam for no
  testing or readability gain.
  Date/Author: 2026-07-06, Claude.
- Decision: the artefact-slicing suites are retained, not retired, at
  milestone 10.
  Rationale: they exercise the GENERATED artefact — the single file the
  sidecar ships and ODW loads — so they are end-to-end evidence the
  module suites cannot replace; retiring them would lose coverage, not
  remove duplication.
  Date/Author: 2026-07-06, Claude.
- Decision: `meta.js` stays JavaScript permanently.
  Rationale: it is concatenated verbatim into the artefact without any
  transpilation step, so it must be loader-dialect JS as written.
  Date/Author: 2026-07-05, Claude with pmcintosh.

## Outcomes & retrospective

Delivered in full, eleven milestones over one continuous run, every
milestone gated green deterministically before a CodeRabbit review that
returned zero findings each time. The ODW workflow is now built from
eleven typed modules plus a 1,000-line typed entry; every subsystem is
unit-tested by direct import (231 bun tests: Gherkin scenarios,
fast-check properties, fixture-repo suites, a scripted-primitive
pipeline harness, and a Dafny-verified decision-table twin pinned by
differential testing), while the 96 artefact tests and the mock-adapter
smoke run keep validating the single generated file that ships.

What worked well: the factory-binding pattern (`makeX(deps)` bound once
in the entry) absorbed every configuration coupling without touching
call sites or source-invariant regexes; content-anchored extraction
scripts made verbatim relocation safe; and the artefact suites caught
the one real slip (the `COMMIT_GATES` under-destructure) that the
type-checker could not see while the entry was still JavaScript.

What would be done differently: widening `readWorkflowSource()` to the
whole src tree should have happened at milestone 0 rather than
milestone 9 — the invariants were coupled to file layout from the
start. Type the entry earlier if repeating this: the `checkJs: false`
window (milestones 1–9) was the only period with a real blind spot.

Deviation from the drafted plan, both logged in the Decision Log:
milestone 9 produced one module (`run-task.ts`) instead of two, and the
artefact-slicing suites were retained rather than retired.

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
   (`RESUME_TASK_ID`, `RESUME_MAX_CANDIDATES`, `BASE`); rather than the
   originally planned explicit-parameter refactor, the limits bind once
   through a `makeRecoveryDiscovery` factory (see Decision Log), keeping
   existing call sites and artefact tests intact.
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

2026-07-06: plan complete. All eleven milestones landed with deterministic
gates and a zero-finding CodeRabbit review per milestone. Two logged
deviations: milestone 9 shipped a single `run-task.ts` module, and the
artefact-slicing suites were retained as shipped-artefact coverage. The
Surprises entry about the `checkJs: false` blind spot is resolved by the
milestone 10 entry conversion.

2026-07-06 (CodeScene follow-up fixes): a wyvern team confirmed five review
findings valid. `dedupeProposals` and `triageNeedsEscalation`
(remediation.ts) now key on the proposal's `source` tag (the
`review:`/`audit:` origin run-task.ts stamps), with `rationale` kept only as a
legacy fallback and `source` added to the `RemediationProposal` type, so
multi-source escalation counts real origins rather than free-form text. In
`runBetweenItemGates` the `runFix` helper now forwards the live attempt number
into `fixPrompt` (it was hardcoded to 1, losing the round on retries). The
between-item CodeScene check was decoupled from `hostGatesBetweenWorkItems`:
the caller guard is now `(HOST_COMMIT_GATES && HOST_GATES_BETWEEN_WORK_ITEMS)
|| CS_CHECK`, and inside the loop the commit-gate portion runs only when the
gate flag is on while the CodeScene portion runs whenever `csCheck` is on, so
enabling `csCheck` alone runs it between items. Tests strengthened: the
implementWorkItemPrompt test asserts step ordering by index (gates, then
CodeScene, then CodeRabbit); new run-task tests assert the between-item fix
loop forwards attempts [1, 2] rather than always 1, and that the CodeScene
check runs between items (a `wi` label) even with `hostGatesBetweenWorkItems`
off. Docs: architecture.md's gate cell split into shorter sentences, and
grammar/style fixes in the execplan and SKILL.md (via scribe).

2026-07-06 (CodeScene deterministic gate): added `cs-check-changed` as a
second deterministic gate, running after the commit gates and before
CodeRabbit at every gate point — each work item (in `runBetweenItemGates`),
each dual-review round, and the addendum lane. `runCodeSceneCheck`
(host-review.ts) runs `csCheckCommand` (default `cs-check-changed`, an
operator-provided wrapper) on the committed changed files, through the same
secure-log spawn path as the commit gates, and skips gracefully when the
binary is absent (like `make verify-modules` without Dafny). A code-health
regression short-circuits to a bounded fix round before any CodeRabbit quota
or reviewer-agent tokens are spent, keeping the cost hierarchy (free gates,
then CodeRabbit, then agents). The build and fix prompts carry
`CS_CHECK_GUIDANCE`: the `@codescene(disable:"...")` suppression syntax (used
only where refactoring would be deleterious, with a justifying comment) plus
paraphrased summaries of the CodeScene module, function, and implementation
smells. Config knobs `csCheck` (default on) and `csCheckCommand`. Module
tests cover the clean/dirty/skip-when-absent host check, the config defaults
and guidance content, the dual-review short-circuit (a CodeScene-blocking
round spends no reviewer-agent tokens and the fix precedes the review), the
persistent-regression halt, and the prompt guidance. `cs-check-changed` is a
wrapper the operator will fold into agent-helper-scripts, so the exact
invocation stays configurable.

2026-07-06 (gate-log security and test hygiene): a wyvern team triaged a
review batch. The security error was real: host gate logs were written to a
predictable `/tmp/df12-gate-<...>-<command>.out` path via `createWriteStream`
with default flags, so a local symlink could clobber or leak them, and the raw
gate command was embedded in the filename. Fixed by writing gate logs into a
lazily-created per-process `mkdtempSync` directory (mode 0700, unpredictable
name) and opening each log `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` at mode 0600,
with the command dropped from the filename; a module test plants a symlink at
the log path and asserts the gate fails closed with its target untouched. Test
hygiene: `host-review.test.ts` imports were hoisted to the top and the
streaming tests gained `afterEach` cleanup of every temp dir and gate log; a
new `recovery-discovery.test.ts` case drives the `worktree-probe-fault` skip
end-to-end (chmod 0000 on the worktrees parent to force an EACCES stat,
skipped when running as root). Docs: the developers-guide roster now lists
`host-review.ts`, the dated revision notes were tidied by scribe, and every
`/tmp/df12-gate-*` reference was updated to the secure per-run directory.
Skipped as already-covered: the compile-time-regression finding (tsc's
erasable-syntax flags, the `workflow-parse` gate, and the build script's
fail-closed no-import/single-workflowMain/rename-survival assertions already
enforce the compile-time invariants; prompt-text snapshots are an odw-testing
anti-pattern) and the tracing-spans finding (the ODW loader injects no
span/trace primitive and imports are banned, while `log()` and `events.jsonl`
already carry task id, stage, round, and attempt).

2026-07-06 (model right-sizing): the operator flagged three places where an
Opus/high-effort model was paying for near-zero-cognition work. (1) The
write-preflight probe (writing one exact token to one exact path) now keeps
the plan/build adapter, but runs at `writeProbeEffort` (minimal) and no
longer inherits `planModel`/`buildModel`; `writeProbeModelByAdapter` sets a
cheaper per-adapter probe model. (2) Report-only partial-branch assessment
gained a deterministic fast-classifier — an empty, clean branch is
classified `discard`, and an evidence-collection failure is classified
`continue-manual`, both at zero tokens — and its model default dropped from
the Opus review model to a medium `assessmentModel` (claude-sonnet-5). A
branch that committed an ExecPlan (a strong adopt-complete candidate) uses
`assessmentEscalationModel`. Dirty or ambiguous branches still reach the
model, so the recovery eligibility gate keeps owning the `dirty-worktree`
downgrade. (3) Remediation triage gained a deterministic exact-duplicate
dedup pre-pass and dropped from `gpt-5.5@high` to a medium `triageModel`
(gpt-5.5), escalating to `triageEscalationModel` (gpt-5.5@high) only when
the deduped proposals span more than one audit or review source. Module
tests pin every new knob, the fast-classifier table, the deterministic
zero-token paths, the evidence-based tiers, and the dedup/escalation
behaviour; the users-guide and architecture document the routing. Design
note: the assessment tier is a single evidence-based model choice (not
medium-then-reconfirm), to avoid a redundant second call and to preserve
the recovery tests' single-call contract.

2026-07-06 (cost-hierarchy review ordering): the operator confirmed the
spend hierarchy — deterministic gates are free, CodeRabbit is a fixed
weekly quota, and the reviewer agents (code and expert review) spend
tokens, the one non-replenishable resource — and stated a preference to
trade wall-clock time for tokens. Two changes followed. (1) Within the
per-work-item build, the host commit gates now re-run after each committed
item, before the between-item CodeRabbit review (`hostGatesBetweenWorkItems`,
default on), closing the window where a committed red item could ride the
agent's `impl.gatesGreen` claim across later items. (2) The dual-review round was
reordered to spend cheapest-first — host gates, then CodeRabbit, then the
reviewer agents — short-circuiting to a fix round the moment a cheaper
stage blocks, so a CodeRabbit-blocking round no longer dispatches the
reviewer agents (a CodeRabbit deferral still falls through to them as the
decisive review). Module tests pin the per-item gate ordering, the
red-gate fail, and the CodeRabbit-before-agents short-circuit; the
users-guide, architecture, and developers-guide document the cost-ordered
stage.

2026-07-06 (review remediation, batch 3): a wyvern team triaged another
findings batch. Fixed: `streamGate` (host-review.ts) gained a write-stream
`error` listener and a settled-once guard, so a gate-log open/write fault
(ENOSPC/EACCES/EISDIR) now settles as a failed gate result instead of
crashing the run on an uncaught stream error (pinned by an EISDIR test).
`directoryExists` now returns `{ ok, exists, detail }`, mirroring
`fileState`, so an I/O fault on a recovery worktree path surfaces as a new
`worktree-probe-fault` skip reason (held out of normal selection) rather
than being silently recorded as `missing-worktree`. The write-preflight
source-invariant was scoped to `run-task.ts` via a new `readModuleSource`
helper, so its ordered regex cannot span module boundaries in the
concatenated tree. Docs: `coderabbitBetweenWorkItems` is documented in the
users-guide and architecture; two grammar fixes and a `readWorkflowSource`
doc-comment were made via scribe. Skipped as stale: the recurring
"getBuiltinModule breaks Bun" findings (Bun 1.3.14 implements it —
re-confirmed by a runtime probe and passing bun suites; established
authoritatively via firecrawl in batch 2 that support landed in
bun-v1.2.6), and the developers-guide dependency list (already complete).
The write-preflight cross-boundary regex was confirmed theoretical (the
tokens are co-located), but was scoped anyway as a cheap robustness win.

2026-07-06 (design-review remediation): a reviewer flagged that "CodeRabbit
between each ExecPlan stage" was not yet real — host CodeRabbit ran only
once, after the whole implementation stage, rather than between
per-work-item build turns. Five concerns were validated against the code
and addressed. (1) The per-work-item build loop now runs a deterministic
host CodeRabbit gate after each committed work item
(`coderabbitBetweenWorkItems`, default on), with a bounded fix loop; the
gate fails closed — unresolved blocking findings fail the item
(`code-review`), and a terminal rate-limit or CLI deferral HALTS the task
for assessment instead of silently continuing. (2) Every fix round (gate
fix, dual-review fix, between-item fix) now runs `verifyWorktreeCommitted`;
a dirty fix fails `FIX DURABILITY` rather than reaching integration. (3)
Host commit gates stream stdout and stderr via `spawn` to the log with a
bounded ring-buffer tail, removing the 16MB `execFile` `maxBuffer` ceiling
that a noisy `make all` could trip, and streaming evidence during long
gates. (4) `coderabbitReviewCommand` is documented as
legacy-agent-mode-only (host mode uses a fixed committed-diff invocation).
(5) `make verify-modules-strict` fails when Dafny is absent, so CI can use
it as a real PR gate, while `make all` keeps the lenient skip for local
runs. New module tests cover the between-item pass/block/defer paths, the
fix durability gate, the >16MB streaming path, and the config flag.

2026-07-06 (review remediation, batch 2): a second findings batch was
triaged by a wyvern verification team, with firecrawl used to settle the
Bun-capability question authoritatively — Bun issue #12161 was closed as
completed in PR #18266 (release bun-v1.2.6), so `process.getBuiltinModule`
has been supported since v1.2.6 and the three "Bun breaks on
getBuiltinModule" findings are stale (this repo runs 1.3.14, verified by
direct invocation; the CodeRabbit note derives from a pre-1.2.6 doc
snapshot, and the proposed static-import fix would break the loader's
no-import constraint). Confirmed and fixed: config.ts interpolates the
configured backoff window into the legacy CodeRabbit guidance instead of a
hardcoded 45-90; `classifyCoderabbitOutcome` now treats a `complete` event
as clean only for a known success status (`review_completed`/`reviewed`,
set-based since the CLI spelling varies by build) so a cancelled review
cannot read as clean; the per-work-item build loop treats a plan that
disappears mid-build as fatal at every re-read (it was fatal only at the
initial guard); `readFileText` gained realpath parent-directory-symlink
containment threaded from the worktree root, deepening last round's
final-component-only guard; three duplicated `readWorkflowSource` copies
were extracted to `tests/support/workflow-source.mjs`; and the
developers-guide dependency list was completed (via scribe). Both docs
findings from the first batch's SKILL.md/failure-resume concern were
already correct and stayed skipped.

2026-07-06 (review remediation): a findings batch was triaged by a wyvern
verification team; 12 code and 6 test findings were confirmed and fixed,
and 8 were skipped as stale or wrong (both docs findings already correct;
`plan-unreadable` already present in the skip-reason contract and the twin
test's REASON map; the Bun `process.getBuiltinModule` claims empirically
false on Bun 1.3.14, where the proposed static-import fix would break the
loader contract; no CI configuration exists for the Dafny job to attach
to). Notable fixes: symlink containment for every ExecPlan read/write
(`readFileText` and the approval flip now open O_NOFOLLOW, `fileState`
lstats and fails closed), the addendum lane gained the
`verifyWorktreeCommitted` durability gate, both lanes now integrate
through one `integrateTask` helper (the two-call-site source invariant was
re-anchored accordingly), retry exhaustion is logged, evidence probes and
write probes run concurrently, and a fast-check fuzz property now guards
`execplanRelPath` containment.

2026-07-06 (post-completion): upstream `assessment-issues` — the branch this
work forked from mid-way, at e755141 — gained eight further commits and was
squash-merged to `origin/main`. The delta was ported into the decomposed
tree via `git merge --squash assessment-issues` (the true 3-way base; a
merge against `origin/main` would have re-conflicted the already-included
half). New subsystem module `host-review.ts` (host-run CodeRabbit review
NDJSON parsing/classification/backoff, host-run commit gates) plus surface
changes to `config.ts`, `exec.ts` (exec options and kill metadata),
`prompts.ts` (host-review conditionals, `implementWorkItemPrompt`),
`recovery-decision.ts` (ExecPlan Progress `items`, two new skip reasons),
`recovery-discovery.ts`, `run-task.ts` (per-work-item build loop,
`finishImplementationStage` split, host gates and host review in the
review rounds and addendum lane), and `main.ts` (`hostGateLock`,
host-review factory binding, result aggregates). All 114 artefact tests
(18 new upstream suites included), 231 module tests, and `make all` green;
the branch was then rebased onto `origin/main`.
