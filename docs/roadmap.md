# df12-build roadmap

This roadmap translates `docs/failure-resume-design.md` and ADR 002 into a
short delivery sequence for failure resume in the ODW workflow. It does not
promise dates. Each phase carries one GIST idea, each step answers a delivery
question, and each task is intended to be review-sized.

The scope is intentionally narrow: discover surviving branches, report
assessments on fresh launch, allow explicit review-mode resume for clean
`adopt-complete` branches, and then add an explicit accepted-plan reuse path
for open tasks whose durable ExecPlan has already passed design review.
Automatic partial adoption stays deferred.

## 1. Fresh-run recovery discovery

Idea: if the workflow can find surviving task branches from durable Git state
before normal roadmap selection, operators can recover useful work without old
agent transcripts or manual branch archaeology.

This phase delivers assess-only recovery. It should not merge, push, delete, or
mark roadmap items complete.

### 1.1. Settle the recovery controls

This step answers which operator knobs are needed before discovery can run
safely. It informs every later task because recovery defaults must remain
non-mutating.

- [x] 1.1.1. Add `resumePartialBranches`, `resumeMode`, `resumeTaskId`, and
  `resumeMaxCandidates` configuration to the ODW workflow.
  - See `docs/failure-resume-design.md` section "Runtime configuration".
  - Success: default workflow behaviour is unchanged unless
    `resumePartialBranches=true`.
- [x] 1.1.2. Document the recovery arguments in the user guide, architecture
  guide, security guide, developer guide, and supervisor skill.
  - Requires 1.1.1.
  - See `docs/failure-resume-design.md` sections "Runtime configuration" and
    "Security and permissions".
  - Success: operators can distinguish assess-only recovery from review-mode
    resume before launching a run.
- [x] 1.1.3. Enforce writable task-agent roots for real git worktrees.
  - Requires 1.1.1.
  - See `docs/architecture.md` sections "Workflow structure" and "Enforcement
    boundary".
  - Ensure planning, review, implementation, fix, addendum, and integration
    agents can read and write the assigned `roadmap-*` worktree rather than
    only the control checkout.
  - Success: a planner can create `docs/execplans/<branch-leaf>.md` in a
    sibling task worktree, and design review reads that same on-disk artifact
    before judging the plan.

### 1.2. Discover candidates without mutating the target project

This step answers whether the workflow can reconstruct useful recovery
candidates from Git and roadmap state alone. Its output feeds assessment and
later review-mode resume.

- [x] 1.2.1. Implement candidate discovery for `roadmap-*` branches and live
  worktrees.
  - Requires 1.1.1.
  - See `docs/failure-resume-design.md` section "Recovery candidate discovery".
  - Success: fixture tests map branch names to dotted roadmap ids, skip
    completed roadmap tasks, and preserve deterministic ordering.
- [x] 1.2.2. Return a top-level `recovery` summary in assess-only mode.
  - Requires 1.2.1.
  - See `docs/failure-resume-design.md` section "Returned result shape".
  - Success: an assess-only run reports candidates, skipped branches, and
    assessment outcomes without changing `processed`.

### 1.3. Reuse ADR 002 assessment for recovered candidates

This step answers whether fresh-run discovery can share the existing
assessment contract instead of creating a second recovery classifier.

- [x] 1.3.1. Route discovered candidates through the existing assessment
  evidence collector and schema.
  - Requires 1.2.1.
  - See `docs/failure-resume-design.md` section "Assessment reuse" and
    `docs/adr-002-assess-partial-task-branches.md`.
  - Success: recovered candidates produce the same classification enum and
    evidence fields as in-run failed task assessments.
- [x] 1.3.2. Add no-mutation regression coverage for assess-only recovery.
  - Requires 1.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: tests prove assess-only recovery does not mark roadmap tasks,
    push, merge, delete branches, or add ids to `processed`.

## 2. Explicit review-mode resume

Idea: if clean `adopt-complete` branches can re-enter the existing review and
integration path, the workflow can finish work that survived a system failure
without weakening gates or branch protection.

This phase adds one mutating recovery path. It must remain opt-in and use the
existing review and integration machinery.

### 2.1. Gate resume eligibility before review

This step answers which recovered branches are safe enough to spend review and
integration effort on. Its output prevents dirty or ambiguous branches from
being treated as complete work.

- [x] 2.1.1. Implement the recovery decision table for `resumeMode`.
  - Requires phase 1.
  - See `docs/failure-resume-design.md` section "Resume decisions".
  - Success: only clean, committed, task-scoped `adopt-complete` candidates
    with validation evidence can enter review-mode resume.
- [x] 2.1.2. Return explicit skip reasons for candidates that cannot enter
  review-mode resume.
  - Requires 2.1.1.
  - See `docs/failure-resume-design.md` sections "Returned result shape" and
    "Failure modes".
  - Success: operators can tell whether a candidate was skipped for dirt,
    missing validation, completed roadmap state, auth failure, or ambiguity.

### 2.2. Re-enter the existing review and integration path

This step answers whether resume can finish a recovered branch without a custom
merge path. Reuse is the safety property: the same gates should apply to
ordinary and recovered work.

- [x] 2.2.1. Build a synthetic implementation result for eligible recovered
  branches.
  - Requires 2.1.1.
  - See `docs/failure-resume-design.md` section "Review-mode resume path".
  - Success: recovered branches can enter review without re-running the
    implementation agent.
- [x] 2.2.2. Route eligible recovered branches through existing review,
  CodeRabbit, expert review, and integration logic.
  - Requires 2.2.1.
  - See `docs/failure-resume-design.md` sections "Review-mode resume path" and
    "Security and permissions".
  - Success: a recovered branch lands only through the existing merge lock and
    roadmap update path.

### 2.3. Prove the end-to-end recovery combinations

This step answers whether the recovery controls interact safely with ordinary
workflow modes. It covers the small combination surface that matters for v1.

- [x] 2.3.1. Add fixture-driven combination tests for recovery modes.
  - Requires 2.2.2.
  - Cover `resumePartialBranches=false`, assess-only, review-mode clean
    `adopt-complete`, dirty branch, completed roadmap task, and auth preflight
    failure.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: the same fixture suite proves both non-mutating assess-only and
    opt-in review-mode behaviour.
- [x] 2.3.2. Run a bounded operator-approved ODW smoke test against a throwaway
  target repository.
  - Requires 2.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: `resumeMode="assess"` reports an existing branch, and
    `resumeMode="review"` attempts only the eligible branch.

## 3. Accepted ExecPlan reuse for unbuilt tasks

Idea: if the workflow can recognize a durable, fresh, accepted ExecPlan for an
open roadmap task, it can avoid repeating planning work while preserving the
same implementation, review, and integration gates.

This phase handles plan-state continuation, not branch-state continuation. It
must sit after normal deterministic selection and fail closed to the ordinary
plan/design loop whenever plan acceptance or freshness cannot be proven.

### 3.1. Define durable accepted-plan evidence

This step answers what evidence is strong enough to skip the planner and design
reviewer. Its output informs the host-side checks and the ExecPlan-writing
contract.

- [ ] 3.1.1. Define the accepted ExecPlan metadata contract.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` section "Accepted ExecPlan reuse".
  - Include the roadmap task id, approval status, approving design-review
    evidence, source roadmap commit, design-input fingerprint, and validation
    commands.
  - Success: a workflow can distinguish a durable accepted plan from a stale
    draft, an uncommitted plan, or a transcript-only approval.
- [ ] 3.1.2. Document the accepted-plan reuse controls.
  - Requires 3.1.1.
  - See `docs/failure-resume-design.md` sections "Runtime configuration" and
    "Accepted ExecPlan reuse".
  - Cover `reuseAcceptedExecPlans`, `acceptedPlanMode`, freshness failure
    behaviour, and the fallback to ordinary planning.
  - Success: operators can run report-only plan verification before allowing a
    build from an accepted plan.

### 3.2. Adopt fresh plans after deterministic selection

This step answers whether the workflow can reuse an accepted plan without
changing roadmap frontier semantics. Selection should remain pure; plan
adoption happens only after an ordinary open task is selected.

- [ ] 3.2.1. Add the post-selection accepted-plan adoption gate.
  - Requires 3.1.1.
  - See `docs/failure-resume-design.md` section "Accepted ExecPlan reuse".
  - Success: the workflow checks the matching ExecPlan for the selected task
    and falls back to the normal plan/design loop when the plan is absent,
    unapproved, stale, or ambiguous.
- [ ] 3.2.2. Route accepted plans into the existing implementation path.
  - Requires 3.2.1.
  - See `docs/failure-resume-design.md` sections "Accepted ExecPlan reuse" and
    "Review-mode resume path".
  - Success: `acceptedPlanMode="build"` can launch implementation from a fresh
    accepted plan while preserving CodeRabbit, expert review, merge-lock,
    roadmap-marking, and audit behaviour.

### 3.3. Prove accepted-plan reuse combinations

This step answers whether the plan-reuse controls interact safely with normal
selection, dry runs, and recovery resume.

- [ ] 3.3.1. Add fixture-driven tests for accepted-plan adoption.
  - Requires 3.2.2.
  - Cover disabled reuse, report-only verification, build-mode adoption,
    missing plan, stale task text, changed design inputs, and uncommitted plan
    files.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: tests prove accepted-plan reuse never changes task selection and
    never skips implementation or review gates.
- [ ] 3.3.2. Run a bounded operator-approved ODW smoke test for plan reuse.
  - Requires 3.3.1.
  - See `docs/failure-resume-design.md` section "Verification".
  - Success: a throwaway target repository with an accepted plan enters
    implementation in build mode, while a stale plan falls back to planning.

## 4. Deferred recovery extensions

Idea: if the first recovery slice remains boring and operator-controlled, later
automation can be evaluated on product value rather than used to fix v1 safety
gaps.

These tasks are intentionally outside the quick build path.

### 4.1. Evaluate partial adoption after dogfooding

This step keeps `adopt-partial` useful without making it automatic before the
manual path has evidence.

- [ ] 4.1.1. Decide whether `adopt-partial` should create addenda, recovery
  ExecPlans, or manual merge proposals.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` section "Deferred decisions".
  - Success: an ADR records whether any partial adoption path should become
    automatic.

### 4.2. Evaluate cleanup automation separately

This step separates resume from destructive cleanup so operators can trust the
first recovery slice.

- [ ] 4.2.1. Decide whether `discard` branches can be deleted by a managed
  sweeper.
  - Requires phase 2.
  - See `docs/failure-resume-design.md` sections "Failure modes" and
    "Deferred decisions".
  - Success: deletion, stash handling, and branch-retention policy are recorded
    before any automated cleanup lands.
