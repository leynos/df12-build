# df12-build user guide

`df12-build` drives a df12-house GIST roadmap forward with a parallel ODW
workflow. It plans, reviews, implements, gates, integrates, audits, and files
remediation work through isolated worker branches. Use it only for projects that
already have a roadmap, design documentation, `AGENTS.md`, repository gates, and
the df12 skill/toolchain installed.

## Launch model

Current ODW launches use a `.workshop` sidecar outside the target project's Git
worktree. Do not launch a long-running workshop from `.claude/`, `/tmp`, the
project source tree, or a workflow-owned `...worktrees/roadmap-*` worktree.
Those locations can be cleaned, switched, or removed while the workshop is still
recoverable.

The sidecar is durable run-control state. The target repository remains the
source of truth for product changes, and `origin/<base>` remains the recovery
point for fresh restarts.

```bash
PROJECT=/data/leynos/Projects/example-project
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SIDECAR="${PROJECT}.workshop/df12-build-${RUN_ID}"
mkdir -p "$SIDECAR"
```

## Sidecar artefacts

Keep these files together in the sidecar:

- `df12-build-odw.js`: the copied workflow script that the live run executes.
- `odw.config.json`: the ODW runtime, adapter, model, workspace, and permission
  configuration for the run.
- `args.json`: the project-specific workflow arguments.
- `operator-notes.md`: the run id, launch command, local sidecar patches,
  validation notes, health checks, failures, and operator decisions.

Patch the sidecar copy only to recover or tune a live workshop. Record the patch
in `operator-notes.md`, validate it there, then promote the proven change back
to the `df12-build` repository through a normal branch.

## Starting a run

Copy the checked-in ODW workflow into the sidecar, then launch it from the
sidecar while using the target project as `--source`.

```bash
cp /path/to/df12-build/workflows/df12-build-odw.js \
  "$SIDECAR/df12-build-odw.js"

odw run "$SIDECAR/df12-build-odw.js" \
  --source "$PROJECT" \
  --config "$SIDECAR/odw.config.json" \
  --args @"$SIDECAR/args.json"
```

Start normal workshop runs in the background. Supervise them with `odw status`,
`odw logs`, `odw result`, and the ODW dashboard. Keep `operator-notes.md` current
enough that another operator can continue after context compaction.

## Roadmap format

`df12-build` expects the target roadmap to follow the df12-house GIST shape:
Goals -> Ideas -> Steps -> Tasks. New projects should use this as the baseline
format before launching a workshop. Older project roadmaps may need grooming
first, because the ODW workflow now uses a deterministic selector rather than a
model-based selector.

The roadmap path defaults to `docs/roadmap.md`. Selection reads the canonical
roadmap from `origin/<base>:<roadmap>`, not from a worker branch or a local
working-tree edit. Keep the integration branch current before launching or
relaunching a run.

At minimum, a runnable roadmap task must be a Markdown checkbox line with a
dotted numeric id:

```markdown
- [ ] 1.2.3. Add parser diagnostics.
  - Success: Parser failures include a stable diagnostic code and source span.
```

The selector recognises checked and unchecked task lines in this form:

```markdown
- [ ] 1.2.3. Task title.
- [x] 1.2.4. Completed task title.
```

Use dependency lines directly under the task body when a task must wait for
other roadmap ids:

```markdown
- [ ] 1.2.5. Wire diagnostics into the CLI.
  - Requires 1.2.3 and 1.2.4.
  - Success: CLI output includes parser diagnostic codes in error reports.
```

Step ranges are also accepted in `Requires` lines:

```markdown
- [ ] 1.6.1. Stabilize the integration surface.
  - Requires steps 1.2 - 1.5.
  - Success: The integration API is documented and covered by tests.
```

The deterministic selector treats a task as unblocked when all of these are
true:

- The task checkbox is unchecked.
- Every id named by its `Requires` lines is complete.
- The task has not already been processed, left manual-merge-ready, marked as a
  dry run, or spawned in the current workflow run.

A task is complete when its own checkbox is checked and every nested addendum
subtask below it is also checked. The selector also treats a prefix id as
complete when every task under that prefix is complete. For example, if every
task under `1.2.*` is complete, then `1.2` can satisfy a later `Requires 1.2`
dependency.

Completed tasks may carry nested unchecked addendum subtasks. These are used for
small follow-up corrections that do not need a full plan and review cycle:

```markdown
- [x] 1.2.8. Implement the parser state machine.
  - Success: The parser accepts valid fixtures and rejects invalid fixtures.
  - [ ] 1.2.8.1. Addendum (from review:high). Cover empty-input recovery.
    Lightweight addendum pass.
```

When an addendum subtask is open under a completed parent, the workflow selects
an addendum pass for the parent task and scopes the implementation to the open
nested ids.

Selection is deliberately simple and reproducible:

- Build all normal and addendum candidates from the canonical roadmap.
- Exclude blocked or already-taken work.
- Apply `taskId` if one was supplied.
- Sort remaining candidates by roadmap line number.
- Select the first candidate.

The workflow parses only the mechanical parts needed for scheduling: checkbox
lines, dotted ids, `Requires` lines, step ranges, and nested addendum subtasks.
The broader GIST discipline is still required for useful planning and triage:
each phase should carry an `Idea:`, each step should state the hypothesis it
answers, and each task should include a clear `Success:` criterion.

Treat this section as the baseline contract for future roadmap tooling. A
roadmap editor or linter should preserve these parseable forms, verify that
`Requires` references resolve, and flag malformed ids or dependency lines before
a long-running workshop starts.

## Workflow arguments

Set project-specific behaviour in `args.json`. The workflow also has matching
top-of-file defaults, but the sidecar `args.json` is the normal retuning point
for ODW launches.

Common arguments:

- `base`: integration branch. Defaults to `main`.
- `roadmap`: roadmap path. Defaults to `docs/roadmap.md`.
- `designDocs`: design document and ADR locations cited in planner prompts.
- `researchNote`: optional external-library research pointer, such as a vendored
  source path.
- `grepaiWorkspace`: GrepAI workspace name. Defaults to `Projects`.
- `grepaiProject`: canonical main-branch GrepAI project name. Set this when the
  ODW source path or worker worktree path would make `$(get-project)` resolve to
  the wrong project.
- `maxParallel`: worker pool width. Defaults to `2` unless `taskId` is set.
- `maxTasks`: maximum roadmap tasks for one run.
- `maxDesignRounds`: planning and design-review exchange cap. Defaults to `4`.
- `maxReviewRounds`: implementation review/fix exchange cap. Defaults to `3`.
- `taskId`: run exactly one roadmap task.
- `dryRun`: when `true`, plan, review, and audit without implementation,
  integration, or document writes.
- `autoMerge`: when `false`, leave reviewed task branches for manual
  integration.
- `documentAudit`: when `false`, return audit findings without writing audit
  files.
- `buildAdapter` and `buildModel`: adapter and model for worktree creation,
  implementation, integration, and remediation agents.
- `planAdapter` and `planModel`: adapter and model for planning agents.
- `reviewAdapter` and `reviewModel`: adapter and model for design review, code
  review, expert review, and audit agents.

Example `args.json`:

```json
{
  "base": "main",
  "roadmap": "docs/roadmap.md",
  "designDocs": "docs/architecture.md, docs/adr-001-adopt-odw-sidecar-launches.md, docs/users-guide.md, docs/developers-guide.md",
  "grepaiWorkspace": "Projects",
  "grepaiProject": "example-project",
  "maxParallel": 2,
  "maxTasks": 6,
  "buildAdapter": "codex-medium",
  "buildModel": "gpt-5.5",
  "planAdapter": "codex-high",
  "planModel": "gpt-5.5",
  "triageAdapter": "codex-high",
  "triageModel": "gpt-5.5",
  "reviewAdapter": "codex-high",
  "reviewModel": "gpt-5.5"
}
```

## Recovery model

Do not try to resume a failed workflow from transient cache state. Treat
`origin/<base>` as the source of truth, inspect the result, clean up or repair
the target project as needed, and relaunch from the sidecar. The workflow
re-selects unblocked roadmap work from the current roadmap state.

Use the `df12-build-supervisor` skill for the detailed operator playbook:
failure-mode diagnosis, orphan worktree cleanup, remediation triage, stash
hygiene, and deciding when a roadmap frontier is actually dry.

Read `docs/security-and-permissions.md` before granting a workshop write,
network, or GitHub access. It names the permissions and external services a run
can use, and explains why roadmap, design, audit, and review text must be
treated as prompt-injection input rather than trusted control logic.
