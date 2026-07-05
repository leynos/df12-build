import {
  branchToRoadmapId,
  parseWorktreeList,
  parseExecplanState,
  recoveryDecision,
  recoveryContinueDecision,
} from './recovery-decision.ts'
import {
  ASSESSMENT_CLASSIFICATIONS,
  ASSESSMENT_SCHEMA,
  AUDIT_SCHEMA,
  DESIGN_VERDICT_SCHEMA,
  FIX_SCHEMA,
  IMPL_SCHEMA,
  INTEGRATE_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
} from './schemas.ts'
import {
  candidateRoadmapComplete,
  isComplete,
  isTaskFullyComplete,
  parseRoadmap,
  roadmapTaskIndex,
  selectRoadmapTask,
} from './roadmap.ts'
import { execFileStatus, execFileText, fileState, shellQuote } from './exec.ts'
import {
  authFailureDetail,
  faultMetrics,
  infrastructureFailureDetail,
  makeWithInfraRetry,
  providerFailureDetail,
  resultFromUnhandledAgentError,
} from './faults.ts'
import { collectAssessmentEvidence } from './git-evidence.ts'
import {
  RECOVERY_HOLD_REASONS,
  makeRecoveryDiscovery,
  readExecplanState,
  recoveryExecplanPath,
  syntheticRecoveryImpl,
} from './recovery-discovery.ts'
import { makeConfig } from './config.ts'
import { makePrompts } from './prompts.ts'
import { makeWritePreflight } from './write-preflight.ts'
import {
  addendumImplementationNeedsManualMerge,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
  isDeferredReviewIssue,
  makeAssessment,
} from './assessment.ts'
import { TRIAGE_SCHEMA, makeRemediation, stepOf } from './remediation.ts'
import {
  commitExecplanApproval,
  commitExecplanDraft,
  execplanRelPath,
  verifyExecplanCommitted,
  verifyWorktreeCommitted,
} from './execplan-durability.ts'

// ---------------------------------------------------------------------------
// Configuration (all overridable through the ODW `args` object).
// ---------------------------------------------------------------------------
const CONFIG = makeConfig(args)
const {
  PROJECT_ROOT,
  BASE,
  ROADMAP,
  ONLY_TASK,
  MAX_TASKS,
  MAX_PARALLEL,
  MAX_PLANNING_PARALLEL,
  MAX_BUILD_PARALLEL,
  MAX_DESIGN_ROUNDS,
  MAX_REVIEW_ROUNDS,
  STAGE_ATTEMPTS,
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
  BUDGET_RESERVE,
  BUILD_ADAPTER,
  PLAN_ADAPTER,
  REVIEW_ADAPTER,
  TRIAGE_ADAPTER,
  ASSESSMENT_ADAPTER,
  BUILD_MODEL,
  PLAN_MODEL,
  REVIEW_MODEL,
  TRIAGE_MODEL,
  ASSESSMENT_MODEL,
  AUTH_REQUIRED_ADAPTERS,
  CODERABBIT_REVIEW_COMMAND,
  COMMIT_GATES,
  COMMIT_GATE_TEXT,
} = CONFIG
if (PROJECT_ROOT !== process.cwd()) {
  const fs = process.getBuiltinModule('node:fs')
  if (!fs.statSync(PROJECT_ROOT).isDirectory()) {
    throw new Error(`Configured projectRoot is not a directory: ${PROJECT_ROOT}`)
  }
  process.chdir(PROJECT_ROOT)
}

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

// Stage-agent retry with the run's attempt budget bound once (see faults.ts).
const withInfraRetry = makeWithInfraRetry(STAGE_ATTEMPTS)

// Recovery discovery with the run's limits bound once (see recovery-discovery.ts).
const discoverRecoveryCandidates = makeRecoveryDiscovery({
  base: BASE,
  resumeTaskId: RESUME_TASK_ID,
  resumeMaxCandidates: RESUME_MAX_CANDIDATES,
})

// Prompt builders with the run configuration bound once (see prompts.ts).
const {
  preamble,
  codeSearchGuidance,
  planPrompt,
  designReviewPrompt,
  implementPrompt,
  fixPrompt,
  codeReviewPrompt,
  expertReviewPrompt,
  addendumReviewPrompt,
  implementAddendumPrompt,
  integratePrompt,
  auditPrompt,
} = makePrompts(CONFIG)

// Host-verified write preflight with the run's probe targets bound once
// (see write-preflight.ts). writeProbeTargets stays here: it routes the
// planner and builder adapters from run configuration.
const { runTaskAgentWritePreflight, ensureTaskAgentWriteAccess } = makeWritePreflight({
  enabled: WORKTREE_WRITE_PREFLIGHT,
  targets: writeProbeTargets,
})

// ADR 002 assessment and remediation triage with the run wiring bound once
// (see assessment.ts and remediation.ts).
const {
  assessmentPrompt,
  recoveryAssessmentPrompt,
  assessRecoveryCandidate,
  shouldAssessFailure,
  attachAssessment,
} = makeAssessment({
  preamble,
  assessPartialBranches: ASSESS_PARTIAL_BRANCHES,
  assessmentAgentOptions,
  withInfraRetry,
})
const { triagePrompt, runTriage } = makeRemediation({
  preamble,
  base: BASE,
  roadmap: ROADMAP,
  triageAgentOptions,
})

// ---------------------------------------------------------------------------
// Deterministic roadmap selection
// ---------------------------------------------------------------------------
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
      const resolved = await recoveryExecplanPath(candidate)
      enriched = { ...candidate, execplanPath: resolved.execplanPath }
      // A plan the host cannot stat or read is a fault, never 'missing':
      // treating it as missing would dispatch a fresh planner over durable
      // work. Fold the stat fault into planState so the decision reports it.
      planState = resolved.error
        ? { status: 'unreadable', ticked: 0, unticked: 0, error: resolved.error }
        : await readExecplanState(enriched)
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
      // A stat FAULT is neither present nor absent — report it distinctly
      // rather than resuming or classifying on unverifiable evidence.
      const resolved = await recoveryExecplanPath(candidate)
      enriched = { ...candidate, execplanPath: resolved.execplanPath }
      decision = resolved.error
        ? { classification: '', action: 'report', stage: null, reason: 'execplan-stat-error', skip: true }
        : { stage: 'review', ...recoveryDecision(enriched, evidence, assessment, RESUME_MODE, { dryRun: DRY_RUN }) }
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
    if (outcome.status === 'fatal-auth' || outcome.status === 'provider-fault' || outcome.status === 'infra-fault') {
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
    plan = await planningLock(() => withInfraRetry(() => agent(planPrompt(task, worktree, designVerdict, round, opts), planAgentOptions({
      phase: 'Plan',
      label: `plan:${tag} r${round}`,
      schema: PLAN_SCHEMA,
    })), `plan:${tag} r${round}`))
    if (!plan) return { fail: { id: tag, status: 'failed', stage: 'plan', detail: 'planner returned nothing', worktree, proposals: [], ...extra } }
    // Containment before any filesystem access: the planner's path is
    // untrusted data, and an escape fails the task closed.
    const contained = execplanRelPath(worktree, plan.execplanPath)
    if (!contained.ok) {
      return { fail: { id: tag, status: 'failed', stage: 'plan', detail: `planner returned an unusable ExecPlan path: ${contained.detail}`, plan, worktree, proposals: [], ...extra } }
    }
    const planFile = await fileState(contained.relPath, worktree)
    if (!planFile.ok) {
      return { fail: { id: tag, status: 'failed', stage: 'plan', detail: `could not verify the ExecPlan path: ${planFile.detail}`, plan, worktree, proposals: [], ...extra } }
    }
    if (!planFile.exists) {
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
    // Host-verified durability gate. Deterministic salvage first: when the
    // plan file is the only uncommitted path, the host commits it rather
    // than spending a 30–90 minute planner round on git bookkeeping. Only a
    // declined or failed salvage bounces to the planner as a blocking item,
    // carrying the salvage evidence (foreign dirty paths, or the git error
    // when the environment itself blocks committing).
    let durability = await verifyExecplanCommitted(worktree, plan.execplanPath)
    let salvageNote = ''
    if (!durability.ok) {
      const salvage = await commitExecplanDraft(worktree, contained.relPath, tag)
      if (salvage.ok) {
        log(`[task ${tag}] plan round ${round}: ${durability.detail}; host committed the drafted plan`)
        durability = await verifyExecplanCommitted(worktree, plan.execplanPath)
      } else {
        salvageNote = ` (host salvage declined: ${salvage.detail})`
      }
    }
    if (!durability.ok) {
      log(`[task ${tag}] plan round ${round}: ExecPlan not durable (${durability.detail})${salvageNote}`)
      designVerdict = {
        satisfied: false,
        blocking: [
          `EXECPLAN DURABILITY: ${durability.detail}${salvageNote}. The committed ExecPlan is the durable source of truth — COMMIT the plan (and every file you changed) on the task branch with an en-GB imperative subject, then return the same plan.`,
        ],
      }
      continue
    }

    phase('Design Review')
    designVerdict = await planningLock(() => withInfraRetry(() => agent(designReviewPrompt(task, worktree, plan, round), reviewAgentOptions({
      phase: 'Design Review',
      label: `design-review:${tag} r${round}`,
      schema: DESIGN_VERDICT_SCHEMA,
    })), `design-review:${tag} r${round}`))
    if (designVerdict?.satisfied) {
      log(`[task ${tag}] design approved in round ${round}`)
      // Deterministic bookkeeping owned by the control loop: record the
      // committed APPROVED transition the moment the reviewer is satisfied.
      const approved = await commitExecplanApproval(worktree, plan.execplanPath, tag)
      if (!approved.ok) {
        return {
          fail: {
            id: tag,
            status: 'failed',
            stage: 'design-review',
            detail: `failed to record the committed ExecPlan approval: ${approved.detail}`,
            plan,
            worktree,
            proposals: [],
            ...extra,
          },
        }
      }
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
  const impl = await buildLock(() => withInfraRetry(() => agent(implementPrompt(task, worktree, plan, opts), buildAgentOptions({
    phase: 'Implement',
    label: `implement:${tag}`,
    schema: IMPL_SCHEMA,
  })), `implement:${tag}`))
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
  // Host-verified durability gate: ok=true with a dirty worktree is a
  // contract violation — uncommitted work is unreviewable and would be lost
  // at the squash merge, so fail fast with the exact paths.
  const committed = await verifyWorktreeCommitted(worktree)
  if (!committed.ok) {
    return {
      fail: {
        id: tag,
        status: 'failed',
        stage: 'implement',
        detail: `implementation returned ok but left uncommitted state in the worktree (${committed.detail}); every work item must be committed before returning`,
        openIssues: impl?.openIssues || [],
        worktree,
        proposals: [],
        ...extra,
      },
    }
  }
  // Stale plan status costs a resumed run one redundant stage, never
  // correctness — log it rather than failing a green implementation.
  if (plan?.execplanPath) {
    const contained = execplanRelPath(worktree, plan.execplanPath)
    if (!contained.ok) {
      log(`[task ${tag}] skipping the post-implementation plan-status check: ${contained.detail}`)
    } else {
      const planState = await readExecplanState({ worktreePath: worktree, execplanPath: contained.relPath })
      if (planState.status !== 'complete') {
        log(`[task ${tag}] implementation returned ok but the committed ExecPlan status is '${planState.status}' (expected COMPLETE)${planState.error ? `: ${planState.error}` : ''}`)
      }
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
    // parallel() resolves a thrown thunk to null, which would make an adapter
    // timeout indistinguishable from a reviewer that returned nothing — so
    // each reviewer retries infra faults and records any residual one here.
    const reviewInfraFaults = []
    const runReviewAgent = (promptText, reviewPhase, label) => () =>
      withInfraRetry(() => agent(promptText, reviewAgentOptions({ phase: reviewPhase, label, schema: REVIEW_SCHEMA })), label)
        .catch((error) => {
          const message = (error && error.message) || String(error)
          if (!infrastructureFailureDetail(message)) throw error
          reviewInfraFaults.push(`${label}: ${message}`)
          return null
        })
    const [codeReview, expertReview] = await parallel([
      runReviewAgent(codeReviewPrompt(task, worktree, plan), 'Code Review', `code-review:${tag} r${round}`),
      runReviewAgent(expertReviewPrompt(task, worktree, plan), 'Expert Review', `expert-review:${tag} r${round}`),
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
      if (reviewInfraFaults.length) {
        faultMetrics.infraFaults += 1
        return {
          id: tag,
          status: 'infra-fault',
          stage: 'review',
          detail: `dual review interrupted by infrastructure fault(s): ${reviewInfraFaults.join('; ')}; the branch is untouched — relaunch with resumeMode: "continue" to re-run review from the committed state`,
          reviewRounds,
          worktree,
          proposals,
          ...kindExtra,
        }
      }
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
    const fix = await buildLock(() => withInfraRetry(() => agent(fixPrompt(task, worktree, plan, blocking, round), buildAgentOptions({ phase: 'Implement', label: `fix:${tag} r${round}`, schema: FIX_SCHEMA })), `fix:${tag} r${round}`))
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
      // Deliberately NOT wrapped in withInfraRetry: integration pushes to
      // origin/BASE, so a hidden-success first attempt re-run after an
      // adapter death could squash and push the same task twice. A fault
      // here is terminal and hands verification to the operator.
      return buildLock(() => agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })))
    }
    try {
      integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
    } catch (error) {
      const message = (error && error.message) || String(error)
      if (!infrastructureFailureDetail(message)) throw error
      faultMetrics.infraFaults += 1
      return {
        id: tag,
        status: 'infra-fault',
        stage: 'integrate',
        detail: `integration agent died on an infrastructure fault (${message}); integration is never retried because the push to origin/${BASE} is not idempotent — inspect origin/${BASE} and the roadmap for a partial or hidden-success integration before relaunching with resumeMode: "continue"`,
        worktree,
        proposals,
        ...kindExtra,
      }
    }
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
    const impl = await buildLock(() => withInfraRetry(() => agent(implementAddendumPrompt(task, worktree), buildAgentOptions({ phase: 'Implement', label: `addendum:${tag}`, schema: IMPL_SCHEMA })), `addendum:${tag}`))
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
      addendumReview = await withInfraRetry(() => agent(addendumReviewPrompt(task, worktree, impl), reviewAgentOptions({ phase: 'Code Review', label: `addendum-review:${tag}`, schema: REVIEW_SCHEMA })), `addendum-review:${tag}`)
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
        // Deliberately NOT wrapped in withInfraRetry: the push to origin/BASE
        // is not idempotent (see the normal-pipeline integrate above).
        return buildLock(() => agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })))
      }
      try {
        integration = mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()
      } catch (error) {
        const message = (error && error.message) || String(error)
        if (!infrastructureFailureDetail(message)) throw error
        faultMetrics.infraFaults += 1
        return {
          id: tag,
          status: 'infra-fault',
          stage: 'integrate',
          detail: `integration agent died on an infrastructure fault (${message}); integration is never retried because the push to origin/${BASE} is not idempotent — inspect origin/${BASE} and the roadmap for a partial or hidden-success integration before relaunching with resumeMode: "continue"`,
          worktree,
          proposals,
          kind: 'addendum',
        }
      }
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
  const selection = selectRoadmapTask(roadmap.text, taken, ONLY_TASK)
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
async function workflowMain() {
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
      if (outcome.fatal.status === 'provider-fault' || outcome.fatal.status === 'infra-fault') providerFaultHalt = true
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
  } else if (result.status === 'infra-fault') {
    // The agent process died (hung stream, killed CLI, reply-channel failure)
    // after in-run retries — no evidence about the branch, so no assessment
    // and no roadmap triage writes. The committed ExecPlan makes the branch
    // resumable: relaunch with resumeMode "continue" to pick up where it died.
    halted = `task ${done.id} infrastructure fault at ${result.stage}: ${result.detail}; branch state is durable — relaunch with resumeMode: "continue" to resume from the committed ExecPlan`
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
  stageAttempts: STAGE_ATTEMPTS,
  // Bounded-cardinality fault metrics (fixed keys): stage retries spent on
  // infrastructure faults plus terminal fault counts per class, so operators
  // can read retry pressure straight from the result instead of the logs.
  faultMetrics: { ...faultMetrics },
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
}
