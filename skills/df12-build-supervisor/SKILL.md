---
name: df12-build-supervisor
description: >-
  Operator playbook for supervising a df12-build workshop — driving a df12-house
  GIST roadmap (docs/roadmap.md) to completion with the df12-build parallel
  workflow. Covers launching runs, monitoring, hoovering orphan worktrees,
  diagnosing and fixing halts (design-review, size, integrate, API faults),
  safely editing/restructuring the roadmap while the loop runs, feeding back
  remediation, and knowing when to stop. Use when you are the operator agent
  supervising df12-build against any project that follows the df12 house
  conventions.
---

# df12-build supervisor

You are the **operator** (a.k.a. supervisor) of a df12-build workshop. The
`df12-build` workflow (`workflows/df12-build.js`) does the building — it fans
out across the unblocked roadmap frontier, plans, adversarially reviews,
implements, gates, merges, and audits each task in isolated worktrees. **Your
job is the loop around the loop:** launch it, watch for completion, clean up
after it, diagnose and repair halts, keep the roadmap honest, and decide when
the work is actually done. The workflow is the worker; you are the foreman.

The golden rule that makes this safe: **recovery is fresh-restart against git
state, never cache-resume.** `origin/<BASE>` (default `main`) is the single
source of truth. Any run can die; you relaunch fresh and it re-selects from the
roadmap. So your cleanup discipline (worktrees + branches + a clean `BASE`)
matters more than any individual run.

## Target-project requirements (the df12 house conventions)

df12-build is generic over projects that follow these conventions. Before
launching against a project, confirm it has them (the
`agent-template-{rust,python,typescript}` copier templates — the generated
content lives under each repo's `template/` directory, e.g.
`template/Makefile.jinja` — are the canonical starting point;
`agent-helper-scripts` installs the toolchain; `df12-documentation-skills`
provides the doc skills):

- **A GIST `docs/roadmap.md`** (authored to the `roadmap-doc` skill): Goals →
  Ideas → Steps → Tasks. Each **phase** carries an `Idea:`; each **step**
  states a hypothesis ("This step answers whether…"); each **task** is a line
  `- [ ] X.Y.Z. <title>` with an optional `- Requires A.B.C and D.E.F.` line
  and a `- Success:` criterion. A task is **unblocked** when it is `[ ]` and
  every id it Requires is `[x]`. A completed `[x]` task may carry nested
  `[ ] X.Y.Z.n` **addendum** sub-tasks (a lightweight pass).
- **Design docs + ADRs under `docs/`** (`tech-design-doc` skill), plus a
  developers' guide and users' guide. These are the source of truth the
  planners and reviewers are held to. Point the workflow at them with the
  `designDocs` arg.
- **`AGENTS.md`** declaring the quality gates and testing rules.
- **Make gate targets:** `make all` (the deterministic gate — format, lint,
  typecheck, test), and `make markdownlint` + `make nixie` (markdown + mermaid
  gates) run whenever markdown changes. If a project names its gate
  differently, it is not yet df12-conformant — align it first.
- **`coderabbit review --agent`** as the per-work-item AI review (a shared,
  rate-limited quota — see the throughput note below).
- **`git donkey`** for worktree/branch creation (leynos/git-donkey).
- **The skill toolchain** (installed from `agent-helper-scripts` via
  `install-skills` / `install-sub-agents`): `execplans`,
  `logisphere-design-review`, `logisphere-experts`, `code-review`, `leta`
  (LSP-aware navigation), `sem` (semantic history), `rebase`, `firecrawl`, and
  the language `*-router` skills; plus the doc skills from
  `df12-documentation-skills` (`roadmap-doc`, `tech-design-doc`,
  `en-gb-oxendict`, `commit-message`, `pr-creation`).
- **en-GB Oxford spelling** (`-ize`/`-yse`/`-our`, the `en-gb-oxendict` skill)
  in all prose, comments, and commits.

## Launching a run

1. **Create a `.workshop` sidecar outside the project Git worktree.** Use a
   sibling directory named after the project, for example:

   ```bash
   PROJECT=/data/leynos/Projects/odw-lint
   RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
   SIDECAR="${PROJECT}.workshop/df12-build-${RUN_ID}"
   mkdir -p "$SIDECAR"
   ```

   The sidecar is the durable operator workspace for the run. It survives root
   branch switches, `git clean -fdx`, workflow-created worktree cleanup, and
   accidental cleanup under `.claude/`. Do not place durable scripts, configs,
   or notes in `.claude/`, `/tmp`, the project source tree, or a
   workflow-owned `...worktrees/roadmap-*` worktree.
2. **Put all run-control artefacts in that sidecar.** At minimum keep:

   - `df12-build-odw.js` — a copied workflow script that the live run executes.
   - `odw.config.json` — adapter, model, workspace, and runtime settings.
   - `args.json` — project-specific workflow args.
   - `operator-notes.md` — run id, launch command, patches, validations,
     status checks, failures, and operator decisions.

   Bootstrap the workflow script once so later launches do not overwrite
   sidecar-local recovery edits:

   ```bash
   if [ ! -e "$SIDECAR/df12-build-odw.js" ]; then
     cp /path/to/df12-build/workflows/df12-build-odw.js \
       "$SIDECAR/df12-build-odw.js"
   fi
   ```

   Treat the sidecar as durable run state, not as source of truth for the
   product repository. `origin/<BASE>` remains the only product source of
   truth. Patch the sidecar script during a live workshop when needed, validate
   it there, record the change in `operator-notes.md`, and later promote the
   proven change back to the `df12-build` repository as an ordinary branch.
   For normal Codex and Claude Code workshops, set ODW `concurrency` to `16`;
   keep `maxAgents` high (for example `1000`) because it is the per-run
   dispatch guard, not the live process-pool size. Set the adapter `timeout`
   high enough for CodeRabbit's expected rate-limit backoff: agents may
   legitimately sleep for three 45-90 minute retries, so a one-hour timeout can
   kill healthy work. Use `21600` seconds for ordinary long-running workshops
   unless you deliberately want a shorter cap.

   When copying a newer workflow into an existing sidecar, audit `args.json`
   before relaunch. Stale `planAdapter`, `reviewAdapter`, or
   `assessmentAdapter` overrides from a Codex-only run will override the
   workflow's current Claude/Codex split. Make sure every adapter named in
   `args.json` exists in `odw.config.json` or in ODW's built-in adapter set;
   the current ODW workflow expects a `claude` adapter for default planning and
   review judgement.
3. **Launch ODW from the sidecar, with the project as `--source`.** Prefer the
   checked-in ODW workflow when running the Codex build-side agents together
   with the Claude Code planning and review agents:

   ```bash
   odw run "$SIDECAR/df12-build-odw.js" \
     --source "$PROJECT" \
     --config "$SIDECAR/odw.config.json" \
     --args @"$SIDECAR/args.json"
   ```

   Use the absolute sidecar workflow path. With `--source`, ODW resolves
   relative workflow paths under the source project, not under the shell's
   current working directory.

   Start the run in the background and supervise it through `odw status`,
   `odw logs`, `odw result`, and the dashboard. Keep periodic health notes in
   `operator-notes.md`; the notes should be good enough for another operator
   to continue after context compaction.
4. **Config (the `args` object / top-of-file consts):** `base` (default `main`),
   `roadmap` (default `docs/roadmap.md`), `designDocs`, `researchNote` (a
   project-specific external-library research pointer, e.g. a vendored lib's
   source path), `grepaiWorkspace`, `grepaiProject` (the canonical main-branch
   GrepAI project name; set this when agents run from sidecar or worktree
   paths), `maxParallel` (task pool width — default 8),
   `maxPlanningParallel` (planning-stage width — default 4),
   `maxBuildParallel` (build-stage width — default 4), `maxTasks`,
   `maxDesignRounds` (4), `maxReviewRounds` (3),
   `taskId` (run exactly one), `dryRun`, `autoMerge`, `documentAudit`,
   `assessPartialBranches`, `buildAdapter`/`buildModel`,
   `planAdapter`/`planModel`, `reviewAdapter`/`reviewModel`, and
   `assessmentAdapter`/`assessmentModel`.

   Recovery and enforcement knobs: `resumePartialBranches` (opt-in fresh-run
   discovery of surviving `roadmap-*` branches, default off), `resumeMode`
   (`assess` reports only — the default; `review` may route clean, committed,
   task-scoped `adopt-complete` branches with validation evidence back through
   the ordinary review + integration path), `resumeTaskId` (narrow discovery
   to one id; separate from `taskId`), `resumeMaxCandidates` (default 4), and
   `worktreeWritePreflight` (host-verified probe that the plan and build
   adapters can write into sibling task worktrees; on by default).

   The checked-in defaults split execution from judgement. Build-side work
   uses Codex defaults, while planning and review judgement use Claude Code
   with `claude-opus-4-8`. Partial-branch assessment inherits the review route
   unless the sidecar `args.json` sets `assessmentAdapter` and
   `assessmentModel` explicitly.
5. **For legacy Claude `Workflow({ scriptPath: ... })` launches, use the same
   sidecar rule.** `scriptPath` launches may not receive `args`; if you use
   that harness, retune by editing the copied sidecar script itself and record
   the edit in `operator-notes.md`.

## The supervision cycle

Every time a run completes you do the same loop:

1. **Parse the result JSON.** Key fields: `processed` (ids merged this run),
   `results[]` (per-task `{id, status, stage, detail}` plus any
   `assessment`; recovery-resumed branches carry `kind: "recovery-resume"`),
   `assessments[]` (summaries for failed or halted branches that
   were assessed), `recovery` (the fresh-run recovery index when
   `resumePartialBranches=true`: `candidates`, `assessed`, `resumed`,
   per-candidate `results` with classification/action/reason, and `skipped`
   with machine-readable reasons), `halted` (null on a clean stop), `audits[]`,
   `remediationTriage[]`, `pendingProposals` (proposals left unwritten because
   the run halted — triage them manually later).
2. **Hoover orphan worktrees.** For each non-root worktree under
   `…worktrees/roadmap-*`: stash any dirt with a **named** stash (see "Stash
   hygiene" below —
   `git -C <wt> stash push -u -m "df12-stash v1 task=<id> kind=discard reason=hoover-orphan"`,
   deriving `<id>` from the `roadmap-<id>` branch), remove it
   (`git worktree remove <wt>` — not `--force`, which is blocked), point its
   branch back at `origin/BASE` and delete it, then `git worktree prune`.
   Finally bring local `BASE` up:
   `git switch BASE && git merge --ff-only origin/BASE`.
3. **Gate the integrated state:** run `make all` on `BASE`. It should be green
   (the workflow only merges green branches), but verify — a concurrent edit
   can surprise you.
4. **Branch on outcome:**
   - **Clean stop** (`halted` null): the frontier is dry or the task ceiling was
     hit. Check how much roadmap remains; decide whether to relaunch (more
     unblocked work) or stop (see "Knowing when to stop").
   - **Halted:** diagnose with the failure-mode playbook, apply the fix to the
     roadmap (or environment), then relaunch.
5. **Run mandatory roadmap maintenance before editing the roadmap.** If the run
   produced `remediationTriage`, `pendingProposals`, audit findings, addenda, or
   any roadmap restructure work, load `roadmap-grooming` together with
   `roadmap-doc` before changing `docs/roadmap.md`. This is a supervisor
   requirement, not an optional clean-up pass. Do not groom merely because a
   normal run is in progress; use the trigger thresholds below.
6. **Relaunch** from the durable script path. The run re-selects from the
   current `origin/BASE` roadmap — no resume needed.

## Active invariant checks

Do not only watch phase logs. At each check-in, verify that the workflow's
claimed df12-build side effects exist in the real repository state. The
supervisor is responsible for catching workshop loops that are spending rounds
on impossible environment or orchestration faults.

Record every check-in in `operator-notes.md` with:

- wall time and run id;
- ODW state and dispatched count;
- active task ids and phases;
- root status;
- active worktrees and their side effects;
- gate and review evidence;
- stale-process suspicion;
- roadmap-grooming threshold result;
- next wake-up.

For every active `roadmap-*` worktree, check:

- the worktree exists and is writable;
- `git status --short --branch`;
- `git log --oneline origin/BASE..HEAD`;
- any returned `execplanPath` exists on disk;
- advertised gate logs exist;
- claimed commits, dirty files, or clean branches match the agent output.

If a planner returns an ExecPlan path but the file is missing, inspect the
child transcript immediately. Repeated missing ExecPlans usually indicate a
sandbox, workspace-root, or worktree write failure, not an intractable roadmap
task. Pause or stop the run and repair the workflow or environment rather than
burning further design-review rounds.

Known concrete failure:

- Symptom: agents repeatedly return missing or unwritten plan or changed-file
  paths under sibling worktrees.
- Cause: Codex was launched with `--cd` at the control checkout, so
  `workspace-write` rejects writes to sibling worktrees.
- Fix: launch task agents with the assigned git worktree as their execution
  root, or configure the adapter to include the worktree parent as an allowed
  writable root.

Treat design-review blockers as probably correct only after the reviewed
artifact actually exists and is readable from the assigned worktree. If the
reviewed artifact is absent, diagnose the missing side effect before editing
the roadmap.

## Worked operator examples

These are examples of the shapes you should recognize after context compaction.
They are not templates for fabricating evidence; copy the live run facts.

### Result JSON

```json
{
  "base": "main",
  "processed": ["2.1.1", "2.1.2"],
  "results": [
    {
      "id": "2.1.1",
      "status": "done",
      "stage": "integrate",
      "detail": "squash merged and pushed"
    },
    {
      "id": "2.1.2",
      "status": "halted",
      "stage": "review",
      "detail": "reviewers not satisfied within cap",
      "assessment": {
        "classification": "continue-manual",
        "recommendation": "Inspect review blockers before deciding whether to keep the branch"
      }
    }
  ],
  "assessments": [
    {
      "id": "2.1.2",
      "stage": "review",
      "status": "halted",
      "classification": "continue-manual",
      "recommendation": "Inspect review blockers before deciding whether to keep the branch"
    }
  ],
  "audits": [
    {
      "afterTask": "2.1.1",
      "proposedRoadmapItems": [
        {
          "title": "Cover empty-input recovery",
          "severity": "high"
        }
      ]
    }
  ],
  "remediationTriage": [
    {
      "step": "2.1",
      "ok": true,
      "pushed": true,
      "decisions": [
        {
          "lane": "addendum",
          "target": "2.1.1"
        }
      ]
    }
  ],
  "pendingProposals": [],
  "halted": "task 2.1.2 halted at review: reviewers not satisfied within cap"
}
```

Operator reading: `2.1.1` landed and may have generated an addendum. `2.1.2`
did not land. Its assessment says the branch needs manual judgement, so inspect
the review blockers and branch evidence before deciding whether to keep it.
Hoover worktrees, fast-forward `BASE`, run `make all`, and load
`roadmap-grooming` before editing any remediation back into the roadmap.

### Operator notes

```markdown
# df12-build run 20260629T101500Z-4242

- Project: `/data/leynos/Projects/example`
- Sidecar: `/data/leynos/Projects/example.workshop/df12-build-20260629T101500Z-4242`
- Base: `main`
- Args: `maxParallel=8`, `maxPlanningParallel=4`, `maxBuildParallel=4`,
  `maxTasks=12`, `autoMerge=true`
- Launch: `odw run "$SIDECAR/df12-build-odw.js" --source "$PROJECT" ...`
- 10:22: `2.1.1` integrated; audit proposed one high-severity addendum.
- 10:41: `2.1.2` halted at review; branch left unmerged.
- Decision: hoover, gate `origin/main`, repair `2.1.2` task wording, relaunch.
```

Good notes record enough state for another operator to continue: paths, args,
run id, status checks, failures, decisions, and validations.

### Halted design-review repair

Failure:

```text
task 3.2.4 halted at design-review:
design review unsatisfied after 4 rounds: removal is not complete by
construction; plan does not enumerate all consumers before deleting the adapter
```

Repair in `docs/roadmap.md`:

```markdown
- [ ] 3.2.4. Remove the legacy adapter after proving every consumer has moved.
  - Requires 3.2.1 and 3.2.3.
  - Enumerate every import and runtime lookup of the legacy adapter, re-point
    each consumer, delete the adapter, and gate the deletion with a grep that
    proves no stale import remains.
  - Success: the adapter file is gone, no stale reference remains, and `make
    all` passes.
```

The repair changes the task so the next planner starts from the blocking design
requirement. Do not relax the reviewer. Fix the task.

### Review halt

Failure:

```text
task 4.1.2 halted at review:
reviewers not satisfied within cap; branch left unmerged for the root agent
```

Operator action:

1. Inspect the task branch and the returned `codeReview` / `expertReview`
   blockers.
2. If the branch is sound but incomplete, finish the fix in a separate
   worktree, run `make all`, run the relevant markdown gates, and merge through
   the same protected integration path.
3. If the blockers reveal broader scope, do not hand-wave it into the branch.
   Fold the finding back into the roadmap after loading `roadmap-grooming` and
   relaunch.

### Triage batch

Input proposals:

```json
[
  {
    "title": "Cover empty-input parser recovery",
    "severity": "high",
    "source": "audit:2.1.1"
  },
  {
    "title": "Rename local helper for style consistency",
    "severity": "low",
    "source": "review:2.1.2"
  },
  {
    "title": "Move retry policy docs beside the operator guide",
    "severity": "medium",
    "source": "audit:2.1.1"
  }
]
```

Expected operator reading:

- The high-severity recovery gap can become an addendum under the completed
  task if it is small.
- The low-severity rename is likely dropped unless it serves an existing step
  hypothesis.
- The documentation move belongs under the step whose hypothesis covers
  operator recovery, not necessarily under the step that happened to produce
  the audit.

### Audit-inflation grooming pass

Symptom:

```text
5.7. Single-home retry labels
5.8. Single-home retry parsing
5.9. Harden retry labels
5.10. Harden retry parsing
5.11. Single-home retry docs
```

Operator action:

1. Stop adding one new step per audit finding.
2. Load `roadmap-grooming` and `roadmap-doc`.
3. Group the findings by the real seam, for example one retry-policy
   consolidation step followed by one hardening task that depends on it.
4. Preserve dotted dependencies and validate every `Requires` reference before
   merging the restructure.

## Failure-mode playbook

The workflow halts (drains in-flight work, then stops) on the first task
failure. Most halts are the **adversarial design review earning its keep** —
treat a blocking verdict as probably correct and fix the *task*, not the
reviewer.

- **Design-review halt** (`design review unsatisfied after N rounds`): read the
  blocking points. They are usually legitimate. Repairs, in order of preference:
  - **Decompose** an over-large or risky task into smaller, independently
    landable tasks (this is the most common fix — see "size halt").
  - **Bake the reviewer's required resolution into the task text** so the next
    plan starts from it instead of rediscovering it. (E.g. a removal that must
    be "complete-by-construction": enumerate consumers, re-point + drop imports,
    gate the deletion behind a grep.)
  - For a **doc-sweep** task, reframe it as **completeness-driven** ("rewrite
    for accuracy; grep proves no stale reference; reconcile prose that describes
    the retired thing as present") rather than an enumerated list of line
    repairs — the reviewer can always find an unenumerated stale line otherwise.
  - If the plan's **premise is factually wrong** (e.g. it assumes one code
    boundary when there are two), correct the fact in the task so the planner
    cannot repeat it.
- **Implement halt** (often a turn-budget/size issue): a task with many work
  items, each gated by `make all` + a per-item coderabbit review, can exceed
  one agent turn. Check `result.assessment` before decomposing the task. A
  timeout may leave a coherent partial slice worth preserving, but the roadmap
  task stays unchecked unless its success criterion is complete and gates/review
  prove it. If the assessment does not identify useful partial work, decompose
  into fewer-work-item tasks. This and design-review size halts are the same
  root cause: tasks that are too big for one plan/implement turn.
- **Integrate halt** (rebase conflict the agent would not resolve safely):
  inspect the conflict; resolve it preserving the intent of both sides (favour
  the design docs/contracts), or re-file the task. The branch is left unmerged
  for you.
- **Addendum manual-merge-ready** (the addendum agent reported completed work,
  green gates, and no open issues, but did not satisfy the strict `ok=true`
  schema contract): preserve the branch and verify it manually before any merge.
  Rerun `make all` plus `make markdownlint`/`make nixie` when Markdown changed,
  confirm CodeRabbit or equivalent review evidence, reconcile the roadmap
  sub-task checkbox, then integrate or discard. Do not relaunch before deciding,
  or the same open addendum can be selected again from `origin/BASE`.
- **Review halt** (dual review unsatisfied within the cap): the branch is left
  unmerged with the blocking items. Check `result.assessment` first. If it says
  `adopt-complete`, verify gates and continue through the ordinary review and
  integration path. If it says `adopt-partial`, preserve only the coherent slice
  without ticking the roadmap task. If it says `continue-manual`, inspect the
  branch before deciding. If it says `discard`, hoover it unless live evidence
  contradicts the recommendation. Either hand-fix and merge, or fold the
  findings back into the roadmap and re-file.
- **Roadmap-prose-fix halt** (an addendum/task whose sole deliverable is editing
  the roadmap's *own* text — a wrong success criterion, a mis-stated contract):
  this is structurally un-runnable, because sub-agents are forbidden to edit
  the roadmap, so it hard-blocks. The triage's **`editorial` lane** is meant to
  catch these and apply them inline (triage is the one step that may edit the
  roadmap); if one still reaches you blocked, **apply the prose fix yourself as
  the operator** and tick the item. Watch for it specifically when a contract
  was documented in two places (e.g. the roadmap *and* `SKILL.md`) and only one
  was corrected — fix the stale copy to match the authoritative one.
- **Recoverable API faults (500 / 429 / 529):** wait and retry. The ODW
  variant reports these as `provider-fault` halts, skips partial-branch
  assessment, and leaves pending remediation unwritten so an outage is not
  mistaken for task evidence. CodeRabbit 429 backoffs are **expected and
  fine** — never shorten them. For a broad outage, schedule a long wake-up
  (≈1h) and relaunch; the fresh-restart model means nothing is lost.
- **Worktree base-skew:** git-donkey can root a worktree on a stale local `BASE`
  (its pull-rebase prompt defaults to "no" non-interactively). The workflow's
  worktree step already mitigates this (no-param `git donkey` + an in-worktree
  `git reset --hard origin/BASE` + a base-sha verify). If you see "based on a
  stale commit" failures, that mitigation is the place to look.
- **A run that dies mid-flight:** do not try to resume transcripts or cached
  scheduler state. Worker interleaving is non-deterministic, so prefix-resume
  is unreliable by design. You now have two recovery options, in order of
  preference:
  1. **Assess-first relaunch:** relaunch with `resumePartialBranches=true`
     (default `resumeMode="assess"`). The fresh run discovers surviving
     `roadmap-*` branches, assesses each against ADR 002, and reports them in
     the top-level `recovery` object without mutating anything. Read the
     classifications, then decide per branch: enable `resumeMode="review"` on
     a follow-up run to let clean `adopt-complete` branches re-enter review
     and integration, finish `continue-manual` branches by hand, or hoover
     `discard` branches.
  2. **Hoover and rebuild:** the pre-recovery behaviour — stash-park, remove
     worktrees, reset branches, and let selection rebuild the task from
     `origin/BASE`. Still correct when the surviving work is worthless.
  While recovery is enabled, every id with a surviving branch is held out of
  normal selection for that run (a fresh `git worktree add -b` would collide
  with the surviving branch), so reported-but-unresolved branches must be
  resumed, finished manually, or hoovered before the pool will rebuild those
  tasks.
- **`worktree-write` failure (task-agent writable-root preflight):** the plan
  or build adapter could not write a host-verified probe file inside the task
  worktree. This is a launch/sandbox fault — fix the adapter config (writable
  roots covering `...worktrees/roadmap-*`) and relaunch; do not burn design
  rounds or reword roadmap tasks. The verdict is computed once per run, so
  every task fails fast together.

## Editing or restructuring the roadmap safely

You will frequently edit `docs/roadmap.md` (adding tasks, fixing a halted task,
restructuring). While a run may be live:

- **Never edit in the root/control worktree.** The workflow's integrate step
  does `git switch BASE` in the root — switching it to a branch will collide.
  Always work in a **separate** worktree created off `origin/BASE`.
- **Gate before you commit.** Run `make markdownlint` and `make nixie` and
  confirm they are clean *before* committing — do not push a lint error to
  `BASE`.
- **Land it concurrency-safely.** If no run is live: ff-merge to `BASE` and
  push. If a run is live: push with a fetch-rebase-retry loop (the roadmap has
  a merge driver that weaves concurrent edits; rebases are usually clean).
- **Use `mapsplice` for structural roadmap edits.** The `mapsplice` CLI (load
  its skill for usage) appends, inserts, deletes, and replaces numbered
  phases, steps, tasks, and addendum sub-tasks while preserving renumbering
  and `Requires` references. Prefer it over hand-editing whenever the change
  is structural rather than prose-only.
- **Large restructures deserve a deterministic transform.** For a big renumber
  (e.g. collapsing bucket-steps), drive it with `mapsplice` where its
  operations fit; otherwise write a script that preserves task bodies
  byte-for-byte and remaps ids + cross-references via an explicit map. Either
  way, **validate hard before merging**: task-count in == out, every
  `Requires` resolves, gates green, and the unrelated phases are untouched.
  Measure twice.
- **Place new work at step boundaries** (`phase.step.task`), live and
  fix-debt-first, so the pool picks it up on the next refill.

## Roadmap grooming thresholds

Grooming is trigger-based, not time-based. A healthy roadmap should be left
alone during ordinary supervision. Hourly check-ins should stay lightweight:
sample roadmap health every few check-ins, or after a run reaches a terminal
state, but do not run a broad grooming pass unless the roadmap has actually
accreted new material or structural debt.

Trigger a full grooming pass when any of these are true:

- A run emits `remediationTriage`, `pendingProposals`, audit findings, addenda,
  or explicit roadmap restructure work.
- A phase grows past roughly five or six open steps.
- Two or more single-task steps accrue in the same phase.
- Two or more same-theme refactor, hardening, or reconciliation fragments sit
  unconsolidated.
- Capability work appears inside a refactor, hardening, or reconciliation
  phase.

Do not groom merely because there is one active task, one partial ExecPlan, a
normal dependency chain, or a roadmap that still looks structurally coherent.
Those are ordinary workshop states, not grooming signals.

Trigger local task repair immediately when a workflow blocker is caused by
ambiguous roadmap wording. Keep that repair narrow: clarify the task's expected
fixture updates, success criterion, or contract text, then relaunch. A
design-review-discarded task whose fixture expectations were implicit is a
targeted task clarification, not a broad roadmap grooming pass.

## Feeding back remediation, and the bucket-inflation trap

The workflow's reviews and audits surface follow-up work as *proposals* (never
written by the sub-agents). Its **triage** step routes each, by GIST
hypothesis, into one of: **addendum** (a small fix folded onto a completed
task's execplan + a nested `[ ]` sub-task — the cheap, no-plan/no-review lane),
**step-task** (substantial work serving the settling step's hypothesis),
**reroute** (substantial work filed under the step whose hypothesis it actually
serves), or **dropped**. The cheap addendum lane (which generates no audit) is
what stops the remediation-of-remediation spiral.

**Watch the audit→reroute lane: it inflates the hardening phase.** Every merged
task gets a post-merge audit; audits reliably find a duplication or an untested
edge; reroute files each — and, biased to spawn a new step when none fits, it
grows the hardening phase into dozens of single-task "steps" across two
redundant themes (single-source/DRY and guard-hardening). A one-task "step" is
a task wearing a step's hat. When you see this accumulating:

- **Consolidate.** Collapse the buckets into a handful of honest steps grouped
  by domain (e.g. several "single-home X" steps → one "single-source the
  projections" step with many tasks), order them DRY-first so hardening and
  docs attach to one canonical implementation, and move genuine *features* out
  to a later phase.
- **Fix the generator** in the roadmap's phase preamble (and the workflow's
  triage guidance): fold audit findings into the *relevant existing step* (or a
  single debt task), filtered by severity — **never a new step per finding**.

This section is a summary; the full discipline is the **`roadmap-grooming`**
skill (`df12-documentation-skills`) — the kind/lane taxonomy that keeps
capability work out of refactoring phases, kind-specific value axes, the method
for constructing proper steps from de-duped, seam-aligned refactoring and
re-architecting tasks, and the genuine-debt-versus-churn test. Load it (paired
with **`roadmap-doc`** for the GIST grammar and format it assumes) whenever you
restructure a roadmap or feed remediation back into one.

## Knowing when to stop

The spine (the core product an end user actually exercises) is the high-value
work. The hardening tail is **self-generating** — the audit loop manufactures
DRY/robustness work faster than it clears it, and that work has near-zero
user-facing value past a point. Recognize the inflection: when the spine is
done and dogfood-ready and the open frontier is almost all hardening, **do not
grind indefinitely**. Surface it to your principal with concrete options: pause
to dogfood the real thing (the highest-value next step — it produces the next
round of *real* findings), cap the tail by severity, or continue. The principal
sets the budget; you do not burn it silently.

## Stash hygiene and the sweeper contract

Agents and the operator both `git stash` constantly — to park unrelated
formatter churn, to clean a worktree before removal, to clear control-worktree
detritus before a squash. Because `git stash drop`/`clear` are often
sandbox-blocked, these stashes accumulate (hundreds, over a long run). They are
harmless against `origin/BASE` but become unmanageable if they are named
opaquely, so the workflow imposes a **machine-parsable naming convention** that
lets a deterministic sweeper clear stashes for completed tasks without touching
in-flight work.

**The format.** Every stash message is:

```text
df12-stash v1 task=<id> kind=<discard|park|keep> reason="<short>"
```

- `df12-stash v1` — a fixed sentinel and version, so a sweeper can tell a
  managed stash from a hand-made or default (`WIP on …`) one and never touch
  the latter.
- `task=<id>` — the roadmap id the stash belongs to (`7.1.6`), or `control` for
  control-worktree detritus not tied to one task. Git also prepends the free
  `On <branch>:` prefix, a second task signal when the stash was made on a
  `roadmap-<id>` branch.
- `kind=` — disposition: `discard` (safe to drop once the task is done — most
  parked formatter churn), `park` (review before dropping), `keep` (must be
  re-applied; never auto-drop).

**Never** use a bare `git stash push`; its default
`WIP on <branch>: <sha> <subject>` names the last commit, not the stash's
purpose.

**The sweeper contract** (a deterministic tool can implement this; it is *safe
by construction* and never interrupts ongoing work):

1. Read `git stash list`; strip git's `On <branch>:` / `WIP on <branch>:`
   prefix; match `^df12-stash v\d+ task=(\S+) kind=(\w+)`. A non-match is not
   managed — skip it.
2. Compute the **active** set: tasks with a live worktree or branch
   (`git worktree list` → `roadmap-<id>`). These are in flight — skip their
   stashes unconditionally.
3. Compute the **completed** set: roadmap ids that are `[x]` on `origin/BASE`.
4. Drop only entries where `kind=discard` **and** `task` is completed **and**
   `task` is not active, iterating from the highest stash index down so refs
   stay stable. Leave every `kind=keep`, every active-task stash, and every
   unmanaged stash untouched.

The operator applies the same convention when hoovering (cycle step 2). Until a
sweeper exists, run `git stash clear` outside the sandbox during a quiet
moment; the convention makes a filtered `git stash list | grep 'kind=discard'`
audit the safe precursor.

## Environment safety-net constraints

This sandbox blocks several destructive/irreversible git and shell operations.
Use the safe equivalents:

- `rm -rf` outside the cwd → blocked. Scope deletions to the worktree.
- `git checkout <ref> -- <path>` → blocked. Use
  `git show <ref>:<path> > <path>`.
- `git worktree remove --force` → blocked. Stash dirt first, then plain
  `git worktree remove`.
- `git branch -D <br>` → blocked. Use `git branch -f <br> origin/BASE` then
  `git branch -d <br>`.
- `git stash drop` → blocked. Leave the stash parked (harmless).
- Foreground `sleep` → blocked. Use a background command or a scheduled wake-up
  for backoff/waiting.

## At a glance

```text
  launch ODW from .workshop sidecar
        │
        ▼
  run builds in background  ──▶  status/logs/result/dashboard checks
        │
        ▼
  parse result · hoover worktrees · ff BASE · make all
        │
        ├─ halted ──▶ fix task / edit roadmap (separate worktree, gated),
        │             then relaunch ──┐
        ◀───────────────────────────┘
        │
        └─ clean stop + spine done + tail all hardening
                 ──▶ stop; surface options to the principal
```
