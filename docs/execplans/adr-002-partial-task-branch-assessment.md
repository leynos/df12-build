# Implement partial task branch assessment

This ExecPlan (execution plan) is a living document. The sections
`Constraints`, `Tolerances`, `Risks`, `Progress`, `Surprises & Discoveries`,
`Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work
proceeds.

Status: COMPLETE

## Purpose / big picture

After this change, `workflows/df12-build-odw.js` will inspect a failed roadmap
task branch before the workflow forgets about it. A failed task that still has a
real git worktree will receive a structured assessment saying whether the work
looks complete, partially adoptable, manually reviewable, or discardable. The
first implementation only reports the recommendation; it must not automatically
merge or cherry-pick partial work.

Success is visible in the ODW result JSON. A task that fails after worktree
creation has an `assessment` object with a classification from ADR 002, the
branch/worktree identity, evidence summaries, missing evidence, and a bounded
recommendation. Auth failures and pre-worktree failures do not get assessed.

## Constraints

- Modify the ODW implementation surface only in `workflows/df12-build-odw.js`.
  Do not change `workflows/df12-build.js`, which targets a different runtime.
- Follow the ODW script contract: keep `meta` literal, do not import injected
  primitives, and use top-level ODW globals only as provided by the runtime.
- Treat direct Node built-in use in this file as an ODW/Codex implementation
  detail already present in this workflow, not as portable Claude Code workflow
  dialect. Do not make `workflows/df12-build.js` depend on it.
- Use `workspaceMode: "inplace"` assumptions for shared git state. Do not rely
  on ODW copy isolation or `agent(..., { isolation: "worktree" })` as a durable
  handoff channel.
- Preserve the fresh-restart model. The recovery source of truth remains
  `origin/<base>` plus surviving task branches, worktrees, commits, ExecPlans,
  roadmap state, and validation evidence.
- Do not resume adapter transcripts, hidden sessions, or host context.
- Do not reinterpret authentication failures as adoptable implementation
  failures. Auth failures remain fatal and assessment is skipped.
- Do not auto-adopt partial branches in this milestone. `adopt-complete` and
  `adopt-partial` are returned as recommendations only.
- Keep operations that can advance `origin/<base>` behind the existing merge
  lock. This milestone should not add any new path that advances `origin/<base>`.
- Update user-facing and operator documentation in the same branch as the
  workflow change.

If satisfying the objective requires violating a constraint, stop, document the
conflict in `Decision Log`, and ask for direction.

## Tolerances (exception triggers)

- Scope: if implementation requires more than eight files or more than 500 net
  lines, stop and escalate.
- Interface: if ODW must support a new primitive, a non-literal `meta`, or a new
  runtime mode, stop and escalate.
- Dependencies: if a new npm package, parser dependency, or external binary is
  required for tests or runtime logic, stop and escalate.
- Adoption: if the cleanest design would automatically merge, cherry-pick,
  push, or mark roadmap checkboxes for partial branches, stop and escalate.
- Tests: if focused tests still fail after three implementation attempts, stop
  and document the failing command and current theory.
- Ambiguity: if `adopt-partial` cannot be distinguished from
  `continue-manual` without changing roadmap semantics, stop and present the
  options.

## Risks

- Risk: The assessment agent may recommend adoption from incomplete or
  prompt-injected evidence.
  Severity: high
  Likelihood: medium
  Mitigation: Host code must consume a schema, never free text, and this
  milestone must only report recommendations.

- Risk: The workflow could assess failures that happened before any durable
  branch exists.
  Severity: medium
  Likelihood: medium
  Mitigation: Gate assessment on a known branch name and worktree path from the
  successful worktree creation step.

- Risk: Dirty worktrees may contain useful uncommitted work, but also unsafe
  generated files or unrelated edits.
  Severity: medium
  Likelihood: high
  Mitigation: Report dirty state explicitly and require manual judgement unless
  the branch is clean, committed, scoped, and gated.

- Risk: Tests can become brittle because `df12-build-odw.js` is an ODW script,
  not an importable Node module.
  Severity: medium
  Likelihood: medium
  Mitigation: Use a small Node `vm`/`Function` harness that evaluates only the
  helper and schema portion of the workflow source and does not launch agents.

- Risk: ODW and Claude Code workflow documentation describe overlapping but not
  identical runtimes.
  Severity: medium
  Likelihood: medium
  Mitigation: Follow the checked-in ODW workflow and local `odw-authoring`
  skill for implementation. Use Claude Code docs only as prior art for the
  orchestration model, not as the runtime contract for this file.

## Progress

- [x] (2026-06-30T15:12:48Z) Read ADR 002, the ODW workflow, and the repository
  documentation that defines the sidecar, state, validation, and supervisor
  contracts.
- [x] (2026-06-30T15:12:48Z) Drafted this ExecPlan in `docs/execplans/`.
- [x] (2026-06-30T15:12:48Z) Used Firecrawl to inspect ODW README and
  primitive docs, Claude Code workflow and worktree docs, Anthropic's agent
  pattern guidance, and ODW's dynamic-workflow research and technical plan.
- [x] (2026-06-30T15:12:48Z) Revised this ExecPlan with prior-art findings and
  the ODW-versus-Claude runtime boundary.
- [x] (2026-06-30T15:35:32Z) Got explicit approval to implement this plan.
- [x] (2026-06-30T15:35:32Z) Added red tests for assessment eligibility,
  schema shape, auth skipping, and fixture evidence collection.
- [x] (2026-06-30T15:35:32Z) Ran the focused red test. It failed for the
  expected reason: `ReferenceError: ASSESSMENT_CLASSIFICATIONS is not defined`.
- [x] (2026-06-30T15:35:32Z) Implemented the schema, prompt, host evidence
  collection, result wiring, and top-level `assessments` summary.
- [x] (2026-06-30T15:35:32Z) Ran the focused green test:
  `node --test tests/df12-build-odw-assessment.test.mjs` passed 4 tests.
- [x] (2026-06-30T15:35:32Z) Updated ADR 002, user guide,
  architecture, developer guide, security guide, and supervisor skill for the
  report-only assessment behaviour.
- [x] (2026-06-30T15:47:19Z) Ran `make all`; diff check, Markdown lint, ODW
  wrapper parse, Nixie diagram validation, and Node assessment tests all
  passed.
- [x] (2026-06-30T16:11:11Z) Verified three review findings against current
  code: auth-shaped implementation issues were not fatal, assessment evidence
  fields were optional in the schema, and two docs still called ADR 002
  proposed.
- [x] (2026-06-30T16:11:11Z) Patched the still-valid findings and extended
  focused tests for auth-shaped implementation issues, both implementation
  paths, and the full assessment required-field set.
- [x] (2026-06-30T16:11:11Z) Ran the focused test and `make all`; both passed
  with 6 Node tests.

## Surprises & discoveries

- Observation: This repository initially had no build-driver file, package
  manifest, or existing test directory.
  Evidence: the post-turn hook failed because no supported build driver was
  available.
  Impact: this branch now adds a small `Makefile` for hook-compatible
  validation, while the plan still uses Node's built-in `node --test` for the
  future focused assessment tests.

- Observation: The developer guide already anticipates future `docs/execplans/`
  use, but the directory did not exist yet.
  Evidence: `docs/developers-guide.md` says future branches that add
  `docs/execplans/` should keep matching plans updated.
  Impact: This plan creates `docs/execplans/` as the durable plan location.

- Observation: Claude Code's dynamic workflow docs say workflow scripts cannot
  directly access filesystem or shell state; agents perform those actions. This
  repository's ODW workflow already uses `process.getBuiltinModule` in the
  workflow host script for deterministic git and file reads.
  Evidence: Firecrawl scrape of `https://code.claude.com/docs/en/workflows`;
  local inspection of `workflows/df12-build-odw.js`.
  Impact: The assessment implementation may follow the existing ODW/Codex
  workflow style, but the plan explicitly avoids applying that assumption to
  the Claude Code-targeted `workflows/df12-build.js`.

- Observation: Claude Code workflows resume only within the same Claude Code
  session, while ADR 002 requires fresh restart from durable git state.
  Evidence: Firecrawl scrape of `https://code.claude.com/docs/en/workflows`.
  Impact: The assessment stage must not use session resume semantics as part of
  recovery, even though Claude Code dynamic workflows expose a same-session
  resume capability.

- Observation: ODW's public README and primitive references stress schema
  handoffs, detached run directories, injected globals, and order-independent
  reductions. Some versioned docs differ on whether newer primitives such as
  nested `workflow()` or precise budget accounting are implemented.
  Evidence: Firecrawl scrapes of the ODW README, `skill/references/primitives.md`,
  `docs/dynamic-workflows-research.md`, and
  `docs/dynamic-workflows-tech-plan.md`.
  Impact: This plan relies only on stable primitives already used by the
  workflow: `agent`, `phase`, `args`, schemas, deterministic JavaScript
  reductions, and existing Node helper style.

## Decision log

- Decision: Implement a report-only assessment stage first.
  Rationale: ADR 002 says automatic adoption should wait until the manual
  recommendation path has been dogfooded. Reporting keeps recovery observable
  without adding a new merge path.
  Date/Author: 2026-06-30T15:12:48Z / Codex.

- Decision: Collect basic git evidence in workflow host code before asking the
  assessment agent to classify the branch.
  Rationale: Branch name, base commit, current commit, dirty state, and changed
  files are deterministic facts. Capturing them in JavaScript reduces the
  amount of prompt-enforced evidence and gives tests a pure surface to verify.
  Date/Author: 2026-06-30T15:12:48Z / Codex.

- Decision: Add lightweight Node tests without adding a package dependency.
  Rationale: The repo has no package manifest, and adding one only for tests
  would exceed the smallest useful change. Node's built-in test runner is enough
  for schema and helper behaviour.
  Date/Author: 2026-06-30T15:12:48Z / Codex.

- Decision: Treat the assessment stage as a workflow-pattern combination of
  orchestrator-worker plus evaluator, with host-enforced gates around the
  recommendation.
  Rationale: Anthropic's agent guidance favours simple composable workflows,
  transparent planning, and programmatic gates. The host can gather deterministic
  git evidence and enforce eligibility; the assessment agent can evaluate the
  branch, but its recommendation must remain data rather than control flow.
  Date/Author: 2026-06-30T15:12:48Z / Codex.

- Decision: Do not use Claude Code same-session workflow resume as prior art
  for this recovery path.
  Rationale: ADR 002 explicitly chooses git-state recovery after system failure
  or token exhaustion. Same-session transcript or journal resume is a different
  reliability model and can disappear across process/session boundaries.
  Date/Author: 2026-06-30T15:12:48Z / Codex.

- Decision: Include the focused assessment test in `make all`.
  Rationale: Assessment is now executable workflow behaviour, not just
  documentation. The repository gate should fail when the schema, eligibility
  guard, or deterministic git evidence collector regresses.
  Date/Author: 2026-06-30T15:35:32Z / Codex.

- Decision: Assess unhandled post-worktree agent errors inside `runTask`.
  Rationale: A thrown agent call after worktree creation is still a failure with
  a durable branch. Catching it inside `runTask` preserves the worktree context
  so ADR 002 assessment can run; auth-shaped failures still bypass assessment.
  Date/Author: 2026-06-30T15:35:32Z / Codex.

- Decision: Treat auth-shaped implementation issues as fatal before any review
  or integration fallback.
  Rationale: ADR 002 says auth failures remain fatal, and authentication
  failures are not useful partial-branch evidence. Both normal and addendum
  implementation results now share the same auth detector and return
  `fatal-auth` before deferred-review handling or mergeability checks.
  Date/Author: 2026-06-30T16:11:11Z / Codex.

- Decision: Require the assessment agent to return all core evidence fields in
  the schema.
  Rationale: The schema is the hard contract between the assessment agent and
  the workflow host. `taskScoped`, `execPlan`, `roadmap`, `validation`,
  `rationale`, and `nextActions` must be present so an operator does not
  receive a bare classification without the evidence ADR 002 relies on.
  Date/Author: 2026-06-30T16:11:11Z / Codex.

## Outcomes & retrospective

The workflow returns partial-branch assessments for failed task branches while
keeping all branch adoption manual. Auth-shaped implementation issues now halt
as `fatal-auth` before review or integration fallback. The focused assessment
tests pass, the documentation updates are present, and `make all` passes. This
milestone keeps all partial-branch adoption manual and report-only.

Post-completion addendum (PR #57, issue #18): `continue-manual`,
`adopt-partial`, and infra-fault handoffs now durably commit any dirty
task-scoped `docs/execplans/*.md` artefacts onto the branch before worktree
cleanup, so a planning or review artefact written just before a failure is
preserved rather than lost. The one exception is a deterministic
`continue-manual` raised from untrustworthy collection-error evidence: it
records a salvage skip instead of committing because that evidence cannot be
trusted. This extends preservation only through the
branch's own Git history; it does not merge, push, or mark the roadmap, so
the report-only, manual-adoption conclusion above still holds. Each per-task
assessment result now also carries a `result.salvage` record
(`{ classification, committed, skipped, sha, detail }`), and the run result
carries a top-level `salvages` array; salvage runs only when partial-branch
assessment is enabled (`assessPartialBranches=true`). See
`docs/developers-guide.md` and `docs/users-guide.md`.

## Context and orientation

`df12-build` is a workflow-asset repository. It does not own the target
project's source code. The ODW workflow runs against a target project selected
with `odw run ... --source <target-project>`.

`workflows/df12-build-odw.js` is an Open Dynamic Workflows script. ODW scripts
use injected globals such as `args`, `agent`, `parallel`, `phase`, `log`, and
`budget`; they must not import those primitives. This workflow creates real git
worktrees for target-project tasks, plans and implements work inside those
worktrees, reviews the result, and serializes integration with a JavaScript
merge lock.

ADR 002, `docs/adr-002-assess-partial-task-branches.md`, decides that failed
task branches should be assessed through durable git state, not through an old
agent transcript. It defines four classifications:

- `adopt-complete`: the branch appears to satisfy the task and could continue
  through the ordinary review and integration path after all gates are proven.
- `adopt-partial`: the branch contains a coherent useful slice, but the roadmap
  task must remain unchecked.
- `continue-manual`: the branch might be useful, but an operator must judge it.
- `discard`: the branch is stale, unsafe, incoherent, or too incomplete.

The current workflow already returns failed or halted task results with the
task id, stage, detail, and worktree path for most failures after worktree
creation. It does not currently assess those branches before stopping the pool.

## Prior art research

Firecrawl research added five relevant context points.

Claude Code dynamic workflows move orchestration into a JavaScript script run by
a background runtime. The plan, loops, branch decisions, and intermediate
results live in script variables, while the user's conversation receives only
the final result. This supports the `df12-build` design choice to keep recovery
state out of host-agent context. Source:
`https://code.claude.com/docs/en/workflows`.

Claude Code's workflow docs distinguish workflows from subagents, skills, and
agent teams by "who holds the plan". For this task, the workflow host should
hold the recovery decision boundaries: it decides which failures are eligible
for assessment, gathers deterministic git evidence, and prevents assessment
output from directly mutating integration state. Source:
`https://code.claude.com/docs/en/workflows`.

Claude Code worktree docs define a worktree as a separate working directory with
its own files and branch, sharing repository history and remote state. They also
say worktrees with changes or commits are preserved for later inspection rather
than silently removed in non-interactive runs. This supports treating surviving
task worktrees and branches as durable recovery artefacts. Source:
`https://code.claude.com/docs/en/worktrees`.

ODW's public README describes the same workflow dialect ODW targets:
`export const meta`, injected `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`
and `budget`, JSON-Schema handoffs, detached background runs, and observable run
directories. This supports schema-driven assessment output and result JSON as
the observable recovery surface. Source:
`https://github.com/xz1220/open-dynamic-workflows/blob/main/README.md`.

Anthropic's "Building Effective Agents" recommends simple composable workflows,
programmatic gates between LLM steps, transparency, and human oversight where
judgement matters. This supports report-only `adopt-partial` and
`continue-manual` recommendations rather than automatic adoption in the first
milestone. Source:
`https://www.anthropic.com/research/building-effective-agents`.

## Plan of work

Stage A preserves the existing ODW contract and adds tests first. Create
`tests/df12-build-odw-assessment.test.mjs`. The test file reads
`workflows/df12-build-odw.js`, rewrites the single `export const meta =` line to
`const meta =`, evaluates the helper/schema section inside an async wrapper, and
returns only the assessment helpers under test. It must not call `agent()` or
run the workflow control loop. Add red tests for these behaviours:

- `ASSESSMENT_SCHEMA` contains only the four ADR 002 classifications.
- `shouldAssessFailure(result, wt)` returns true for `failed` and `halted`
  results that have a branch and worktree after worktree creation.
- `shouldAssessFailure(result, wt)` returns false for worktree-creation
  failures, `dry-run`, `manual-merge-ready`, `done`, `fatal-auth`, and details
  that match `authFailureDetail`.
- `collectAssessmentEvidence(task, wt)` works against temporary git fixture
  repositories for clean committed work, dirty work, no commits after base, and
  task-scoped versus unrelated changed files.

Run the focused test before production changes and record the expected failure.
The expected red failure is that assessment helpers and schema do not exist.

Stage B implements the host-side assessment surface in
`workflows/df12-build-odw.js`. Add an `Assess` phase to `meta.phases`. Add
configuration defaults near the other runtime arguments:
`ASSESS_PARTIAL_BRANCHES = cfg.assessPartialBranches !== false`,
`ASSESSMENT_ADAPTER = cfg.assessmentAdapter || REVIEW_ADAPTER`, and
`ASSESSMENT_MODEL = cfg.assessmentModel || REVIEW_MODEL`. Add
`assessmentAgentOptions(options = {})`.

Add `ASSESSMENT_SCHEMA` beside the other schemas. It must be literal JSON
Schema and include at least:

```javascript
const ASSESSMENT_CLASSIFICATIONS = [
  'adopt-complete',
  'adopt-partial',
  'continue-manual',
  'discard',
]
```

The returned assessment object should require `classification`, `branchName`,
`worktreePath`, `baseCommit`, `currentCommit`, `dirtyState`, `changedFiles`,
`execPlan`, `roadmap`, `validation`, `missingEvidence`, `risks`, and
`recommendation`. Use arrays of strings or small objects rather than free-form
paragraphs where JavaScript needs to inspect the value.

(Post-implementation note, issue #23: the schema also requires an advisory
`residualRisk` array alongside the blocking `missingEvidence`, separating the
two evidence channels.)

Add `collectAssessmentEvidence(task, wt)`. It should run deterministic git
commands inside the task worktree:

- `git -C <worktree> rev-parse HEAD`
- `git -C <worktree> status --porcelain=v1`
- `git -C <worktree> diff --name-status <baseSha>...HEAD`
- `git -C <worktree> diff --name-status`
- `git -C <worktree> diff --cached --name-status`
- `git -C <worktree> log --oneline --max-count=20 <baseSha>..HEAD`

It should return a plain object with task id/title, branch name, worktree path,
base commit, current commit, committed changes, dirty changes, staged changes,
recent commits, and collection errors. If a command fails, capture the error in
the object; do not throw away the original task failure.

This helper follows the existing `df12-build-odw.js` ODW/Codex style, where the
workflow host script already uses Node built-ins for deterministic git and file
operations. It is not a Claude Code workflow portability claim.

Add `assessmentPrompt(task, wt, result, evidence)`. The prompt must be read-only
and evidence-first. It must instruct the agent to inspect the worktree and git
state, read the ExecPlan and roadmap if present, review validation evidence,
and classify using only the ADR 002 enum. It must explicitly say not to edit,
commit, stash, merge, push, mark roadmap checkboxes, or resume the failed
agent's transcript.

Add `shouldAssessFailure(result, wt)` and `attachAssessment(task, wt, result)`.
`shouldAssessFailure` is the host guard. It should require
`ASSESS_PARTIAL_BRANCHES`, a branch name, a worktree path, a non-auth result,
and a failed/halted status after worktree creation. `attachAssessment` should:

1. Return the original result unchanged when the guard is false.
2. Call `phase('Assess')`.
3. Collect host evidence.
4. Call the assessment agent with `ASSESSMENT_SCHEMA`.
5. Return the original result plus `assessment` when structured output arrives.
6. Return the original result plus `assessmentError` when assessment itself
   fails or returns null.

Stage C wires assessment into task failure returns. In `runTask`, keep the
successful path unchanged. For every failed or halted return after successful
worktree creation, return `await attachAssessment(task, wt, result)`. This
includes normal task failures in planning, design review, implementation,
review, and integration, plus addendum implementation, addendum fallback review,
and addendum integration failures. Do not assess `DRY_RUN`,
`manual-merge-ready`, successful `done`, worktree creation failure, or fatal
auth failure.

At the final return object, keep each per-task `assessment` attached in
`results[]` and add a convenience top-level `assessments` array derived from
those results. Update `summary` to include a short assessment count when any
assessment ran. Do not let any classification change `processed`, roadmap
checkboxes, audit scheduling, or remediation triage.

Stage D updates documentation. Update:

- `docs/users-guide.md`: explain the assessment result, the
  `assessPartialBranches`, `assessmentAdapter`, and `assessmentModel`
  arguments, and the operator action for each classification.
- `docs/architecture.md`: add the `Assess` phase and enforcement-boundary row
  describing host evidence, schema consumption, and report-only behaviour.
- `docs/developers-guide.md`: mention assessment tests and the no-live-run
  validation rule.
- `docs/security-and-permissions.md`: note that assessment sends branch diffs,
  roadmap text, ExecPlans, logs, and validation evidence to the selected
  assessment adapter.
- `skills/df12-build-supervisor/SKILL.md`: update the failure-mode playbook so
  operators inspect `result.assessment` before manual branch archaeology.

Stage E refactors only after tests pass. Keep helper names stable, remove
duplication from failure-return wrapping if it is local and obvious, and avoid
changing scheduling semantics. Re-run focused and repository validation after
each refactor.

## Concrete steps

Work from the repository root:

```bash
cd /data/leynos/Projects/df12-build.worktrees/codex-annex
```

Red step:

```bash
node --test tests/df12-build-odw-assessment.test.mjs
```

Expected first failure:

```plaintext
not ok ... assessment helpers are exported by the test harness
ReferenceError: ASSESSMENT_SCHEMA is not defined
```

Green step:

```bash
node --test tests/df12-build-odw-assessment.test.mjs
```

Expected pass after implementation:

```plaintext
# tests 4
# pass 4
# fail 0
```

## Validation and acceptance

Red-Green-Refactor evidence must be recorded in this document during
implementation:

- Red: `node --test tests/df12-build-odw-assessment.test.mjs` fails before
  production changes because assessment helpers/schema are absent.
- Green: the same command passes after `workflows/df12-build-odw.js` implements
  the schema, eligibility guard, evidence collector, prompt, and result wiring.
- Refactor: after cleanup, the focused test still passes, markdown lint passes,
  diff check passes, and the ODW wrapper parse check prints
  `workflows/df12-build-odw.js: wrapped JavaScript parses`.

Acceptance criteria:

- A failed or halted task result after worktree creation includes a structured
  `assessment` object or a non-fatal `assessmentError`.
- Worktree creation failures, dry runs, manual-merge-ready branches, successful
  tasks, and auth failures are not assessed.
- Assessment classifications are limited to `adopt-complete`,
  `adopt-partial`, `continue-manual`, and `discard`.
- No assessment classification marks a roadmap task complete, pushes a branch,
  merges a branch, or changes `processed`.
- Documentation tells an operator how to read and act on assessment output.

## Idempotence and recovery

The implementation is idempotent. Re-running the tests recreates temporary git
fixtures from scratch and does not touch real target-project branches. The
workflow assessment stage is read-only with respect to the target project's
reviewed work and roadmap state: if it fails, the original task failure still
returns and the surviving worktree remains available for manual inspection.
Salvage still durably commits task-scoped `docs/execplans/*.md` planning and
review artefacts to the branch's own Git history, without merging, pushing, or
ticking the roadmap.

If a partial implementation of this plan is interrupted, inspect `git status`,
run the focused test, and resume from the first failing or unchecked Progress
item. Do not attempt to recover by running a live ODW workshop.

## Artefacts and notes

Concise validation transcripts are recorded here instead of full command logs.

Red test evidence:

```plaintext
$ node --test tests/df12-build-odw-assessment.test.mjs
not ok 1 - assessment schema exposes only ADR 002 classifications
ReferenceError: ASSESSMENT_CLASSIFICATIONS is not defined
```

Green test evidence:

```plaintext
$ node --test tests/df12-build-odw-assessment.test.mjs
# tests 4
# pass 4
# fail 0
```

Final repository validation:

```plaintext
$ make all
markdownlint-cli2: Summary: 0 error(s)
workflows/df12-build-odw.js: wrapped JavaScript parses
workflows/df12-build.js: wrapped JavaScript parses
All diagrams validated successfully
# tests 6
# pass 6
# fail 0
```

## Interfaces and dependencies

No new external dependencies are allowed.

The workflow must expose these in `workflows/df12-build-odw.js` for the local
test harness and runtime code:

```javascript
const ASSESSMENT_CLASSIFICATIONS = [
  'adopt-complete',
  'adopt-partial',
  'continue-manual',
  'discard',
]

const ASSESSMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    classification: { type: 'string', enum: ASSESSMENT_CLASSIFICATIONS },
    branchName: { type: 'string' },
    worktreePath: { type: 'string' },
    baseCommit: { type: 'string' },
    currentCommit: { type: 'string' },
    dirtyState: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    execPlan: { type: 'string' },
    roadmap: { type: 'string' },
    validation: { type: 'string' },
    missingEvidence: { type: 'array', items: { type: 'string' } },
    residualRisk: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  },
  required: [
    'classification',
    'branchName',
    'worktreePath',
    'baseCommit',
    'currentCommit',
    'dirtyState',
    'changedFiles',
    'missingEvidence',
    'residualRisk',
    'recommendation',
  ],
}

async function collectAssessmentEvidence(task, wt) {
  // Returns deterministic git evidence; never mutates the worktree.
}

function shouldAssessFailure(result, wt) {
  // True only for non-auth failed/halted results with a durable task worktree.
}

async function attachAssessment(task, wt, result) {
  // Returns result unchanged, or result plus assessment/assessmentError.
}
```

The exact schema may grow during implementation if tests or docs show a missing
field, but it must stay within the constraints and classifications above.

## Revision note

Initial draft created from ADR 002 and the current ODW workflow. It scopes the
first implementation to report-only partial-branch assessment, defines the
test-first path, and leaves all automatic adoption behaviour for a later
approved plan.

Revision 1 on 2026-06-30: Added Firecrawl-backed prior art from ODW, Claude
Code dynamic workflow and worktree docs, and Anthropic agent-pattern guidance.
This revision tightens the runtime boundary: implementation may use the
existing ODW/Codex host-script style in `workflows/df12-build-odw.js`, but must
not treat that style as portable Claude Code workflow dialect or change
`workflows/df12-build.js`.

Revision 2 on 2026-06-30: Added a hook-compatible `Makefile` and updated the
plan's validation instructions from ad hoc commands to `make all`. This changes
only the validation driver, not the planned assessment implementation.

Revision 3 on 2026-06-30: Marked the plan in progress, recorded explicit
approval, and captured the red-test evidence before implementation.

Revision 4 on 2026-06-30: Recorded the implemented assessment surface and
focused green-test evidence. Documentation and final gates remain.

Revision 5 on 2026-06-30: Recorded documentation completion and decisions to
include assessment tests in `make all` and to assess unhandled post-worktree
agent errors. Final validation remains.

Revision 6 on 2026-06-30: Recorded final `make all` validation and marked the
plan complete.

Revision 7 on 2026-06-30: Recorded review follow-up fixes for fatal auth
handling, required assessment evidence fields, and stale ADR wording. Updated
validation evidence to 6 focused Node tests.

Revision 8 on 2026-07-07: Post-completion scope note (documentation only; the
plan remains COMPLETE). Artefact salvage was added in PR #57 (issue #18) after
this ExecPlan closed: `salvageTaskArtefacts` (`execplan-durability.ts`) plus
`salvageAssessmentArtefacts` and `salvageInfraFaultArtefacts` (`assessment.ts`)
durably commit dirty task-scoped `docs/execplans/*.md` artefacts onto the
failing branch's own history before cleanup, for `continue-manual`,
`adopt-partial`, and infra-fault (schema-retry exhaustion) handoffs. Salvage
never merges, pushes, or ticks the roadmap, so it stays within this plan's
report-only, manual-adoption boundary. See `docs/developers-guide.md` and
`docs/users-guide.md` for the salvage flow.
