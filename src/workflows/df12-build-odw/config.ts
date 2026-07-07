// Run configuration: every `args` default, clamp, validation, and derived
// guidance string, built once by makeConfig and destructured by the entry.
// Field names deliberately match the entry's historical constant names so
// `const { BASE, ROADMAP, ... } = makeConfig(args)` keeps every reference
// intact. makeConfig is pure: the projectRoot chdir side effect stays with
// the caller.

export interface RawWorkflowArgs {
  projectRoot?: string
  base?: string
  roadmap?: string
  designDocs?: string
  researchNote?: string
  taskId?: string
  maxTasks?: number
  maxParallel?: number
  maxPlanningParallel?: number
  maxPlanParallel?: number
  maxBuildParallel?: number
  maxDesignRounds?: number
  maxReviewRounds?: number
  stageAttempts?: number | string
  infraRetryBackoffSeconds?: unknown
  perWorkItemBuild?: boolean
  maxWorkItemRounds?: number | string
  autoMerge?: boolean
  documentAudit?: boolean
  dryRun?: boolean
  authPreflight?: boolean
  requireCoderabbitAuth?: boolean
  assessPartialBranches?: boolean
  resumePartialBranches?: boolean
  resumeMode?: string
  resumeTaskId?: string | number
  resumeMaxCandidates?: number | string
  worktreeWritePreflight?: boolean
  writeProbeEffort?: string
  writeProbeModelByAdapter?: Record<string, string>
  searchBackend?: string
  codeSearchBackend?: string
  grepaiWorkspace?: string
  grepaiProject?: string
  project?: string
  memtraceRepoId?: string
  buildAdapter?: string
  planAdapter?: string
  reviewAdapter?: string
  triageAdapter?: string
  assessmentAdapter?: string
  buildModel?: string
  planModel?: string
  reviewModel?: string
  triageModel?: string
  triageEscalationModel?: string
  assessmentModel?: string
  assessmentEscalationModel?: string
  coderabbitReviewCommand?: string
  coderabbitHostReview?: boolean
  coderabbitBetweenWorkItems?: boolean
  coderabbitAttempts?: number | string
  coderabbitBackoffMinutes?: unknown
  coderabbitFindingsFile?: string
  hostCommitGates?: boolean
  csCheck?: boolean
  csCheckCommand?: string
  hostGatesBetweenWorkItems?: boolean
  commitGateTimeoutSeconds?: number | string
  commitGates?: unknown
}

export interface WorkflowConfig {
  PROJECT_ROOT: string
  BASE: string
  ROADMAP: string
  DESIGN_DOCS: string
  RESEARCH_NOTE: string | null
  ONLY_TASK: string | null
  MAX_TASKS: number
  MAX_PARALLEL: number
  MAX_PLANNING_PARALLEL: number
  MAX_BUILD_PARALLEL: number
  MAX_DESIGN_ROUNDS: number
  MAX_REVIEW_ROUNDS: number
  STAGE_ATTEMPTS: number
  INFRA_RETRY_BACKOFF_SECONDS: [number, number]
  PER_WORK_ITEM_BUILD: boolean
  MAX_WORK_ITEM_ROUNDS: number
  AUTO_MERGE: boolean
  DOCUMENT_AUDIT: boolean
  DRY_RUN: boolean
  AUTH_PREFLIGHT: boolean
  REQUIRE_CODERABBIT_AUTH: boolean
  ASSESS_PARTIAL_BRANCHES: boolean
  RESUME_PARTIAL_BRANCHES: boolean
  RESUME_MODE: string
  RESUME_TASK_ID: string | null
  RESUME_MAX_CANDIDATES: number
  WORKTREE_WRITE_PREFLIGHT: boolean
  WRITE_PROBE_EFFORT: string
  WRITE_PROBE_MODEL_BY_ADAPTER: Record<string, string>
  BUDGET_RESERVE: number
  SEARCH_BACKEND: string
  GREPAI_WORKSPACE: string
  GREPAI_PROJECT: string | null
  MEMTRACE_REPO_ID: string | null
  BUILD_ADAPTER: string
  PLAN_ADAPTER: string
  REVIEW_ADAPTER: string
  TRIAGE_ADAPTER: string
  ASSESSMENT_ADAPTER: string
  BUILD_MODEL: string
  PLAN_MODEL: string
  REVIEW_MODEL: string
  TRIAGE_MODEL: string
  TRIAGE_ESCALATION_MODEL: string
  ASSESSMENT_MODEL: string
  ASSESSMENT_ESCALATION_MODEL: string
  AUTH_REQUIRED_ADAPTERS: Set<string>
  CODERABBIT_REVIEW_COMMAND: string
  CODERABBIT_HOST_REVIEW: boolean
  CODERABBIT_BETWEEN_WORK_ITEMS: boolean
  CODERABBIT_ATTEMPTS: number
  CODERABBIT_BACKOFF_MINUTES: [number, number]
  CODERABBIT_FINDINGS_FILE: string
  HOST_COMMIT_GATES: boolean
  CS_CHECK: boolean
  CS_CHECK_COMMAND: string
  HOST_GATES_BETWEEN_WORK_ITEMS: boolean
  COMMIT_GATE_TIMEOUT_SECONDS: number
  COMMIT_GATES: string[]
  COMMIT_GATE_TEXT: string
  COMMIT_GATE_GUIDANCE: string
  CS_CHECK_GUIDANCE: string
  CODERABBIT_REVIEW_GUIDANCE: string
  SPARK_DELEGATION_GUIDANCE: string
  SCRUTINEER_DELEGATION_GUIDANCE: string
}

export function makeConfig(rawArgs: Record<string, unknown> | null | undefined): WorkflowConfig {
  const cfg = (rawArgs || {}) as RawWorkflowArgs
  const PROJECT_ROOT = cfg.projectRoot || process.cwd()
  const BASE = cfg.base || 'main' // integration branch: rebase + squash-merge target, roadmap source of truth
  const ROADMAP = cfg.roadmap || 'docs/roadmap.md'
  const DESIGN_DOCS = cfg.designDocs || 'the design document(s) and the ADRs (docs/adr-*.md) under docs/' // project design sources cited in prompts
  const RESEARCH_NOTE = cfg.researchNote || null // optional project-specific external-library research note (e.g. a vendored lib source path to verify against)
  const ONLY_TASK = cfg.taskId || null // process exactly one named roadmap id (e.g. "1.2.1")
  const MAX_TASKS = ONLY_TASK ? 1 : cfg.maxTasks || 12 // hard ceiling on roadmap steps per run
  const MAX_PARALLEL = ONLY_TASK ? 1 : Math.max(1, cfg.maxParallel || 16) // worker-pool width: tasks in flight. Defaults to 16 to match the normal ODW/Codex runtime concurrency cap.
  const MAX_PLANNING_PARALLEL = Math.max(1, cfg.maxPlanningParallel || cfg.maxPlanParallel || 8) // concurrent planning-stage agents.
  const MAX_BUILD_PARALLEL = Math.max(1, cfg.maxBuildParallel || 8) // concurrent build-stage agents.
  const MAX_DESIGN_ROUNDS = cfg.maxDesignRounds || 4 // plan <-> design-review exchanges before halting
  const MAX_REVIEW_ROUNDS = cfg.maxReviewRounds || 3 // review -> fix -> re-review cycles
  const STAGE_ATTEMPTS = Math.max(1, Math.trunc(Number(cfg.stageAttempts) || 2)) // total attempts per stage agent when the previous attempt died on an infrastructure fault (adapter timeout, schema-retry exhaustion); product failures are never retried
  // Bounded backoff (seconds) between stage-agent retries when the previous
  // attempt hit a provider rate-limit: retrying instantly just burns the
  // attempt budget against a still-closed window, so pause a seeded-jitter
  // interval in [low, high] (or the advertised retry-after, clamped into this
  // range) before the warm re-run. Second-scale, unlike the minute-scale
  // CodeRabbit host-review backoff, because provider limits recover fast.
  const INFRA_RETRY_BACKOFF_SECONDS: [number, number] = (() => {
    const range = Array.isArray(cfg.infraRetryBackoffSeconds) ? cfg.infraRetryBackoffSeconds : []
    const low = Math.max(1, Math.trunc(Number(range[0]) || 5))
    const high = Math.max(low, Math.trunc(Number(range[1]) || 30))
    return [low, high]
  })()

  // Per-work-item build loop: the host reads the committed ExecPlan's Progress
  // checklist and dispatches ONE builder turn per unticked work item, verifying
  // committed progress after each turn. Small turns keep the build adapter on a
  // tight timeout and make a hung stream cheap. perWorkItemBuild=false restores
  // the single-turn whole-task build. Plans without a Progress checklist fall
  // back to the single-turn build automatically.
  const PER_WORK_ITEM_BUILD = cfg.perWorkItemBuild !== false
  const MAX_WORK_ITEM_ROUNDS = Math.max(1, Math.trunc(Number(cfg.maxWorkItemRounds) || 16)) // builder turns per task before failing closed

  const AUTO_MERGE = cfg.autoMerge !== false // false => stop after review, leave branch for manual merge
  const DOCUMENT_AUDIT = cfg.documentAudit !== false // false => return audit findings only, write nothing
  const DRY_RUN = cfg.dryRun === true // plan/review/audit only; skip implement, merge, and doc writes
  const AUTH_PREFLIGHT = cfg.authPreflight !== false // false => skip local CLI auth checks before spawning agents
  const REQUIRE_CODERABBIT_AUTH = cfg.requireCoderabbitAuth !== false && !DRY_RUN // CodeRabbit is required once implementation/review can run
  const ASSESS_PARTIAL_BRANCHES = cfg.assessPartialBranches !== false // false => skip report-only assessment of failed task branches
  const RESUME_PARTIAL_BRANCHES = cfg.resumePartialBranches === true // opt-in: discover surviving roadmap-* branches on fresh launch before normal selection
  const RESUME_MODE = String(cfg.resumeMode || 'assess').toLowerCase() // maximum recovery action: "assess" reports only; "review" may route clean adopt-complete branches into review + integration; "continue" dispatches on the committed ExecPlan Status (DRAFT->plan, APPROVED/IN PROGRESS->implement, COMPLETE->review) so partial work is finished through the ordinary gates instead of parked
  if (!['assess', 'review', 'continue'].includes(RESUME_MODE)) {
    throw new Error(`Unsupported resumeMode: ${RESUME_MODE} (use "assess", "review", or "continue")`)
  }
  const RESUME_TASK_ID = cfg.resumeTaskId ? String(cfg.resumeTaskId) : null // limit recovery discovery to one roadmap id (separate from taskId, which selects normal roadmap work)
  const RESUME_MAX_CANDIDATES_RAW = Number(cfg.resumeMaxCandidates ?? 4)
  const RESUME_MAX_CANDIDATES = Number.isFinite(RESUME_MAX_CANDIDATES_RAW)
    ? Math.max(1, Math.floor(RESUME_MAX_CANDIDATES_RAW))
    : 4 // bound startup recovery fan-in so a messy repository does not consume the whole run
  const WORKTREE_WRITE_PREFLIGHT = cfg.worktreeWritePreflight !== false // false => skip the once-per-run probe that proves task agents can write into sibling roadmap-* worktrees
  // The write preflight probe asks an agent to write one exact token to one
  // exact path; the host verifies the bytes. It tests launch/sandbox/write
  // permission, not reasoning, so it keeps the plan/build ADAPTER but must NOT
  // inherit PLAN_MODEL/BUILD_MODEL. Minimal effort by default; set a cheap
  // per-adapter probe model to save more (adapter name lowercased).
  const WRITE_PROBE_EFFORT = String(cfg.writeProbeEffort || 'minimal')
  const WRITE_PROBE_MODEL_BY_ADAPTER: Record<string, string> = Object.fromEntries(
    Object.entries(cfg.writeProbeModelByAdapter || {}).map(([adapter, model]) => [String(adapter).toLowerCase(), String(model)]),
  )
  const BUDGET_RESERVE = 80_000 // stop opening new tasks when remaining budget falls below this
  const SEARCH_BACKEND = String(cfg.searchBackend || cfg.codeSearchBackend || (cfg.memtraceRepoId ? 'memtrace' : 'grepai')).toLowerCase()
  const GREPAI_WORKSPACE = cfg.grepaiWorkspace || 'Projects'
  const GREPAI_PROJECT = cfg.grepaiProject || (SEARCH_BACKEND === 'grepai' ? cfg.project : null) || null // canonical main-branch GrepAI project; set this when source is a worktree
  const MEMTRACE_REPO_ID = cfg.memtraceRepoId || (SEARCH_BACKEND === 'memtrace' ? cfg.project : null) || null // canonical Memtrace repo id; discover with list_indexed_repositories when unset
  const BUILD_ADAPTER = cfg.buildAdapter || 'codex-medium'
  const PLAN_ADAPTER = cfg.planAdapter || 'claude'
  const REVIEW_ADAPTER = cfg.reviewAdapter || 'claude'
  const TRIAGE_ADAPTER = cfg.triageAdapter || 'codex'
  const ASSESSMENT_ADAPTER = cfg.assessmentAdapter || REVIEW_ADAPTER
  const BUILD_MODEL = cfg.buildModel || 'gpt-5.5'
  const PLAN_MODEL = cfg.planModel || 'claude-opus-4-8'
  const REVIEW_MODEL = cfg.reviewModel || 'claude-opus-4-8'
  // Remediation triage is mostly de-duplication plus hypothesis routing. A
  // deterministic pre-pass collapses exact duplicates, and the routing agent
  // runs at a MEDIUM default, escalating to the escalation model only for
  // complex triage (proposals spanning multiple audit/review sources, i.e.
  // potential cross-cutting or conflicting routing).
  const TRIAGE_MODEL = cfg.triageModel || 'gpt-5.5'
  const TRIAGE_ESCALATION_MODEL = cfg.triageEscalationModel || 'gpt-5.5@high'
  // Assessment is report-only; a deterministic fast-classifier (assessment.ts)
  // handles the clear cases with zero tokens, and only genuinely ambiguous
  // adopt decisions reach a model — so assessment gets its own MEDIUM default
  // rather than inheriting the Opus-class review model, escalating to the
  // escalation model only when the medium pass lands on an adopt verdict.
  const ASSESSMENT_MODEL = cfg.assessmentModel || 'claude-sonnet-5'
  const ASSESSMENT_ESCALATION_MODEL = cfg.assessmentEscalationModel || REVIEW_MODEL
  const AUTH_REQUIRED_ADAPTERS = new Set([
    BUILD_ADAPTER,
    PLAN_ADAPTER,
    REVIEW_ADAPTER,
    TRIAGE_ADAPTER,
    ASSESSMENT_ADAPTER,
  ].map((adapter) => String(adapter || '').toLowerCase()))
  // LEGACY (agent-run) mode ONLY: the command the build/fix prompts tell the
  // agent to invoke when coderabbitHostReview=false. In host-review mode the
  // control loop runs a FIXED committed-diff invocation
  // (`coderabbit review --agent --type committed --base <base>`, see
  // host-review.ts) that this knob does NOT override.
  const CODERABBIT_REVIEW_COMMAND = cfg.coderabbitReviewCommand || 'coderabbit review --agent'
  // Host-run CodeRabbit review: the control loop invokes the CLI against
  // committed work, absorbs rate-limit backoff in host wall-clock instead of
  // agent tokens, and feeds actionable findings back into the fix rounds.
  // coderabbitHostReview=false restores the legacy agent-run flow.
  const CODERABBIT_HOST_REVIEW = cfg.coderabbitHostReview !== false
  // Run the host CodeRabbit review BETWEEN per-work-item build turns (a
  // deterministic gate on each committed work item) rather than only once at
  // the end of the implementation stage. Only meaningful when both host
  // review and the per-work-item build are on. coderabbitBetweenWorkItems=false
  // restores end-of-stage-only host review.
  const CODERABBIT_BETWEEN_WORK_ITEMS = cfg.coderabbitBetweenWorkItems !== false
  const CODERABBIT_ATTEMPTS = Math.max(1, Math.trunc(Number(cfg.coderabbitAttempts) || 3)) // total attempts per host review when rate limited
  const CODERABBIT_BACKOFF_MINUTES: [number, number] = (() => {
    const range = Array.isArray(cfg.coderabbitBackoffMinutes) ? cfg.coderabbitBackoffMinutes : []
    const low = Math.max(1, Math.trunc(Number(range[0]) || 45))
    const high = Math.max(low, Math.trunc(Number(range[1]) || 90))
    return [low, high]
  })()
  // Optional durable JSONL sink for every CodeRabbit finding, so recurring
  // finding classes can be tuned into deterministic lint rules over time.
  const CODERABBIT_FINDINGS_FILE = String(cfg.coderabbitFindingsFile || '')
  // The deterministic commit-gate command set for the target project. `make all`
  // is the df12 house default, but it is NOT universal: some projects alias
  // `all` to a release build, so operators must be able to name the authoritative
  // gate targets (e.g. sequential check-fmt/typecheck/lint/test) via args.
  const COMMIT_GATES = (Array.isArray(cfg.commitGates) && cfg.commitGates.length
    ? cfg.commitGates
    : ['make all']).map((command) => String(command))
  const COMMIT_GATE_TEXT = COMMIT_GATES.map((command) => `\`${command}\``).join(' then ')
  // Host-run commit gates: the control loop re-runs the configured gate
  // commands against committed HEAD before review and integration, so a
  // gatesGreen claim is verified, never trusted. hostCommitGates=false
  // restores the trust-the-agent flow.
  const HOST_COMMIT_GATES = cfg.hostCommitGates !== false
  // Re-run the host commit gates BETWEEN per-work-item build turns (a
  // deterministic gate on each committed work item, before the between-item
  // CodeRabbit review) rather than only at the dual-review boundary. Only
  // meaningful when both host gates and the per-work-item build are on.
  // hostGatesBetweenWorkItems=false restores gate verification at the review
  // boundary only (cheaper: one `make all` per review round, not per item).
  const HOST_GATES_BETWEEN_WORK_ITEMS = cfg.hostGatesBetweenWorkItems !== false
  const COMMIT_GATE_TIMEOUT_SECONDS = Math.max(1, Math.trunc(Number(cfg.commitGateTimeoutSeconds) || 3600))
  const COMMIT_GATE_GUIDANCE =
    `The deterministic commit gates for this run are ${COMMIT_GATE_TEXT}. AGENTS.md is authoritative for the gate set: if AGENTS.md names different or additional gate targets (for example sequential \`make check-fmt\`, \`make typecheck\`, \`make lint\`, \`make test\`), run those named targets as well — NEVER assume \`make all\` aggregates them, and never report gates as green unless every project-required gate passed at HEAD.${HOST_COMMIT_GATES ? ' The workflow host independently re-runs the configured gates against your committed HEAD before review and integration; a gatesGreen claim the host cannot reproduce fails the stage with the host gate log as evidence.' : ''}`
  // CodeScene code-health check on the committed changed files, run as a
  // deterministic gate AFTER the commit gates and BEFORE CodeRabbit (free, so
  // it precedes the quota-limited CodeRabbit and the token-spending reviewer
  // agents). `cs-check-changed` is a wrapper the operator provides; override
  // the invocation with csCheckCommand. Skips gracefully when the binary is
  // absent, like `make verify-modules` without Dafny.
  const CS_CHECK = cfg.csCheck !== false
  const CS_CHECK_COMMAND = String(cfg.csCheckCommand || 'cs-check-changed')
  const CS_CHECK_GUIDANCE = CS_CHECK
    ? [
        `A deterministic CodeScene code-health check (\`${CS_CHECK_COMMAND}\`) runs on your committed changed files AFTER the commit gates and BEFORE CodeRabbit. Clear a flagged code-health regression by refactoring the code. ONLY when further refinement would genuinely be deleterious to clarity or correctness, suppress a specific smell with a \`@codescene(disable:"Complex Method")\` comment (combine several as \`@codescene(disable:"Complex Method", disable:"Bumpy Road Ahead")\`) placed immediately before the affected function or method, and precede that suppression with a plain-language comment explaining why it is justified.`,
        'What the flagged smells mean:',
        'Module smells — Low Cohesion: the module/class carries several unrelated responsibilities (measured by LCOM4), breaking the single-responsibility principle. Brain Class (God Class): a large module with many functions and at least one Brain Method, holding too much responsibility at once. Developer Congestion: the code has become a coordination bottleneck because too many people must change it in parallel. Complex code by former contributors: a low-health hotspot whose original author has left the organisation carries heightened maintenance risk. Lines of Code: the file is simply too large.',
        "Function smells — Brain Method (God Function): one complex function concentrates the module's behaviour and becomes a local hotspot. DRY violations: duplicated logic that is actually changed together in predictable patterns. Complex Method: high cyclomatic complexity from many conditionals (if/for/while). Primitive Obsession: heavy use of raw primitives (integers, strings, floats) where a domain type would encapsulate the validation and meaning of the values. Large Method: a function with too many lines to comprehend easily.",
        'Implementation smells — Nested Complexity: if-statements nested inside other ifs and/or loops, which sharply raises defect risk. Bumpy Road: a function that fails to encapsulate its responsibilities and instead holds several separate chunks of logic — extract each chunk into its own function. Complex Conditional: a single branch condition (in an if/for/while) combining multiple logical operators such as AND/OR. Large Assertion Blocks (test smell): a long run of consecutive assert statements that signals a missing abstraction. Duplicated Assertion Blocks (test smell): the same assertion block copy-pasted across the suite — a DRY violation.',
      ].join('\n')
    : ''
  const CODERABBIT_REVIEW_GUIDANCE = CODERABBIT_HOST_REVIEW
    ? 'Do NOT run coderabbit yourself and do not spend context waiting on its rate limits: the workflow host runs `coderabbit review --agent` against your COMMITTED work after the stage returns, absorbs any rate-limit backoff without agent tokens, and feeds actionable findings back to you as blocking review items. Your responsibilities are the deterministic commit gates and committing every piece of work — only committed changes reach the host review.'
    : `Use \`coderabbit review --agent\` as the per-work-item AI review after deterministic gates are green, and clear all actionable concerns before advancing to the next work item or declaring the fix round complete. CodeRabbit is a shared, rate-limited quota: do not ask it to find errors that the project commit gates, markdown gates, linting, typechecking, or tests can catch locally. If the CodeRabbit rate limit is exceeded, treat the backoff as expected and sleep (use the \`vsleep\` command) for \`$(shuf -i ${CODERABBIT_BACKOFF_MINUTES[0]}-${CODERABBIT_BACKOFF_MINUTES[1]} -n 1)\` minutes before trying again; never shorten this backoff. You are not in any rush, and there is no wallclock time limit for this task. Retry at most three times after the initial CodeRabbit attempt, then record the deferred review with the exact error/output as an open issue so the supervisor can decide whether to relaunch, fallback-review, or wait for the quota to recover.`
  const SPARK_DELEGATION_GUIDANCE =
    "You are free to delegate to the `wyvern` fast Codex subagent for bounded read-only tasks on known surfaces as needed; use 5.4-mini in place of 5.3 Codex Spark when Spark quota is unavailable. Quick surface maps, candidate-file recon, targeted consistency searches, and medium-grain 'what changed / where is the seam' checks."
  const SCRUTINEER_DELEGATION_GUIDANCE = CODERABBIT_HOST_REVIEW
    ? `Delegate deterministic gate execution to the \`scrutineer\` sub-agent: ask it to run the repository commit gates/test suites. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until the gates are green. ${CODERABBIT_REVIEW_GUIDANCE}`
    : `Delegate deterministic gate execution and CodeRabbit invocation to the \`scrutineer\` sub-agent: ask it to run the repository commit gates/test suites and, only after those pass, to run \`${CODERABBIT_REVIEW_COMMAND}\` from inside the worktree. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until gates and CodeRabbit are green or a documented rate-limit/deferred-review open issue remains. ${CODERABBIT_REVIEW_GUIDANCE}`

  return {
    PROJECT_ROOT,
    BASE,
    ROADMAP,
    DESIGN_DOCS,
    RESEARCH_NOTE,
    ONLY_TASK,
    MAX_TASKS,
    MAX_PARALLEL,
    MAX_PLANNING_PARALLEL,
    MAX_BUILD_PARALLEL,
    MAX_DESIGN_ROUNDS,
    MAX_REVIEW_ROUNDS,
    STAGE_ATTEMPTS,
    INFRA_RETRY_BACKOFF_SECONDS,
    PER_WORK_ITEM_BUILD,
    MAX_WORK_ITEM_ROUNDS,
    AUTO_MERGE,
    DOCUMENT_AUDIT,
    DRY_RUN,
    AUTH_PREFLIGHT,
    REQUIRE_CODERABBIT_AUTH,
    ASSESS_PARTIAL_BRANCHES,
    RESUME_PARTIAL_BRANCHES,
    RESUME_MODE,
    RESUME_TASK_ID,
    RESUME_MAX_CANDIDATES,
    WORKTREE_WRITE_PREFLIGHT,
    WRITE_PROBE_EFFORT,
    WRITE_PROBE_MODEL_BY_ADAPTER,
    BUDGET_RESERVE,
    SEARCH_BACKEND,
    GREPAI_WORKSPACE,
    GREPAI_PROJECT,
    MEMTRACE_REPO_ID,
    BUILD_ADAPTER,
    PLAN_ADAPTER,
    REVIEW_ADAPTER,
    TRIAGE_ADAPTER,
    ASSESSMENT_ADAPTER,
    BUILD_MODEL,
    PLAN_MODEL,
    REVIEW_MODEL,
    TRIAGE_MODEL,
    TRIAGE_ESCALATION_MODEL,
    ASSESSMENT_MODEL,
    ASSESSMENT_ESCALATION_MODEL,
    AUTH_REQUIRED_ADAPTERS,
    CODERABBIT_REVIEW_COMMAND,
    CODERABBIT_HOST_REVIEW,
    CODERABBIT_BETWEEN_WORK_ITEMS,
    CODERABBIT_ATTEMPTS,
    CODERABBIT_BACKOFF_MINUTES,
    CODERABBIT_FINDINGS_FILE,
    HOST_COMMIT_GATES,
    CS_CHECK,
    CS_CHECK_COMMAND,
    HOST_GATES_BETWEEN_WORK_ITEMS,
    COMMIT_GATE_TIMEOUT_SECONDS,
    COMMIT_GATES,
    COMMIT_GATE_TEXT,
    COMMIT_GATE_GUIDANCE,
    CS_CHECK_GUIDANCE,
    CODERABBIT_REVIEW_GUIDANCE,
    SPARK_DELEGATION_GUIDANCE,
    SCRUTINEER_DELEGATION_GUIDANCE,
  }
}
