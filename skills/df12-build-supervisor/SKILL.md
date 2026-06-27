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

1. **Keep the workflow script at a durable path OUTSIDE the repo working tree.**
   `.claude/` is not `git clean -fdx`-proof — a clean run (by an agent or a
   make target) will wipe it and can break a live run or a resume. Copy
   `workflows/df12-build.js` to a stable location (e.g. under the session
   directory) and launch from there with `Workflow({ scriptPath: "…" })`. If
   the script is ever lost, recover its source from the run-metadata JSON
   (`<session>/workflows/wf_<id>.json`, top-level `script` field).
2. **Launch in the background** and let the harness notify you on completion (a
   `task-notification`). Do **not** poll it — when harness-tracked work
   finishes you are re-invoked automatically.
3. **Config (the `args` object / top-of-file consts):** `base` (default `main`),
   `roadmap` (default `docs/roadmap.md`), `designDocs`, `researchNote` (a
   project-specific external-library research pointer, e.g. a vendored lib's
   source path), `maxParallel` (pool width — default 2 to keep coderabbit from
   saturating), `maxTasks`, `maxDesignRounds` (4), `maxReviewRounds` (3),
   `taskId` (run exactly one), `dryRun`, `autoMerge`, `documentAudit`.
   **Caveat:** `args` do not reach `scriptPath` launches — to retune, edit the
   defaults at the top of the script file itself.

## The supervision cycle

Every time a run completes you do the same loop:

1. **Parse the result JSON.** Key fields: `processed` (ids merged this run),
   `results[]` (per-task `{id, status, stage, detail}`), `halted` (null on a
   clean stop), `audits[]`, `remediationTriage[]`, `pendingProposals`
   (proposals left unwritten because the run halted — triage them manually
   later).
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
5. **Relaunch** from the durable script path. The run re-selects from the
   current `origin/BASE` roadmap — no resume needed.

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
  one agent turn — it gets the code green but runs out before committing.
  **Decompose into fewer-work-item tasks.** This and design-review size halts
  are the same root cause: tasks that are too big for one plan/implement turn.
- **Integrate halt** (rebase conflict the agent would not resolve safely):
  inspect the conflict; resolve it preserving the intent of both sides (favour
  the design docs/contracts), or re-file the task. The branch is left unmerged
  for you.
- **Review halt** (dual review unsatisfied within the cap): the branch is left
  unmerged with the blocking items; either hand-fix and merge, or fold the
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
- **Recoverable API faults (500 / 429):** wait and retry. coderabbit 429
  backoffs are **expected and fine** — never shorten them. For a broad outage,
  schedule a long wake-up (≈1h) and relaunch; the fresh-restart model means
  nothing is lost.
- **Worktree base-skew:** git-donkey can root a worktree on a stale local `BASE`
  (its pull-rebase prompt defaults to "no" non-interactively). The workflow's
  worktree step already mitigates this (no-param `git donkey` + an in-worktree
  `git reset --hard origin/BASE` + a base-sha verify). If you see "based on a
  stale commit" failures, that mitigation is the place to look.
- **A run that dies mid-flight:** do not try to resume. Hoover, then relaunch
  fresh. Worker interleaving is non-deterministic, so prefix-resume is
  unreliable by design.

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
- **Large restructures deserve a deterministic transform.** For a big renumber
  (e.g. collapsing bucket-steps), write a script that preserves task bodies
  byte-for-byte and remaps ids + cross-references via an explicit map, then
  **validate hard before merging**: task-count in == out, every `Requires`
  resolves, gates green, and the unrelated phases are untouched. Measure twice.
- **Place new work at step boundaries** (`phase.step.task`), live and
  fix-debt-first, so the pool picks it up on the next refill.

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
user-facing value past a point. Recognise the inflection: when the spine is
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
  launch from durable scriptPath
        │
        ▼
  run builds in background  ──▶  task-notification on completion
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
