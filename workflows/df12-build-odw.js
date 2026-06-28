export const meta = {
  name: 'df12-build-odw',
  description:
    'ODW/Codex variant of df12-build: drive a roadmap to completion with a parallel worker pool, Codex GPT 5.5 routing, branch-local verification guidance, serialized integration, and post-merge audit.',
  whenToUse:
    'When you want to autonomously advance docs/roadmap.md across MULTIPLE independent unblocked tasks at once, each fully planned, reviewed, implemented, gated, merged, and audited. Opt-in only (heavy, many agents in parallel, performs commits/merges). Recovery model is fresh-restart against git state, not cache-resume.',
  phases: [
    { title: 'Select' },
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Design Review' },
    { title: 'Implement' },
    { title: 'Code Review' },
    { title: 'Expert Review' },
    { title: 'Integrate' },
    { title: 'Audit' },
    { title: 'Remediation' },
  ],
}

// ---------------------------------------------------------------------------
// Configuration (all overridable through the ODW `args` object).
// ---------------------------------------------------------------------------
const cfg = args || {}
const BASE = cfg.base || 'main' // integration branch: rebase + squash-merge target, roadmap source of truth
const ROADMAP = cfg.roadmap || 'docs/roadmap.md'
const DESIGN_DOCS = cfg.designDocs || 'the design document(s) and the ADRs (docs/adr-*.md) under docs/' // project design sources cited in prompts
const RESEARCH_NOTE = cfg.researchNote || null // optional project-specific external-library research note (e.g. a vendored lib source path to verify against)
const ONLY_TASK = cfg.taskId || null // process exactly one named roadmap id (e.g. "1.2.1")
const MAX_TASKS = ONLY_TASK ? 1 : cfg.maxTasks || 12 // hard ceiling on roadmap steps per run
const MAX_PARALLEL = ONLY_TASK ? 1 : Math.max(1, cfg.maxParallel || 2) // worker-pool width: tasks built concurrently. Default 2 to keep coderabbit (a shared, rate-limited quota) from saturating and timing out tasks. Agents are globally capped at min(16, cores-2).
const MAX_DESIGN_ROUNDS = cfg.maxDesignRounds || 4 // plan <-> design-review exchanges before halting
const MAX_REVIEW_ROUNDS = cfg.maxReviewRounds || 3 // review -> fix -> re-review cycles
const AUTO_MERGE = cfg.autoMerge !== false // false => stop after review, leave branch for manual merge
const DOCUMENT_AUDIT = cfg.documentAudit !== false // false => return audit findings only, write nothing
const DRY_RUN = cfg.dryRun === true // plan/review/audit only; skip implement, merge, and doc writes
const BUDGET_RESERVE = 80_000 // stop opening new tasks when remaining budget falls below this
const GREPAI_WORKSPACE = cfg.grepaiWorkspace || 'Projects'
const GREPAI_PROJECT = cfg.grepaiProject || cfg.project || null // canonical main-branch GrepAI project; set this when source is a worktree
const BUILD_ADAPTER = cfg.buildAdapter || 'codex-medium'
const PLAN_ADAPTER = cfg.planAdapter || 'codex-xhigh'
const REVIEW_ADAPTER = cfg.reviewAdapter || 'codex-high'
const BUILD_MODEL = cfg.buildModel || 'gpt-5.5'
const PLAN_MODEL = cfg.planModel || 'gpt-5.5'
const REVIEW_MODEL = cfg.reviewModel || 'gpt-5.5'

function buildAgentOptions(options = {}) {
  return { adapter: BUILD_ADAPTER, model: BUILD_MODEL, ...options }
}

function planAgentOptions(options = {}) {
  return { adapter: PLAN_ADAPTER, model: PLAN_MODEL, ...options }
}

function reviewAgentOptions(options = {}) {
  return { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL, ...options }
}

function grepaiSearchCommand() {
  const projectArg = GREPAI_PROJECT || '$(get-project)'
  return `grepai search --workspace ${GREPAI_WORKSPACE} --project ${projectArg} "<English intent query>" --toon --compact`
}

// ---------------------------------------------------------------------------
// Shared preamble — prepended to every agent so the standing rules are
// non-negotiable: tooling, worktree isolation, doc adherence, en-GB spelling.
// ---------------------------------------------------------------------------
function preamble(worktree) {
  const loc = worktree
    ? `Work EXCLUSIVELY inside the git-donkey worktree at ${worktree}. cd into it before doing anything. Never read-modify-write any file in the root/control worktree; it is off-limits for edits.`
    : `This is a read-only / setup step. Do not edit any file in the root/control worktree.`
  return [
    'You are a sub-agent in the df12-build roadmap workflow. Your final message IS your return value — return data, not chat.',
    '',
    'Standing rules (apply to every step, no exceptions):',
    `- ${loc}`,
    `- Use \`${grepaiSearchCommand()}\` as the PRIMARY tool for intent/concept code search against the canonical main-branch index. The grepai index reflects \`main\` only: never treat it as evidence for branch-local or newly changed code. Verify every branch-local fact directly inside your worktree with \`leta\`, exact text search, or file inspection before acting.`,
    '- Use `leta` for symbol navigation, references, call graphs, and branch-local verification (leta show / refs / grep / files) instead of ad-hoc ripgrep or read-file.',
    '- Use `sem` for codebase history navigation (semantic, entity-level diffs and blame) instead of raw git log/blame.',
    '- Load the appropriate language router skill for any code you touch: python-router for Python, rust-router for Rust, and the matching router for other languages. Follow the smaller skills it routes you to.',
    `- Treat docs/ as the source of truth: ${DESIGN_DOCS}, the developers guide, any users guide present, the coding/scripting standards, and AGENTS.md. Obey AGENTS.md quality gates and the en-GB Oxford-spelling ("-ize"/"-yse"/"-our") convention in all prose, comments, and commits.`,
    `- The integration branch is "${BASE}"; treat origin/${BASE} as canonical. The roadmap lives at ${ROADMAP}.`,
    '- Format ONLY the files you changed: run the markdown formatter on the specific paths you touched (`mdtablefix … <files>` then `markdownlint-cli2 --fix <files>`), then gate. Do NOT run a repo-global format such as `make fmt` / `mdformat-all` that reformats unrelated files — that churn only has to be parked and discarded.',
    '- Never `git stash` with a bare or default message. Name every stash so a deterministic sweeper can tie it to a task and clear it safely: `df12-stash v1 task=<this roadmap id> kind=<discard|park|keep> reason="<short>"`. Formatter or build churn you park is kind=discard; anything you must re-apply later is kind=keep.',
    '- Signpost the documentation and skills you relied on in your output so the next agent can follow the same trail.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hasTask: { type: 'boolean' },
    task: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'roadmap id, e.g. "1.2.1"' },
        title: { type: 'string' },
        requires: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string', description: 'why this task is unblocked (every Requires is [x] and it is [ ]); for an addendum pass, why the parent has open sub-tasks' },
        isAddendum: { type: 'boolean', description: 'true when this is a lightweight ADDENDUM PASS: a completed [x] task that now carries open [ ] sub-tasks to clear' },
        subtasks: { type: 'array', items: { type: 'string' }, description: 'for an addendum pass, the open sub-task ids to implement, e.g. ["1.2.8.1","1.2.8.3"]' },
      },
      required: ['id', 'title', 'requires', 'rationale'],
    },
    remainingUnblocked: { type: 'array', items: { type: 'string' }, description: 'other ids currently unblocked' },
    blockedSummary: { type: 'string', description: 'short note on what is still blocked and by what' },
  },
  required: ['hasTask'],
}

const WORKTREE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    worktreePath: { type: 'string' },
    branch: { type: 'string' },
    baseSha: { type: 'string' },
    donkeyInvocation: { type: 'string', description: 'the exact git donkey command used' },
    notes: { type: 'string' },
  },
  required: ['ok', 'worktreePath', 'branch'],
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    execplanPath: { type: 'string' },
    workItems: { type: 'array', items: { type: 'string' }, description: 'ordered execplan work-item titles' },
    docsCited: { type: 'array', items: { type: 'string' } },
    skillsCited: { type: 'array', items: { type: 'string' } },
    addressedSince: { type: 'string', description: 'how the previous design-review blocking points were resolved (empty on round 1)' },
    summary: { type: 'string' },
  },
  required: ['execplanPath', 'workItems', 'summary'],
}

const DESIGN_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    satisfied: { type: 'boolean', description: 'true only when the plan is implementable, design-conformant, and complete' },
    blocking: { type: 'array', items: { type: 'string' }, description: 'must-fix design defects; empty iff satisfied' },
    advisory: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['satisfied', 'blocking'],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true when every work item is implemented, committed, and make all is green' },
    execplanPath: { type: 'string' },
    workItemsCompleted: { type: 'integer' },
    workItemsTotal: { type: 'integer' },
    commits: { type: 'array', items: { type: 'string' } },
    gatesGreen: { type: 'boolean', description: 'make all (plus markdownlint/nixie where markdown changed) passes at HEAD' },
    coderabbitRuns: { type: 'integer' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'anything left unresolved, with reason' },
    summary: { type: 'string' },
  },
  required: ['ok', 'execplanPath', 'gatesGreen', 'summary'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes-requested'] },
    blocking: { type: 'array', items: { type: 'string' }, description: 'must-fix before the task can be called done' },
    advisory: { type: 'array', items: { type: 'string' } },
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        correctness: { type: 'string' },
        planAdherence: { type: 'string' },
        documentation: { type: 'string' },
        validation: { type: 'string' },
      },
    },
    proposedRoadmapItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, rationale: { type: 'string' }, severity: { type: 'string' } },
        required: ['title', 'rationale'],
      },
      description: 'follow-up work surfaced by the review — PROPOSED ONLY, never written to the roadmap by you',
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'blocking', 'summary'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    roadmapMarkedDone: { type: 'boolean' },
    rebased: { type: 'boolean' },
    squashMerged: { type: 'boolean' },
    mergeSha: { type: 'string' },
    pushed: { type: 'boolean' },
    conflicts: { type: 'string', description: 'description of any conflict encountered and how it was handled, empty if none' },
    summary: { type: 'string' },
  },
  required: ['ok', 'summary'],
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issueFile: { type: 'string', description: `path written under docs/issues/, empty if nothing recorded` },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', description: 'duplication | complexity | ergonomics | similarity | inconsistency | separation-of-concerns | cqs | docs-gap | test-gap' },
          location: { type: 'string' },
          description: { type: 'string' },
          proposedFix: { type: 'string' },
          severity: { type: 'string' },
        },
        required: ['category', 'location', 'description', 'proposedFix'],
      },
    },
    proposedRoadmapItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, rationale: { type: 'string' }, severity: { type: 'string' } },
        required: ['title', 'rationale'],
      },
      description: 'PROPOSED ONLY — adding these to the roadmap is reserved to the root agent',
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function selectPrompt(taken) {
  const normalTaken = taken?.normal || []
  const addendumTaken = taken?.addendum || []
  return [
    preamble(null),
    `TASK: Identify the next roadmap task that is ready to start.`,
    '',
    `Read the roadmap. Prefer the canonical copy on the integration branch: \`git show origin/${BASE}:${ROADMAP}\` (fall back to the working-tree ${ROADMAP} if origin/${BASE} is unreachable, and say so).`,
    '',
    'Roadmap conventions:',
    '- A task is a line like `- [ ] 1.2.1. <title>` (incomplete) or `- [x] ...` (complete).',
    '- A task may declare dependencies in a child bullet such as `- Requires 1.1.2 and 1.2.1.` (zero or more ids).',
    '- A task is UNBLOCKED when it is `[ ]` AND every id it Requires is `[x]`. A task with no Requires line is unblocked once incomplete.',
    '- ADDENDUM PASSES: a COMPLETED task (`- [x] <id>.`) may carry nested `- [ ] <id>.<n>.` sub-tasks — lightweight addenda folded back onto it (e.g. `- [ ] 1.2.8.3.` under `- [x] 1.2.8.`). A parent with one or more OPEN sub-tasks is itself ready to work as a single ADDENDUM PASS, regardless of the parent being [x]. Represent it with the PARENT id as `id`, `isAddendum=true`, and every open sub-task id listed in `subtasks`. Its own dependencies are already satisfied (the parent is done), so an addendum pass is always unblocked.',
    '',
    ONLY_TASK
      ? `Restrict your answer to task id "${ONLY_TASK}": return it only if it is genuinely unblocked (or is a completed parent with open sub-tasks), otherwise hasTask=false with blockedSummary explaining what blocks it.`
      : `Consider BOTH (a) unblocked incomplete tasks and (b) completed tasks that have open sub-tasks (addendum passes). Choose the one with the lowest id in document order. For an addendum pass set isAddendum=true and fill \`subtasks\`; for a normal task leave isAddendum false/omitted. Normal tasks already taken this run (merged, or being built in parallel): [${normalTaken.join(', ') || 'none'}]. Addendum passes already taken this run (merged, or being built in parallel): [${addendumTaken.join(', ') || 'none'}]. Do NOT re-pick the same kind of work. CRITICAL: a task id listed under normal tasks does NOT block an ADDENDUM PASS for the same id — a just-merged [x] task that has since gained open [ ] sub-tasks is a valid addendum pass and SHOULD be selected now (fix-debt-first). Only skip an addendum pass whose own addendum pass was already taken this run.`,
    '',
    'If no task qualifies, return hasTask=false. Do not modify any file.',
  ].join('\n')
}

function worktreePrompt(task) {
  const slug = `roadmap-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')}${task.isAddendum ? '-addendum' : ''}`
  return [
    preamble(null),
    `TASK: Create an isolated worktree + branch for roadmap task ${task.id} ("${task.title}") using \`git donkey\`, rooted on the CURRENT tip of origin/${BASE}. Do NOT do any task work here.`,
    '',
    `Syntax: \`git donkey <branch-name> [parent-ref]\`. It creates the branch + worktree and PRINTS the worktree path in its output — capture that path from stdout.`,
    '',
    `Procedure — this MUST end with the branch at the current origin/${BASE} tip, even when the control worktree's local ${BASE} is stale (it usually is after a remediation flush pushes origin/${BASE} without advancing local ${BASE}):`,
    `  1. \`git fetch origin ${BASE}\` to retrieve the current origin/${BASE} tip.`,
    `  2. Create the worktree with \`git donkey ${slug}\` and NO parent ref. With no second argument git donkey pulls local ${BASE} forward to origin/${BASE} and roots the new branch there — the behaviour we want. Do NOT pass \`origin/${BASE}\` (git donkey misparses a remote-qualified ref as a bare branch name and fails looking for \`origin/origin/${BASE}\`), and avoid passing a bare \`${BASE}\` parent (that pins to the local ref, which may be stale, and is a known git donkey bug).`,
    `  3. SAFETY NET for non-interactive runs: git donkey advances ${BASE} via an interactive pull-rebase prompt that defaults to "no" when stdin is non-interactive, so it may still root on a stale commit. If \`git -C <worktree> rev-parse HEAD\` does not already equal \`git rev-parse origin/${BASE}\`, re-root from INSIDE the new worktree (the branch has no work yet, so this loses nothing): \`cd <worktree>\` then \`git reset --hard origin/${BASE}\`. This mutates ONLY the new worktree — never the root/control worktree.`,
    `  4. VERIFY the base: \`git -C <worktree> rev-parse HEAD\` MUST equal \`git rev-parse origin/${BASE}\`. If they differ, set ok=false and explain.`,
    '',
    'Requirements:',
    `- The new worktree branch MUST sit at the current origin/${BASE} tip (verified in step 4); return that sha as baseSha.`,
    '- Return the absolute worktree path, the branch name, the verified base sha, and the exact commands you ran (in donkeyInvocation).',
    `- Stay within the worktree: never edit or advance any ref in the root/control worktree. If you cannot produce a correctly-based worktree without doing so, set ok=false and explain in notes.`,
  ].join('\n')
}

function planPrompt(task, worktree, priorVerdict, round) {
  const revision =
    round === 1
      ? 'This is the first planning round.'
      : [
          `This is planning round ${round}. The design reviewer was NOT satisfied. Resolve every blocking point below by revising the execplan, then explain in addressedSince how each was resolved:`,
          ...(priorVerdict?.blocking || []).map((b, i) => `  ${i + 1}. ${b}`),
        ].join('\n')
  return [
    preamble(worktree),
    `TASK: Produce (or revise) a self-contained ExecPlan for roadmap task ${task.id} — "${task.title}".`,
    '',
    'Use the `execplans` skill and follow it exactly. Name the plan docs/execplans/<branch-leaf>.md within the worktree (branch leaf = the part after the last "/").',
    'The plan must:',
    '- Decompose the task into ordered, atomic work items, each independently committable and gate-passable.',
    `- Adhere to the design documents (${DESIGN_DOCS}), the developers guide, the coding standards, and AGENTS.md. Cite the exact sections/ADRs each work item implements.`,
    '- Signpost, per work item, the documentation to read and the skills to load (router skills, hypothesis/crosshair/mutmut for verification, etc.).',
    '- Specify the tests (unit, behavioural, property, snapshot, e2e) each work item must add or update, per the AGENTS.md testing rules.',
    '- State the validation commands (make all; plus make markdownlint and make nixie for markdown changes).',
    '- VALIDATION COMMANDS MUST BE PATH-SAFE: prefer repository gates such as `make all`, `make markdownlint`, and `make nixie` over hand-written file lists. If a work item lists direct formatter/linter commands, every listed path must definitely exist at that point in the work item. Do not include a file that the same work item may delete, an optional file such as an optional snapshot, or a file that the work item does not edit. If a path is conditional, make the command conditional (`test -e path && …`) or omit that path and rely on the repository gate. This is a blocking design-review requirement.',
    '',
    'RESEARCH before you commit to any mechanism — do not leave the implementer a menu of unverified workarounds:',
    '- For every external or locked library the plan leans on, verify its REAL behaviour before relying on it: read the actual source (a vendored or sibling checkout if the project has one) and the official docs (use the `firecrawl` skill / firecrawl_* tools). Pin every load-bearing API to what the LOCKED version genuinely supports and cite the file/symbol or doc you verified against. If the library cannot express what a work item needs, say so explicitly and specify the justified, scoped alternative rather than hedging.',
    ...(RESEARCH_NOTE ? [`- Project-specific research guidance: ${RESEARCH_NOTE}`] : []),
    '- Every load-bearing behavioural claim must be either verified-and-cited or pinned by a test in the plan. No undecided forks.',
    '',
    revision,
    '',
    'Write/update the execplan file on disk in the worktree. Return its path, the ordered work-item titles, the docs and skills cited, and a short summary. Do NOT begin implementation.',
  ].join('\n')
}

function designReviewPrompt(task, worktree, plan, round) {
  return [
    preamble(worktree),
    `TASK: Conduct an ADVERSARIAL Logisphere DESIGN review of the ExecPlan for roadmap task ${task.id} at ${plan.execplanPath}. Round ${round}.`,
    '',
    'Invoke the `logisphere-design-review` skill and run the plan past the full crew (Pandalump structural integrity, Wafflecat alternatives, Buzzy Bee scaling, Telefono contracts, Doggylump failure modes, Dinolump long-term viability), plus the pre-mortem and alternatives checkpoint.',
    'Be genuinely adversarial: assume the plan is flawed until proven otherwise. Check it against the design documents, ADRs, developers guide, and AGENTS.md. Verify the work items are atomic, ordered, testable, and complete; that validation is specified; that direct formatter/linter file lists only name files guaranteed to exist and changed by that work item; and that nothing contradicts the deterministic/judgemental boundary or the established contracts.',
    '',
    'Read the execplan from disk yourself — do not trust the planner\'s summary. You may leave review notes in the execplan or an adjacent review file, but do NOT implement anything and do NOT relax the design to make it pass.',
    'Where the plan asserts any external or locked-library behaviour, verify it against the REAL source (a vendored or sibling checkout if the project has one) and the official docs. Treat any uncited memory-based claim about library behaviour as a blocking defect: the plan must verify and cite (firecrawl the official docs) or pin the behaviour with a test.',
    '',
    'Set satisfied=true ONLY when you would stake your name on the plan being implementable and design-conformant as written. Otherwise list precise, addressable blocking defects (these go straight back to the planner).',
  ].join('\n')
}

function implementPrompt(task, worktree, plan) {
  return [
    preamble(worktree),
    `TASK: Implement roadmap task ${task.id} ("${task.title}") by executing the approved ExecPlan at ${plan.execplanPath}, work item by work item, in order.`,
    '',
    'For EACH execplan work item, in this exact order:',
    '  1. Implement the work item (code + tests + docs) per the plan and AGENTS.md.',
    '  2. DETERMINISTIC GATE FIRST: run `make all`. If it fails, fix the failures (format, lint, typecheck, tests, audit) and re-run until green. For any markdown you touched, also run `make markdownlint` and `make nixie` and fix failures. Do not proceed to coderabbit until the deterministic gates are green.',
    '  3. THEN run `coderabbit review --agent` from inside the worktree. Address its actionable feedback (highest severity first). After applying fixes, re-run `make all` to confirm the deterministic gates are still green.',
    '     - If coderabbit reports a rate limit, READ the quoted wait time from its response (it usually states one, e.g. "waitTime ~16 min" or "retry after N"). Do NOT retry before that window elapses — earlier retries are guaranteed to fail and only burn the turn. Wait the quoted duration plus a small margin (via sleep), then retry ONCE. If no time is quoted, fall back to exponential backoff (30s, 60s, 120s, 240s, 480s, cap ~900s). If the quoted wait would not fit your remaining turn budget, do NOT sit in a doomed wait: the deterministic gates already passed, so commit the work item now and record the deferred coderabbit review in the execplan and openIssues for a later run to complete.',
    '  4. Commit the work item as one atomic commit (en-GB imperative subject ~50 cols, wrapped body explaining what and why).',
    '  5. Update the execplan IN PLACE with findings, progress (tick the work item), and any decisions or deviations, with rationale.',
    '',
    'Use leta for navigation, sem for history, and the language router skill for the languages you touch. Follow the per-work-item skill and documentation signposts in the plan.',
    '',
    `${DRY_RUN ? 'DRY RUN: do not run this step — it is skipped by the orchestrator.' : ''}`,
    'When all work items are done, ensure `make all` is green at HEAD. Return the completion counts, commit subjects, whether gates are green, the number of coderabbit runs, and any open issues.',
  ].join('\n')
}

function fixPrompt(task, worktree, plan, blocking, round) {
  return [
    preamble(worktree),
    `TASK: Address blocking review findings for roadmap task ${task.id} (fix round ${round}). Execplan: ${plan.execplanPath}.`,
    '',
    'The dual review returned the following BLOCKING items. Resolve every one:',
    ...blocking.map((b, i) => `  ${i + 1}. ${b}`),
    '',
    'Same per-change discipline as implementation: deterministic gate (`make all`, plus markdownlint/nixie for markdown) first and green, THEN `coderabbit review --agent` (on a rate limit, wait the quoted wait time before retrying — never retry before that window elapses — and if the quoted wait exceeds your turn, commit and record the deferred review), then an atomic commit, then update the execplan with what changed and why. Do not introduce scope beyond the blocking items.',
  ].join('\n')
}

function codeReviewPrompt(task, worktree, plan) {
  return [
    preamble(worktree),
    `TASK: Benchmark the implementation of roadmap task ${task.id} against its plan using the \`code-review\` skill.`,
    '',
    `Compare the committed work on this branch against the execplan at ${plan.execplanPath} and the design documents. Judge four axes explicitly:`,
    '- correctness (does it do what the task and plan specify; any bugs or regressions?),',
    '- plan adherence (were all work items delivered as planned; were deviations justified and recorded?),',
    '- documentation coverage (docstrings, developers/users guide, ADR/design updates per AGENTS.md),',
    '- validation coverage (unit, behavioural, property, snapshot, e2e per AGENTS.md; do the gates actually exercise the new behaviour?).',
    '',
    'Use leta to inspect the code and sem to inspect the change history. Use `make all` output as evidence but do not rely on it alone.',
    'Return verdict=pass only if you would ship it. List precise blocking items otherwise. Any follow-up ideas go in proposedRoadmapItems (PROPOSAL ONLY — do not touch the roadmap).',
  ].join('\n')
}

function expertReviewPrompt(task, worktree, plan) {
  return [
    preamble(worktree),
    `TASK: Run an ADVERSARIAL community-of-experts review of roadmap task ${task.id}, scoped STRICTLY to the work delivered for this task.`,
    '',
    'Invoke the `logisphere-experts` skill and bring the full crew to bear (architecture, alternatives, performance/observability, type-safety/contracts, reliability/ops, developer experience). Be adversarial: actively try to find what is wrong, brittle, or under-tested in THIS task\'s diff only — do not review unrelated code.',
    `Ground the review in the execplan at ${plan.execplanPath}, the design documents, and AGENTS.md. Use leta and sem.`,
    '',
    'Return verdict=pass only when the crew is collectively satisfied the task is correct, conformant, and production-ready within its scope. List precise blocking items otherwise. Surface broader follow-ups as proposedRoadmapItems (PROPOSAL ONLY — never edit the roadmap).',
  ].join('\n')
}

function implementAddendumPrompt(task, worktree) {
  const ids = (task.subtasks || []).join(', ')
  const parentPlan = `docs/execplans/roadmap-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')}.md`
  return [
    preamble(worktree),
    `TASK: Lightweight ADDENDUM PASS for completed roadmap task ${task.id}. Implement ONLY its open sub-tasks: ${ids}. This is an addendum, NOT a full task — there is deliberately NO plan, NO design review, and NO dual logisphere review. Keep every change surgical and strictly in-scope; an addendum that grows into a redesign is a defect.`,
    '',
    `These sub-tasks are recorded as unchecked items under an "## Addenda" section of the parent task's execplan (start at ${parentPlan}; if the leaf differs, find the execplan whose Addenda list contains ${ids}). Read that section for the precise scope and gate of each sub-task.`,
    '',
    'For EACH open sub-task, in id order:',
    '  1. Make ONLY the change the Addenda item describes. Do not expand scope.',
    '  2. DETERMINISTIC GATE: run `make all`. For any Markdown you touched, also run `make markdownlint` and `make nixie`. Fix until green.',
    '  3. Run `coderabbit review --agent` from inside the worktree; address actionable feedback (highest severity first); re-run `make all` to confirm green. On a coderabbit rate limit, read the QUOTED wait time from its response and wait at least that long before retrying (do NOT retry before that window elapses — it cannot succeed); if no time is quoted use exponential backoff (30s, 60s, 120s, 240s, 480s, cap ~900s); if the wait exceeds your turn, commit the gated work and record the deferred review in openIssues.',
    '  4. Commit the sub-task as one atomic commit (en-GB imperative subject).',
    `  5. Tick the sub-task in the Addenda checklist of its execplan (\`- [ ] ${task.id}.<n>\` → \`- [x] …\`).`,
    '',
    'Use leta for navigation, sem for history, and the language router skill for the languages you touch. Do NOT edit the roadmap — integration ticks the roadmap sub-tasks. When all listed sub-tasks are done, ensure `make all` is green at HEAD. Return using the IMPL schema (execplanPath = the parent execplan): completion counts, commit subjects, gatesGreen, coderabbit run count, and any open issues.',
  ].join('\n')
}

function integratePrompt(task, worktree) {
  const markStep = task.isAddendum
    ? `Tick each completed sub-task in ${ROADMAP}: for every id in [${(task.subtasks || []).join(', ')}], change its nested \`- [ ] ${task.id}.<n>.\` to \`- [x] …\`. LEAVE the parent ${task.id} as \`[x]\` (it was already done). Run \`make markdownlint\` and \`make nixie\`; commit the roadmap update (en-GB).`
    : `Mark the task done in ${ROADMAP}: change its \`- [ ] ${task.id}.\` to \`- [x] ${task.id}.\`. Run \`make markdownlint\` and \`make nixie\`; commit the roadmap update (en-GB).`
  return [
    preamble(worktree),
    `TASK: Integrate completed ${task.isAddendum ? `addendum pass for roadmap task ${task.id} (sub-tasks ${(task.subtasks || []).join(', ')})` : `roadmap task ${task.id} ("${task.title}")`}.`,
    '',
    `CONCURRENCY: sibling tasks are being built in parallel and merge through a single merge queue. You hold the merge lock for the duration of this step, so you are the only one merging right now — but origin/${BASE} may have advanced since your branch was created (a sibling merged, or a remediation flush landed). Always reconcile against the LATEST origin/${BASE} immediately before merging.`,
    '',
    `Steps, in order, from inside the worktree:`,
    `  1. ${markStep}`,
    `  2. Fetch and rebase the branch onto the current origin/${BASE} (\`git fetch origin ${BASE}\` then rebase). Use the \`rebase\` skill for functionality-aware conflict resolution: resolve each conflict by preserving the INTENT of both sides (favour the design docs and existing contracts), not by blindly taking one side. If a conflict genuinely cannot be resolved safely, set ok=false, describe it in conflicts, and STOP without merging.`,
    `  3. Re-run \`make all\` after the rebase to confirm the branch is still green.`,
    `  4. Land the squash ENTIRELY inside this worktree. NEVER \`git switch ${BASE}\` and never touch the control/root worktree or its checked-out ${BASE}: that switch fails when ${BASE} is checked out elsewhere, and it pollutes the control worktree (the root of recurring detritus). Step 2 left the task branch rebased on the current origin/${BASE}; from here, create a fresh temp branch there (\`git switch -c integrate-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')} origin/${BASE}\`), squash-merge the task branch onto it (\`git merge --squash <task-branch>\` then \`git commit\` with a clear squash message summarising the task), and push it straight to the integration branch with \`git push origin HEAD:${BASE}\`. If the push is rejected non-fast-forward (a sibling advanced origin/${BASE} since step 2), go back to step 2 — re-fetch and re-rebase the task branch onto the new origin/${BASE} — then redo this step. Retry until it lands.`,
    '',
    'Return what you actually did (roadmapMarkedDone, rebased, squashMerged, mergeSha, pushed) and any conflict notes. Do not delete the worktree unless git donkey expects you to; leave the repo in a clean state.',
  ].join('\n')
}

function auditPrompt(task, worktree) {
  const writeClause = DOCUMENT_AUDIT
    ? `Record your findings as a structured markdown file at docs/issues/audit-${task.id}.md (create docs/issues/ if absent), one section per finding with location and a concrete proposed fix. Run \`make markdownlint\` and \`make nixie\` on it, then commit it on your own worktree branch and push it straight to the integration branch with \`git push origin HEAD:${BASE}\` (re-fetch and rebase on a non-fast-forward reject, then retry). NEVER \`git switch ${BASE}\` or touch the control/root worktree.`
    : `Do NOT write any file; return findings only.`
  return [
    preamble(worktree),
    `TASK: Post-step codebase audit, run after roadmap task ${task.id} merged. Create a fresh git-donkey worktree off origin/${BASE} for your inspection (no work in the root worktree); explore with leta and trace history with sem.`,
    '',
    'Run this audit verbatim:',
    '"""',
    'Please audit the codebase for refactoring opportunities, places with repeated code, complex conditionals, ergonomic awkwardness, functions with high similarity, inconsistencies, poor separation of concerns or domain, command query segregation violation, or gaps in documentation comments, developer/user documentation and behavioural/unit test coverage. Propose actionable fixes for any issues identified.',
    '"""',
    '',
    writeClause,
    '',
    'Return every finding (category, location, description, proposed fix, severity) and any proposedRoadmapItems. Adding items to the roadmap is reserved to the root agent — propose only, never edit the roadmap.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Per-task pipeline
// ---------------------------------------------------------------------------
async function runTask(task, mergeLock) {
  const tag = `${task.id}`
  log(`[task ${tag}] ${task.title}`)

  // --- Worktree -----------------------------------------------------------
  phase('Worktree')
  const wt = await agent(worktreePrompt(task), buildAgentOptions({ phase: 'Worktree', label: `worktree:${tag}`, schema: WORKTREE_SCHEMA }))
  if (!wt || !wt.ok || !wt.worktreePath) {
    return { id: tag, status: 'failed', stage: 'worktree', detail: wt?.notes || 'worktree creation failed', proposals: [] }
  }
  const worktree = wt.worktreePath
  log(`[task ${tag}] worktree ${wt.branch} @ ${worktree}`)

  // --- Addendum pass: lightweight lane (no plan / design / dual review) ----
  // A completed task with open sub-tasks: implement the sub-tasks, gate, and
  // merge. No audit afterwards (the control loop skips it), which is what stops
  // remediation from spawning more remediation.
  if (task.isAddendum) {
    phase('Implement')
    const impl = await agent(implementAddendumPrompt(task, worktree), buildAgentOptions({ phase: 'Implement', label: `addendum:${tag}`, schema: IMPL_SCHEMA }))
    if (!impl || !impl.ok || !impl.gatesGreen) {
      return { id: tag, status: 'failed', stage: 'addendum', detail: impl?.summary || 'addendum did not reach a green state', openIssues: impl?.openIssues || [], worktree, proposals: [], kind: 'addendum' }
    }
    let integration = null
    if (AUTO_MERGE) {
      const doIntegrate = () => {
        phase('Integrate')
        return agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA }))
      }
      integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
      if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
        return { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)', worktree, proposals: [], kind: 'addendum' }
      }
    }
    return { id: tag, status: 'done', impl, integration, worktree, proposals: [], kind: 'addendum' }
  }

  // --- Plan <-> Design review (adversarial loop) --------------------------
  let plan = null
  let designVerdict = null
  for (let round = 1; round <= MAX_DESIGN_ROUNDS; round++) {
    phase('Plan')
    plan = await agent(planPrompt(task, worktree, designVerdict, round), planAgentOptions({
      phase: 'Plan',
      label: `plan:${tag} r${round}`,
      schema: PLAN_SCHEMA,
    }))
    if (!plan) return { id: tag, status: 'failed', stage: 'plan', detail: 'planner returned nothing', proposals: [] }

    phase('Design Review')
    designVerdict = await agent(designReviewPrompt(task, worktree, plan, round), reviewAgentOptions({
      phase: 'Design Review',
      label: `design-review:${tag} r${round}`,
      schema: DESIGN_VERDICT_SCHEMA,
    }))
    if (designVerdict?.satisfied) {
      log(`[task ${tag}] design approved in round ${round}`)
      break
    }
    log(`[task ${tag}] design round ${round}: ${(designVerdict?.blocking || []).length} blocking point(s)`)
    if (round === MAX_DESIGN_ROUNDS) {
      return {
        id: tag,
        status: 'halted',
        stage: 'design-review',
        detail: `design review unsatisfied after ${MAX_DESIGN_ROUNDS} rounds: ${(designVerdict?.blocking || []).join('; ')}`,
        worktree,
        proposals: [],
      }
    }
  }

  if (DRY_RUN) {
    return { id: tag, status: 'dry-run', stage: 'post-design', plan, worktree, proposals: [] }
  }

  // --- Implement ----------------------------------------------------------
  phase('Implement')
  const impl = await agent(implementPrompt(task, worktree, plan), buildAgentOptions({
    phase: 'Implement',
    label: `implement:${tag}`,
    schema: IMPL_SCHEMA,
  }))
  if (!impl || !impl.ok || !impl.gatesGreen) {
    return {
      id: tag,
      status: 'failed',
      stage: 'implement',
      detail: impl?.summary || 'implementation did not reach a green state',
      openIssues: impl?.openIssues || [],
      worktree,
      proposals: [],
    }
  }

  // --- Dual review (code-review + experts) with fix loop ------------------
  const proposals = []
  let reviewsPass = false
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const [codeReview, expertReview] = await parallel([
      () => agent(codeReviewPrompt(task, worktree, plan), reviewAgentOptions({ phase: 'Code Review', label: `code-review:${tag} r${round}`, schema: REVIEW_SCHEMA })),
      () => agent(expertReviewPrompt(task, worktree, plan), reviewAgentOptions({ phase: 'Expert Review', label: `expert-review:${tag} r${round}`, schema: REVIEW_SCHEMA })),
    ])
    for (const r of [codeReview, expertReview]) {
      if (r?.proposedRoadmapItems?.length) proposals.push(...r.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })))
    }
    const blocking = [
      ...((codeReview && codeReview.verdict !== 'pass' && codeReview.blocking) || []),
      ...((expertReview && expertReview.verdict !== 'pass' && expertReview.blocking) || []),
    ]
    if (blocking.length === 0 && codeReview?.verdict === 'pass' && expertReview?.verdict === 'pass') {
      reviewsPass = true
      log(`[task ${tag}] dual review passed in round ${round}`)
      break
    }
    log(`[task ${tag}] review round ${round}: ${blocking.length} blocking item(s)`)
    if (round === MAX_REVIEW_ROUNDS) break
    phase('Implement')
    await agent(fixPrompt(task, worktree, plan, blocking, round), buildAgentOptions({ phase: 'Implement', label: `fix:${tag} r${round}` }))
  }

  if (!reviewsPass) {
    return { id: tag, status: 'halted', stage: 'review', detail: 'reviewers not satisfied within cap; branch left unmerged for the root agent', worktree, proposals }
  }

  // --- Integrate (serialized behind the merge queue) ----------------------
  // Plan, design review, implement and the dual review all ran in parallel
  // with sibling tasks; only the rebase + squash-merge + push is serialized,
  // so at most one task touches origin/BASE at a time.
  let integration = null
  if (AUTO_MERGE) {
    const doIntegrate = () => {
      phase('Integrate')
      return agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA }))
    }
    integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
    if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
      return { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)', worktree, proposals }
    }
  }

  return { id: tag, status: 'done', plan, impl, integration, worktree, proposals }
}

// ---------------------------------------------------------------------------
// Post-step audit
// ---------------------------------------------------------------------------
async function runAudit(task) {
  phase('Audit')
  const audit = await agent(auditPrompt(task, null), reviewAgentOptions({ phase: 'Audit', label: `audit:after-${task.id}`, schema: AUDIT_SCHEMA }))
  return audit
}

// ---------------------------------------------------------------------------
// Remediation triage — when a step quiesces (no task from it still building),
// GIST-triage the review/audit proposals it accrued into three lanes instead of
// dumping them as full tasks into the current step:
//   • addendum  -> small fix folded onto a completed task's execplan + a nested
//                  [ ] sub-task (consumed by the lightweight addendum lane);
//   • step-task -> substantial work that serves THIS step's hypothesis;
//   • reroute   -> substantial work filed under the step/phase whose hypothesis
//                  it actually serves (a new step is created when none fits).
// Routing by hypothesis keeps a step carrying only debt that advances it, and
// the cheap addendum lane (no audit) is what stops the amplification spiral.
// ---------------------------------------------------------------------------
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposal: { type: 'string', description: 'short title of the proposal triaged' },
          lane: { type: 'string', enum: ['addendum', 'step-task', 'reroute', 'editorial', 'dropped'] },
          newId: { type: 'string', description: 'roadmap id created — a sub-task id like "1.2.8.5" for addendum, a task id for step-task/reroute, empty if dropped' },
          target: { type: 'string', description: 'addendum: parent task id + execplan folded onto; step-task/reroute: the step filed under; dropped: why' },
          reason: { type: 'string', description: 'GIST rationale — which step hypothesis it serves, or why it does not serve the settling step' },
        },
        required: ['proposal', 'lane', 'reason'],
      },
    },
    newSteps: { type: 'array', items: { type: 'string' }, description: 'any new step headings created to home reroutes, e.g. "7.4 Harden …"' },
    pushed: { type: 'boolean' },
    commitSha: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['ok', 'decisions', 'summary'],
}

const stepOf = (id) => String(id).split('.').slice(0, 2).join('.')

function triagePrompt(stepPrefix, proposals) {
  return [
    preamble(null),
    `TASK: GIST-triage the remediation proposals accrued during step ${stepPrefix} (now settled) and file each onto the correct roadmap lane. They came from the reviews and audits of step ${stepPrefix}'s tasks. RECORD them correctly; do NOT implement them.`,
    '',
    `Create a fresh git-donkey worktree off origin/${BASE} (no edits in the root worktree); do all work there. Read ${ROADMAP} in full first. It is a GIST roadmap: each PHASE states an "Idea:", each STEP states a hypothesis it confirms or falsifies ("This step answers whether…"), and each TASK has Success criteria. Route by hypothesis. Re-read step ${stepPrefix}'s hypothesis specifically.`,
    '',
    'For EACH proposal below: first DE-DUPLICATE (merge near-identical items; DROP any already covered by an existing task or sub-task), then choose exactly ONE lane:',
    '',
    '  • ADDENDUM — a small, surgical correction to a SPECIFIC already-completed task (a doc fix, a localised bugfix, a small test/fixture refactor; about one focused commit, no design needed). File it as BOTH (a) a new item under a "## Addenda" section of that task\'s execplan in docs/execplans/ (create the section if absent), and (b) a nested unchecked sub-task on the roadmap directly under that [x] parent, numbered `<parent-id>.<next-n>` (e.g. `- [ ] 1.2.8.5.`) with one child bullet `- Addendum (from <source>; <sev>). <one-line scope>. Lightweight addendum pass.` and NO Requires line. The harness runs these as a no-plan, no-review lightweight pass.',
    '',
    `  • STEP-TASK — substantial work (warrants its own plan and review) that genuinely advances the settling step's hypothesis (${stepPrefix}). Append a full task in step ${stepPrefix}: \`- [ ] ${stepPrefix}.<next-n>. <title>\` with a description bullet, an appropriate \`- Requires …\` line, and a \`- Success:\` criterion. Use this lane ONLY if you can name the ${stepPrefix} hypothesis it serves.`,
    '',
    '  • REROUTE — substantial work that does NOT serve the settling step\'s hypothesis (hardening, cross-cutting quality, or a different concern). File it as a full task under the EXISTING step whose hypothesis it genuinely serves, with a `- Requires …` line so it is sequenced correctly and blocks nothing earlier. If NO existing step fits, CREATE a new step under the most appropriate phase (prefer the hardening or "deferred extensions" phase, typically the last phase): add a `### <phase>.<n>. <title>` heading with a one-paragraph hypothesis ("This step answers whether…") followed by the task(s). Record any new step in newSteps.',
    '',
    '  • EDITORIAL — the proposal is a correction to the roadmap text itself (a task description, success criterion, or wording — not code or other docs). APPLY it directly to the roadmap NOW, in this step (you are already editing the roadmap here), and do NOT file it as an addendum or task: the addendum/step-task/reroute lanes run later as sub-agents that are FORBIDDEN to edit the roadmap, so such an item is un-runnable and would halt the loop. Record lane "editorial" and note the corrected wording in reason.',
    '  • DROPPED — duplicate, already done, or not actionable. Record why in reason.',
    '',
    'Rules:',
    '  - Route by HYPOTHESIS, not by where the proposal was raised. A proposal raised during step ' + stepPrefix + ' that does not advance ' + stepPrefix + "'s hypothesis MUST be rerouted, never parked in " + stepPrefix + '.',
    '  - Prefer ADDENDUM for anything small and tied to one completed task — it is the cheap lane and skips the full plan/review cycle.',
    '  - Only append; keep the format and numbering of OTHER tasks intact. en-GB Oxford spelling throughout.',
    `  - When done, run \`make markdownlint\` and \`make nixie\`; fix any issues. Commit the roadmap and any execplan changes (en-GB imperative subject) and push it straight to the integration branch with \`git push origin HEAD:${BASE}\` (docs-only; re-fetch and rebase on a non-fast-forward reject, then retry). NEVER \`git switch ${BASE}\` or touch the control/root worktree.`,
    '',
    'Proposals to triage (JSON — each has title, rationale, optional severity, and a source tag like "audit:1.2.8" or "review:1.3.2"):',
    '```json',
    JSON.stringify(proposals, null, 2),
    '```',
    '',
    'Return one decision per proposal (proposal, lane, newId, target, reason), any newSteps created, whether you pushed, the commit sha, and a short summary.',
  ].join('\n')
}

async function runTriage(stepPrefix, proposals) {
  phase('Remediation')
  return await agent(triagePrompt(stepPrefix, proposals), buildAgentOptions({ phase: 'Remediation', label: `triage:${stepPrefix}`, schema: TRIAGE_SCHEMA }))
}

// ---------------------------------------------------------------------------
// Parallel worker pool: keep MAX_PARALLEL tasks building at once, re-selecting
// whenever any completes; serialize only integrate (merge queue), audit, and
// remediation flush in the control loop. Runs until the frontier is dry, the
// task ceiling or budget reserve is hit, or a task fails (then drain + stop).
// ---------------------------------------------------------------------------
const processed = [] // task ids merged (or terminal) this run
const processedNormal = new Set()
const processedAddendum = new Set()
const results = []
const audits = []
const triages = []
const pendingByStep = new Map() // step prefix -> accrued review/audit proposals awaiting that step's flush
const inflight = new Map() // task id -> Promise<{id, task, result}> for tasks currently being built
const inflightNormal = new Set()
const inflightAddendum = new Set()
let halted = null

// Only fold remediation into the roadmap when we are actually advancing BASE.
const canFlush = AUTO_MERGE && !DRY_RUN

// Minimal async mutex: serialize callers through a promise chain. Used as a
// merge queue so only one task rebases + squash-merges + pushes BASE at a time.
function mutex() {
  let tail = Promise.resolve()
  return (fn) => {
    const result = tail.then(() => fn())
    tail = result.then(() => {}, () => {}) // keep the queue alive regardless of outcome
    return result
  }
}
const mergeLock = mutex()

let selectSeq = 0
async function doSelect(taken) {
  phase('Select')
  return await agent(selectPrompt(taken), buildAgentOptions({ phase: 'Select', label: `select#${++selectSeq}`, schema: SELECTION_SCHEMA }))
}

function takenSnapshot() {
  return {
    normal: [...processedNormal, ...inflightNormal],
    addendum: [...processedAddendum, ...inflightAddendum],
  }
}

function isAlreadyTaken(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal
  return processedSet.has(task.id) || inflightNormal.has(task.id) || inflightAddendum.has(task.id)
}

function markInflight(task) {
  const inflightSet = task?.isAddendum ? inflightAddendum : inflightNormal
  inflightSet.add(task.id)
}

function unmarkInflight(task) {
  const inflightSet = task?.isAddendum ? inflightAddendum : inflightNormal
  inflightSet.delete(task.id)
}

function markProcessed(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal
  processedSet.add(task.id)
  processed.push(task.id)
}

function addPending(step, items) {
  if (!items || !items.length) return
  if (!pendingByStep.has(step)) pendingByStep.set(step, [])
  pendingByStep.get(step).push(...items)
}

// Fold a step's accrued remediation into the roadmap once no in-flight task
// belongs to that step. The parallel pool has no single "current step", so debt
// is flushed per step at the point that step quiesces (nothing from it still
// building). Inserted tasks are live + unblocked, so the pool picks them up on
// the next refill — fix-debt-first within the step.
async function flushSettledSteps() {
  if (!canFlush) return
  const inflightSteps = new Set([...inflight.keys()].map(stepOf))
  for (const [step, items] of [...pendingByStep.entries()]) {
    if (!items.length || inflightSteps.has(step)) continue
    const tr = await mergeLock(() => runTriage(step, items))
    triages.push({ step, ...(tr || {}) })
    const lanes = (tr?.decisions || []).reduce((m, d) => ((m[d.lane] = (m[d.lane] || 0) + 1), m), {})
    log(`[step ${step}] triaged ${items.length} proposal(s): ${Object.entries(lanes).map(([k, v]) => `${v} ${k}`).join(', ') || 'none recorded'}`)
    pendingByStep.delete(step)
  }
}

// Open new tasks until the pool is full or the frontier is dry. Selection keeps
// normal work and addendum passes distinct so a just-merged task can immediately
// run its newly filed addenda without letting either kind duplicate.
async function fillPool() {
  while (inflight.size < MAX_PARALLEL && processed.length + inflight.size < MAX_TASKS) {
    if (budget.total && budget.remaining() < BUDGET_RESERVE) {
      if (!halted) halted = `budget reserve reached (${Math.round(budget.remaining() / 1000)}k remaining)`
      return
    }
    let sel
    try {
      sel = await doSelect(takenSnapshot())
    } catch (err) {
      log(`[pool] select agent failed (${(err && err.message) || String(err)}); stop opening new work, drain in-flight`)
      if (!halted) halted = `select agent error: ${(err && err.message) || String(err)}`
      return
    }
    if (!sel || !sel.hasTask || !sel.task) {
      if (inflight.size === 0) log(sel?.blockedSummary ? `No unblocked task: ${sel.blockedSummary}` : 'No unblocked roadmap tasks remain.')
      return
    }
    const task = sel.task
    if (isAlreadyTaken(task)) {
      log(`Selector re-offered already-taken ${task.isAddendum ? 'addendum pass' : 'normal task'} ${task.id}; not double-spawning.`)
      return
    }
    log(`[pool] spawning ${task.id} (${inflight.size + 1}/${MAX_PARALLEL} in flight)`)
    markInflight(task)
    inflight.set(
      task.id,
      // A thrown agent error (e.g. a subagent that completes without emitting
      // structured output) must NOT reject through Promise.race and crash the
      // whole run — convert it to a failed result the control loop drains.
      runTask(task, mergeLock).then(
        (result) => ({ id: task.id, task, result }),
        (err) => ({
          id: task.id,
          task,
          result: { id: task.id, status: 'failed', stage: 'error', detail: `unhandled agent error: ${(err && err.message) || String(err)}`, proposals: [] },
        }),
      ),
    )
  }
}

// --- Worker-pool control loop -----------------------------------------------
// Fill the pool, then await whichever task finishes first (Promise.race),
// record it, and refill — re-running select the instant any flow completes. A
// failed task stops new work but lets in-flight siblings drain. Audits and
// remediation triage run here in the control loop (serialized), so their
// worktrees and BASE writes never collide with each other.
let stop = false
while (true) {
  if (!stop && !halted) {
    try {
      await flushSettledSteps()
    } catch (err) {
      log(`[triage] failed (${(err && err.message) || String(err)}); proposals stay pending for a later sweep`)
    }
    await fillPool()
  }
  if (inflight.size === 0) break

  const done = await Promise.race(inflight.values())
  inflight.delete(done.id)
  unmarkInflight(done.task)
  const result = done.result
  results.push(result)

  if (result.status === 'done') {
    markProcessed(done.task)
    if (result.kind !== 'addendum') {
      // Addendum passes deliberately generate no audit and no proposals — that
      // is what breaks the remediation-of-remediation recursion.
      addPending(stepOf(done.id), result.proposals)
      let audit = null
      try {
        audit = await mergeLock(() => runAudit({ id: done.id }))
      } catch (err) {
        log(`[audit ${done.id}] failed (${(err && err.message) || String(err)}); skipping (task already merged)`)
      }
      if (audit) {
        audits.push({ afterTask: done.id, ...audit })
        addPending(stepOf(done.id), (audit.proposedRoadmapItems || []).map((p) => ({ ...p, source: `audit:${done.id}` })))
      }
    }
  } else if (!halted) {
    // Record the failure, stop opening new work, and let in-flight siblings
    // finish rather than abandoning their (possibly mergeable) branches.
    halted = `task ${done.id} ${result.status} at ${result.stage}: ${result.detail}`
    stop = true
  }
}

// End-of-run: the pool is drained, so every step has quiesced. Fold any
// remaining remediation into the roadmap — even on a halt, since triage only
// RECORDS proposals (it never implements), so accrued audit findings are not
// lost to a single task's failure.
if (canFlush) {
  try {
    await flushSettledSteps()
  } catch (err) {
    log(`[triage:end] failed (${(err && err.message) || String(err)}); ${[...pendingByStep.values()].flat().length} proposal(s) left pending`)
  }
}
const pendingProposals = [...pendingByStep.values()].flat()

return {
  base: BASE,
  modelRouting: {
    build: { adapter: BUILD_ADAPTER, model: BUILD_MODEL },
    plan: { adapter: PLAN_ADAPTER, model: PLAN_MODEL },
    review: { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL },
  },
  maxParallel: MAX_PARALLEL,
  processed,
  results,
  audits,
  // Remediation GIST-triaged into addendum / step-task / reroute lanes when each
  // step quiesced (see remediationTriage). Anything in pendingProposals was left
  // unwritten because the run halted — triage it manually.
  remediationTriage: triages,
  pendingProposals,
  halted,
  summary:
    `Processed ${processed.length} roadmap task(s) (pool width ${MAX_PARALLEL}): ` +
    results.map((r) => `${r.id}=${r.status}`).join(', ') +
    (triages.length ? ` | triaged ${triages.reduce((n, t) => n + (t.decisions ? t.decisions.length : 0), 0)} proposal(s) across ${triages.length} step(s)` : '') +
    (halted ? ` | halted: ${halted}` : ' | clean stop (no more unblocked tasks).'),
}
