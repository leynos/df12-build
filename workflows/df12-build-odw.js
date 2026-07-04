// df12-build-odw — ODW/Codex workflow that drives a df12-house GIST roadmap
// to completion: deterministic selection, real git-worktree task isolation,
// adversarial plan/design review, implementation with deterministic gates,
// dual review, merge-lock integration, post-merge audit, remediation triage,
// fresh-run recovery of surviving task branches (failure-resume design), and
// a host-verified task-agent write preflight. Helpers live above the
// worker-pool control-loop marker so the test suites in tests/ can compile
// them in isolation; see docs/architecture.md for the enforcement boundary.
export const meta = {
  name: 'df12-build-odw',
  description:
    'ODW/Codex variant of df12-build: drive a roadmap to completion with a parallel worker pool, Claude Opus planning/review routing, branch-local verification guidance, serialized integration, and post-merge audit.',
  whenToUse:
    'When you want to autonomously advance docs/roadmap.md across MULTIPLE independent unblocked tasks at once, each fully planned, reviewed, implemented, gated, merged, and audited. Opt-in only (heavy, many agents in parallel, performs commits/merges). Recovery model is fresh-restart against git state, not cache-resume.',
  phases: [
    { title: 'Select' },
    { title: 'Auth Preflight' },
    { title: 'Recovery' },
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Design Review' },
    { title: 'Implement' },
    { title: 'Code Review' },
    { title: 'Expert Review' },
    { title: 'Assess' },
    { title: 'Integrate' },
    { title: 'Audit' },
    { title: 'Remediation' },
  ],
}

// ---------------------------------------------------------------------------
// Configuration (all overridable through the ODW `args` object).
// ---------------------------------------------------------------------------
const cfg = args || {}
const PROJECT_ROOT = cfg.projectRoot || process.cwd()
if (PROJECT_ROOT !== process.cwd()) {
  const fs = process.getBuiltinModule('node:fs')
  if (!fs.statSync(PROJECT_ROOT).isDirectory()) {
    throw new Error(`Configured projectRoot is not a directory: ${PROJECT_ROOT}`)
  }
  process.chdir(PROJECT_ROOT)
}
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
const TRIAGE_MODEL = cfg.triageModel || 'gpt-5.5@high'
const ASSESSMENT_MODEL = cfg.assessmentModel || REVIEW_MODEL
const AUTH_REQUIRED_ADAPTERS = new Set([
  BUILD_ADAPTER,
  PLAN_ADAPTER,
  REVIEW_ADAPTER,
  TRIAGE_ADAPTER,
  ASSESSMENT_ADAPTER,
].map((adapter) => String(adapter || '').toLowerCase()))
const CODERABBIT_REVIEW_COMMAND = cfg.coderabbitReviewCommand || 'coderabbit review --agent'
// The deterministic commit-gate command set for the target project. `make all`
// is the df12 house default, but it is NOT universal: some projects alias
// `all` to a release build, so operators must be able to name the authoritative
// gate targets (e.g. sequential check-fmt/typecheck/lint/test) via args.
const COMMIT_GATES = (Array.isArray(cfg.commitGates) && cfg.commitGates.length
  ? cfg.commitGates
  : ['make all']).map((command) => String(command))
const COMMIT_GATE_TEXT = COMMIT_GATES.map((command) => `\`${command}\``).join(' then ')
const COMMIT_GATE_GUIDANCE =
  `The deterministic commit gates for this run are ${COMMIT_GATE_TEXT}. AGENTS.md is authoritative for the gate set: if AGENTS.md names different or additional gate targets (for example sequential \`make check-fmt\`, \`make typecheck\`, \`make lint\`, \`make test\`), run those named targets as well — NEVER assume \`make all\` aggregates them, and never report gates as green unless every project-required gate passed at HEAD.`
const CODERABBIT_REVIEW_GUIDANCE =
  'Use `coderabbit review --agent` as the per-work-item AI review after deterministic gates are green, and clear all actionable concerns before advancing to the next work item or declaring the fix round complete. CodeRabbit is a shared, rate-limited quota: do not ask it to find errors that the project commit gates, markdown gates, linting, typechecking, or tests can catch locally. If the CodeRabbit rate limit is exceeded, treat the backoff as expected and sleep (use the `vsleep` command) for `$(shuf -i 45-90 -n 1)` minutes before trying again; never shorten this backoff. You are not in any rush, and there is no wallclock time limit for this task. Retry at most three times after the initial CodeRabbit attempt, then record the deferred review with the exact error/output as an open issue so the supervisor can decide whether to relaunch, fallback-review, or wait for the quota to recover.'
const SPARK_DELEGATION_GUIDANCE =
  "You are free to delegate to the `wyvern` fast Codex subagent for bounded read-only tasks on known surfaces as needed; use 5.4-mini in place of 5.3 Codex Spark when Spark quota is unavailable. Quick surface maps, candidate-file recon, targeted consistency searches, and medium-grain 'what changed / where is the seam' checks."
const SCRUTINEER_DELEGATION_GUIDANCE =
  `Delegate deterministic gate execution and CodeRabbit invocation to the \`scrutineer\` sub-agent: ask it to run the repository commit gates/test suites and, only after those pass, to run \`${CODERABBIT_REVIEW_COMMAND}\` from inside the worktree. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until gates and CodeRabbit are green or a documented rate-limit/deferred-review open issue remains. ${CODERABBIT_REVIEW_GUIDANCE}`

function buildAgentOptions(options = {}) {
  return { adapter: BUILD_ADAPTER, model: BUILD_MODEL, ...options }
}

function planAgentOptions(options = {}) {
  return { adapter: PLAN_ADAPTER, model: PLAN_MODEL, ...options }
}

function reviewAgentOptions(options = {}) {
  return { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL, ...options }
}

function triageAgentOptions(options = {}) {
  return { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL, ...options }
}

function assessmentAgentOptions(options = {}) {
  return { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL, ...options }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

async function fileExists(pathValue, baseDir = process.cwd()) {
  if (!pathValue) return false
  const path = process.getBuiltinModule('node:path')
  const candidate = path.isAbsolute(String(pathValue))
    ? String(pathValue)
    : path.join(baseDir, String(pathValue))
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

function grepaiSearchCommand() {
  const workspaceArg = shellQuote(GREPAI_WORKSPACE)
  const projectArg = GREPAI_PROJECT ? shellQuote(GREPAI_PROJECT) : '$(get-project)'
  return `grepai search --workspace ${workspaceArg} --project ${projectArg} "<English intent query>" --toon --compact`
}

function memtraceRepoGuidance() {
  return MEMTRACE_REPO_ID
    ? `Use repo_id ${shellQuote(MEMTRACE_REPO_ID)} for Memtrace calls after confirming it appears in list_indexed_repositories.`
    : 'Call list_indexed_repositories first and select the repo_id for this project before using other Memtrace tools.'
}

function codeSearchGuidance() {
  if (SEARCH_BACKEND === 'memtrace') {
    return `Use the Memtrace MCP server as the PRIMARY tool for canonical main-branch code search and graph context. ${memtraceRepoGuidance()} Use find_code for intent/concept search, find_symbol for exact identifiers, list_communities/find_central_symbols for orientation, get_symbol_context/get_impact/get_timeline before changing load-bearing symbols, and get_source_window only for bounded source reads. Treat Memtrace's committed/main view as canonical context, not branch-local evidence; verify every branch-local or newly changed fact directly inside your worktree with \`leta\`, exact text search, or file inspection before acting. If a Memtrace MCP call is unavailable because the host session rejects, cancels, or lacks the tool, record that exact tooling failure in the ExecPlan and continue with bounded branch-local evidence; do not make the plan impossible to execute solely because Memtrace was unavailable in the planning session. Memtrace unavailability is not a valid reason to set ExecPlan status to BLOCKED.`
  }
  if (SEARCH_BACKEND !== 'grepai') {
    throw new Error(`Unsupported searchBackend: ${SEARCH_BACKEND}`)
  }
  return `Use \`${grepaiSearchCommand()}\` as the PRIMARY tool for intent/concept code search against the canonical main-branch index. The grepai index reflects \`main\` only: never treat it as evidence for branch-local or newly changed code. Verify every branch-local fact directly inside your worktree with \`leta\`, exact text search, or file inspection before acting. If GrepAI is unavailable in the agent session, record the exact tooling failure in the ExecPlan and continue with bounded branch-local evidence; do not make the plan impossible to execute solely because GrepAI was unavailable.`
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
    '- File edits must target the assigned git-donkey worktree. When using an edit tool whose target is not scoped by shell `cd` or command `workdir`, use absolute paths under the assigned worktree; never let relative edit paths hit the root/control worktree.',
    `- ${codeSearchGuidance()}`,
    '- Use `leta` for symbol navigation, references, call graphs, and branch-local verification (leta show / refs / grep / files) instead of ad-hoc ripgrep or read-file. If Leta is unavailable because its daemon or workspace tooling fails, record the exact failure and fall back to precise file inspection for the current task; do not add a hard implementation blocker solely for a transient Leta startup failure. Leta unavailability is not a valid reason to set ExecPlan status to BLOCKED.',
    '- Use `sem` for codebase history navigation (semantic, entity-level diffs and blame) instead of raw git log/blame.',
    '- Load the appropriate language router skill for any code you touch: python-router for Python, rust-router for Rust, and the matching router for other languages. Follow the smaller skills it routes you to.',
    `- Treat docs/ as the source of truth: ${DESIGN_DOCS}, the developers guide, any users guide present, the coding/scripting standards, and AGENTS.md. Obey AGENTS.md quality gates and the en-GB Oxford-spelling ("-ize"/"-yse"/"-our") convention in all prose, comments, and commits.`,
    `- ${COMMIT_GATE_GUIDANCE}`,
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
    ok: { type: 'boolean', description: 'true when every work item is implemented, committed, and every project commit gate is green' },
    execplanPath: { type: 'string' },
    workItemsCompleted: { type: 'integer' },
    workItemsTotal: { type: 'integer' },
    commits: { type: 'array', items: { type: 'string' } },
    gatesGreen: { type: 'boolean', description: 'every project commit gate (plus markdownlint/nixie where markdown changed) passes at HEAD' },
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

// Structured return contract for review-fix rounds. Without it, the gate and
// CodeRabbit evidence a fix agent produces evaporates with its transcript, and
// a later assessment of the branch cannot see that the workflow already
// re-validated the current tip (issue #24).
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commits: { type: 'array', items: { type: 'string' }, description: 'commit subjects added in this fix round' },
    gatesGreen: { type: 'boolean', description: 'every project commit gate (plus markdownlint/nixie where markdown changed) passes at HEAD after the fixes' },
    coderabbitRuns: { type: 'integer' },
    resolved: { type: 'array', items: { type: 'string' }, description: 'how each blocking item was resolved' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'anything left unresolved, with reason' },
    summary: { type: 'string' },
  },
  required: ['gatesGreen', 'summary'],
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
    dirtyState: { type: 'string', enum: ['clean', 'dirty', 'unknown'] },
    changedFiles: { type: 'array', items: { type: 'string' } },
    taskScoped: { type: 'boolean' },
    execPlan: { type: 'string' },
    roadmap: { type: 'string' },
    validation: { type: 'string' },
    missingEvidence: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    recommendation: { type: 'string' },
    nextActions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'classification',
    'branchName',
    'worktreePath',
    'baseCommit',
    'currentCommit',
    'dirtyState',
    'changedFiles',
    'taskScoped',
    'execPlan',
    'roadmap',
    'validation',
    'missingEvidence',
    'risks',
    'rationale',
    'recommendation',
    'nextActions',
  ],
}

// ---------------------------------------------------------------------------
// Deterministic roadmap selection
// ---------------------------------------------------------------------------
const TASK_LINE_RE = /^(\s*)-\s+\[([ xX])\]\s+(\d+(?:\.\d+)+)\.\s*(.*)$/
const REQUIRES_LINE_RE = /^\s*-\s+Requires\s+(.+?)\.?\s*$/
const STEP_RANGE_RE = /\bsteps?\s+(\d+\.\d+)\s*-\s*(\d+\.\d+)\b/gi
const ROADMAP_ID_RE = /\b\d+(?:\.\d+)+\b/g

async function execFileText(command, commandArgs) {
  const { execFile } = process.getBuiltinModule('node:child_process')
  return await new Promise((resolve, reject) => {
    execFile(command, commandArgs, { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

async function execFileStatus(command, commandArgs) {
  try {
    return { ok: true, stdout: await execFileText(command, commandArgs), stderr: '' }
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || '',
      stderr: error?.stderr || '',
      message: (error && error.message) || String(error),
    }
  }
}

function authFailureDetail(value) {
  const text = String(value || '')
  const patterns = [
    /401 Unauthorized/i,
    /Missing bearer or basic authentication/i,
    /no Codex credentials/i,
    /\bNot logged in\b/i,
    /\bsigned out\b/i,
    /no token is available/i,
    /\bauth(?:entication)? failed\b/i,
    /\bbrowser login required\b/i,
    /\btoken missing\b/i,
    /\bmissing token\b/i,
    /\btoken expired\b/i,
    /\bnot authenticated\b/i,
    /"loggedIn"\s*:\s*false/i,
    /Run `?coderabbit auth login`?/i,
    /Run codex login/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

function providerFailureDetail(value) {
  const text = String(value || '')
  const patterns = [
    /\bAPI Error:\s*(?:429|500|502|503|504|529)\b/i,
    /\b(?:429|500|502|503|504|529)\b.*\b(?:gateway|overload|rate limit|server-side|temporar|timeout|unavailable)\b/i,
    /\b(?:gateway timeout|model overloaded|overloaded|rate limited|server-side issue|service unavailable|temporarily unavailable|try again in a moment)\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
}

function resultFromUnhandledAgentError(id, detail, extra = {}) {
  const authDetail = authFailureDetail(detail)
  if (authDetail) {
    return {
      id,
      status: 'fatal-auth',
      stage: 'auth',
      detail,
      proposals: [],
      ...extra,
    }
  }
  const providerDetail = providerFailureDetail(detail)
  if (providerDetail) {
    return {
      id,
      status: 'provider-fault',
      stage: 'provider',
      detail,
      proposals: [],
      ...extra,
    }
  }
  return {
    id,
    status: 'failed',
    stage: 'error',
    detail,
    proposals: [],
    ...extra,
  }
}

function parseNameStatus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split(/\t+/)
      return secondPath
        ? { status, path: secondPath, oldPath: firstPath }
        : { status, path: firstPath || '' }
    })
    .filter((entry) => entry.path)
}

function parsePorcelainDirty(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const status = line.slice(0, 2)
      const pathText = line.slice(3).trim()
      if (!pathText) return []
      if (status === '??') return [{ status, path: pathText }]
      if (status[1] && status[1] !== ' ') return [{ status: status[1], path: pathText }]
      return []
    })
}

async function gitEvidence(worktreePath, commandArgs, parse = (text) => String(text || '').trim()) {
  const result = await execFileStatus('git', ['-C', worktreePath, ...commandArgs])
  if (result.ok) {
    return { ok: true, value: parse(result.stdout) }
  }
  return {
    ok: false,
    value: parse(result.stdout),
    error: [result.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim(),
  }
}

async function collectAssessmentEvidence(task, wt) {
  const worktreePath = wt?.worktreePath || ''
  const baseCommit = wt?.baseSha || ''
  const branchName = wt?.branch || ''
  const errors = []

  const current = await gitEvidence(worktreePath, ['rev-parse', 'HEAD'])
  if (!current.ok) errors.push(`rev-parse HEAD: ${current.error}`)

  const branch = branchName
    ? { ok: true, value: branchName }
    : await gitEvidence(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch.ok) errors.push(`rev-parse --abbrev-ref HEAD: ${branch.error}`)

  const status = await gitEvidence(worktreePath, ['status', '--porcelain=v1'])
  if (!status.ok) errors.push(`status --porcelain=v1: ${status.error}`)

  const committed = baseCommit
    ? await gitEvidence(worktreePath, ['diff', '--name-status', `${baseCommit}...HEAD`], parseNameStatus)
    : { ok: false, value: [], error: 'missing base commit' }
  if (!committed.ok) errors.push(`diff base...HEAD: ${committed.error}`)

  const dirty = await gitEvidence(worktreePath, ['diff', '--name-status'], parseNameStatus)
  if (!dirty.ok) errors.push(`diff --name-status: ${dirty.error}`)

  const staged = await gitEvidence(worktreePath, ['diff', '--cached', '--name-status'], parseNameStatus)
  if (!staged.ok) errors.push(`diff --cached --name-status: ${staged.error}`)

  const commits = baseCommit
    ? await gitEvidence(worktreePath, ['log', '--oneline', '--max-count=20', `${baseCommit}..HEAD`], (text) => String(text || '').trim().split(/\r?\n/).filter(Boolean))
    : { ok: false, value: [], error: 'missing base commit' }
  if (!commits.ok) errors.push(`log base..HEAD: ${commits.error}`)

  const untrackedOrModified = parsePorcelainDirty(status.value)
  const dirtyChanges = [
    ...dirty.value,
    ...untrackedOrModified.filter((entry) => !dirty.value.some((item) => item.path === entry.path)),
  ]
  const allChanged = new Set([
    ...committed.value.map((entry) => entry.path),
    ...dirtyChanges.map((entry) => entry.path),
    ...staged.value.map((entry) => entry.path),
  ])

  return {
    taskId: task?.id || '',
    taskTitle: task?.title || '',
    branchName: branch.value || branchName,
    worktreePath,
    baseCommit,
    currentCommit: current.value || '',
    dirtyState: status.ok ? (String(status.value || '').trim() ? 'dirty' : 'clean') : 'unknown',
    changedFiles: [...allChanged].sort(),
    committedChanges: committed.value,
    dirtyChanges,
    stagedChanges: staged.value,
    recentCommits: commits.value,
    collectionErrors: errors.filter(Boolean),
  }
}

async function runAuthPreflight() {
  if (!AUTH_PREFLIGHT) return []
  phase('Auth Preflight')
  const failures = []

  const codex = await execFileStatus('codex', ['login', 'status'])
  const codexOutput = [codex.stdout, codex.stderr, codex.message].filter(Boolean).join('\n')
  if (!codex.ok || authFailureDetail(codexOutput)) {
    failures.push({
      tool: 'codex',
      command: 'codex login status',
      detail: authFailureDetail(codexOutput) || codexOutput.trim() || 'Codex auth status check failed',
    })
  }

  if (AUTH_REQUIRED_ADAPTERS.has('claude')) {
    const claude = await execFileStatus('claude', ['auth', 'status'])
    const claudeOutput = [claude.stdout, claude.stderr, claude.message].filter(Boolean).join('\n')
    if (!claude.ok || authFailureDetail(claudeOutput)) {
      failures.push({
        tool: 'claude',
        command: 'claude auth status',
        detail: authFailureDetail(claudeOutput) || claudeOutput.trim() || 'Claude auth status check failed',
      })
    }
  }

  if (REQUIRE_CODERABBIT_AUTH) {
    const coderabbit = await execFileStatus('coderabbit', ['auth', 'status'])
    const coderabbitOutput = [coderabbit.stdout, coderabbit.stderr, coderabbit.message].filter(Boolean).join('\n')
    if (!coderabbit.ok || authFailureDetail(coderabbitOutput)) {
      failures.push({
        tool: 'coderabbit',
        command: 'coderabbit auth status',
        detail: authFailureDetail(coderabbitOutput) || coderabbitOutput.trim() || 'CodeRabbit auth status check failed',
      })
    }
  }

  if (failures.length) {
    log(`[auth] fatal preflight failure: ${failures.map((failure) => `${failure.tool}: ${failure.detail.split(/\r?\n/)[0]}`).join('; ')}`)
  } else {
    const passed = ['Codex']
    if (AUTH_REQUIRED_ADAPTERS.has('claude')) passed.push('Claude')
    if (REQUIRE_CODERABBIT_AUTH) passed.push('CodeRabbit')
    log(`[auth] preflight passed for ${passed.join(', ')}`)
  }

  return failures
}

function slugForTask(task) {
  return `roadmap-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')}${task.isAddendum ? '-addendum' : ''}`
}

function worktreeParentPath() {
  const path = process.getBuiltinModule('node:path')
  const cwd = process.cwd()
  return path.join(path.dirname(cwd), `${path.basename(cwd)}.worktrees`)
}

async function createWorktree(task) {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const branch = slugForTask(task)
  const worktreePath = path.join(worktreeParentPath(), branch)
  const setupCommand = `git worktree add -b ${branch} ${worktreePath} origin/${BASE}`

  try {
    await execFileText('git', ['fetch', 'origin', BASE])
    const baseSha = (await execFileText('git', ['rev-parse', `origin/${BASE}`])).trim()
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
    await execFileText('git', ['worktree', 'add', '-b', branch, worktreePath, `origin/${BASE}`])
    const worktreeSha = (await execFileText('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).trim()
    if (worktreeSha !== baseSha) {
      return {
        ok: false,
        worktreePath,
        branch,
        baseSha,
        donkeyInvocation: setupCommand,
        notes: `worktree HEAD ${worktreeSha} did not match origin/${BASE} ${baseSha}`,
      }
    }
    return {
      ok: true,
      worktreePath,
      branch,
      baseSha,
      donkeyInvocation: setupCommand,
      notes: 'created deterministically by the ODW control loop; no setup agent required',
    }
  } catch (error) {
    const details = [
      (error && error.message) || String(error),
      error?.stderr ? `stderr: ${error.stderr.trim()}` : '',
      error?.stdout ? `stdout: ${error.stdout.trim()}` : '',
    ].filter(Boolean).join('; ')
    return {
      ok: false,
      worktreePath,
      branch,
      baseSha: '',
      donkeyInvocation: setupCommand,
      notes: details,
    }
  }
}

async function readFileText(path) {
  const { readFile } = process.getBuiltinModule('node:fs/promises')
  return await readFile(path, 'utf8')
}

async function readRoadmapForSelection(root = process.cwd()) {
  const canonicalRef = `origin/${BASE}:${ROADMAP}`
  try {
    return {
      text: await execFileText('git', ['-C', root, 'show', canonicalRef]),
      source: canonicalRef,
      fallbackReason: '',
    }
  } catch (error) {
    const details = [
      (error && error.message) || String(error),
      error?.stderr ? `stderr: ${error.stderr.trim()}` : '',
      error?.stdout ? `stdout: ${error.stdout.trim()}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`Failed to read canonical roadmap ref ${canonicalRef}: ${details}`)
  }
}

function parentIdOf(id) {
  const parts = id.split('.')
  return parts.length > 1 ? parts.slice(0, -1).join('.') : ''
}

function isComplete(task) {
  return task?.checked?.toLowerCase() === 'x'
}

function extractRoadmapIds(text) {
  const ids = new Set([...text.matchAll(ROADMAP_ID_RE)].map((match) => match[0]))
  for (const match of text.matchAll(STEP_RANGE_RE)) {
    const expanded = expandStepRange(match[1], match[2])
    if (expanded.length) {
      ids.delete(match[1])
      ids.delete(match[2])
      for (const id of expanded) ids.add(id)
    }
  }
  return [...ids]
}

function expandStepRange(start, end) {
  const startParts = start.split('.').map(Number)
  const endParts = end.split('.').map(Number)
  if (startParts.length !== 2 || endParts.length !== 2 || startParts[0] !== endParts[0]) return []
  const [phaseId, firstStep] = startParts
  const lastStep = endParts[1]
  if (!Number.isInteger(phaseId) || !Number.isInteger(firstStep) || !Number.isInteger(lastStep) || firstStep > lastStep) return []
  return Array.from({ length: lastStep - firstStep + 1 }, (_, index) => `${phaseId}.${firstStep + index}`)
}

function parseRoadmap(text) {
  const tasks = []
  const byId = new Map()
  let currentTask = null

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const taskMatch = line.match(TASK_LINE_RE)
    if (taskMatch) {
      const [, indent, checked, id, rawTitle] = taskMatch
      const task = {
        id,
        checked,
        title: rawTitle.trim(),
        requires: [],
        line: index + 1,
        indent: indent.length,
        subtasks: [],
      }
      const parent = byId.get(parentIdOf(id))
      if (parent && isComplete(parent) && task.indent > parent.indent) {
        task.parentId = parent.id
        task.isAddendumSubtask = true
        parent.subtasks.push(task)
      } else {
        tasks.push(task)
      }
      byId.set(id, task)
      currentTask = task
      continue
    }

    const requiresMatch = line.match(REQUIRES_LINE_RE)
    if (requiresMatch && currentTask) {
      currentTask.requires.push(...extractRoadmapIds(requiresMatch[1]))
    }
  }

  for (const task of byId.values()) {
    task.requires = [...new Set(task.requires)]
  }

  return {
    tasks,
    completed: completedIds(tasks),
  }
}

function completedIds(tasks) {
  const completed = new Set()
  const prefixes = new Map()

  for (const task of tasks) {
    if (isTaskFullyComplete(task)) completed.add(task.id)
    for (const subtask of task.subtasks || []) {
      if (isComplete(subtask)) completed.add(subtask.id)
    }
    const parts = task.id.split('.')
    for (let length = 1; length < parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('.')
      if (!prefixes.has(prefix)) prefixes.set(prefix, [])
      prefixes.get(prefix).push(task)
    }
  }

  for (const [prefix, groupedTasks] of prefixes.entries()) {
    if (groupedTasks.length && groupedTasks.every(isTaskFullyComplete)) completed.add(prefix)
  }

  return completed
}

function isTaskFullyComplete(task) {
  return isComplete(task) && task.subtasks.every(isComplete)
}

function taskMatchesOnlyTask(candidate) {
  if (!ONLY_TASK) return true
  if (candidate.task.id === ONLY_TASK) return true
  return Boolean(candidate.task.subtasks?.includes(ONLY_TASK))
}

function blockedSummary(blocked) {
  if (!blocked.length) return ''
  const sample = blocked.slice(0, 5).join('; ')
  const suffix = blocked.length > 5 ? `; ${blocked.length - 5} more` : ''
  return `${blocked.length} blocked task(s): ${sample}${suffix}`
}

function selectRoadmapTask(roadmapText, taken) {
  const { tasks, completed } = parseRoadmap(roadmapText)
  const normalTaken = new Set(taken?.normal || [])
  const addendumTaken = new Set(taken?.addendum || [])
  const candidates = []
  const blocked = []

  for (const task of tasks) {
    const openSubtasks = task.subtasks.filter((subtask) => !isComplete(subtask))
    if (isComplete(task) && openSubtasks.length && !addendumTaken.has(task.id)) {
      candidates.push({
        order: task.line,
        kind: 'addendum',
        task: {
          id: task.id,
          title: task.title,
          requires: [],
          rationale: `Completed parent ${task.id} has open addendum sub-task(s): ${openSubtasks.map((subtask) => subtask.id).join(', ')}.`,
          isAddendum: true,
          subtasks: openSubtasks.map((subtask) => subtask.id),
        },
      })
    }

    if (!isComplete(task) && !normalTaken.has(task.id)) {
      const missing = task.requires.filter((id) => !completed.has(id))
      if (missing.length) {
        blocked.push(`${task.id} requires ${missing.join(', ')}`)
      } else {
        candidates.push({
          order: task.line,
          kind: 'normal',
          task: {
            id: task.id,
            title: task.title,
            requires: task.requires,
            rationale: task.requires.length
              ? `Every declared dependency is complete: ${task.requires.join(', ')}.`
              : 'The task has no declared dependencies.',
            isAddendum: false,
            subtasks: [],
          },
        })
      }
    }
  }

  const matchingCandidates = candidates.filter(taskMatchesOnlyTask).sort((left, right) => left.order - right.order)
  const selected = matchingCandidates[0]
  if (!selected) {
    const reason = ONLY_TASK
      ? `Task ${ONLY_TASK} is not currently unblocked as a normal task or addendum pass. ${blockedSummary(blocked)}`
      : blockedSummary(blocked)
    return { hasTask: false, remainingUnblocked: [], blockedSummary: reason.trim() }
  }

  return {
    hasTask: true,
    task: selected.task,
    remainingUnblocked: matchingCandidates.slice(1).map((candidate) => (candidate.kind === 'addendum' ? `${candidate.task.id} (addendum)` : candidate.task.id)),
    blockedSummary: blockedSummary(blocked),
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function planPrompt(task, worktree, priorVerdict, round, opts = {}) {
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
    ...(opts.resume
      ? [
          'RESUME: this branch survived a previous run. A committed ExecPlan draft may already exist at docs/execplans/<branch-leaf>.md, and the branch may already carry commits. Read the existing draft (Status, Progress, Decision Log) and the branch history FIRST, then complete or revise the plan IN PLACE rather than starting over. Account for any work already committed on the branch.',
          '',
        ]
      : []),
    SPARK_DELEGATION_GUIDANCE,
    '',
    'Use the `execplans` skill and follow it exactly. Name the plan docs/execplans/<branch-leaf>.md within the worktree (branch leaf = the part after the last "/").',
    'The plan must:',
    '- Decompose the task into ordered, atomic work items, each independently committable and gate-passable.',
    `- Adhere to the design documents (${DESIGN_DOCS}), the developers guide, the coding standards, and AGENTS.md. Cite the exact sections/ADRs each work item implements.`,
    '- Signpost, per work item, the documentation to read and the skills to load (router skills, hypothesis/crosshair/mutmut for verification, etc.).',
    '- Specify the tests (unit, behavioural, property, snapshot, e2e) each work item must add or update, per the AGENTS.md testing rules.',
    '- The ExecPlan must be implementable as written. Do NOT set Status: BLOCKED merely because Memtrace, GrepAI, Leta, Firecrawl, sem, or another advisory tool is unavailable in your agent session. Record the failed command and use bounded local docs/source/tests as fallback evidence. Only mark blocked for a true product/design ambiguity or missing requirement that cannot be resolved from the repository.',
    `- State the validation commands (${COMMIT_GATE_TEXT}; plus \`make markdownlint\` and \`make nixie\` for markdown changes). ${COMMIT_GATE_GUIDANCE}`,
    `- VALIDATION COMMANDS MUST BE PATH-SAFE: prefer repository gates such as ${COMMIT_GATE_TEXT}, \`make markdownlint\`, and \`make nixie\` over hand-written file lists. If a work item lists direct formatter/linter commands, every listed path must definitely exist at that point in the work item. Do not include a file that the same work item may delete, an optional file such as an optional snapshot, or a file that the work item does not edit. If a path is conditional, make the command conditional (\`test -e path && …\`) or omit that path and rely on the repository gate. This is a blocking design-review requirement.`,
    '',
    'RESEARCH before you commit to any mechanism — do not leave the implementer a menu of unverified workarounds:',
    '- For every external or locked library the plan leans on, verify its REAL behaviour before relying on it: read the actual source (a vendored or sibling checkout if the project has one) and the official docs (use the `firecrawl` skill / firecrawl_* tools). Pin every load-bearing API to what the LOCKED version genuinely supports and cite the file/symbol or doc you verified against. If the library cannot express what a work item needs, say so explicitly and specify the justified, scoped alternative rather than hedging.',
    ...(RESEARCH_NOTE ? [`- Project-specific research guidance: ${RESEARCH_NOTE}`] : []),
    '- Every load-bearing behavioural claim must be either verified-and-cited or pinned by a test in the plan. No undecided forks.',
    '',
    revision,
    '',
    'EXECPLAN DURABILITY CONTRACT: the committed ExecPlan is the durable source of truth for where this task stands — an uncommitted plan is lost when the run dies. COMMIT the ExecPlan on the task branch as soon as it is first written, and commit again after EVERY revision (en-GB imperative subject). Keep the header Status field accurate: it stays `DRAFT` while planning; the design reviewer flips it to `APPROVED`. Never return with the ExecPlan uncommitted or the worktree dirty.',
    '',
    'Write/update the execplan file on disk in the worktree and COMMIT it. Return its path, the ordered work-item titles, the docs and skills cited, and a short summary. Do NOT begin implementation.',
  ].join('\n')
}

function designReviewPrompt(task, worktree, plan, round) {
  return [
    preamble(worktree),
    `TASK: Conduct an ADVERSARIAL Logisphere DESIGN review of the ExecPlan for roadmap task ${task.id} at ${plan.execplanPath}. Round ${round}.`,
    '',
    'Invoke the `logisphere-design-review` skill and run the plan past the full crew (Pandalump structural integrity, Wafflecat alternatives, Buzzy Bee scaling, Telefono contracts, Doggylump failure modes, Dinolump long-term viability), plus the pre-mortem and alternatives checkpoint.',
    `Be genuinely adversarial: assume the plan is flawed until proven otherwise. Check it against the design documents, ADRs, developers guide, and AGENTS.md. Verify the work items are atomic, ordered, testable, and complete; that validation includes the project commit gates (${COMMIT_GATE_TEXT}, cross-checked against the gate targets AGENTS.md actually names) plus markdown gates when markdown changes; that direct formatter/linter file lists only name files guaranteed to exist and changed by that work item; that no standalone red-test commit is required; and that nothing contradicts the deterministic/judgemental boundary or the established contracts.`,
    '',
    'Read the execplan from disk yourself — do not trust the planner\'s summary. You may leave review notes in the execplan or an adjacent review file, but do NOT implement anything and do NOT relax the design to make it pass.',
    'Where the plan asserts any external or locked-library behaviour, verify it against the REAL source (a vendored or sibling checkout if the project has one) and the official docs. Treat any uncited memory-based claim about library behaviour as a blocking defect: the plan must verify and cite official docs when tools permit, or pin the behaviour with a test. Do not reject an otherwise implementable plan solely because Memtrace, GrepAI, Leta, Firecrawl, or sem was unavailable in the planner session; reject it if that unavailability was turned into a hard blocker instead of a documented fallback.',
    '',
    'Set satisfied=true ONLY when you would stake your name on the plan being implementable and design-conformant as written. Otherwise list precise, addressable blocking defects (these go straight back to the planner).',
    '',
    'STATUS TRANSITION: when (and only when) you set satisfied=true, update the ExecPlan header Status field from `DRAFT` to `APPROVED` and COMMIT that change (en-GB imperative subject) — the committed Status is what a resumed run dispatches on. If you are NOT satisfied, leave Status as `DRAFT`, and commit any review notes you chose to leave in the worktree so nothing is lost if the run dies.',
  ].join('\n')
}

function implementPrompt(task, worktree, plan, opts = {}) {
  return [
    preamble(worktree),
    `TASK: Implement roadmap task ${task.id} ("${task.title}") by executing the approved ExecPlan at ${plan.execplanPath}, work item by work item, in order.`,
    '',
    ...(opts.resume
      ? [
          'RESUME: this branch survived a previous run, and the committed ExecPlan is the source of truth for where the build stands. Read its Status, Progress checkboxes, and Decision Log FIRST. Verify already-ticked work items briefly (their commits exist on the branch and gates still pass) rather than redoing them, then continue from the first unticked work item.',
          '',
        ]
      : []),
    SPARK_DELEGATION_GUIDANCE,
    '',
    SCRUTINEER_DELEGATION_GUIDANCE,
    '',
    'For EACH execplan work item, in this exact order:',
    '  1. Implement the work item (code + tests + docs) per the plan and AGENTS.md.',
    `  2. DETERMINISTIC GATE FIRST: summon \`scrutineer\` to run the project commit gates (${COMMIT_GATE_TEXT}, plus any further gate targets AGENTS.md names). If it reports failures, fix them yourself (format, lint, typecheck, tests, audit) and summon \`scrutineer\` again until green. For any markdown you touched, also have \`scrutineer\` run \`make markdownlint\` and \`make nixie\` and fix failures. Do not proceed to coderabbit until the deterministic gates are green.`,
    `  3. THEN summon \`scrutineer\` to run \`${CODERABBIT_REVIEW_COMMAND}\` from inside the worktree. Address actionable feedback yourself (highest severity first). After applying fixes, summon \`scrutineer\` again to re-run the commit gates and confirm they are still green.`,
    `     - ${CODERABBIT_REVIEW_GUIDANCE}`,
    '  4. Update the execplan IN PLACE with findings, progress (tick the work item), and any decisions or deviations, with rationale.',
    '  5. Commit the work item and the execplan update together as one atomic commit (en-GB imperative subject ~50 cols, wrapped body explaining what and why).',
    '',
    'EXECPLAN DURABILITY CONTRACT: the committed ExecPlan (Status + Progress checkboxes) is the durable source of truth for where this task stands. Before starting the first work item, set the header Status to `IN PROGRESS` and commit it. When every work item is complete and the gates are green, set Status to `COMPLETE` together with the Outcomes & Retrospective update, and commit. Never leave the ExecPlan stale or uncommitted at any stopping point — if you must stop early, commit the plan reflecting exactly what is done and what remains.',
    '',
    'Use leta for navigation, sem for history, and the language router skill for the languages you touch. Follow the per-work-item skill and documentation signposts in the plan.',
    '',
    `${DRY_RUN ? 'DRY RUN: do not run this step — it is skipped by the orchestrator.' : ''}`,
    `When all work items are done, ensure the project commit gates (${COMMIT_GATE_TEXT}) are green at HEAD. Return the completion counts, commit subjects, whether gates are green, the number of coderabbit runs, and any open issues.`,
  ].join('\n')
}

function fixPrompt(task, worktree, plan, blocking, round) {
  return [
    preamble(worktree),
    `TASK: Address blocking review findings for roadmap task ${task.id} (fix round ${round}). Execplan: ${plan.execplanPath}.`,
    '',
    SPARK_DELEGATION_GUIDANCE,
    '',
    SCRUTINEER_DELEGATION_GUIDANCE,
    '',
    'The dual review returned the following BLOCKING items. Resolve every one:',
    ...blocking.map((b, i) => `  ${i + 1}. ${b}`),
    '',
    `Same per-change discipline as implementation: summon \`scrutineer\` for the deterministic gates (${COMMIT_GATE_TEXT}, plus markdownlint/nixie for markdown) first and green, THEN summon \`scrutineer\` for \`${CODERABBIT_REVIEW_COMMAND}\`, then one atomic commit that includes the execplan update recording what changed and why (the committed ExecPlan is the durable source of truth — never leave it stale or uncommitted). ${CODERABBIT_REVIEW_GUIDANCE} Do not introduce scope beyond the blocking items.`,
    '',
    'Return the commit subjects you added, whether every deterministic gate is green at HEAD after your fixes, the number of CodeRabbit runs you completed, how each blocking item was resolved, any open issues with reasons, and a short summary. This structured report is durable validation evidence for the branch — be precise about which gates ran and at which commit.',
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
    `Use leta to inspect the code and sem to inspect the change history. Use the commit-gate output (${COMMIT_GATE_TEXT}) as evidence but do not rely on it alone.`,
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

function addendumReviewPrompt(task, worktree, impl) {
  const ids = (task.subtasks || []).join(', ')
  const parentPlan = `docs/execplans/roadmap-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')}.md`
  return [
    preamble(worktree),
    `TASK: Review the committed addendum implementation for completed roadmap task ${task.id}, scoped ONLY to sub-task(s): ${ids}.`,
    '',
    'CodeRabbit review was deferred or unavailable for this addendum, so you are the high-model fallback reviewer. Use the `code-review` skill. Be strict, but keep the scope surgical: this is not a full design review and not a licence to expand the task.',
    '',
    `Compare the branch diff against the Addenda checklist in ${parentPlan}, the relevant design/developer docs, and AGENTS.md. Confirm:`,
    '- each listed addendum sub-task is actually implemented and ticked in the execplan,',
    '- the implementation is correct and does not regress existing behaviour,',
    '- tests or property checks cover the new edge, and repository gates are meaningful evidence,',
    '- documentation changes are present where AGENTS.md or the addendum requires them.',
    '',
    `Do not treat unchecked entries in ${ROADMAP} as a blocking issue for this review. The implementation agent is forbidden to edit the roadmap; the serialized integration phase ticks the roadmap after this review passes.`,
    '',
    'Implementation summary from the builder:',
    impl?.summary || '',
    '',
    'Builder-reported deferred/open issues:',
    ...((impl?.openIssues || []).map((issue, index) => `  ${index + 1}. ${issue}`)),
    '',
    'Use leta for branch-local code navigation and sem for the committed diff. Return verdict=pass only if you would ship this addendum despite the deferred CodeRabbit review. If not, list precise blocking items. Follow-up ideas go in proposedRoadmapItems only.',
  ].join('\n')
}

function implementAddendumPrompt(task, worktree) {
  const ids = (task.subtasks || []).join(', ')
  const parentPlan = `docs/execplans/roadmap-${task.id.replace(/[^0-9a-zA-Z]+/g, '-')}.md`
  return [
    preamble(worktree),
    `TASK: Lightweight ADDENDUM PASS for completed roadmap task ${task.id}. Implement ONLY its open sub-tasks: ${ids}. This is an addendum, NOT a full task — there is deliberately NO plan, NO design review, and NO dual logisphere review. Keep every change surgical and strictly in-scope; an addendum that grows into a redesign is a defect.`,
    '',
    SPARK_DELEGATION_GUIDANCE,
    '',
    SCRUTINEER_DELEGATION_GUIDANCE,
    '',
    `These sub-tasks are recorded as unchecked items under an "## Addenda" section of the parent task's execplan (start at ${parentPlan}; if the leaf differs, find the execplan whose Addenda list contains ${ids}). Read that section for the precise scope and gate of each sub-task.`,
    '',
    'For EACH open sub-task, in id order:',
    '  1. Make ONLY the change the Addenda item describes. Do not expand scope.',
    `  2. DETERMINISTIC GATE: summon \`scrutineer\` to run the project commit gates (${COMMIT_GATE_TEXT}, plus any further gate targets AGENTS.md names). For any Markdown you touched, also have it run \`make markdownlint\` and \`make nixie\`. Fix until green.`,
    `  3. Summon \`scrutineer\` to run \`${CODERABBIT_REVIEW_COMMAND}\` from inside the worktree; address actionable feedback yourself (highest severity first); summon \`scrutineer\` again to re-run the commit gates and confirm green. ${CODERABBIT_REVIEW_GUIDANCE}`,
    `  4. Tick the sub-task in the Addenda checklist of its execplan (\`- [ ] ${task.id}.<n>\` → \`- [x] …\`).`,
    '  5. Commit the sub-task and Addenda tick together as one atomic commit (en-GB imperative subject).',
    '',
    `Use leta for navigation, sem for history, and the language router skill for the languages you touch. Do NOT edit the roadmap — integration ticks the roadmap sub-tasks. When all listed sub-tasks are done, ensure the project commit gates (${COMMIT_GATE_TEXT}) are green at HEAD. Return using the IMPL schema (execplanPath = the parent execplan): completion counts, commit subjects, gatesGreen, coderabbit run count, and any open issues.`,
  ].join('\n')
}

function isDeferredReviewIssue(issue) {
  const text = String(issue || '').toLowerCase()
  const deferredReviewMarkers = [
    'rate limit',
    'rate_limit',
    'rate-limit',
    'ratelimit',
    '429',
    'retry after',
    'waittime',
    'wait time',
    'deferred review',
    'deferred coderabbit review',
    'coderabbit review deferred',
    'unavailable',
  ]
  return text.includes('coderabbit') && deferredReviewMarkers.some((marker) => text.includes(marker))
}

function hasOnlyDeferredReviewIssues(openIssues) {
  const issues = openIssues || []
  return issues.length > 0 && issues.every(isDeferredReviewIssue)
}

function implementationAuthFailureDetail(impl) {
  const detail = [impl?.summary, ...(impl?.openIssues || [])].filter(Boolean).join('\n')
  return authFailureDetail(detail)
}

// A complete, gate-green addendum whose builder did not set ok=true is an
// operator handoff, not an assessment case. Open issues are tolerated only
// when every one is a deferred/recoverable review fault (e.g. a CodeRabbit
// 429): that exact missing evidence is bounded and mechanical — retry the
// review, verify, integrate — so spending an unbounded judgement agent on it
// burns tokens without adding operator information (issue #27).
function addendumImplementationNeedsManualMerge(impl) {
  if (!impl || impl.ok || !impl.gatesGreen) return false
  const openIssues = impl.openIssues || []
  if (openIssues.length > 0 && !hasOnlyDeferredReviewIssues(openIssues)) return false
  const completed = Number(impl.workItemsCompleted)
  const total = Number(impl.workItemsTotal)
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total
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
    `  3. Re-run the project commit gates (${COMMIT_GATE_TEXT}) after the rebase to confirm the branch is still green.`,
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

// Shared ADR 002 assessment prompt body — the classification contract is ONE
// contract: in-run failure assessment and fresh-run recovery assessment feed
// the same schema, enum, and evidence expectations. Only the task header and
// the context block differ between the two entry points.
function assessmentPromptLines(taskHeader, worktreePath, evidence, contextTitle, contextValue) {
  return [
    preamble(worktreePath),
    taskHeader,
    '',
    'This is a READ-ONLY recovery assessment. Do not edit files, commit, stash, merge, cherry-pick, push, delete worktrees, mark roadmap checkboxes, or run any command that mutates repository state. Do not resume or rely on the failed agent transcript. Inspect only durable state that exists on disk or in Git.',
    '',
    'Use ADR 002 (`docs/adr-002-assess-partial-task-branches.md`) as the classification contract. Return exactly one classification:',
    '- `adopt-complete`: the branch satisfies the roadmap task success criterion, has an up-to-date ExecPlan, required gates are green, and can proceed through the ordinary review and integration path.',
    '- `adopt-partial`: the branch contains a coherent useful slice, but the roadmap task must remain unchecked and the work should be preserved only through Git state.',
    '- `continue-manual`: the branch is promising, but scope, roadmap state, validation, or review evidence needs operator judgement before any merge.',
    '- `discard`: the branch is stale, unsafe, incoherent, unrelated, or too incomplete to keep.',
    '',
    'Assess evidence first:',
    '- branch name, worktree path, base commit, and current commit;',
    '- dirty-state summary;',
    '- changed files and whether they are scoped to the task;',
    '- ExecPlan status, progress notes, decision log, and retrospective state;',
    '- roadmap checkbox state for the task;',
    '- available validation evidence;',
    '- missing validation or review evidence;',
    '- safety risks and recommended operator next actions.',
    '',
    'Evidence freshness rules:',
    '- Judge the branch at the CURRENT commit recorded in the host-collected evidence below. ExecPlan prose, earlier assessments, and logs that predate later commits are historical context, not the current validation state.',
    '- When the failure context includes `reviewRounds`, those review verdicts and structured fix-round reports were produced by this workflow AFTER any earlier snapshot: treat the latest fix round\'s gate and CodeRabbit report, together with the host-collected git evidence, as the branch\'s current validation state. Do not list evidence as missing when the latest fix round reports the named gates green at the current tip — cite that report instead.',
    '- Gate logs under /tmp are not durable; their absence is not, by itself, missing evidence when a structured fix-round or implementation report records the gates that ran and their outcomes.',
    '',
    'Host-collected git evidence:',
    '```json',
    JSON.stringify(evidence, null, 2),
    '```',
    '',
    contextTitle,
    '```json',
    JSON.stringify(contextValue, null, 2),
    '```',
    '',
    'Return only the schema-bound assessment object. Free-text recommendations do not drive integration; make the enum classification and evidence fields precise.',
  ].join('\n')
}

function assessmentPrompt(task, wt, result, evidence) {
  return assessmentPromptLines(
    `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") after a workflow failure.`,
    wt.worktreePath,
    evidence,
    'Original workflow failure result:',
    result,
  )
}

function recoveryAssessmentPrompt(task, candidate, evidence) {
  return assessmentPromptLines(
    `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") discovered during fresh-run recovery.`,
    candidate.worktreePath,
    evidence,
    "Recovery discovery context (fresh launch; the failed run's transcript and result are unavailable by design):",
    candidate,
  )
}

// Route a discovered candidate through the SAME ADR 002 assessment contract as
// in-run failures: same evidence collector, same schema, same adapter routing.
async function assessRecoveryCandidate(candidate) {
  const task = { id: candidate.taskId, title: candidate.taskTitle }
  const wt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit }
  const evidence = await collectAssessmentEvidence(task, wt)
  try {
    const assessment = await agent(recoveryAssessmentPrompt(task, candidate, evidence), assessmentAgentOptions({
      phase: 'Recovery',
      label: `recover-assess:${candidate.taskId}${candidate.isAddendum ? '-addendum' : ''}`,
      schema: ASSESSMENT_SCHEMA,
    }))
    if (!assessment) {
      return { evidence, assessment: null, assessmentError: 'assessment agent returned no structured output' }
    }
    return { evidence, assessment: { ...assessment, hostEvidence: evidence }, assessmentError: '' }
  } catch (error) {
    return { evidence, assessment: null, assessmentError: (error && error.message) || String(error) }
  }
}

function shouldAssessFailure(result, wt) {
  if (!ASSESS_PARTIAL_BRANCHES) return false
  if (!wt?.branch || !wt?.worktreePath) return false
  if (!result || !['failed', 'halted'].includes(result.status)) return false
  if (result.stage === 'worktree' || result.stage === 'worktree-write' || result.stage === 'auth' || result.stage === 'provider' || result.status === 'fatal-auth' || result.status === 'provider-fault') return false
  const detail = [result.detail, ...(result.openIssues || [])].filter(Boolean).join('\n')
  return !authFailureDetail(detail) && !providerFailureDetail(detail)
}

async function attachAssessment(task, wt, result) {
  if (!shouldAssessFailure(result, wt)) return result
  phase('Assess')
  const evidence = await collectAssessmentEvidence(task, wt)
  try {
    const assessment = await agent(assessmentPrompt(task, wt, result, evidence), assessmentAgentOptions({
      phase: 'Assess',
      label: `assess:${task.id}`,
      schema: ASSESSMENT_SCHEMA,
    }))
    if (!assessment) {
      return { ...result, assessmentError: 'assessment agent returned no structured output', assessmentEvidence: evidence }
    }
    return { ...result, assessment: { ...assessment, hostEvidence: evidence } }
  } catch (error) {
    return {
      ...result,
      assessmentError: (error && error.message) || String(error),
      assessmentEvidence: evidence,
    }
  }
}

// ---------------------------------------------------------------------------
// Fresh-run recovery discovery (failure resume, phase 1) — reconstruct
// recovery candidates from durable Git state alone: local roadmap-* branches,
// live worktrees, and the canonical roadmap. Discovery never mutates the
// target project; it only reads refs, worktree metadata, and commit ids.
// ---------------------------------------------------------------------------
const TASK_BRANCH_RE = /^roadmap-((?:\d+-)*\d+)(-addendum)?$/

function branchToRoadmapId(branch) {
  const match = TASK_BRANCH_RE.exec(String(branch || ''))
  if (!match) return null
  return { id: match[1].replace(/-/g, '.'), isAddendum: Boolean(match[2]) }
}

function parseWorktreeList(output) {
  const entries = []
  let current = null
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current)
      current = null
      continue
    }
    const spaceIndex = line.indexOf(' ')
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex)
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1)
    if (key === 'worktree') {
      current = { worktreePath: value, branch: '', head: '' }
    } else if (current && key === 'HEAD') {
      current.head = value
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '')
    }
  }
  if (current) entries.push(current)
  return entries
}

async function directoryExists(pathValue) {
  if (!pathValue) return false
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    const stat = await fs.stat(String(pathValue))
    return stat.isDirectory()
  } catch {
    return false
  }
}

function roadmapTaskIndex(roadmapText) {
  const { tasks } = parseRoadmap(roadmapText)
  const byId = new Map()
  for (const task of tasks) {
    byId.set(task.id, task)
    for (const subtask of task.subtasks || []) byId.set(subtask.id, subtask)
  }
  return byId
}

// A normal branch is stale once its task checkbox is ticked; an addendum
// branch is stale once the parent AND every addendum sub-task are ticked.
function candidateRoadmapComplete(task, isAddendum) {
  if (!isAddendum) return isComplete(task)
  return isTaskFullyComplete(task)
}

async function discoverRecoveryCandidates(roadmapText, gitRoot) {
  const root = gitRoot || process.cwd()
  const skipped = []
  const errors = []

  const branchList = await execFileStatus('git', ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/roadmap-*'])
  if (!branchList.ok) {
    errors.push(`for-each-ref failed: ${[branchList.message, branchList.stderr].filter(Boolean).join('; ')}`)
    return { candidates: [], skipped, errors }
  }
  const branches = branchList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  const worktreeList = await execFileStatus('git', ['-C', root, 'worktree', 'list', '--porcelain'])
  if (!worktreeList.ok) {
    errors.push(`worktree list failed: ${[worktreeList.message, worktreeList.stderr].filter(Boolean).join('; ')}`)
  }
  const worktreeByBranch = new Map(
    parseWorktreeList(worktreeList.stdout)
      .filter((entry) => entry.branch)
      .map((entry) => [entry.branch, entry.worktreePath]),
  )

  const byId = roadmapTaskIndex(roadmapText)
  const mapped = []
  for (const branch of branches) {
    const parsed = branchToRoadmapId(branch)
    const task = parsed ? byId.get(parsed.id) : null
    if (!parsed || !task) {
      skipped.push({ id: parsed?.id || '', branchName: branch, reason: 'unmapped-branch' })
      continue
    }
    if (candidateRoadmapComplete(task, parsed.isAddendum)) {
      skipped.push({ id: parsed.id, branchName: branch, reason: 'already-complete' })
      continue
    }

    const commit = await execFileStatus('git', ['-C', root, 'rev-parse', '--verify', `${branch}^{commit}`])
    if (!commit.ok) {
      skipped.push({ id: parsed.id, branchName: branch, reason: 'unreadable-commit' })
      continue
    }
    const mergeBase = await execFileStatus('git', ['-C', root, 'merge-base', `origin/${BASE}`, branch])

    const worktreePath = worktreeByBranch.get(branch) || ''
    mapped.push({
      taskId: parsed.id,
      taskTitle: task.title || '',
      branchName: branch,
      worktreePath: (await directoryExists(worktreePath)) ? worktreePath : '',
      baseCommit: mergeBase.ok ? mergeBase.stdout.trim() : '',
      currentCommit: commit.stdout.trim(),
      roadmapComplete: false,
      isAddendum: parsed.isAddendum,
      line: task.line || Number.MAX_SAFE_INTEGER,
    })
  }

  mapped.sort((left, right) => (left.line - right.line) || left.branchName.localeCompare(right.branchName))

  const candidates = []
  for (const candidate of mapped) {
    if (RESUME_TASK_ID && candidate.taskId !== RESUME_TASK_ID) continue
    if (!candidate.worktreePath) {
      skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: 'missing-worktree' })
      continue
    }
    if (candidates.length >= RESUME_MAX_CANDIDATES) {
      skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: 'candidate-cap' })
      continue
    }
    candidates.push(candidate)
  }

  return { candidates, skipped, errors }
}

// Reasons a discovered branch is recorded in recovery.skipped instead of
// proceeding to its mode's maximum action. Discovery emits the first five;
// the assessment and resume-decision stages emit the rest.
const RECOVERY_SKIP_REASONS = [
  'unmapped-branch',
  'already-complete',
  'unreadable-commit',
  'missing-worktree',
  'candidate-cap',
  'assessment-error',
  'addendum-branch',
  'evidence-collection-error',
  'dirty-worktree',
  'no-committed-work',
  'not-task-scoped',
  'missing-validation-evidence',
  'missing-execplan',
  'plan-blocked',
  'dry-run',
]

// Review-mode resume eligibility: only a clean, committed, task-scoped
// adopt-complete branch with validation evidence may spend review and
// integration effort. Returns '' when eligible, else the disqualifying skip
// reason. Host-collected evidence is decisive over agent-reported fields.
function recoveryResumeEligibility(candidate, evidence, assessment) {
  if (candidate?.isAddendum) return 'addendum-branch'
  if ((evidence?.collectionErrors || []).length) return 'evidence-collection-error'
  if (evidence?.dirtyState !== 'clean') return 'dirty-worktree'
  if (!(evidence?.recentCommits || []).length) return 'no-committed-work'
  if (assessment?.taskScoped !== true) return 'not-task-scoped'
  if (!String(assessment?.validation || '').trim()) return 'missing-validation-evidence'
  if ((assessment?.missingEvidence || []).length) return 'missing-validation-evidence'
  if (!candidate?.execplanPath) return 'missing-execplan'
  return ''
}

// The failure-resume decision table. Every classification is report-only in
// assess mode; in review mode only eligible adopt-complete candidates may
// resume, and an adopt-complete verdict that fails an eligibility check is
// DOWNGRADED to continue-manual in the summary (fail closed).
function recoveryDecision(candidate, evidence, assessment, mode, flags = {}) {
  const classification = assessment?.classification || ''
  if (mode !== 'review' || classification !== 'adopt-complete') {
    return { action: 'report', classification, reason: '', skip: false }
  }
  const reason = recoveryResumeEligibility(candidate, evidence, assessment)
  if (reason) {
    return { action: 'report', classification: 'continue-manual', reason, skip: true }
  }
  if (flags.dryRun) {
    return { action: 'report', classification, reason: 'dry-run', skip: true }
  }
  return { action: 'resume', classification, reason: '', skip: false }
}

// ---------------------------------------------------------------------------
// Continue-mode dispatch (failure resume, phase 3) — the committed ExecPlan is
// the durable source of truth for where a task stands. Agents commit the plan
// after every change and keep its Status field accurate, so a fresh run can
// dispatch a survivor branch deterministically, with no judgement agent:
//   Status DRAFT (or missing/unfilled) -> re-enter the plan/design-review loop
//   Status APPROVED or IN PROGRESS     -> re-enter implementation
//   Status COMPLETE                    -> re-enter dual review + integration
//   Status BLOCKED                     -> report for the operator
// Safety comes from the downstream gates the resumed branch still has to pass
// (design review, deterministic gates, dual review, serialized integration),
// not from an up-front classification.
// ---------------------------------------------------------------------------
const EXECPLAN_STATUS_MAP = {
  draft: 'draft',
  approved: 'approved',
  'in progress': 'in-progress',
  blocked: 'blocked',
  complete: 'complete',
}

// Parse the durable state out of a committed ExecPlan: the Status field and
// the Progress checkbox tallies (informational — dispatch keys on Status
// alone). An unfilled skeleton line ("Status: DRAFT | APPROVED | …") or an
// unrecognized value parses as 'unknown', which dispatches to planning.
function parseExecplanState(text) {
  const source = String(text || '')
  let status = 'unknown'
  const statusMatch = source.match(/^Status:\s*([A-Za-z ]+?)\s*$/m)
  if (statusMatch) {
    const value = statusMatch[1].trim().toLowerCase().replace(/\s+/g, ' ')
    status = EXECPLAN_STATUS_MAP[value] || 'unknown'
  }
  let ticked = 0
  let unticked = 0
  const progressSection = source.split(/^##\s+/m).find((section) => /^progress\b/i.test(section)) || ''
  for (const line of progressSection.split(/\r?\n/)) {
    if (/^\s*-\s+\[[xX]\]/.test(line)) ticked += 1
    else if (/^\s*-\s+\[ \]/.test(line)) unticked += 1
  }
  return { status, ticked, unticked }
}

async function readExecplanState(candidate) {
  if (!candidate?.execplanPath) return { status: 'missing', ticked: 0, unticked: 0 }
  const path = process.getBuiltinModule('node:path')
  try {
    const text = await readFileText(path.join(candidate.worktreePath, candidate.execplanPath))
    return parseExecplanState(text)
  } catch {
    return { status: 'missing', ticked: 0, unticked: 0 }
  }
}

// The continue-mode decision table. Purely deterministic: hygiene checks from
// host-collected evidence, then a stage keyed on the committed ExecPlan
// Status. Returns { action: 'report'|'resume', stage, reason, skip }.
function recoveryContinueDecision(candidate, evidence, planState, flags = {}) {
  const report = (reason) => ({ action: 'report', stage: null, reason, skip: true })
  if (candidate?.isAddendum) return report('addendum-branch')
  if ((evidence?.collectionErrors || []).length) return report('evidence-collection-error')
  if (evidence?.dirtyState !== 'clean') return report('dirty-worktree')
  if (planState.status === 'blocked') return report('plan-blocked')
  const stage =
    planState.status === 'approved' || planState.status === 'in-progress'
      ? 'implement'
      : planState.status === 'complete'
        ? 'review'
        : 'plan' // missing, draft, or unknown: (re-)enter planning
  if (stage === 'review' && !(evidence?.recentCommits || []).length) return report('no-committed-work')
  if (flags.dryRun) return { action: 'report', stage, reason: 'dry-run', skip: true }
  return { action: 'resume', stage, reason: '', skip: false }
}

// Skip reasons whose branch still exists and still maps to a selectable
// roadmap id — normal selection must not re-open these this run, because
// `git worktree add -b` would collide with the surviving branch.
const RECOVERY_HOLD_REASONS = new Set(['missing-worktree', 'candidate-cap', 'unreadable-commit', 'assessment-error'])

// Bridge an eligible recovered branch into the ordinary review path without
// re-running implementation. The synthetic result mirrors IMPL_SCHEMA but is
// NOT proof the branch is shippable: code review, expert review, gates, and
// integration remain decisive, and the open issue makes that explicit to
// reviewers reading the implementation summary.
// The canonical durable plan for a task branch, or '' when it does not exist
// on disk in the worktree. An absent plan stays absent: nothing downstream may
// substitute the canonical path back in after this check has failed.
async function recoveryExecplanPath(candidate) {
  const canonicalPlan = `docs/execplans/${candidate.branchName}.md`
  return (await fileExists(canonicalPlan, candidate.worktreePath)) ? canonicalPlan : ''
}

async function syntheticRecoveryImpl(candidate, evidence) {
  const execplanPath =
    typeof candidate.execplanPath === 'string'
      ? candidate.execplanPath
      : await recoveryExecplanPath(candidate)
  return {
    ok: true,
    gatesGreen: true,
    execplanPath,
    workItemsCompleted: 0,
    workItemsTotal: 0,
    commits: evidence?.recentCommits || [],
    coderabbitRuns: 0,
    openIssues: ['recovered branch requires fresh review'],
    summary: 'Recovered adopt-complete branch from durable git state.',
  }
}

// Execute a resume at the dispatched stage through the ordinary pipeline.
// Every stage funnels into the SAME dual-review + merge-lock integration path
// as fresh work; the host-verified write gate runs first because plan, build,
// fix, and integration agents all write into the recovered worktree.
async function executeResume(task, candidate, enriched, evidence, stage, mergeLock) {
  const worktree = candidate.worktreePath
  const extra = { kind: 'recovery-resume' }
  const writeAccess = await ensureTaskAgentWriteAccess(worktree, candidate.taskId)
  if (!writeAccess.ok) {
    const detail = `task-agent writable-root preflight failed (launch/sandbox fault, not a task defect): ${writeAccess.failures.map((failure) => `${failure.adapter}: ${failure.detail}`).join('; ')}`
    return { id: candidate.taskId, status: 'failed', stage: 'worktree-write', detail, worktree, proposals: [], ...extra }
  }
  try {
    let plan
    let impl
    if (stage === 'plan') {
      const planned = await runPlanDesignLoop(task, worktree, { resume: true, extra })
      if (planned.fail) return planned.fail
      plan = planned.plan
    } else if (stage === 'implement') {
      plan = {
        execplanPath: enriched.execplanPath,
        workItems: [],
        summary: 'Resumed from the committed ExecPlan on the surviving branch.',
      }
    }
    if (stage === 'plan' || stage === 'implement') {
      const built = await runImplementationStage(task, worktree, plan, { resume: stage === 'implement', extra })
      if (built.fail) return built.fail
      impl = built.impl
    } else {
      impl = await syntheticRecoveryImpl(enriched, evidence)
      plan = { execplanPath: impl.execplanPath, workItems: [], summary: impl.summary }
    }
    return await runDualReviewAndIntegration(task, candidate.worktreePath, plan, impl, mergeLock, { kind: 'recovery-resume' })
  } catch (error) {
    const detail = `unhandled agent error: ${(error && error.message) || String(error)}`
    return resultFromUnhandledAgentError(candidate.taskId, detail, { worktree, kind: 'recovery-resume' })
  }
}

// Fresh-run recovery pass: discover -> decide -> report or resume.
// Assess mode never mutates the target project: it reads Git state and spawns
// read-only assessment agents. Review mode may route eligible adopt-complete
// candidates through the SAME dual-review + merge-lock integration path as
// ordinary tasks. Continue mode dispatches deterministically on the committed
// ExecPlan Status and re-enters the ordinary pipeline at the plan, implement,
// or review stage; nothing merges outside that path in any mode.
async function runRecovery(root, mergeLock = null) {
  const summary = {
    enabled: true,
    mode: RESUME_MODE,
    candidates: 0,
    assessed: 0,
    resumed: 0,
    skipped: [],
    results: [],
    errors: [],
  }
  const held = { normal: new Set(), addendum: new Set() }
  const taskResults = []
  phase('Recovery')

  const fetched = await execFileStatus('git', ['-C', root, 'fetch', 'origin', BASE])
  if (!fetched.ok) {
    summary.errors.push(`fetch origin ${BASE} failed (continuing with local refs): ${(fetched.message || fetched.stderr || '').trim()}`)
  }
  let roadmap
  try {
    roadmap = await readRoadmapForSelection(root)
  } catch (error) {
    summary.errors.push((error && error.message) || String(error))
    log('[recovery] cannot read the canonical roadmap; skipping recovery discovery')
    return { summary, taskResults, held, fatal: null }
  }

  const discovery = await discoverRecoveryCandidates(roadmap.text, root)
  summary.candidates = discovery.candidates.length
  summary.skipped.push(...discovery.skipped)
  summary.errors.push(...discovery.errors)

  const holdCandidate = (branchName, taskId) => {
    const parsed = branchToRoadmapId(branchName)
    if (!parsed) return
    ;(parsed.isAddendum ? held.addendum : held.normal).add(taskId || parsed.id)
  }
  for (const entry of discovery.skipped) {
    if (RECOVERY_HOLD_REASONS.has(entry.reason)) holdCandidate(entry.branchName, entry.id)
  }

  for (const candidate of discovery.candidates) {
    holdCandidate(candidate.branchName, candidate.taskId)
    const task = {
      id: candidate.taskId,
      title: candidate.taskTitle,
      requires: [],
      rationale: `${RESUME_MODE}-mode recovery resume of a surviving task branch`,
      isAddendum: false,
      subtasks: [],
    }
    const resumeWt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit }

    let decision
    let evidence
    let enriched
    let assessment = null
    let planState = null
    if (RESUME_MODE === 'continue') {
      // Deterministic dispatch: host git evidence plus the committed ExecPlan
      // Status. No judgement agent — the downstream gates ARE the judgement.
      log(`[recovery] dispatching ${candidate.branchName} (task ${candidate.taskId}) from its committed ExecPlan`)
      evidence = await collectAssessmentEvidence(task, resumeWt)
      enriched = { ...candidate, execplanPath: await recoveryExecplanPath(candidate) }
      planState = await readExecplanState(enriched)
      decision = { classification: '', ...recoveryContinueDecision(enriched, evidence, planState, { dryRun: DRY_RUN }) }
    } else {
      log(`[recovery] assessing ${candidate.branchName} (task ${candidate.taskId})`)
      const assessed = await assessRecoveryCandidate(candidate)
      if (!assessed.assessment) {
        summary.results.push({
          id: candidate.taskId,
          branchName: candidate.branchName,
          classification: '',
          action: 'assessment-error',
          assessmentError: assessed.assessmentError,
        })
        summary.skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: 'assessment-error' })
        if (authFailureDetail(assessed.assessmentError) || providerFailureDetail(assessed.assessmentError)) {
          // Infrastructure faults during recovery poison every later agent
          // call too — halt the run instead of pretending branches were
          // assessed.
          return { summary, taskResults, held, fatal: resultFromUnhandledAgentError(candidate.taskId, assessed.assessmentError) }
        }
        continue
      }
      assessment = assessed.assessment
      summary.assessed += 1
      evidence = assessment.hostEvidence
      // Resolve the durable ExecPlan before deciding: resume eligibility
      // requires it, and its absence must stay visible as missing-execplan.
      enriched = { ...candidate, execplanPath: await recoveryExecplanPath(candidate) }
      decision = { stage: 'review', ...recoveryDecision(enriched, evidence, assessment, RESUME_MODE, { dryRun: DRY_RUN }) }
    }

    const resultBase = {
      id: candidate.taskId,
      branchName: candidate.branchName,
      classification: decision.classification,
      ...(planState ? { planStatus: planState.status } : {}),
    }

    if (decision.action !== 'resume') {
      if (decision.skip) {
        summary.skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: decision.reason })
      }
      summary.results.push({
        ...resultBase,
        action: 'reported',
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(assessment ? { assessment } : {}),
      })
      log(`[recovery] ${candidate.branchName}: ${decision.classification || planState?.status || 'reported'} (reported${decision.reason ? `; ${decision.reason}` : ''})`)
      continue
    }

    // --- Resume: re-enter the ordinary pipeline at the dispatched stage. The
    // committed ExecPlan (continue mode) or the ADR 002 assessment (review
    // mode) chose the entry point; the pipeline's own gates remain decisive,
    // and integration ticks the roadmap under the merge lock.
    const stage = decision.stage || 'review'
    log(`[recovery] resuming ${candidate.branchName} at the ${stage} stage through the ordinary pipeline`)
    const outcome = await executeResume(task, candidate, enriched, evidence, stage, mergeLock)
    if (outcome.status === 'fatal-auth' || outcome.status === 'provider-fault') {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resume-failed', reason: outcome.detail || outcome.status })
      return { summary, taskResults, held, fatal: outcome }
    }
    // A failed or halted resume gets a FRESH assessment through the same
    // guard as ordinary task failures — any pre-resume snapshot is stale
    // once later agents have touched the branch.
    taskResults.push({ task, result: outcome.status === 'done' ? outcome : await attachAssessment(task, resumeWt, outcome) })
    if (outcome.status === 'done') {
      summary.resumed += 1
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resumed' })
      log(`[recovery] ${candidate.branchName}: resumed and integrated`)
    } else if (outcome.status === 'manual-merge-ready') {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'manual-merge-ready' })
    } else {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resume-failed', reason: outcome.detail || outcome.status })
      log(`[recovery] ${candidate.branchName}: resume ${outcome.status} at ${outcome.stage || 'unknown stage'}`)
    }
  }

  return { summary, taskResults, held, fatal: null }
}

// ---------------------------------------------------------------------------
// Task-agent writable-root preflight — ODW launches every adapter with the
// control checkout as its working directory, so a sandbox scoped to that
// checkout silently rejects writes to sibling ...worktrees/roadmap-* paths.
// Prompt text cannot fix that, so the workflow proves writability once per
// run: each adapter that must write into task worktrees (planner and builder)
// is asked to write a token file inside the first task worktree, and the HOST
// verifies the bytes on disk. A failed probe is a launch/sandbox fault, so the
// task fails fast at stage "worktree-write" instead of burning design rounds,
// and that stage is excluded from partial-branch assessment.
// ---------------------------------------------------------------------------
const WRITE_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true when the probe file was written with the exact token' },
    detail: { type: 'string', description: 'the error encountered, empty when ok' },
  },
  required: ['ok'],
}

function writeProbeTargets() {
  const targets = [
    { role: 'plan', adapter: String(PLAN_ADAPTER).toLowerCase(), options: planAgentOptions },
    { role: 'build', adapter: String(BUILD_ADAPTER).toLowerCase(), options: buildAgentOptions },
  ]
  const seen = new Set()
  return targets.filter((target) => {
    if (seen.has(target.adapter)) return false
    seen.add(target.adapter)
    return true
  })
}

function writeProbePath(worktree, adapter) {
  const path = process.getBuiltinModule('node:path')
  return path.join(worktree, `.df12-write-probe-${String(adapter).replace(/[^0-9a-zA-Z._-]+/g, '-')}`)
}

function writeProbeToken(tag, adapter) {
  return `df12-write-probe v1 task=${tag} adapter=${adapter}`
}

function writeProbePrompt(probeFile, token) {
  return [
    'You are a sub-agent in the df12-build roadmap workflow. Your final message IS your return value — return data, not chat.',
    '',
    'TASK: Writable-root probe. Write EXACTLY the token below (no trailing newline required) to the probe file path below, using your shell or file-edit tooling. Do not write anywhere else, do not commit, and do not delete the file afterwards — the workflow host verifies and removes it.',
    '',
    `PROBE_FILE: ${probeFile}`,
    `PROBE_TOKEN: ${token}`,
    '',
    'Return ok=true only if the write succeeded. If the write is rejected (sandbox, permissions, missing directory), return ok=false with the exact error text in detail.',
  ].join('\n')
}

// The worktree is untrusted content: a branch can commit a symlink or a decoy
// file at a probe path. `fs.rm` removes the link itself (never its target),
// so clearing before writing or dispatching keeps the host from writing
// through, reading through, or trusting anything it did not create.
async function clearProbeArtifact(probeFile) {
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    await fs.lstat(probeFile)
  } catch {
    return // nothing at the path
  }
  await fs.rm(probeFile, { force: true, recursive: true })
}

async function verifyWriteProbe(probeFile, token) {
  const fs = process.getBuiltinModule('node:fs/promises')
  const { constants } = process.getBuiltinModule('node:fs')
  // Open once with O_NOFOLLOW and verify/read through the handle: the check
  // and the read then target the same inode, so a symlink (or a swap between
  // a check and a separate path-based read) can never redirect the read.
  let handle = null
  let content = null
  try {
    handle = await fs.open(probeFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (stat.isFile()) {
      content = await handle.readFile({ encoding: 'utf8' })
    }
  } catch (error) {
    // Linux reports ELOOP for O_NOFOLLOW on a symlink; FreeBSD uses EMLINK.
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      await fs.rm(probeFile, { force: true, recursive: true })
      return { ok: false, detail: 'probe path is not a regular file (symlink or special file rejected)' }
    }
    return { ok: false, detail: `probe file missing or unreadable: ${(error && error.message) || String(error)}` }
  } finally {
    if (handle) await handle.close()
  }
  await fs.rm(probeFile, { force: true, recursive: true })
  if (content === null) {
    return { ok: false, detail: 'probe path is not a regular file (symlink or special file rejected)' }
  }
  if (content.trim() === token) return { ok: true, detail: '' }
  return { ok: false, detail: `probe file content mismatch (${content.trim().slice(0, 80) || '<empty>'})` }
}

async function hostWriteProbe(worktree) {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const hostProbe = path.join(worktree, '.df12-write-probe-host')
  try {
    // Clear any committed artefact first, then create exclusively ('wx'
    // fails on any pre-existing path), so the write can never follow a
    // symlink out of the worktree.
    await clearProbeArtifact(hostProbe)
    await fs.writeFile(hostProbe, 'df12-write-probe host', { encoding: 'utf8', flag: 'wx' })
    await fs.rm(hostProbe, { force: true })
    return { ok: true, detail: '' }
  } catch (error) {
    return { ok: false, detail: (error && error.message) || String(error) }
  }
}

async function runTaskAgentWritePreflight(worktree, tag) {
  const failures = []
  const host = await hostWriteProbe(worktree)
  if (!host.ok) {
    return { ok: false, failures: [{ adapter: 'host', detail: host.detail }] }
  }
  for (const target of writeProbeTargets()) {
    const probeFile = writeProbePath(worktree, target.adapter)
    const token = writeProbeToken(tag, target.adapter)
    // Clear committed decoys before dispatch: the token is predictable, so a
    // pre-existing file (or symlink) at the probe path must never be able to
    // satisfy — or redirect — the verification that follows.
    await clearProbeArtifact(probeFile)
    let reply = null
    let agentError = ''
    try {
      reply = await agent(writeProbePrompt(probeFile, token), target.options({
        phase: 'Worktree',
        label: `write-probe:${target.adapter}`,
        schema: WRITE_PROBE_SCHEMA,
      }))
    } catch (error) {
      agentError = (error && error.message) || String(error)
    }
    const verified = await verifyWriteProbe(probeFile, token)
    if (!verified.ok) {
      const detail = [verified.detail, reply && reply.ok === false ? reply.detail : '', agentError]
        .filter(Boolean)
        .join('; ')
      failures.push({ adapter: target.adapter, detail })
    }
  }
  return { ok: failures.length === 0, failures }
}

// One probe per run: sandbox scope does not vary between sibling worktrees,
// so every task shares the first task's verdict (concurrent tasks await the
// same promise and fail fast together when the environment is broken).
let taskAgentWritePreflight = null
function ensureTaskAgentWriteAccess(worktree, tag) {
  if (!WORKTREE_WRITE_PREFLIGHT) return Promise.resolve({ ok: true, skipped: true, failures: [] })
  if (!taskAgentWritePreflight) taskAgentWritePreflight = runTaskAgentWritePreflight(worktree, tag)
  return taskAgentWritePreflight
}

// ---------------------------------------------------------------------------
// Shared pipeline stages — used by the normal task pipeline and by
// continue-mode recovery resume, so a resumed branch runs through exactly the
// same planning loop, design review, implementation contract, reviewers, and
// integration path as ordinary work. Each helper returns { fail } (an
// unassessed result object) or its stage product; callers decide whether to
// attach an assessment.
// ---------------------------------------------------------------------------
async function runPlanDesignLoop(task, worktree, opts = {}) {
  const tag = task.id
  const extra = opts.extra || {}
  let plan = null
  let designVerdict = null
  for (let round = 1; round <= MAX_DESIGN_ROUNDS; round++) {
    phase('Plan')
    plan = await planningLock(() => agent(planPrompt(task, worktree, designVerdict, round, opts), planAgentOptions({
      phase: 'Plan',
      label: `plan:${tag} r${round}`,
      schema: PLAN_SCHEMA,
    })))
    if (!plan) return { fail: { id: tag, status: 'failed', stage: 'plan', detail: 'planner returned nothing', worktree, proposals: [], ...extra } }
    if (!await fileExists(plan.execplanPath, worktree)) {
      return {
        fail: {
          id: tag,
          status: 'failed',
          stage: 'plan',
          detail: `planner returned missing ExecPlan path: ${plan.execplanPath || '<empty>'}`,
          plan,
          worktree,
          proposals: [],
          ...extra,
        },
      }
    }

    phase('Design Review')
    designVerdict = await planningLock(() => agent(designReviewPrompt(task, worktree, plan, round), reviewAgentOptions({
      phase: 'Design Review',
      label: `design-review:${tag} r${round}`,
      schema: DESIGN_VERDICT_SCHEMA,
    })))
    if (designVerdict?.satisfied) {
      log(`[task ${tag}] design approved in round ${round}`)
      return { plan }
    }
    log(`[task ${tag}] design round ${round}: ${(designVerdict?.blocking || []).length} blocking point(s)`)
  }
  return {
    fail: {
      id: tag,
      status: 'halted',
      stage: 'design-review',
      detail: `design review unsatisfied after ${MAX_DESIGN_ROUNDS} rounds: ${(designVerdict?.blocking || []).join('; ')}`,
      worktree,
      proposals: [],
      ...extra,
    },
  }
}

async function runImplementationStage(task, worktree, plan, opts = {}) {
  const tag = task.id
  const extra = opts.extra || {}
  phase('Implement')
  const impl = await buildLock(() => agent(implementPrompt(task, worktree, plan, opts), buildAgentOptions({
    phase: 'Implement',
    label: `implement:${tag}`,
    schema: IMPL_SCHEMA,
  })))
  const authDetail = implementationAuthFailureDetail(impl)
  if (authDetail) {
    return { fail: { id: tag, status: 'fatal-auth', stage: 'auth', detail: authDetail, openIssues: impl?.openIssues || [], worktree, proposals: [], ...extra } }
  }
  if (!impl || !impl.ok || !impl.gatesGreen) {
    return {
      fail: {
        id: tag,
        status: 'failed',
        stage: 'implement',
        detail: impl?.summary || 'implementation did not reach a green state',
        openIssues: impl?.openIssues || [],
        worktree,
        proposals: [],
        ...extra,
      },
    }
  }
  return { impl }
}

// ---------------------------------------------------------------------------
// Dual review + serialized integration — shared by the normal task pipeline
// and review-mode recovery resume, so a recovered branch can only land
// through exactly the same reviewers, fix rounds, merge lock, and roadmap
// update path as ordinary work.
// ---------------------------------------------------------------------------
// Bounded per-round records of what the reviewers and fix agents actually
// reported, so a failed/halted outcome carries fresh validation evidence into
// its assessment instead of leaving the assessor with only stale ExecPlan
// text and non-durable /tmp gate logs (issue #24).
function summarizeReviewVerdict(review) {
  if (!review) return null
  return {
    verdict: review.verdict || '',
    blocking: review.blocking || [],
    summary: review.summary || '',
  }
}

function summarizeFixReport(fix) {
  if (!fix) return null
  if (typeof fix === 'string') return { summary: fix }
  return {
    commits: fix.commits || [],
    gatesGreen: fix.gatesGreen === true,
    coderabbitRuns: Number(fix.coderabbitRuns) || 0,
    resolved: fix.resolved || [],
    openIssues: fix.openIssues || [],
    summary: fix.summary || '',
  }
}

async function runDualReviewAndIntegration(task, worktree, plan, impl, mergeLock, options = {}) {
  const tag = task.id
  const kindExtra = options.kind ? { kind: options.kind } : {}
  const proposals = []
  const reviewRounds = []
  let reviewsPass = false
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const [codeReview, expertReview] = await parallel([
      () => agent(codeReviewPrompt(task, worktree, plan), reviewAgentOptions({ phase: 'Code Review', label: `code-review:${tag} r${round}`, schema: REVIEW_SCHEMA })),
      () => agent(expertReviewPrompt(task, worktree, plan), reviewAgentOptions({ phase: 'Expert Review', label: `expert-review:${tag} r${round}`, schema: REVIEW_SCHEMA })),
    ])
    for (const r of [codeReview, expertReview]) {
      if (r?.proposedRoadmapItems?.length) proposals.push(...r.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })))
    }
    if (!codeReview || !expertReview) {
      const missing = [
        !codeReview ? 'code review' : null,
        !expertReview ? 'expert review' : null,
      ].filter(Boolean).join(' and ')
      reviewRounds.push({ round, codeReview: summarizeReviewVerdict(codeReview), expertReview: summarizeReviewVerdict(expertReview), blocking: [], fix: null })
      return {
        id: tag,
        status: 'failed',
        stage: 'review',
        detail: `dual review failed to return a structured verdict from ${missing}; branch left unmerged for the root agent`,
        reviewRounds,
        worktree,
        proposals,
        ...kindExtra,
      }
    }
    const blocking = [
      ...(codeReview.blocking || []),
      ...(expertReview.blocking || []),
    ]
    const roundRecord = { round, codeReview: summarizeReviewVerdict(codeReview), expertReview: summarizeReviewVerdict(expertReview), blocking, fix: null }
    reviewRounds.push(roundRecord)
    if (blocking.length === 0 && codeReview?.verdict === 'pass' && expertReview?.verdict === 'pass') {
      reviewsPass = true
      log(`[task ${tag}] dual review passed in round ${round}`)
      break
    }
    log(`[task ${tag}] review round ${round}: ${blocking.length} blocking item(s)`)
    if (round === MAX_REVIEW_ROUNDS) break
    phase('Implement')
    const fix = await buildLock(() => agent(fixPrompt(task, worktree, plan, blocking, round), buildAgentOptions({ phase: 'Implement', label: `fix:${tag} r${round}`, schema: FIX_SCHEMA })))
    roundRecord.fix = summarizeFixReport(fix)
  }

  if (!reviewsPass) {
    const lastRound = reviewRounds[reviewRounds.length - 1]
    const finalBlocking = (lastRound?.blocking || []).slice(0, 6).join('; ')
    return {
      id: tag,
      status: 'halted',
      stage: 'review',
      detail: `reviewers not satisfied within cap; branch left unmerged for the root agent${finalBlocking ? `. Final blocking items: ${finalBlocking}` : ''}`,
      reviewRounds,
      worktree,
      proposals,
      ...kindExtra,
    }
  }

  // --- Integrate (serialized behind the merge queue) ----------------------
  // Plan, design review, implement and the dual review all ran in parallel
  // with sibling tasks; only the rebase + squash-merge + push is serialized,
  // so at most one task touches origin/BASE at a time.
  let integration = null
  if (AUTO_MERGE) {
    const doIntegrate = () => {
      phase('Integrate')
      return buildLock(() => agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })))
    }
    integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
    if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
      return { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)', worktree, proposals, ...kindExtra }
    }
  } else {
    return { id: tag, status: 'manual-merge-ready', plan, impl, integration, worktree, proposals, ...kindExtra }
  }

  return { id: tag, status: 'done', plan, impl, integration, worktree, proposals, ...kindExtra }
}

// ---------------------------------------------------------------------------
// Per-task pipeline
// ---------------------------------------------------------------------------
async function runTask(task, mergeLock) {
  const tag = `${task.id}`
  log(`[task ${tag}] ${task.title}`)

  // --- Worktree -----------------------------------------------------------
  phase('Worktree')
  const wt = await createWorktree(task)
  if (!wt || !wt.ok || !wt.worktreePath) {
    return { id: tag, status: 'failed', stage: 'worktree', detail: wt?.notes || 'worktree creation failed', proposals: [] }
  }
  const worktree = wt.worktreePath
  log(`[task ${tag}] worktree ${wt.branch} @ ${worktree}`)

  try {
  // --- Task-agent writable-root gate (host-verified, once per run) ---------
  const writeAccess = await ensureTaskAgentWriteAccess(worktree, tag)
  if (!writeAccess.ok) {
    return {
      id: tag,
      status: 'failed',
      stage: 'worktree-write',
      detail: `task-agent writable-root preflight failed (launch/sandbox fault, not a task defect): ${writeAccess.failures.map((failure) => `${failure.adapter}: ${failure.detail}`).join('; ')}`,
      worktree,
      proposals: [],
    }
  }
  // --- Addendum pass: lightweight lane (no plan / design / dual review) ----
  // A completed task with open sub-tasks: implement the sub-tasks, gate, and
  // merge. No audit afterwards (the control loop skips it), which is what stops
  // remediation from spawning more remediation.
  if (task.isAddendum) {
    if (DRY_RUN) {
      return {
        id: tag,
        status: 'dry-run',
        stage: 'addendum',
        detail: 'dry run stopped before addendum implementation',
        worktree,
        proposals: [],
        kind: 'addendum',
      }
    }

    phase('Implement')
    const impl = await buildLock(() => agent(implementAddendumPrompt(task, worktree), buildAgentOptions({ phase: 'Implement', label: `addendum:${tag}`, schema: IMPL_SCHEMA })))
    const authDetail = implementationAuthFailureDetail(impl)
    if (authDetail) {
      return {
        id: tag,
        status: 'fatal-auth',
        stage: 'auth',
        detail: authDetail,
        openIssues: impl?.openIssues || [],
        worktree,
        proposals: [],
        kind: 'addendum',
      }
    }
    const openIssues = impl?.openIssues || []
    const onlyDeferredReviewIssues = hasOnlyDeferredReviewIssues(openIssues)
    if (addendumImplementationNeedsManualMerge(impl)) {
      const deferredEvidence = openIssues.length
        ? ` Outstanding deferred review evidence: ${openIssues.join('; ')}`
        : ''
      return {
        id: tag,
        status: 'manual-merge-ready',
        stage: 'addendum',
        detail:
          `addendum implementation reported completed work and green gates but did not set ok=true` +
          `${openIssues.length ? ' and left only deferred/recoverable review issues open' : ' and no open issues'}; ` +
          `branch left for operator verification before integration.${deferredEvidence}`,
        openIssues,
        impl,
        worktree,
        proposals: [],
        kind: 'addendum',
      }
    }
    if (!impl || !impl.ok || !impl.gatesGreen || (openIssues.length > 0 && !onlyDeferredReviewIssues)) {
      return await attachAssessment(task, wt, { id: tag, status: 'failed', stage: 'addendum', detail: impl?.summary || 'addendum did not reach a green state or left open issues', openIssues: impl?.openIssues || [], worktree, proposals: [], kind: 'addendum' })
    }
    const proposals = []
    let addendumReview = null
    if (onlyDeferredReviewIssues) {
      phase('Code Review')
      addendumReview = await agent(addendumReviewPrompt(task, worktree, impl), reviewAgentOptions({ phase: 'Code Review', label: `addendum-review:${tag}`, schema: REVIEW_SCHEMA }))
      if (addendumReview?.proposedRoadmapItems?.length) {
        proposals.push(...addendumReview.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })))
      }
      const blocking = addendumReview?.blocking || []
      if (!addendumReview || addendumReview.verdict !== 'pass' || blocking.length > 0) {
        return await attachAssessment(task, wt, { id: tag, status: 'halted', stage: 'addendum-review', detail: blocking.join('; ') || addendumReview?.summary || 'addendum fallback review did not pass', impl, addendumReview, worktree, proposals, kind: 'addendum' })
      }
      log(`[task ${tag}] addendum fallback review passed after deferred CodeRabbit review`)
    }
    let integration = null
    if (AUTO_MERGE) {
      const doIntegrate = () => {
        phase('Integrate')
        return buildLock(() => agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })))
      }
      integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
      if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
        return await attachAssessment(task, wt, { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)', worktree, proposals, kind: 'addendum' })
      }
    } else {
      return { id: tag, status: 'manual-merge-ready', impl, addendumReview, integration, worktree, proposals, kind: 'addendum' }
    }
    return { id: tag, status: 'done', impl, addendumReview, integration, worktree, proposals, kind: 'addendum' }
  }

  // --- Plan <-> Design review (adversarial loop) --------------------------
  const planned = await runPlanDesignLoop(task, worktree)
  if (planned.fail) return await attachAssessment(task, wt, planned.fail)
  const plan = planned.plan

  if (DRY_RUN) {
    return {
      id: tag,
      status: 'dry-run',
      stage: 'post-design',
      detail: 'dry run stopped after planning and design review',
      plan,
      worktree,
      proposals: [],
    }
  }

  // --- Implement ----------------------------------------------------------
  const built = await runImplementationStage(task, worktree, plan)
  if (built.fail) {
    return built.fail.status === 'fatal-auth' ? built.fail : await attachAssessment(task, wt, built.fail)
  }
  const impl = built.impl

  // --- Dual review + integration (shared with review-mode recovery resume) --
  const outcome = await runDualReviewAndIntegration(task, worktree, plan, impl, mergeLock)
  if (outcome.status === 'failed' || outcome.status === 'halted') {
    return await attachAssessment(task, wt, outcome)
  }
  return outcome
  } catch (error) {
    const detail = `unhandled agent error: ${(error && error.message) || String(error)}`
    const result = resultFromUnhandledAgentError(tag, detail, { worktree })
    return await attachAssessment(task, wt, result)
  }
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
  return await agent(triagePrompt(stepPrefix, proposals), triageAgentOptions({ phase: 'Remediation', label: `triage:${stepPrefix}`, schema: TRIAGE_SCHEMA }))
}

// ---------------------------------------------------------------------------
// Parallel worker pool: keep MAX_PARALLEL tasks building at once, re-selecting
// whenever any completes; serialize only integrate (merge queue), audit, and
// remediation flush in the control loop. Runs until the frontier is dry, the
// task ceiling or budget reserve is hit, or a task fails (then drain + stop).
// ---------------------------------------------------------------------------
const processed = [] // task ids pushed to BASE this run
const processedNormal = new Set()
const processedAddendum = new Set()
const manualMergeReadyNormal = new Set()
const manualMergeReadyAddendum = new Set()
const dryRunNormal = new Set()
const dryRunAddendum = new Set()
const recoveryHeldNormal = new Set() // ids with surviving branches recovery reported but did not integrate this run
const recoveryHeldAddendum = new Set()
let recovery = {
  enabled: RESUME_PARTIAL_BRANCHES,
  mode: RESUME_MODE,
  candidates: 0,
  assessed: 0,
  resumed: 0,
  skipped: [],
  results: [],
  errors: [],
}
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

function semaphore(limit) {
  const max = Math.max(1, limit)
  const queue = []
  let active = 0

  const drain = () => {
    while (active < max && queue.length) {
      const item = queue.shift()
      active += 1
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    drain()
  })
}

const planningLock = semaphore(MAX_PLANNING_PARALLEL)
const buildLock = semaphore(MAX_BUILD_PARALLEL)

let selectSeq = 0
async function doSelect(taken) {
  phase('Select')
  const label = `select#${++selectSeq}`
  const roadmap = await readRoadmapForSelection()
  if (roadmap.fallbackReason) {
    log(`[${label}] using working-tree ${ROADMAP}; origin/${BASE} read failed: ${roadmap.fallbackReason}`)
  }
  const selection = selectRoadmapTask(roadmap.text, taken)
  if (selection?.hasTask && selection.task) {
    log(`[${label}] selected ${selection.task.isAddendum ? 'addendum pass' : 'normal task'} ${selection.task.id} from ${roadmap.source}`)
  } else {
    log(`[${label}] no unblocked roadmap task found from ${roadmap.source}`)
  }
  return selection
}

function takenSnapshot() {
  return {
    normal: [...processedNormal, ...manualMergeReadyNormal, ...dryRunNormal, ...inflightNormal, ...recoveryHeldNormal],
    addendum: [...processedAddendum, ...manualMergeReadyAddendum, ...dryRunAddendum, ...inflightAddendum, ...recoveryHeldAddendum],
  }
}

function isAlreadyTaken(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal
  const manualMergeReadySet = task?.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal
  const dryRunSet = task?.isAddendum ? dryRunAddendum : dryRunNormal
  const recoveryHeldSet = task?.isAddendum ? recoveryHeldAddendum : recoveryHeldNormal
  return processedSet.has(task.id) || manualMergeReadySet.has(task.id) || dryRunSet.has(task.id) || recoveryHeldSet.has(task.id) || inflightNormal.has(task.id) || inflightAddendum.has(task.id)
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

function markManualMergeReady(task) {
  const manualMergeReadySet = task?.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal
  manualMergeReadySet.add(task.id)
}

function markDryRun(task) {
  const dryRunSet = task?.isAddendum ? dryRunAddendum : dryRunNormal
  dryRunSet.add(task.id)
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
    if (!tr?.ok || !tr.pushed) {
      log(`[step ${step}] triage did not land; keeping ${items.length} proposal(s) pending`)
      continue
    }
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
        (err) => {
          const detail = `unhandled agent error: ${(err && err.message) || String(err)}`
          return {
            id: task.id,
            task,
            result: resultFromUnhandledAgentError(task.id, detail),
          }
        },
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
const authPreflight = await runAuthPreflight()
if (authPreflight.length) {
  halted = `fatal auth preflight failed: ${authPreflight.map((failure) => `${failure.tool} (${failure.command})`).join(', ')}`
}
let stop = Boolean(halted)
let providerFaultHalt = false

// --- Fresh-run recovery: runs before normal selection so surviving branches
// are assessed (and, in review mode, resumed) ahead of new roadmap work. A
// fatal auth preflight blocks recovery entirely: no assessment, no resume.
if (RESUME_PARTIAL_BRANCHES && halted) {
  recovery.blocked = 'auth-preflight-failed'
}
if (RESUME_PARTIAL_BRANCHES && !halted) {
  try {
    const outcome = await runRecovery(process.cwd(), mergeLock)
    recovery = outcome.summary
    for (const id of outcome.held.normal) recoveryHeldNormal.add(id)
    for (const id of outcome.held.addendum) recoveryHeldAddendum.add(id)
    for (const entry of outcome.taskResults) {
      results.push(entry.result)
      if (entry.result.status === 'done' && entry.result.integration?.pushed) {
        markProcessed(entry.task)
      } else if (entry.result.status === 'manual-merge-ready') {
        markManualMergeReady(entry.task)
      } else if (['failed', 'halted'].includes(entry.result.status) && !halted) {
        // A failed recovery resume is a task failure, not a footnote: halt the
        // run (same first-failure semantics as the worker pool) so the
        // terminal state is machine-actionable instead of a clean stop that
        // is indistinguishable from a dry frontier (issue #25).
        halted = `recovery resume of task ${entry.result.id} ${entry.result.status} at ${entry.result.stage}: ${entry.result.detail}`
        stop = true
      }
    }
    if (outcome.fatal) {
      results.push(outcome.fatal)
      halted = `recovery ${outcome.fatal.status} at ${outcome.fatal.stage}: ${outcome.fatal.detail}`
      if (outcome.fatal.status === 'provider-fault') providerFaultHalt = true
      stop = true
    }
  } catch (error) {
    const detail = (error && error.message) || String(error)
    recovery.errors.push(`recovery pass failed: ${detail}`)
    log(`[recovery] failed (${detail}); continuing with normal roadmap selection`)
  }
}

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

  if (result.status === 'done' && result.integration?.pushed) {
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
  } else if (result.status === 'dry-run') {
    markDryRun(done.task)
  } else if (result.status === 'manual-merge-ready') {
    markManualMergeReady(done.task)
  } else if (result.status === 'fatal-auth') {
    halted = `task ${done.id} fatal auth failure at ${result.stage}: ${result.detail}`
    stop = true
  } else if (result.status === 'provider-fault') {
    halted = `task ${done.id} provider fault at ${result.stage}: ${result.detail}`
    providerFaultHalt = true
    stop = true
  } else if (!halted) {
    // Record the failure, stop opening new work, and let in-flight siblings
    // finish rather than abandoning their (possibly mergeable) branches.
    halted = `task ${done.id} ${result.status} at ${result.stage}: ${result.detail}`
    stop = true
  }
}

// End-of-run: the pool is drained, so every step has quiesced. Fold any
// remaining remediation into the roadmap after product failures; skip that
// write on provider faults so an outage does not look like task evidence.
if (canFlush && !providerFaultHalt) {
  try {
    await flushSettledSteps()
  } catch (err) {
    log(`[triage:end] failed (${(err && err.message) || String(err)}); ${[...pendingByStep.values()].flat().length} proposal(s) left pending`)
  }
}
// Recovery survivors the run reported but did not integrate still hold their
// roadmap ids out of selection, so the frontier stays blocked until the
// operator closes, resumes, splits, or hoovers each branch. A run that ends
// with such survivors has NOT stopped cleanly, even when the selector reports
// no unblocked tasks — surface it as an explicit operator-recovery terminal
// state instead of `halted: null` (issue #25).
const unresolvedRecovery = [
  ...[...recoveryHeldNormal]
    .filter((id) => !processedNormal.has(id) && !manualMergeReadyNormal.has(id))
    .map((id) => ({ id, isAddendum: false })),
  ...[...recoveryHeldAddendum]
    .filter((id) => !processedAddendum.has(id) && !manualMergeReadyAddendum.has(id))
    .map((id) => ({ id, isAddendum: true })),
].sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }) || Number(left.isAddendum) - Number(right.isAddendum))
recovery.unresolved = unresolvedRecovery.map((entry) => {
  const reported = (recovery.results || []).filter((result) => result.id === entry.id)
  const last = reported[reported.length - 1]
  return {
    id: entry.id,
    isAddendum: entry.isAddendum,
    branchName: last?.branchName || '',
    classification: last?.classification || '',
    action: last?.action || 'held',
    ...(last?.reason ? { reason: last.reason } : {}),
  }
})
if (!halted && unresolvedRecovery.length) {
  halted =
    `needs-operator-recovery: ${unresolvedRecovery.length} recovery survivor branch(es) still block the roadmap frontier ` +
    `(${unresolvedRecovery.map((entry) => entry.id + (entry.isAddendum ? ' (addendum)' : '')).join(', ')}); ` +
    'use recovery.results/recovery.unresolved to close, resume, split, or hoover each branch, then relaunch'
}

const pendingProposals = [...pendingByStep.values()].flat()
const assessments = results
  .filter((result) => result.assessment || result.assessmentError)
  .map((result) => ({
    id: result.id,
    stage: result.stage,
    status: result.status,
    classification: result.assessment?.classification || '',
    recommendation: result.assessment?.recommendation || '',
    assessmentError: result.assessmentError || '',
  }))

return {
  base: BASE,
  modelRouting: {
    worktree: { mode: 'deterministic-git-worktree' },
    build: { adapter: BUILD_ADAPTER, model: BUILD_MODEL },
    plan: { adapter: PLAN_ADAPTER, model: PLAN_MODEL },
    review: { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL },
    triage: { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL },
    assessment: { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL },
  },
  maxParallel: MAX_PARALLEL,
  maxPlanningParallel: MAX_PLANNING_PARALLEL,
  maxBuildParallel: MAX_BUILD_PARALLEL,
  // The exact deterministic gate set every branch agent was instructed to run
  // (issue #28): operators can audit reported gate greenness against it.
  commitGates: COMMIT_GATES,
  processed,
  results,
  assessments,
  audits,
  authPreflight,
  // Fresh-run recovery index (failure-resume design): per-task results[]
  // entries remain the primary record for review/integration outcomes.
  recovery,
  // Remediation GIST-triaged into addendum / step-task / reroute lanes when each
  // step quiesced (see remediationTriage). Anything in pendingProposals was left
  // unwritten because the run halted — triage it manually.
  remediationTriage: triages,
  pendingProposals,
  halted,
  summary:
    `Processed ${processed.length} roadmap task(s) (pool width ${MAX_PARALLEL}): ` +
    results.map((r) => `${r.id}=${r.status}`).join(', ') +
    (recovery.enabled ? ` | recovery(${recovery.mode}): ${recovery.assessed} assessed, ${recovery.resumed} resumed, ${recovery.skipped.length} skipped` : '') +
    (assessments.length ? ` | assessed ${assessments.length} failed/halted branch(es)` : '') +
    (triages.length ? ` | triaged ${triages.reduce((n, t) => n + (t.decisions ? t.decisions.length : 0), 0)} proposal(s) across ${triages.length} step(s)` : '') +
    (halted ? ` | halted: ${halted}` : ' | clean stop (no more unblocked tasks).'),
}
