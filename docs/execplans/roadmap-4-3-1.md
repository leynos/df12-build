# ExecPlan: roadmap 4.3.1 salvage failed-agent artefacts

This ExecPlan records the implemented approach for roadmap task 4.3.1:
preserve useful task-scoped ExecPlan and review artefacts when an ODW
`df12-build-odw` branch fails after writing files but before returning valid
schema-bound output.

The observable outcome is that a failed or halted task branch assessed as
`continue-manual` or `adopt-partial` receives a branch-local commit whose
subject starts with `df12 salvage v1`, and the workflow result names the
committed and skipped artefacts. The base branch, origin refs, roadmap
checkboxes, and `processed` list must not change.

## Constraints

Salvage is not recovery resume. It must never merge, push, mark a roadmap item,
or imply that the task succeeded. It only preserves task-scoped Markdown files
under `docs/execplans/` on the failed task branch.

The only eligible classifications are `continue-manual` and `adopt-partial`.
`adopt-complete` continues through review-mode resume when explicitly enabled,
and `discard` remains advisory.

The candidate path convention is
`docs/execplans/roadmap-<id-with-dashes>*.md`, including adjacent review files
such as `docs/execplans/roadmap-2-2-1.review-r1.md`.

The host must verify every candidate before staging it: the path must resolve
inside the worktree, must not be absolute, must be a regular file by `lstat`,
and must open with `O_NOFOLLOW`.

Raw adapter stdout/stderr capture and truncation of adapter error detail in
ODW `result.json` are external ODW-runtime concerns. The workflow can preserve
the `detail` string it receives and attach Git evidence; it cannot recover
bytes the runtime never passed to workflow JavaScript.

## Tolerances

If salvage commit creation fails, the original task failure remains the run
result. The salvage failure is recorded in `result.salvage.skippedPaths`; it
must not become a new workflow-halting infrastructure error.

If a candidate is suspicious or unreadable, skip that candidate and record a
reason. Do not attempt fallback path handling.

## Risks

The main risk is accidentally committing unrelated dirty files from a failed
branch. The mitigation is the narrow task-scoped filename convention plus
pre-staging verification.

Another risk is treating salvage as a substitute for raw adapter logs. The
documentation explicitly scopes this out and tells operators to retain ODW run
logs when the runtime truncates adapter output before workflow JavaScript sees
it.

## Progress

- [x] Added `salvageArtefacts` configuration, defaulting on.
- [x] Added candidate selection, spoof-resistant verification, and branch-local
  `df12 salvage v1` commit logic in `workflows/df12-build-odw.js`.
- [x] Attached `salvage`, `postmortem`, and top-level salvage rollup fields to
  workflow results.
- [x] Added summary-line surfacing for preserved artefacts.
- [x] Added tests for eligible commits, symlink rejection, path escape
  rejection, disabled salvage, ineligible classifications, and no
  base/origin/roadmap mutation.
- [x] Updated failure-resume design, architecture, roadmap, and supervisor
  guidance.

## Surprises & Discoveries

The existing assessment evidence collector already gathered the facts needed
for postmortem diagnosis: branch name, worktree path, base/current commits,
changed files, dirty changes, staged changes, and recent commits. The salvage
implementation could therefore reuse that evidence rather than introducing a
second Git inspection path.

The outer worker-pool rejection path could produce a failed result without
assessment if `runTask()` rejected outside its own catch block. A small
task-id-to-worktree map now lets that fallback path attach assessment and
salvage when a worktree handle exists.

## Decision Log

Use a branch-local commit instead of copying artefacts to the run directory.
This keeps the artefacts next to the failed branch state they explain, and it
does not depend on sidecar lifetime.

Do not salvage arbitrary files. The task examples that motivated the change
were ExecPlan and review Markdown files, and preserving code changes or other
dirty files would cross from evidence preservation into partial adoption.

Keep `adopt-complete` out of salvage eligibility. A clean complete branch has a
different path: review-mode resume. Salvage is for branches that need manual
judgement or partial preservation.

Document ODW raw-output truncation as an external runtime limitation. The
workflow cannot store stdout/stderr it never receives, so the honest mitigation
is durable Git evidence plus operator retention of run logs.

## Outcomes & Retrospective

The workflow now makes salvage explicit and durable for the failure mode seen
in run `20260704-111859-045c9e`: useful ExecPlan and review files can be
committed on their failed task branches and named in the result. Operators no
longer have to depend only on live untracked worktree state before cleanup.

Validation is the repository gate `make all`, plus focused coverage in
`tests/df12-build-odw-assessment.test.mjs`. CodeRabbit review is requested
after deterministic gates pass.
