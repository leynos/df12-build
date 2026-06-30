export const meta = {
  name: 'df12-build-odw',
  description:
    'ODW/Codex variant of df12-build: drive a roadmap to completion with a parallel worker pool, Codex GPT 5.5 routing, branch-local verification guidance, serialized integration, and post-merge audit.',
  whenToUse:
    'When you want to autonomously advance docs/roadmap.md across MULTIPLE independent unblocked tasks at once, each fully planned, reviewed, implemented, gated, merged, and audited. Opt-in only (heavy, many agents in parallel, performs commits/merges). Recovery model is fresh-restart against git state, not cache-resume.',
  phases: [
    { title: 'Select' },
    { title: 'Auth Preflight' },
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
const AUTH_PREFLIGHT = cfg.authPreflight !== false // false => skip local CLI auth checks before spawning agents
const REQUIRE_CODERABBIT_AUTH = cfg.requireCoderabbitAuth !== false && !DRY_RUN // CodeRabbit is required once implementation/review can run
const BUDGET_RESERVE = 80_000 // stop opening new tasks when remaining budget falls below this
const GREPAI_WORKSPACE = cfg.grepaiWorkspace || 'Projects'
const GREPAI_PROJECT = cfg.grepaiProject || cfg.project || null // canonical main-branch GrepAI project; set this when source is a worktree
const BUILD_ADAPTER = cfg.buildAdapter || 'codex-medium'
const PLAN_ADAPTER = cfg.planAdapter || 'codex-high'
const REVIEW_ADAPTER = cfg.reviewAdapter || 'codex-high'
const TRIAGE_ADAPTER = cfg.triageAdapter || 'codex-high'
const BUILD_MODEL = cfg.buildModel || 'gpt-5.5'
const PLAN_MODEL = cfg.planModel || 'gpt-5.5'
const REVIEW_MODEL = cfg.reviewModel || 'gpt-5.5'
const TRIAGE_MODEL = cfg.triageModel || PLAN_MODEL
const SPARK_DELEGATION_GUIDANCE =
  "You are free to delegate to the `wyvern` 5.3 codex spark subagent for bounded read-only tasks on known surfaces as needed. Quick surface maps, candidate-file recon, targeted consistency searches, and medium-grain 'what changed / where is the seam' checks."
const SCRUTINEER_DELEGATION_GUIDANCE =
  'Delegate deterministic gate execution and CodeRabbit invocation to the `scrutineer` sub-agent: ask it to run the repository commit gates/test suites and, only after those pass, to run `coderabbit review --agent`. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until gates and CodeRabbit are green or a documented rate-limit/deferred-review open issue remains.'

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function grepaiSearchCommand() {
  const workspaceArg = shellQuote(GREPAI_WORKSPACE)
  const projectArg = GREPAI_PROJECT ? shellQuote(GREPAI_PROJECT) : '$(get-project)'
  return `grepai search --workspace ${workspaceArg} --project ${projectArg} "<English intent query>" --toon --compact`
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
    /Run `?coderabbit auth login`?/i,
    /Run codex login/i,
  ]
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : ''
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
    log(`[auth] preflight passed${REQUIRE_CODERABBIT_AUTH ? ' for Codex and CodeRabbit' : ' for Codex'}`)
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

async function readRoadmapForSelection() {
  const canonicalRef = `origin/${BASE}:${ROADMAP}`
  try {
    return {
      text: await execFileText('git', ['show', canonicalRef]),
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
    SPARK_DELEGATION_GUIDANCE,
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
    SPARK_DELEGATION_GUIDANCE,
    '',
    SCRUTINEER_DELEGATION_GUIDANCE,
    '',
    'For EACH execplan work item, in this exact order:',
    '  1. Implement the work item (code + tests + docs) per the plan and AGENTS.md.',
    '  2. DETERMINISTIC GATE FIRST: summon `scrutineer` to run `make all`. If it reports failures, fix them yourself (format, lint, typecheck, tests, audit) and summon `scrutineer` again until green. For any markdown you touched, also have `scrutineer` run `make markdownlint` and `make nixie` and fix failures. Do not proceed to coderabbit until the deterministic gates are green.',
    '  3. THEN summon `scrutineer` to run `coderabbit review --agent` from inside the worktree. Address actionable feedback yourself (highest severity first). After applying fixes, summon `scrutineer` again to re-run `make all` and confirm the deterministic gates are still green.',
    '     - If coderabbit reports a rate limit, READ the quoted wait time from its response (it usually states one, e.g. "waitTime ~16 min" or "retry after N"). Do NOT retry before that window elapses — earlier retries are guaranteed to fail and only burn the turn. Wait the quoted duration plus a small margin (via sleep), then retry ONCE. If no time is quoted, fall back to exponential backoff (30s, 60s, 120s, 240s, 480s, cap ~900s). If the quoted wait would not fit your remaining turn budget, do NOT sit in a doomed wait: the deterministic gates already passed, so record the deferred coderabbit review in the execplan and openIssues for a later run to complete before committing.',
    '  4. Update the execplan IN PLACE with findings, progress (tick the work item), and any decisions or deviations, with rationale.',
    '  5. Commit the work item and the execplan update together as one atomic commit (en-GB imperative subject ~50 cols, wrapped body explaining what and why).',
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
    SPARK_DELEGATION_GUIDANCE,
    '',
    SCRUTINEER_DELEGATION_GUIDANCE,
    '',
    'The dual review returned the following BLOCKING items. Resolve every one:',
    ...blocking.map((b, i) => `  ${i + 1}. ${b}`),
    '',
    'Same per-change discipline as implementation: summon `scrutineer` for the deterministic gate (`make all`, plus markdownlint/nixie for markdown) first and green, THEN summon `scrutineer` for `coderabbit review --agent` (on a rate limit, wait the quoted wait time before retrying — never retry before that window elapses — and if the quoted wait exceeds your turn, commit and record the deferred review), then an atomic commit, then update the execplan with what changed and why. Do not introduce scope beyond the blocking items.',
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
    '  2. DETERMINISTIC GATE: summon `scrutineer` to run `make all`. For any Markdown you touched, also have it run `make markdownlint` and `make nixie`. Fix until green.',
    '  3. Summon `scrutineer` to run `coderabbit review --agent` from inside the worktree; address actionable feedback yourself (highest severity first); summon `scrutineer` again to re-run `make all` and confirm green. On a coderabbit rate limit, read the QUOTED wait time from its response and wait at least that long before retrying (do NOT retry before that window elapses — it cannot succeed); if no time is quoted use exponential backoff (30s, 60s, 120s, 240s, 480s, cap ~900s); if the wait exceeds your turn, record the deferred review in openIssues before committing the gated work.',
    `  4. Tick the sub-task in the Addenda checklist of its execplan (\`- [ ] ${task.id}.<n>\` → \`- [x] …\`).`,
    '  5. Commit the sub-task and Addenda tick together as one atomic commit (en-GB imperative subject).',
    '',
    'Use leta for navigation, sem for history, and the language router skill for the languages you touch. Do NOT edit the roadmap — integration ticks the roadmap sub-tasks. When all listed sub-tasks are done, ensure `make all` is green at HEAD. Return using the IMPL schema (execplanPath = the parent execplan): completion counts, commit subjects, gatesGreen, coderabbit run count, and any open issues.',
  ].join('\n')
}

function isDeferredReviewIssue(issue) {
  const text = String(issue || '').toLowerCase()
  const deferredReviewMarkers = [
    'rate limit',
    'retry after',
    'waittime',
    'wait time',
    'deferred review',
    'deferred coderabbit review',
    'coderabbit review deferred',
    'unavailable',
    'authentication failed',
    'auth failed',
    'browser login required',
    'token missing',
    'token expired',
  ]
  return text.includes('coderabbit') && deferredReviewMarkers.some((marker) => text.includes(marker))
}

function hasOnlyDeferredReviewIssues(openIssues) {
  const issues = openIssues || []
  return issues.length > 0 && issues.every(isDeferredReviewIssue)
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
  const wt = await createWorktree(task)
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
    const impl = await agent(implementAddendumPrompt(task, worktree), buildAgentOptions({ phase: 'Implement', label: `addendum:${tag}`, schema: IMPL_SCHEMA }))
    const openIssues = impl?.openIssues || []
    const onlyDeferredReviewIssues = hasOnlyDeferredReviewIssues(openIssues)
    if (!impl || !impl.ok || !impl.gatesGreen || (openIssues.length > 0 && !onlyDeferredReviewIssues)) {
      return { id: tag, status: 'failed', stage: 'addendum', detail: impl?.summary || 'addendum did not reach a green state or left open issues', openIssues: impl?.openIssues || [], worktree, proposals: [], kind: 'addendum' }
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
        return { id: tag, status: 'halted', stage: 'addendum-review', detail: blocking.join('; ') || addendumReview?.summary || 'addendum fallback review did not pass', impl, addendumReview, worktree, proposals, kind: 'addendum' }
      }
      log(`[task ${tag}] addendum fallback review passed after deferred CodeRabbit review`)
    }
    let integration = null
    if (AUTO_MERGE) {
      const doIntegrate = () => {
        phase('Integrate')
        return agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA }))
      }
      integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
      if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
        return { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)', worktree, proposals, kind: 'addendum' }
      }
    } else {
      return { id: tag, status: 'manual-merge-ready', impl, addendumReview, integration, worktree, proposals, kind: 'addendum' }
    }
    return { id: tag, status: 'done', impl, addendumReview, integration, worktree, proposals, kind: 'addendum' }
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
    if (!codeReview || !expertReview) {
      const missing = [
        !codeReview ? 'code review' : null,
        !expertReview ? 'expert review' : null,
      ].filter(Boolean).join(' and ')
      return {
        id: tag,
        status: 'failed',
        stage: 'review',
        detail: `dual review failed to return a structured verdict from ${missing}; branch left unmerged for the root agent`,
        worktree,
        proposals,
      }
    }
    const blocking = [
      ...(codeReview.blocking || []),
      ...(expertReview.blocking || []),
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
  } else {
    return { id: tag, status: 'manual-merge-ready', plan, impl, integration, worktree, proposals }
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
    normal: [...processedNormal, ...manualMergeReadyNormal, ...dryRunNormal, ...inflightNormal],
    addendum: [...processedAddendum, ...manualMergeReadyAddendum, ...dryRunAddendum, ...inflightAddendum],
  }
}

function isAlreadyTaken(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal
  const manualMergeReadySet = task?.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal
  const dryRunSet = task?.isAddendum ? dryRunAddendum : dryRunNormal
  return processedSet.has(task.id) || manualMergeReadySet.has(task.id) || dryRunSet.has(task.id) || inflightNormal.has(task.id) || inflightAddendum.has(task.id)
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
          const authDetail = authFailureDetail(detail)
          return {
            id: task.id,
            task,
            result: {
              id: task.id,
              status: authDetail ? 'fatal-auth' : 'failed',
              stage: authDetail ? 'auth' : 'error',
              detail,
              proposals: [],
            },
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
    worktree: { mode: 'deterministic-git-worktree' },
    build: { adapter: BUILD_ADAPTER, model: BUILD_MODEL },
    plan: { adapter: PLAN_ADAPTER, model: PLAN_MODEL },
    review: { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL },
    triage: { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL },
  },
  maxParallel: MAX_PARALLEL,
  processed,
  results,
  audits,
  authPreflight,
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
