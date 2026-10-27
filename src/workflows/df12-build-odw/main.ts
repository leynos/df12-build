/**
 * df12-build-odw entry: the ODW workflow's worker-pool control loop and
 * fresh-run recovery entrypoint. This module unpacks the run configuration
 * (config.ts) once, binds each subsystem factory with that configuration
 * (prompts, write preflight, assessment, remediation, host review, and the
 * per-task pipeline in run-task.ts), and owns the run-scoped state the
 * factories must share: the merge queue and stage semaphores, the worker
 * pool, recovery orchestration over the recovery-decision/-discovery
 * helpers, per-step remediation flushing, and the terminal run summary.
 * The build (scripts/build-workflow.mjs) bundles this file and its imports
 * flat and wraps the whole body for the ODW loader; workflowMain() below is
 * invoked by the generated footer.
 *
 * @module
 */
import {
  branchToRoadmapId,
  parseWorktreeList,
  parseExecplanState,
  recoveryDecision,
  recoveryContinueDecision,
  advisoryResidualRisk,
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
  roadmapIdSlug,
  roadmapTaskIndex,
  selectRoadmapTask,
} from './roadmap.ts'
import { execFileStatus, execFileText, fileState, shellQuote } from './exec.ts'
import {
  authFailureDetail,
  createFaultMetrics,
  infrastructureFailureDetail,
  makeWithInfraRetry,
  providerFailureDetail,
  resultFromUnhandledAgentError,
  faultThrownMessage,
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
import { makeAuthPreflight } from './auth-preflight.ts'
import { makePrompts, worktreeSafetyNet } from './prompts.ts'
import { makeWritePreflight, type WriteProbeTarget } from './write-preflight.ts'
import {
  addendumImplementationNeedsManualMerge,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
  isDeferredReviewIssue,
  makeAssessment,
  summarizeSalvages,
} from './assessment.ts'
import { TRIAGE_SCHEMA, makeRemediation, stepOf } from './remediation.ts'
import {
  reviewBlockingItems,
  classifyCoderabbitOutcome,
  makeHostReview,
  parseCoderabbitAgentOutput,
} from './host-review.ts'
import { makeTaskPipeline, summarizeFixReport, summarizeReviewVerdict } from './run-task.ts'
import { DAKAR_COMMAND_VALIDATION_ERROR, dakarInvocationFromCommand, redactedShellCommand } from './shell-command.ts'
import type { AssessmentEvidence } from './git-evidence.ts'
import type { ExecplanState, RecoveryAssessmentFields } from './recovery-decision.ts'
import type { SelectionResult } from './roadmap.ts'
import type { StagePlan } from './run-task.ts'
import type { RecoveryCandidate, SelectedTask } from './types.ts'
import { checkedTaskOutcome, type TaskOutcome } from './task-outcome.ts'

type AnyRecord = Record<string, unknown>
type MergeLockFn = (<T>(fn: () => Promise<T>) => Promise<T>) | null

interface RecoveryRunSummary {
  enabled: boolean
  mode: string
  candidates: number
  assessed: number
  resumed: number
  skipped: Array<{ id: string; branchName?: string; reason: string }>
  results: AnyRecord[]
  errors: string[]
  blocked?: string
  unresolved?: AnyRecord[]
}
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
  BUILD_ADAPTER,
  PLAN_ADAPTER,
  REVIEW_ADAPTER,
  AUDIT_ADAPTER,
  TRIAGE_ADAPTER,
  ASSESSMENT_ADAPTER,
  BUILD_MODEL,
  PLAN_MODEL,
  REVIEW_MODEL,
  AUDIT_MODEL,
  AUDIT_EFFORT,
  TRIAGE_MODEL,
  TRIAGE_EFFORT,
  TRIAGE_ESCALATION_MODEL,
  ASSESSMENT_MODEL,
  ASSESSMENT_ESCALATION_MODEL,
  AUTH_REQUIRED_ADAPTERS,
  REVIEW_TOOL,
  DAKAR_COMMAND,
  REVIEW_TIMEOUT_SECONDS,
  DAKAR_BUDGET_GBP,
  CODERABBIT_REVIEW_COMMAND,
  CODERABBIT_HOST_REVIEW,
  HOST_REVIEW_BETWEEN_WORK_ITEMS,
  HOST_REVIEW_ATTEMPTS,
  HOST_REVIEW_BACKOFF_MINUTES,
  HOST_REVIEW_FINDINGS_FILE,
  HOST_COMMIT_GATES,
  HOST_GATES_BETWEEN_WORK_ITEMS,
  CS_CHECK,
  CS_CHECK_COMMAND,
  COMMIT_GATE_TIMEOUT_SECONDS,
  COMMIT_GATES,
  COMMIT_GATE_TEXT,
  COMMIT_GATE_GUIDANCE,
  CS_CHECK_GUIDANCE,
} = CONFIG
if (PROJECT_ROOT !== process.cwd()) {
  const fs = process.getBuiltinModule('node:fs')
  // stat first so a missing path fails with a configuration error rather
  // than a raw ENOENT from statSync.
  let projectRootStat
  try {
    projectRootStat = fs.statSync(PROJECT_ROOT)
  } catch (error) {
    throw new Error(`Configured projectRoot is not accessible: ${PROJECT_ROOT} (${faultThrownMessage(error)})`)
  }
  if (!projectRootStat.isDirectory()) {
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

function auditAgentOptions(options = {}) {
  return { adapter: AUDIT_ADAPTER, model: AUDIT_MODEL, effort: AUDIT_EFFORT, ...options }
}

function triageAgentOptions(options = {}) {
  return { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL, effort: TRIAGE_EFFORT, ...options }
}

function assessmentAgentOptions(options = {}) {
  return { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL, ...options }
}

function modelRouting() {
  return {
    worktree: { mode: 'deterministic-git-worktree' },
    build: { adapter: BUILD_ADAPTER, model: BUILD_MODEL },
    plan: { adapter: PLAN_ADAPTER, model: PLAN_MODEL },
    review: { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL },
    audit: { adapter: AUDIT_ADAPTER, model: AUDIT_MODEL, effort: AUDIT_EFFORT },
    triage: { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL, effort: TRIAGE_EFFORT },
    assessment: { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL },
  }
}

// Stage-agent retry with the run's attempt budget bound once (see faults.ts).
const runFaultMetrics = createFaultMetrics()
const withInfraRetry = makeWithInfraRetry(STAGE_ATTEMPTS, runFaultMetrics)

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
  implementWorkItemPrompt,
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
  assessmentEscalationModel: ASSESSMENT_ESCALATION_MODEL,
  withInfraRetry,
})
const { triagePrompt, runTriage } = makeRemediation({
  preamble,
  worktreeSafetyNet,
  base: BASE,
  roadmap: ROADMAP,
  triageAgentOptions,
  triageEscalationModel: TRIAGE_ESCALATION_MODEL,
})

// Host review and host commit gates with the run wiring bound
// once (see host-review.ts).
const HOST_REVIEW_ENABLED = CODERABBIT_HOST_REVIEW
// Parse the operator-configured command once so preflight probes and review
// execution preserve the same quoted fixed arguments.
const DAKAR_INVOCATION = dakarInvocationFromCommand(DAKAR_COMMAND)
if (!DAKAR_INVOCATION) throw new Error(DAKAR_COMMAND_VALIDATION_ERROR)
const DAKAR_SENSITIVE_VALUES = [process.env.OPENAI_API_KEY || '']
const hostReview = makeHostReview({
  base: BASE,
  reviewTool: REVIEW_TOOL,
  dakarCommand: DAKAR_COMMAND,
  dakarInvocation: DAKAR_INVOCATION,
  dakarSensitiveValues: DAKAR_SENSITIVE_VALUES,
  reviewTimeoutSeconds: REVIEW_TIMEOUT_SECONDS,
  dakarBudgetGbp: DAKAR_BUDGET_GBP,
  reviewAttempts: HOST_REVIEW_ATTEMPTS,
  reviewBackoffMinutes: HOST_REVIEW_BACKOFF_MINUTES,
  reviewFindingsFile: HOST_REVIEW_FINDINGS_FILE,
  commitGates: COMMIT_GATES,
  commitGateTimeoutSeconds: COMMIT_GATE_TIMEOUT_SECONDS,
  csCheck: CS_CHECK,
  csCheckCommand: CS_CHECK_COMMAND,
  // This deterministic identifier lets every host boundary correlate one
  // workflow run without turning task labels into metric dimensions.
  traceContext: { runId: `df12-build-odw:${BASE}:${ROADMAP}` },
})

const {
  reviewBackoffMinutes,
  runHostReview,
  recordHostReview,
  runHostCommitGates,
  runCodeSceneCheck,
  disposeHostGateLogs,
  metrics: getHostReviewMetrics,
  recordHostReviewAuthFailure,
} = hostReview
const runAuthPreflight = makeAuthPreflight(
  {
    enabled: AUTH_PREFLIGHT,
    requireHostReviewAuth: REQUIRE_CODERABBIT_AUTH,
    requiredAdapters: AUTH_REQUIRED_ADAPTERS,
    reviewTool: REVIEW_TOOL,
    dakarInvocation: DAKAR_INVOCATION,
  },
  {
    exec: execFileStatus,
    environment: { get: (name) => process.env[name] },
    phase,
    log,
    recordHostReviewAuthFailure,
  },
)

// ---------------------------------------------------------------------------
// Deterministic roadmap selection
// ---------------------------------------------------------------------------

function slugForTask(task: SelectedTask): string {
  return `roadmap-${roadmapIdSlug(task.id)}${task.isAddendum ? '-addendum' : ''}`
}

function worktreeParentPath() {
  const path = process.getBuiltinModule('node:path')
  const cwd = process.cwd()
  return path.join(path.dirname(cwd), `${path.basename(cwd)}.worktrees`)
}

async function createWorktree(task: SelectedTask) {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const branch = slugForTask(task)
  const worktreePath = path.join(worktreeParentPath(), branch)
  const setupCommand = `git worktree add -b ${branch} ${worktreePath} origin/${BASE}`

  try {
    await execFileText('git', ['fetch', 'origin', BASE])
    const baseShaOutput = await execFileText('git', ['rev-parse', `origin/${BASE}`])
    const baseSha = baseShaOutput.trim()
    await fs.mkdir(path.dirname(worktreePath), { recursive: true })
    await execFileText('git', ['worktree', 'add', '-b', branch, worktreePath, `origin/${BASE}`])
    const worktreeShaOutput = await execFileText('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
    const worktreeSha = worktreeShaOutput.trim()
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
    // SAFETY: These host operations fail with Node errors; execFileText
    // attaches captured text streams to child-process errors.
    const failure = error as (Error & { stderr?: string; stdout?: string }) | null
    const details = [
      (failure && failure.message) || String(error),
      failure?.stderr ? `stderr: ${failure.stderr.trim()}` : '',
      failure?.stdout ? `stdout: ${failure.stdout.trim()}` : '',
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

async function readRoadmapForSelection(root: string = process.cwd()) {
  const canonicalRef = `origin/${BASE}:${ROADMAP}`
  try {
    return {
      text: await execFileText('git', ['-C', root, 'show', canonicalRef]),
      source: canonicalRef,
      fallbackReason: '',
    }
  } catch (error) {
    // SAFETY: execFileText rejects with a Node child-process error carrying
    // its captured text streams.
    const failure = error as (Error & { stderr?: string; stdout?: string }) | null
    const details = [
      (failure && failure.message) || String(error),
      failure?.stderr ? `stderr: ${failure.stderr.trim()}` : '',
      failure?.stdout ? `stdout: ${failure.stdout.trim()}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`Failed to read canonical roadmap ref ${canonicalRef}: ${details}`)
  }
}

interface ResumeContext {
  candidate: RecoveryCandidate
  enriched: RecoveryCandidate
  evidence: AssessmentEvidence | AnyRecord | undefined
  stage: string
  residualRisk: string[]
}

interface RecoveryDispatchDecision {
  classification?: string
  action: string
  stage?: string | null
  reason?: string
  skip?: boolean
}

type RecoveryReportedResult = {
  id: string
  branchName: string
  classification: string | undefined
  planStatus?: string
  action: 'reported'
  reason?: string
  assessment?: AnyRecord
}

async function executeResume(
  task: SelectedTask,
  resume: ResumeContext,
  mergeLock: MergeLockFn,
): Promise<TaskOutcome> {
  const { candidate, enriched, evidence, stage, residualRisk } = resume
  const worktree = candidate.worktreePath
  const extra = { kind: 'recovery-resume' }
  const writeAccess = await ensureTaskAgentWriteAccess(worktree, candidate.taskId)
  if (!writeAccess.ok) {
    const detail = `task-agent writable-root preflight failed (launch/sandbox fault, not a task defect): ${writeAccess.failures.map((failure) => `${failure.adapter}: ${failure.detail}`).join('; ')}`
    return { id: candidate.taskId, status: 'failed', stage: 'worktree-write', detail, worktree, proposals: [], ...extra }
  }
  try {
    let plan: StagePlan
    let impl: AnyRecord
    if (stage === 'plan' || stage === 'implement') {
      if (stage === 'plan') {
        const planned = await runPlanDesignLoop(task, worktree, { resume: true, extra })
        if (planned.kind === 'failure') return checkedTaskOutcome(planned.fail)
        plan = planned.plan
      } else {
        plan = {
          execplanPath: enriched.execplanPath,
          workItems: [],
          summary: 'Resumed from the committed ExecPlan on the surviving branch.',
        }
      }
      const built = await runImplementationStage(task, worktree, plan, { resume: stage === 'implement', extra })
      if (built.kind === 'failure') return checkedTaskOutcome(built.fail)
      impl = built.impl
    } else {
      // Carry the ADR 002 assessment's advisory residual risk forward into the
      // synthetic implementation report so the resumed reviewer/integrator sees
      // the caveats — without the resume having been blocked for them (#23).
      const synthetic = await syntheticRecoveryImpl(enriched, evidence, residualRisk)
      impl = synthetic
      plan = { execplanPath: synthetic.execplanPath, workItems: [], summary: synthetic.summary }
    }
    return checkedTaskOutcome(await runDualReviewAndIntegration(task, candidate.worktreePath, plan, impl, mergeLock, { kind: 'recovery-resume' }))
  } catch (error) {
    const detail = `unhandled agent error: ${faultThrownMessage(error)}`
    return checkedTaskOutcome(resultFromUnhandledAgentError(candidate.taskId, detail, { worktree, kind: 'recovery-resume' }, runFaultMetrics))
  }
}

// Fresh-run recovery pass: discover -> decide -> report or resume.
// Assess mode never mutates the target project: it reads Git state and spawns
// read-only assessment agents. Review mode may route eligible adopt-complete
// candidates through the SAME dual-review + merge-lock integration path as
// ordinary tasks. Continue mode dispatches deterministically on the committed
// ExecPlan Status and re-enters the ordinary pipeline at the plan, implement,
// or review stage; nothing merges outside that path in any mode.
async function runRecovery(root: string, mergeLock: MergeLockFn = null): Promise<{
  summary: RecoveryRunSummary
  taskResults: Array<{ task: SelectedTask; result: TaskOutcome }>
  held: { normal: Set<string>; addendum: Set<string> }
  fatal: TaskOutcome | null
}> {
  const summary: RecoveryRunSummary = {
    enabled: true,
    mode: RESUME_MODE,
    candidates: 0,
    assessed: 0,
    resumed: 0,
    skipped: [],
    results: [],
    errors: [],
  }
  const held = { normal: new Set<string>(), addendum: new Set<string>() }
  const taskResults: Array<{ task: SelectedTask; result: TaskOutcome }> = []
  phase('Recovery')

  const fetched = await execFileStatus('git', ['-C', root, 'fetch', 'origin', BASE])
  if (!fetched.ok) {
    summary.errors.push(`fetch origin ${BASE} failed (continuing with local refs): ${(fetched.message || fetched.stderr || '').trim()}`)
  }
  let roadmap
  try {
    roadmap = await readRoadmapForSelection(root)
  } catch (error) {
    summary.errors.push(faultThrownMessage(error))
    log('[recovery] cannot read the canonical roadmap; skipping recovery discovery')
    return { summary, taskResults, held, fatal: null }
  }

  const discovery = await discoverRecoveryCandidates(roadmap.text, root)
  summary.candidates = discovery.candidates.length
  summary.skipped.push(...discovery.skipped)
  summary.errors.push(...discovery.errors)

  const holdCandidate = (branchName: string, taskId?: string) => {
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

    let decision: RecoveryDispatchDecision
    let evidence: AssessmentEvidence | AnyRecord | undefined
    let enriched: RecoveryCandidate
    let assessment: AnyRecord | undefined
    let planState: ExecplanState | undefined
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
        ? { status: 'unreadable', ticked: 0, unticked: 0, items: [], error: resolved.error }
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
          // SAFETY: Empty extra cannot override the task fields or the empty
          // proposals returned by resultFromUnhandledAgentError.
          return { summary, taskResults, held, fatal: resultFromUnhandledAgentError(candidate.taskId, assessed.assessmentError, {}, runFaultMetrics) as TaskOutcome }
        }
        continue
      }
      assessment = assessed.assessment
      summary.assessed += 1
      evidence = assessed.evidence
      // Resolve the durable ExecPlan before deciding: resume eligibility
      // requires it, and its absence must stay visible as missing-execplan.
      // A stat FAULT is neither present nor absent — report it distinctly
      // rather than resuming or classifying on unverifiable evidence.
      const resolved = await recoveryExecplanPath(candidate)
      enriched = { ...candidate, execplanPath: resolved.execplanPath }
      const assessmentFields: RecoveryAssessmentFields = {
        classification: typeof assessment.classification === 'string' ? assessment.classification : undefined,
        taskScoped: typeof assessment.taskScoped === 'boolean' ? assessment.taskScoped : undefined,
        validation: typeof assessment.validation === 'string' ? assessment.validation : undefined,
        missingEvidence: Array.isArray(assessment.missingEvidence)
          ? assessment.missingEvidence.map(String)
          : undefined,
        residualRisk: advisoryResidualRisk(assessment),
      }
      decision = resolved.error
        ? { classification: '', action: 'report', reason: 'execplan-stat-error', skip: true }
        : { stage: 'review', ...recoveryDecision(enriched, evidence, assessmentFields, RESUME_MODE, { dryRun: DRY_RUN }) }
    }

    const resultBase: Omit<RecoveryReportedResult, 'action' | 'reason' | 'assessment'> = {
      id: candidate.taskId,
      branchName: candidate.branchName,
      classification: decision.classification,
    }
    if (planState) resultBase.planStatus = planState.status

    if (decision.action !== 'resume') {
      if (decision.skip) {
        summary.skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: decision.reason || '' })
      }
      const reported: RecoveryReportedResult = {
        ...resultBase,
        action: 'reported',
      }
      if (decision.reason) reported.reason = decision.reason
      if (assessment) reported.assessment = assessment
      summary.results.push(reported)
      log(`[recovery] ${candidate.branchName}: ${decision.classification || planState?.status || 'reported'} (reported${decision.reason ? `; ${decision.reason}` : ''})`)
      continue
    }

    // --- Resume: re-enter the ordinary pipeline at the dispatched stage. The
    // committed ExecPlan (continue mode) or the ADR 002 assessment (review
    // mode) chose the entry point; the pipeline's own gates remain decisive,
    // and integration ticks the roadmap under the merge lock.
    const stage = decision.stage || 'review'
    // Surface the advisory-vs-blocking boundary for operator diagnosis (#23):
    // the resume proceeded despite this many non-blocking residual-risk caveats,
    // which are carried into the review/integration prompts rather than blocking.
    const residualRisk = advisoryResidualRisk(assessment)
    log(`[recovery] resuming ${candidate.branchName} at the ${stage} stage through the ordinary pipeline (advisory residualRisk: ${residualRisk.length})`)
    const resume = { candidate, enriched, evidence, stage, residualRisk }
    const outcome = await executeResume(task, resume, mergeLock)
    if (outcome.status === 'fatal-auth' || outcome.status === 'provider-fault' || outcome.status === 'infra-fault') {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resume-failed', reason: outcome.detail || outcome.status, residualRisk })
      return { summary, taskResults, held, fatal: outcome }
    }
    // A failed or halted resume gets a FRESH assessment through the same
    // guard as ordinary task failures — any pre-resume snapshot is stale
    // once later agents have touched the branch.
    taskResults.push({ task, result: outcome.status === 'done' ? outcome : await attachAssessment(task, resumeWt, outcome) })
    if (outcome.status === 'done') {
      summary.resumed += 1
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resumed', residualRisk })
      log(`[recovery] ${candidate.branchName}: resumed and integrated`)
    } else if (outcome.status === 'manual-merge-ready') {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'manual-merge-ready', residualRisk })
    } else {
      summary.results.push({ ...resultBase, resumeStage: stage, action: 'resume-failed', reason: outcome.detail || outcome.status, residualRisk })
      log(`[recovery] ${candidate.branchName}: resume ${outcome.status} at ${outcome.stage || 'unknown stage'}`)
    }
  }

  return { summary, taskResults, held, fatal: null }
}

function writeProbeTargets() {
  // The probe keeps the real adapter (it tests THAT adapter's launch/sandbox
  // write permission) but right-sizes the model: minimal effort, an optional
  // cheap per-adapter probe model, and deliberately NO PLAN_MODEL/BUILD_MODEL
  // inheritance — writing an exact token to an exact path needs no reasoning.
  const probeOptions = (realAdapter: string): WriteProbeTarget['options'] => (options) => {
    const model = WRITE_PROBE_MODEL_BY_ADAPTER[realAdapter.toLowerCase()]
    const routing = model ? { adapter: realAdapter, model } : { adapter: realAdapter }
    return { ...routing, effort: WRITE_PROBE_EFFORT, ...options }
  }
  // Normalize each adapter once (lowercase, matching AUTH_REQUIRED_ADAPTERS)
  // and reuse the single value for both the dedup key and the agent() adapter,
  // so a mixed-case config cannot make them diverge.
  const planAdapter = String(PLAN_ADAPTER).toLowerCase()
  const buildAdapter = String(BUILD_ADAPTER).toLowerCase()
  const targets = [
    { role: 'plan', adapter: planAdapter, options: probeOptions(planAdapter) },
    { role: 'build', adapter: buildAdapter, options: probeOptions(buildAdapter) },
  ]
  const seen = new Set()
  return targets.filter((target) => {
    if (seen.has(target.adapter)) return false
    seen.add(target.adapter)
    return true
  })
}

// ---------------------------------------------------------------------------
// Post-step audit
// ---------------------------------------------------------------------------
async function runAudit(task: { id: string }) {
  phase('Audit')
  const audit = await agent(auditPrompt(task, null), auditAgentOptions({ phase: 'Audit', label: `audit:after-${task.id}`, schema: AUDIT_SCHEMA }))
  return audit
}

// ---------------------------------------------------------------------------
// Parallel worker pool: keep MAX_PARALLEL tasks building at once, re-selecting
// whenever any completes; serialize only integrate (merge queue), audit, and
// remediation flush in the control loop. Runs until the frontier is dry, the
// task ceiling or budget reserve is hit, or a task fails (then drain + stop).
// ---------------------------------------------------------------------------
const processed: string[] = [] // task ids pushed to BASE this run
const processedNormal = new Set<string>()
const processedAddendum = new Set<string>()
const manualMergeReadyNormal = new Set<string>()
const manualMergeReadyAddendum = new Set<string>()
const dryRunNormal = new Set<string>()
const dryRunAddendum = new Set<string>()
const recoveryHeldNormal = new Set<string>() // ids with surviving branches recovery reported but did not integrate this run
const recoveryHeldAddendum = new Set<string>()
let recovery: RecoveryRunSummary = {
  enabled: RESUME_PARTIAL_BRANCHES,
  mode: RESUME_MODE,
  candidates: 0,
  assessed: 0,
  resumed: 0,
  skipped: [],
  results: [],
  errors: [],
}
const results: TaskOutcome[] = []
const audits: AnyRecord[] = []
const triages: Array<AnyRecord & { step: string; decisions?: Array<{ lane: string }> }> = []
const pendingByStep = new Map<string, AnyRecord[]>() // step prefix -> accrued review/audit proposals awaiting that step's flush
const inflight = new Map<string, Promise<{ id: string; task: SelectedTask; result: TaskOutcome }>>() // task id -> Promise<{id, task, result}> for tasks currently being built
const inflightNormal = new Set<string>()
const inflightAddendum = new Set<string>()
let halted: string | null = null

// Only fold remediation into the roadmap when we are actually advancing BASE.
const canFlush = AUTO_MERGE && !DRY_RUN

// Minimal async mutex: serialize callers through a promise chain. Used as a
// merge queue so only one task rebases + squash-merges + pushes BASE at a time.
function mutex() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn())
    tail = result.then(() => {}, () => {}) // keep the queue alive regardless of outcome
    return result
  }
}
const mergeLock = mutex()

function semaphore(limit: number) {
  const max = Math.max(1, limit)
  const queue: Array<() => void> = []
  let active = 0

  const drain = () => {
    while (active < max && queue.length > 0) {
      const start = queue.shift()
      if (!start) break
      active += 1
      start()
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    // Each closure keeps the result and resolver paired with their own T.
    queue.push(() => {
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active -= 1
          drain()
        })
    })
    drain()
  })
}

const planningLock = semaphore(MAX_PLANNING_PARALLEL)
const buildLock = semaphore(MAX_BUILD_PARALLEL)
// Host gate runs are serialized across the whole pool: the target project's
// build cache rewards sequential execution, and concurrent gate runs from
// sibling worktrees would contend for it.
const hostGateLock = semaphore(1)

// Shared pipeline stages and the per-task pipeline with the run wiring bound
// once (see run-task.ts).
const {
  runPlanDesignLoop,
  runWorkItemBuildLoop,
  runImplementationStage,
  runDualReviewAndIntegration,
  runTask,
} = makeTaskPipeline({
  faultMetrics: runFaultMetrics,
  CS_CHECK,
  runCodeSceneCheck,
  MAX_DESIGN_ROUNDS,
  MAX_REVIEW_ROUNDS,
  MAX_WORK_ITEM_ROUNDS,
  PER_WORK_ITEM_BUILD,
  HOST_COMMIT_GATES,
  HOST_GATES_BETWEEN_WORK_ITEMS,
  HOST_REVIEW_ENABLED,
  HOST_REVIEW_BETWEEN_WORK_ITEMS,
  HOST_REVIEWER: REVIEW_TOOL,
  DRY_RUN,
  AUTO_MERGE,
  BASE,
  planPrompt,
  designReviewPrompt,
  implementPrompt,
  implementWorkItemPrompt,
  fixPrompt,
  codeReviewPrompt,
  expertReviewPrompt,
  addendumReviewPrompt,
  implementAddendumPrompt,
  integratePrompt,
  planAgentOptions,
  reviewAgentOptions,
  buildAgentOptions,
  planningLock,
  buildLock,
  hostGateLock,
  withInfraRetry,
  attachAssessment,
  ensureTaskAgentWriteAccess,
  createWorktree,
  runHostCommitGates,
  runHostReview,
  recordHostReview,
})

let selectSeq = 0
async function doSelect(taken: { normal: string[]; addendum: string[] }) {
  phase('Select')
  const label = `select#${++selectSeq}`
  const roadmap = await readRoadmapForSelection()
  if (roadmap.fallbackReason) {
    log(`[${label}] using working-tree ${ROADMAP}; origin/${BASE} read failed: ${roadmap.fallbackReason}`)
  }
  const selection = selectRoadmapTask(roadmap.text, taken, ONLY_TASK)
  if (selection.hasTask && selection.task) {
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

function isAlreadyTaken(task: SelectedTask) {
  const processedSet = task.isAddendum ? processedAddendum : processedNormal
  const manualMergeReadySet = task.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal
  const dryRunSet = task.isAddendum ? dryRunAddendum : dryRunNormal
  const recoveryHeldSet = task.isAddendum ? recoveryHeldAddendum : recoveryHeldNormal
  return processedSet.has(task.id) || manualMergeReadySet.has(task.id) || dryRunSet.has(task.id) || recoveryHeldSet.has(task.id) || inflightNormal.has(task.id) || inflightAddendum.has(task.id)
}

function markInflight(task: SelectedTask) {
  const inflightSet = task.isAddendum ? inflightAddendum : inflightNormal
  inflightSet.add(task.id)
}

function unmarkInflight(task: SelectedTask) {
  const inflightSet = task.isAddendum ? inflightAddendum : inflightNormal
  inflightSet.delete(task.id)
}

function markProcessed(task: SelectedTask) {
  const processedSet = task.isAddendum ? processedAddendum : processedNormal
  processedSet.add(task.id)
  processed.push(task.id)
}

function markManualMergeReady(task: SelectedTask) {
  const manualMergeReadySet = task.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal
  manualMergeReadySet.add(task.id)
}

function markDryRun(task: SelectedTask) {
  const dryRunSet = task.isAddendum ? dryRunAddendum : dryRunNormal
  dryRunSet.add(task.id)
}

function addPending(step: string, items: AnyRecord[] | undefined) {
  if (!items || items.length === 0) return
  if (!pendingByStep.has(step)) pendingByStep.set(step, [])
  pendingByStep.get(step)!.push(...items)
}

// Fold a step's accrued remediation into the roadmap once no in-flight task
// belongs to that step. The parallel pool has no single "current step", so debt
// is flushed per step at the point that step quiesces (nothing from it still
// building). Inserted tasks are live + unblocked, so the pool picks them up on
// the next refill — fix-debt-first within the step.
async function flushSettledSteps() {
  if (!canFlush) return
  const inflightSteps = new Set([...inflight.keys()].map((taskId) => stepOf(taskId)))
  // Snapshot the entries before awaiting triage, which can let other tasks
  // append proposals to the pending map.
  const pendingEntries = [...pendingByStep.entries()]
  for (const [step, items] of pendingEntries) {
    if (items.length === 0 || inflightSteps.has(step)) continue
    // SAFETY: ODW validates triage replies against TRIAGE_SCHEMA; the
    // no-proposals branch returns compatible fields. Keep null for test doubles.
    const tr = (await mergeLock(() => runTriage(step, items))) as { ok?: boolean; pushed?: boolean; decisions?: Array<{ lane: string }> } | null
    triages.push({ step, ...tr })
    if (!tr?.ok || !tr.pushed) {
      log(`[step ${step}] triage did not land; keeping ${items.length} proposal(s) pending`)
      continue
    }
    const lanes: Record<string, number> = {}
    for (const decision of tr.decisions || []) {
      lanes[decision.lane] = (lanes[decision.lane] || 0) + 1
    }
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
    } catch (error) {
      log(`[pool] select agent failed (${faultThrownMessage(error)}); stop opening new work, drain in-flight`)
      if (!halted) halted = `select agent error: ${faultThrownMessage(error)}`
      return
    }
    if (!sel.hasTask || !sel.task) {
      if (inflight.size === 0) log(sel.blockedSummary ? `No unblocked task: ${sel.blockedSummary}` : 'No unblocked roadmap tasks remain.')
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
      runTask(task, mergeLock)
        .then((result) => ({ id: task.id, task, result: checkedTaskOutcome(result) }))
        .catch((error) => {
          const detail = `unhandled agent error: ${faultThrownMessage(error)}`
          // SAFETY: Empty extra cannot override the task fields or the empty
          // proposals returned by resultFromUnhandledAgentError.
          return {
            id: task.id,
            task,
            result: resultFromUnhandledAgentError(task.id, detail, {}, runFaultMetrics) as TaskOutcome,
          }
        }),
    )
  }
}

/**
 * Redact leading shell environment-assignment values before command
 * configuration reaches durable workflow output. The original command remains
 * the host-gate input, so operator behaviour is unchanged while result.json
 * cannot expose a token embedded in `NAME=value` syntax. Shared tokenization
 * also identifies the host's executable; this function only projects its
 * assignment spans into displayed evidence.
 */
function redactedCodeSceneCommand(command: string): string {
  return redactedShellCommand(command)
}

// --- Worker-pool control loop -----------------------------------------------
async function runWorkflowMain() {
// Fill the pool, then await whichever task finishes first (Promise.race),
// record it, and refill — re-running select the instant any flow completes. A
// failed task stops new work but lets in-flight siblings drain. Audits and
// remediation triage run here in the control loop (serialized), so their
// worktrees and BASE writes never collide with each other.
const authPreflight = await runAuthPreflight()
if (authPreflight.length > 0) {
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
    const detail = faultThrownMessage(error)
    recovery.errors.push(`recovery pass failed: ${detail}`)
    log(`[recovery] failed (${detail}); continuing with normal roadmap selection`)
  }
}

for (;;) {
  if (!stop && !halted) {
    try {
      await flushSettledSteps()
    } catch (error) {
      log(`[triage] failed (${faultThrownMessage(error)}); proposals stay pending for a later sweep`)
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
      let audit: (AnyRecord & { proposedRoadmapItems?: AnyRecord[] }) | null | undefined
      try {
        // SAFETY: runAudit passes AUDIT_SCHEMA to ODW, which validates any
        // proposed roadmap items as objects. Null remains for test doubles.
        audit = (await mergeLock(() => runAudit({ id: done.id }))) as (AnyRecord & { proposedRoadmapItems?: AnyRecord[] }) | null
      } catch (error) {
        log(`[audit ${done.id}] failed (${faultThrownMessage(error)}); skipping (task already merged)`)
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
  } catch (error) {
    log(`[triage:end] failed (${faultThrownMessage(error)}); ${[...pendingByStep.values()].flat().length} proposal(s) left pending`)
  }
}
// Recovery survivors the run reported but did not integrate still hold their
// roadmap ids out of selection, so the frontier stays blocked until the
// operator closes, resumes, splits, or hoovers each branch. A run that ends
// with such survivors has NOT stopped cleanly, even when the selector reports
// no unblocked tasks — surface it as an explicit operator-recovery terminal
// state instead of `halted: null` (issue #25).
const heldRecovery: Array<{ id: string; isAddendum: boolean }> = []
for (const id of recoveryHeldNormal) {
  if (!processedNormal.has(id) && !manualMergeReadyNormal.has(id)) {
    heldRecovery.push({ id, isAddendum: false })
  }
}
for (const id of recoveryHeldAddendum) {
  if (!processedAddendum.has(id) && !manualMergeReadyAddendum.has(id)) {
    heldRecovery.push({ id, isAddendum: true })
  }
}
const unresolvedRecovery = heldRecovery.toSorted(
  (left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }) || Number(left.isAddendum) - Number(right.isAddendum),
)
recovery.unresolved = unresolvedRecovery.map((entry) => {
  const reported = recovery.results.filter((result) => result.id === entry.id)
  const last = reported.at(-1)
  const unresolved = {
    id: entry.id,
    isAddendum: entry.isAddendum,
    branchName: last?.branchName || '',
    classification: last?.classification || '',
    action: last?.action || 'held',
  }
  return last?.reason ? { ...unresolved, reason: last.reason } : unresolved
})
if (!halted && unresolvedRecovery.length > 0) {
  halted =
    `needs-operator-recovery: ${unresolvedRecovery.length} recovery survivor branch(es) still block the roadmap frontier ` +
    `(${unresolvedRecovery.map((entry) => entry.id + (entry.isAddendum ? ' (addendum)' : '')).join(', ')}); ` +
    'use recovery.results/recovery.unresolved to close, resume, split, or hoover each branch, then relaunch'
}

const pendingProposals = [...pendingByStep.values()].flat()
const assessments = results.flatMap((result) =>
  result.assessment || result.assessmentError
    ? [{
        id: result.id,
        stage: result.stage,
        status: result.status,
        classification: result.assessment?.classification || '',
        recommendation: result.assessment?.recommendation || '',
        assessmentError: result.assessmentError || '',
      }]
    : [],
)
// Salvage rides on individual task results (assessment.ts); surface it in the
// terminal summary so an operator sees which branches had docs/execplans/*.md
// artefacts committed (or why salvage was skipped) without opening result.json.
// summarizeSalvages is a pure, unit-tested aggregator (see assessment.ts).
const { salvages, summarySuffix: salvageSummarySuffix } = summarizeSalvages(results)
const hostReviewSnapshot = getHostReviewMetrics()

return {
  base: BASE,
  modelRouting: modelRouting(),
  maxParallel: MAX_PARALLEL,
  maxPlanningParallel: MAX_PLANNING_PARALLEL,
  maxBuildParallel: MAX_BUILD_PARALLEL,
  // The exact deterministic gate set every branch agent was instructed to run
  // (issue #28): operators can audit reported gate greenness against it.
  commitGates: COMMIT_GATES,
  // Host gate verification aggregate: whether the host re-ran the gates
  // itself, the per-gate timeout, and bounded counters. Per-round pass/fail
  // detail lives in each task's reviewRounds[].hostGates.
  hostGates: {
    enabled: HOST_COMMIT_GATES,
    timeoutSeconds: COMMIT_GATE_TIMEOUT_SECONDS,
    ...hostReviewSnapshot.hostGates,
  },
  codeScene: {
    enabled: CS_CHECK,
    command: redactedCodeSceneCommand(CS_CHECK_COMMAND),
    ...hostReviewSnapshot.codeScene,
  },
  stageAttempts: STAGE_ATTEMPTS,
  // Host-driven build loop configuration: one builder turn per unticked
  // ExecPlan Progress item when enabled, with committed progress verified
  // after every turn.
  workItemBuild: { enabled: PER_WORK_ITEM_BUILD, maxRounds: MAX_WORK_ITEM_ROUNDS },
  // Bounded-cardinality fault metrics (fixed keys): stage retries spent on
  // infrastructure faults plus terminal fault counts per class, so operators
  // can read retry pressure straight from the result instead of the logs.
  faultMetrics: { ...runFaultMetrics },
  // Host-review aggregate: effective configuration plus bounded counters.
  // Per-finding detail goes to the JSONL sink when
  // coderabbitFindingsFile is configured.
  hostReview: {
    enabled: HOST_REVIEW_ENABLED,
    reviewer: REVIEW_TOOL,
    attempts: HOST_REVIEW_ATTEMPTS,
    backoffMinutes: HOST_REVIEW_BACKOFF_MINUTES,
    findingsFile: HOST_REVIEW_FINDINGS_FILE,
    ...hostReviewSnapshot.hostReview,
    bySeverity: { ...hostReviewSnapshot.hostReview.bySeverity },
  },
  processed,
  results,
  assessments,
  // Per-branch artefact-salvage records (committed docs/execplans/*.md paths,
  // skip counts, and the salvage commit sha). A skipped salvage still produces a
  // record with no committed paths, so this is empty only when no salvage was
  // attempted on any branch.
  salvages,
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
    (assessments.length > 0 ? ` | assessed ${assessments.length} failed/halted branch(es)` : '') +
    salvageSummarySuffix +
    (triages.length > 0 ? ` | triaged ${triages.reduce((n, t) => n + (t.decisions ? t.decisions.length : 0), 0)} proposal(s) across ${triages.length} step(s)` : '') +
    (halted ? ` | halted: ${halted}` : ' | clean stop (no more unblocked tasks).'),
}
}

/** Run the workflow and release temporary host-gate logs after every terminal path. */
async function workflowMain() {
  try {
    return await runWorkflowMain()
  } finally {
    try {
      disposeHostGateLogs()
    } catch (error) {
      log(`[host gates] could not dispose temporary log roots: ${faultThrownMessage(error).slice(-500)}`)
    }
  }
}
