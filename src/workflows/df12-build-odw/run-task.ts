// Shared pipeline stages and the per-task pipeline — used by the normal task
// lane and by continue-mode recovery resume, so a resumed branch runs through
// exactly the same planning loop, design review, implementation contract,
// reviewers, and integration path as ordinary work. Each stage helper returns
// { fail } (an unassessed result object) or its stage product; callers decide
// whether to attach an assessment. The run wiring (config caps, prompt
// builders, adapter options, stage locks, retry, assessment, write gate,
// worktree creation) binds once via makeTaskPipeline.
import { fileState } from './exec.ts'
import {
  commitExecplanApproval,
  commitExecplanDraft,
  execplanRelPath,
  verifyExecplanCommitted,
  verifyWorktreeCommitted,
} from './execplan-durability.ts'
import {
  faultMetrics,
  infrastructureFailureDetail,
  resultFromUnhandledAgentError,
} from './faults.ts'
import {
  addendumImplementationNeedsManualMerge,
  hasOnlyDeferredReviewIssues,
  implementationAuthFailureDetail,
} from './assessment.ts'
import { coderabbitBlockingItems, coderabbitCapture } from './host-review.ts'
import type { CoderabbitReview, HostGateRun } from './host-review.ts'
import { readExecplanState } from './recovery-discovery.ts'
import {
  DESIGN_VERDICT_SCHEMA,
  FIX_SCHEMA,
  IMPL_SCHEMA,
  INTEGRATE_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
} from './schemas.ts'
import type { SelectedTask } from './types.ts'

export interface StagePlan extends Record<string, unknown> {
  execplanPath?: string
}

export interface StageImpl extends Record<string, unknown> {
  ok?: boolean
  gatesGreen?: boolean
  summary?: string
  openIssues?: string[]
  workItemsCompleted?: unknown
  workItemsTotal?: unknown
}

interface StageReview extends Record<string, unknown> {
  verdict?: string
  blocking?: string[]
  summary?: string
  proposedRoadmapItems?: Array<Record<string, unknown>>
}

interface StageIntegration extends Record<string, unknown> {
  ok?: boolean
  rebased?: boolean
  pushed?: boolean
  squashMerged?: boolean
  mergeSha?: string
  roadmapMarkedDone?: boolean
  conflicts?: string
  summary?: string
}

interface DesignVerdict extends Record<string, unknown> {
  satisfied?: boolean
  blocking?: string[]
}

export type StageResult = Record<string, unknown> & { id: string; status: string; stage?: string; detail?: string }

type Lock = <T>(fn: () => Promise<T>) => Promise<T>
type MergeLock = (<T>(fn: () => Promise<T>) => Promise<T>) | null
type AgentOptions = (options: Record<string, unknown>) => Record<string, unknown>

export interface TaskPipelineDeps {
  MAX_DESIGN_ROUNDS: number
  MAX_REVIEW_ROUNDS: number
  MAX_WORK_ITEM_ROUNDS: number
  PER_WORK_ITEM_BUILD: boolean
  HOST_COMMIT_GATES: boolean
  HOST_GATES_BETWEEN_WORK_ITEMS: boolean
  CS_CHECK: boolean
  CODERABBIT_HOST_REVIEW: boolean
  CODERABBIT_BETWEEN_WORK_ITEMS: boolean
  DRY_RUN: boolean
  AUTO_MERGE: boolean
  BASE: string
  planPrompt: (task: SelectedTask, worktree: string, priorVerdict: DesignVerdict | null, round: number, opts?: Record<string, unknown>) => string
  designReviewPrompt: (task: SelectedTask, worktree: string, plan: StagePlan, round: number) => string
  implementPrompt: (task: SelectedTask, worktree: string, plan: StagePlan, opts?: Record<string, unknown>) => string
  implementWorkItemPrompt: (task: SelectedTask, worktree: string, plan: StagePlan, item: { text: string }, opts?: Record<string, unknown>) => string
  fixPrompt: (task: SelectedTask, worktree: string, plan: StagePlan, blocking: string[], round: number) => string
  codeReviewPrompt: (task: SelectedTask, worktree: string, plan: StagePlan) => string
  expertReviewPrompt: (task: SelectedTask, worktree: string, plan: StagePlan) => string
  addendumReviewPrompt: (task: SelectedTask, worktree: string, impl: StageImpl | null) => string
  implementAddendumPrompt: (task: SelectedTask, worktree: string) => string
  integratePrompt: (task: SelectedTask, worktree: string) => string
  planAgentOptions: AgentOptions
  reviewAgentOptions: AgentOptions
  buildAgentOptions: AgentOptions
  planningLock: Lock
  buildLock: Lock
  hostGateLock: Lock
  withInfraRetry: <T>(run: () => Promise<T>, label: string) => Promise<T>
  attachAssessment: (task: SelectedTask, wt: { branch?: string; worktreePath?: string; baseSha?: string }, result: StageResult) => Promise<StageResult>
  ensureTaskAgentWriteAccess: (worktree: string, tag: string) => Promise<{ ok: boolean; failures: Array<{ adapter: string; detail: string }> }>
  runHostCommitGates: (worktree: string, tag: string, roundLabel: string) => Promise<HostGateRun>
  runCodeSceneCheck: (worktree: string, tag: string, label: string) => Promise<{ clean: boolean; skipped: boolean; detail: string; logFile: string }>
  runCoderabbitHostReview: (worktree: string, label: string) => Promise<CoderabbitReview>
  recordCoderabbitReview: (label: string, review: CoderabbitReview) => Promise<void>
  createWorktree: (task: SelectedTask) => Promise<{ ok?: boolean; worktreePath?: string; branch?: string; baseSha?: string; notes?: string } | null>
}

// Bounded per-round records of what the reviewers and fix agents actually
// reported, so a failed/halted outcome carries fresh validation evidence into
// its assessment instead of leaving the assessor with only stale ExecPlan
// text and non-durable /tmp gate logs (issue #24).
export function summarizeReviewVerdict(review: StageReview | null | undefined) {
  if (!review) return null
  return {
    verdict: review.verdict || '',
    blocking: review.blocking || [],
    summary: review.summary || '',
  }
}

export function summarizeFixReport(fix: Record<string, unknown> | string | null | undefined) {
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

export function makeTaskPipeline(deps: TaskPipelineDeps) {
  const {
    MAX_DESIGN_ROUNDS,
    MAX_REVIEW_ROUNDS,
    MAX_WORK_ITEM_ROUNDS,
    PER_WORK_ITEM_BUILD,
    HOST_COMMIT_GATES,
    HOST_GATES_BETWEEN_WORK_ITEMS,
    CS_CHECK,
    CODERABBIT_HOST_REVIEW,
    CODERABBIT_BETWEEN_WORK_ITEMS,
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
    runCodeSceneCheck,
    runCoderabbitHostReview,
    recordCoderabbitReview,
  } = deps

  async function runPlanDesignLoop(task: SelectedTask, worktree: string, opts: Record<string, unknown> = {}): Promise<{ plan?: StagePlan; fail?: StageResult }> {
    const tag = task.id
    const extra = (opts.extra as Record<string, unknown>) || {}
    let plan: StagePlan | null = null
    let designVerdict: DesignVerdict | null = null
    for (let round = 1; round <= MAX_DESIGN_ROUNDS; round++) {
      phase('Plan')
      plan = (await planningLock(() => withInfraRetry(() => agent(planPrompt(task, worktree, designVerdict, round, opts), planAgentOptions({
        phase: 'Plan',
        label: `plan:${tag} r${round}`,
        schema: PLAN_SCHEMA,
      })), `plan:${tag} r${round}`))) as StagePlan | null
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
      designVerdict = (await planningLock(() => withInfraRetry(() => agent(designReviewPrompt(task, worktree, plan as StagePlan, round), reviewAgentOptions({
        phase: 'Design Review',
        label: `design-review:${tag} r${round}`,
        schema: DESIGN_VERDICT_SCHEMA,
      })), `design-review:${tag} r${round}`))) as DesignVerdict | null
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

  // The host-driven build loop: one builder turn per unticked Progress item in
  // the committed ExecPlan, with committed progress verified after every turn.
  // The checklist — not the agent's say-so — decides when the build is done.
  // Returns null when the plan has no checklist (caller falls back to the
  // single-turn build), { fail } on failure, or { impl } with an aggregate
  // implementation report on success.
  // Deterministic host commit-gate check on ONE committed work item, run
  // between build turns and BEFORE the between-item CodeRabbit review, so a
  // committed red work item is caught by the host re-running the gates rather
  // than trusting the build agent's gatesGreen claim. A red gate drives a
  // bounded fix loop; an unresolved red state fails the item. Returns
  // { ok } or { fail }.
  // Shared fix mechanic for every check -> fix -> durability path (host gates,
  // CodeScene, and CodeRabbit, in both the between-item loop and the dual
  // review): dispatch a fix agent for the blocking items at the LIVE round,
  // then host-verify the worktree is committed. Returns the fix report (for the
  // caller to summarize) and a dirtyDetail string when the fix left uncommitted
  // state, so the dispatch, round threading, and durability check live in one
  // place while each caller keeps its own failure-result shape and logging.
  async function dispatchFixAndVerify(
    task: SelectedTask,
    worktree: string,
    plan: StagePlan,
    blocking: string[],
    label: string,
    round: number,
  ): Promise<{ report: Record<string, unknown> | null; dirtyDetail: string | null }> {
    phase('Implement')
    const report = (await buildLock(() => withInfraRetry(() => agent(fixPrompt(task, worktree, plan, blocking, round), buildAgentOptions({ phase: 'Implement', label, schema: FIX_SCHEMA })), label))) as Record<string, unknown> | null
    const committed = await verifyWorktreeCommitted(worktree)
    return { report, dirtyDetail: committed.ok ? null : committed.detail }
  }

  async function runBetweenItemGates(
    task: SelectedTask,
    worktree: string,
    plan: StagePlan,
    itemLabel: string,
    extra: Record<string, unknown>,
  ): Promise<{ ok: true } | { fail: StageResult }> {
    const tag = task.id
    // Bounded fix loop shared by the two deterministic checks. The commit gates
    // run FIRST but only when host-gate-between-work-items verification is on;
    // the CodeScene check runs whenever CS_CHECK is on, independent of that flag
    // (they are separate gates). Both are free, so they gate the item before the
    // quota-limited between-item CodeRabbit review the caller runs next.
    const runGates = HOST_COMMIT_GATES && HOST_GATES_BETWEEN_WORK_ITEMS
    const runFix = async (blocking: string[], fixLabel: string, attempt: number): Promise<{ fail: StageResult } | null> => {
      const { dirtyDetail } = await dispatchFixAndVerify(task, worktree, plan, blocking, fixLabel, attempt)
      if (dirtyDetail) {
        return { fail: { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the fix for ${itemLabel} left uncommitted state (${dirtyDetail}); every fix must be committed before the checks re-run`, worktree, proposals: [], ...extra } }
      }
      return null
    }
    for (let attempt = 1; attempt <= MAX_REVIEW_ROUNDS; attempt++) {
      if (runGates) {
        const gates = await hostGateLock(() => runHostCommitGates(worktree, tag, `${itemLabel} a${attempt}`))
        if (!gates.green) {
          log(`[task ${tag}] host commit gates red after ${itemLabel} (attempt ${attempt} of ${MAX_REVIEW_ROUNDS})`)
          if (attempt === MAX_REVIEW_ROUNDS) {
            return { fail: { id: tag, status: 'failed', stage: 'implement', detail: `HOST GATES RED after ${itemLabel}: ${gates.detail} The committed work item's gatesGreen claim could not be reproduced after ${MAX_REVIEW_ROUNDS} fix attempt(s).`, worktree, proposals: [], ...extra } }
          }
          const durability = await runFix([`HOST GATES RED: ${gates.detail} The agent-reported gate status for ${itemLabel} was wrong or is stale — reproduce the failure from the log, fix it, re-run the gates to green, and commit.`], `fix:${tag} ${itemLabel} gate a${attempt}`, attempt)
          if (durability) return durability
          continue
        }
      }
      // Gates green (or off) — the CodeScene code-health check (skips gracefully
      // when its binary is absent).
      const cs = CS_CHECK
        ? await hostGateLock(() => runCodeSceneCheck(worktree, tag, `${itemLabel} a${attempt}`))
        : { clean: true, skipped: true, detail: '', logFile: '' }
      if (cs.clean) return { ok: true }
      log(`[task ${tag}] CodeScene check red after ${itemLabel} (attempt ${attempt} of ${MAX_REVIEW_ROUNDS})`)
      if (attempt === MAX_REVIEW_ROUNDS) {
        return { fail: { id: tag, status: 'failed', stage: 'implement', detail: `CODESCENE RED after ${itemLabel}: ${cs.detail} The committed work item's code health could not be cleared after ${MAX_REVIEW_ROUNDS} fix attempt(s).`, worktree, proposals: [], ...extra } }
      }
      const durability = await runFix([`CODESCENE RED: ${cs.detail} Clear these code-health regressions by refactoring, or — only where further refinement would be deleterious — suppress the specific smell with a justified @codescene(disable:"...") comment, then re-run the check to green and commit.`], `fix:${tag} ${itemLabel} cs a${attempt}`, attempt)
      if (durability) return durability
    }
    return { ok: true }
  }

  // Deterministic host CodeRabbit gate on ONE committed work item, run between
  // build turns. Blocking findings (critical/major) drive a bounded fix loop;
  // an unresolved set fails the item, and a terminal deferral (rate limit or
  // CLI fault after the configured retries) HALTS the task for assessment
  // rather than silently continuing — "between" is a real gate, so a gate that
  // cannot complete must not read as a pass. Returns { ok } or { fail }.
  async function runBetweenItemReview(
    task: SelectedTask,
    worktree: string,
    plan: StagePlan,
    itemLabel: string,
    extra: Record<string, unknown>,
  ): Promise<{ ok: true; coderabbitRuns: number } | { fail: StageResult }> {
    const tag = task.id
    let runs = 0
    for (let attempt = 1; attempt <= MAX_REVIEW_ROUNDS; attempt++) {
      const review = await runCoderabbitHostReview(worktree, `coderabbit:${tag} ${itemLabel} a${attempt}`)
      await recordCoderabbitReview(`${tag} ${itemLabel} a${attempt}`, review)
      runs += 1
      if (review.outcome === 'auth') {
        return { fail: { id: tag, status: 'fatal-auth', stage: 'auth', detail: `CodeRabbit host review is not authenticated: ${review.detail}`, worktree, proposals: [], ...extra } }
      }
      if (review.outcome === 'rate-limited' || review.outcome === 'error') {
        coderabbitCapture.deferred += 1
        return { fail: { id: tag, status: 'halted', stage: 'code-review', detail: `CodeRabbit between-item review could not complete for ${itemLabel} (${review.outcome} after ${review.attempts} attempt(s)): ${review.detail}; the work is committed but unreviewed — resolve the CodeRabbit quota/CLI fault and relaunch with resumeMode: "continue"`, worktree, proposals: [], ...extra } }
      }
      const blocking = coderabbitBlockingItems(review.findings)
      log(`[task ${tag}] between-item CodeRabbit ${itemLabel} attempt ${attempt}: ${review.findings.length} finding(s), ${blocking.length} blocking`)
      if (!blocking.length) return { ok: true, coderabbitRuns: runs }
      if (attempt === MAX_REVIEW_ROUNDS) {
        return { fail: { id: tag, status: 'failed', stage: 'code-review', detail: `CodeRabbit between-item review left blocking finding(s) unresolved after ${MAX_REVIEW_ROUNDS} fix attempt(s) on ${itemLabel}: ${blocking.join('; ')}`, worktree, proposals: [], ...extra } }
      }
      const { dirtyDetail } = await dispatchFixAndVerify(task, worktree, plan, blocking, `fix:${tag} ${itemLabel} a${attempt}`, attempt)
      if (dirtyDetail) {
        return { fail: { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the CodeRabbit fix for ${itemLabel} left uncommitted state (${dirtyDetail}); every fix must be committed before re-review`, worktree, proposals: [], ...extra } }
      }
    }
    return { ok: true, coderabbitRuns: runs }
  }

  async function runWorkItemBuildLoop(task: SelectedTask, worktree: string, plan: StagePlan, opts: Record<string, unknown> = {}): Promise<{ impl?: StageImpl; fail?: StageResult } | null> {
    const tag = task.id
    const extra = (opts.extra as Record<string, unknown>) || {}
    const fail = (detail: string, openIssues: string[] = []) => ({ fail: { id: tag, status: 'failed', stage: 'implement', detail, openIssues, worktree, proposals: [], ...extra } })
    const contained = execplanRelPath(worktree, plan.execplanPath)
    if (!contained.ok) return fail(contained.detail)
    const planRef = { worktreePath: worktree, execplanPath: contained.relPath }
    const initial = await readExecplanState(planRef)
    if (initial.status === 'unreadable') return fail(`could not read the committed ExecPlan: ${initial.error}`)
    if (initial.status === 'missing') return fail(`the ExecPlan disappeared before the build: ${contained.relPath}`)
    if (!(initial.items || []).length) return null
    const commits: string[] = []
    const openIssues: string[] = []
    let coderabbitRuns = 0
    let lastImpl: StageImpl | null = null
    let noProgressNote = ''
    let strikes = 0
    for (let round = 1; round <= MAX_WORK_ITEM_ROUNDS; round++) {
      const before = await readExecplanState(planRef)
      if (before.status === 'unreadable') return fail(`could not read the committed ExecPlan: ${before.error}`, openIssues)
      if (before.status === 'missing') return fail(`the committed ExecPlan disappeared mid-build: ${contained.relPath}`, openIssues)
      const item = (before.items || []).find((entry) => !entry.ticked)
      if (!item) break
      const label = `implement:${tag} wi${round}`
      const impl = (await buildLock(() => withInfraRetry(() => agent(implementWorkItemPrompt(task, worktree, plan, item, { ...opts, noProgressNote }), buildAgentOptions({
        phase: 'Implement',
        label,
        schema: IMPL_SCHEMA,
      })), label))) as StageImpl | null
      lastImpl = impl
      const authDetail = implementationAuthFailureDetail(impl)
      if (authDetail) {
        return { fail: { id: tag, status: 'fatal-auth', stage: 'auth', detail: authDetail, openIssues: impl?.openIssues || [], worktree, proposals: [], ...extra } }
      }
      if (!impl || !impl.ok || !impl.gatesGreen) {
        return fail(impl?.summary || `work item did not reach a green state: ${item.text}`, impl?.openIssues || [])
      }
      if (Array.isArray(impl.commits)) commits.push(...(impl.commits as string[]))
      openIssues.push(...(impl.openIssues || []))
      coderabbitRuns += Number(impl.coderabbitRuns) || 0
      // Host-verified durability per turn: a dirty worktree or an uncommitted
      // tick would silently stall the loop, so both are checked here.
      const committed = await verifyWorktreeCommitted(worktree)
      if (!committed.ok) {
        return fail(`work item returned ok but left uncommitted state in the worktree (${committed.detail}); every work item must be committed before returning`, openIssues)
      }
      const after = await readExecplanState(planRef)
      if (after.status === 'unreadable') return fail(`could not re-read the committed ExecPlan: ${after.error}`, openIssues)
      if (after.status === 'missing') return fail(`the committed ExecPlan disappeared mid-build: ${contained.relPath}`, openIssues)
      if (after.unticked >= before.unticked) {
        strikes += 1
        noProgressNote = `your previous turn returned ok but the committed ExecPlan still shows ${after.unticked} unticked Progress item(s) (it had ${before.unticked} before the turn); tick the work item you completed in ## Progress and commit the plan update together with the work`
        log(`[task ${tag}] work-item round ${round}: no committed Progress movement (strike ${strikes} of 2)`)
        if (strikes >= 2) {
          return fail(`the work-item build made no committed ExecPlan progress in two consecutive turns; ${after.unticked} Progress item(s) remain unticked`, openIssues)
        }
      } else {
        strikes = 0
        noProgressNote = ''
        log(`[task ${tag}] work-item round ${round}: ${after.ticked}/${after.ticked + after.unticked} Progress item(s) committed`)
        // Deterministic checks on this committed work item, before the next
        // item is dispatched. Host commit gates run FIRST (a red branch must
        // not spend a CodeRabbit review), then the CodeScene check, then the
        // between-item CodeRabbit review. Each gate is independently
        // enable/disableable: the commit gates follow
        // hostGatesBetweenWorkItems and the CodeScene check follows csCheck,
        // so csCheck runs here even when the between-item commit gates are off.
        if ((HOST_COMMIT_GATES && HOST_GATES_BETWEEN_WORK_ITEMS) || CS_CHECK) {
          const gate = await runBetweenItemGates(task, worktree, plan, `wi${round}`, extra)
          if ('fail' in gate) return gate
        }
        if (CODERABBIT_HOST_REVIEW && CODERABBIT_BETWEEN_WORK_ITEMS) {
          const gate = await runBetweenItemReview(task, worktree, plan, `wi${round}`, extra)
          if ('fail' in gate) return gate
          coderabbitRuns += gate.coderabbitRuns
        }
      }
    }
    const final = await readExecplanState(planRef)
    if (final.status === 'unreadable') return fail(`could not read the committed ExecPlan after the build: ${final.error}`, openIssues)
    if (final.status === 'missing') return fail(`the committed ExecPlan is absent after the build: ${contained.relPath}`, openIssues)
    const remaining = (final.items || []).filter((entry) => !entry.ticked)
    if (remaining.length) {
      return fail(`the work-item round cap (maxWorkItemRounds=${MAX_WORK_ITEM_ROUNDS}) was reached with ${remaining.length} Progress item(s) still unticked; the first is: ${remaining[0].text}`, openIssues)
    }
    return {
      impl: {
        ok: true,
        gatesGreen: true,
        execplanPath: contained.relPath,
        workItemsCompleted: final.ticked,
        workItemsTotal: final.ticked + final.unticked,
        commits: commits.slice(0, 50),
        coderabbitRuns,
        openIssues: [...new Set(openIssues)].slice(0, 20),
        summary: lastImpl?.summary || 'work-item build completed from the committed ExecPlan checklist',
      },
    }
  }

  async function runImplementationStage(task: SelectedTask, worktree: string, plan: StagePlan, opts: Record<string, unknown> = {}): Promise<{ impl?: StageImpl; fail?: StageResult }> {
    const tag = task.id
    const extra = (opts.extra as Record<string, unknown>) || {}
    phase('Implement')
    if (PER_WORK_ITEM_BUILD) {
      const itemised = await runWorkItemBuildLoop(task, worktree, plan, opts)
      // null means the plan carries no Progress checklist: fall back to the
      // single-turn whole-task build below.
      if (itemised) {
        if (itemised.fail) return itemised
        return finishImplementationStage(task, worktree, plan, itemised.impl as StageImpl, extra)
      }
      log(`[task ${tag}] the committed ExecPlan has no Progress checklist; falling back to the single-turn build`)
    }
    const impl = (await buildLock(() => withInfraRetry(() => agent(implementPrompt(task, worktree, plan, opts), buildAgentOptions({
      phase: 'Implement',
      label: `implement:${tag}`,
      schema: IMPL_SCHEMA,
    })), `implement:${tag}`))) as StageImpl | null
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
    return finishImplementationStage(task, worktree, plan, impl, extra)
  }

  // Shared tail of the implementation stage: the committed-worktree durability
  // gate and the plan-status advisory, identical for both build modes.
  async function finishImplementationStage(task: SelectedTask, worktree: string, plan: StagePlan, impl: StageImpl, extra: Record<string, unknown>): Promise<{ impl?: StageImpl; fail?: StageResult }> {
    const tag = task.id
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

  // One integration implementation for the normal pipeline and the addendum
  // lane (the two copies had already drifted once). Deliberately NOT wrapped
  // in withInfraRetry: integration pushes to origin/BASE, so a hidden-success
  // first attempt re-run after an adapter death could squash and push the
  // same task twice — a fault here is terminal and hands verification to the
  // operator. Returns the integration report, or a terminal infra-fault
  // result the caller must return as-is.
  async function integrateTask(
    task: SelectedTask,
    worktree: string,
    mergeLock: MergeLock,
    proposals: Array<Record<string, unknown>>,
    kindExtra: Record<string, unknown>,
  ): Promise<{ integration?: StageIntegration | null; fault?: StageResult }> {
    const tag = task.id
    const doIntegrate = () => {
      phase('Integrate')
      return buildLock(() => agent(integratePrompt(task, worktree), buildAgentOptions({ phase: 'Integrate', label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })))
    }
    try {
      return { integration: (mergeLock ? await mergeLock(doIntegrate) : await doIntegrate()) as StageIntegration | null }
    } catch (error) {
      const message = ((error as Error | null) && (error as Error).message) || String(error)
      if (!infrastructureFailureDetail(message)) throw error
      faultMetrics.infraFaults += 1
      return {
        fault: {
          id: tag,
          status: 'infra-fault',
          stage: 'integrate',
          detail: `integration agent died on an infrastructure fault (${message}); integration is never retried because the push to origin/${BASE} is not idempotent — inspect origin/${BASE} and the roadmap for a partial or hidden-success integration before relaunching with resumeMode: "continue"`,
          worktree,
          proposals,
          ...kindExtra,
        },
      }
    }
  }

  async function runDualReviewAndIntegration(task: SelectedTask, worktree: string, plan: StagePlan, impl: StageImpl, mergeLock: MergeLock, options: Record<string, unknown> = {}): Promise<StageResult> {
    const tag = task.id
    const kindExtra = options.kind ? { kind: options.kind } : {}
    const proposals: Array<Record<string, unknown>> = []
    const reviewRounds: Array<Record<string, unknown>> = []
    let reviewsPass = false
    const coderabbitDeferred: string[] = []
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      // Host-verified gates FIRST: deterministic, zero tokens, and a red
      // branch must not spend reviewer agents. A red gate goes straight to a
      // fix round carrying the host log evidence.
      let hostGates: HostGateRun | null = null
      if (HOST_COMMIT_GATES) {
        hostGates = await hostGateLock(() => runHostCommitGates(worktree, tag, `r${round}`))
        if (!hostGates.green) {
          log(`[task ${tag}] host commit gates red in round ${round}`)
          const gateBlocking = [`HOST GATES RED: ${hostGates.detail} The agent-reported gate status was wrong or is stale — reproduce the failure from the log, fix it, re-run the gates to green, and commit.`]
          reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: gateBlocking, hostGates: hostGates.results, fix: null })
          if (round === MAX_REVIEW_ROUNDS) break
          // A fix that leaves the worktree dirty is unreviewable and lost at
          // the squash merge, so the next round's gates/reviews and any
          // integration would judge state the host never verified.
          const gateFix = await dispatchFixAndVerify(task, worktree, plan, gateBlocking, `fix:${tag} r${round}`, round)
          reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(gateFix.report)
          if (gateFix.dirtyDetail) {
            return { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the gate-fix round left uncommitted state (${gateFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra }
          }
          continue
        }
      }
      // Second deterministic check (still free): the CodeScene code-health
      // check on the committed changed files, after the commit gates and
      // before CodeRabbit. A regression short-circuits to a fix round without
      // spending CodeRabbit quota or reviewer-agent tokens; it skips
      // gracefully when the binary is absent.
      if (CS_CHECK) {
        const cs = await hostGateLock(() => runCodeSceneCheck(worktree, tag, `r${round}`))
        if (!cs.clean) {
          log(`[task ${tag}] CodeScene check red in round ${round}`)
          const csBlocking = [`CODESCENE RED: ${cs.detail} Clear these code-health regressions by refactoring, or — only where further refinement would be deleterious — suppress the specific smell with a justified @codescene(disable:"...") comment, then re-run the check to green and commit.`]
          reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: csBlocking, ...(hostGates ? { hostGates: hostGates.results } : {}), fix: null })
          if (round === MAX_REVIEW_ROUNDS) break
          const csFix = await dispatchFixAndVerify(task, worktree, plan, csBlocking, `fix:${tag} cs r${round}`, round)
          reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(csFix.report)
          if (csFix.dirtyDetail) {
            return { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the CodeScene-fix round left uncommitted state (${csFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra }
          }
          continue
        }
      }
      // Cost hierarchy: the deterministic gates (free) already ran above. Run
      // the host CodeRabbit review (a fixed weekly quota — cheaper than agent
      // tokens) BEFORE the reviewer agents, so a CodeRabbit-blocking round
      // never spends reviewer-agent tokens. We trade wall-clock (CodeRabbit
      // and its backoff) for tokens, which do not replenish.
      if (CODERABBIT_HOST_REVIEW) {
        const coderabbit = await runCoderabbitHostReview(worktree, `coderabbit:${tag} r${round}`)
        await recordCoderabbitReview(`${tag} r${round}`, coderabbit)
        if (coderabbit.outcome === 'auth') {
          return { id: tag, status: 'fatal-auth', stage: 'review', detail: `CodeRabbit host review is not authenticated: ${coderabbit.detail}`, reviewRounds, worktree, proposals, ...kindExtra }
        }
        if (coderabbit.outcome === 'rate-limited' || coderabbit.outcome === 'error') {
          // Deferred: CodeRabbit could not complete, so fall through to the
          // reviewer agents — they remain the decisive review.
          coderabbitCapture.deferred += 1
          coderabbitDeferred.push(`CodeRabbit review deferred in round ${round} (${coderabbit.outcome} after ${coderabbit.attempts} attempt(s)): ${coderabbit.detail}`)
          log(`[task ${tag}] CodeRabbit host review deferred in round ${round}: ${coderabbit.outcome} (${coderabbit.detail})`)
        } else {
          const coderabbitBlocking = coderabbitBlockingItems(coderabbit.findings)
          log(`[task ${tag}] CodeRabbit host review round ${round}: ${coderabbit.findings.length} finding(s), ${coderabbitBlocking.length} blocking`)
          if (coderabbitBlocking.length) {
            // Short-circuit before the reviewer agents: fix the CodeRabbit
            // blockers first, spending zero agent tokens this round.
            reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: coderabbitBlocking, ...(hostGates ? { hostGates: hostGates.results } : {}), fix: null })
            if (round === MAX_REVIEW_ROUNDS) break
            const crFix = await dispatchFixAndVerify(task, worktree, plan, coderabbitBlocking, `fix:${tag} r${round}`, round)
            reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(crFix.report)
            if (crFix.dirtyDetail) {
              return { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the CodeRabbit-fix round left uncommitted state (${crFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra }
            }
            continue
          }
        }
      }
      // Reviewer agents (tokens — the scarcest resource) run only once the
      // free gates and the cheaper CodeRabbit review are clean this round.
      // parallel() resolves a thrown thunk to null, which would make an adapter
      // timeout indistinguishable from a reviewer that returned nothing — so
      // each reviewer retries infra faults and records any residual one here.
      const reviewInfraFaults: string[] = []
      const runReviewAgent = (promptText: string, reviewPhase: string, label: string) => () =>
        withInfraRetry(() => agent(promptText, reviewAgentOptions({ phase: reviewPhase, label, schema: REVIEW_SCHEMA })), label)
          .catch((error) => {
            const message = ((error as Error | null) && (error as Error).message) || String(error)
            if (!infrastructureFailureDetail(message)) throw error
            reviewInfraFaults.push(`${label}: ${message}`)
            return null
          })
      const [codeReview, expertReview] = (await parallel([
        runReviewAgent(codeReviewPrompt(task, worktree, plan), 'Code Review', `code-review:${tag} r${round}`),
        runReviewAgent(expertReviewPrompt(task, worktree, plan), 'Expert Review', `expert-review:${tag} r${round}`),
      ])) as Array<StageReview | null>
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
      const roundRecord: Record<string, unknown> = { round, codeReview: summarizeReviewVerdict(codeReview), expertReview: summarizeReviewVerdict(expertReview), blocking, ...(hostGates ? { hostGates: hostGates.results } : {}), fix: null }
      reviewRounds.push(roundRecord)
      if (blocking.length === 0 && codeReview?.verdict === 'pass' && expertReview?.verdict === 'pass') {
        reviewsPass = true
        log(`[task ${tag}] dual review passed in round ${round}`)
        break
      }
      log(`[task ${tag}] review round ${round}: ${blocking.length} blocking item(s)`)
      if (round === MAX_REVIEW_ROUNDS) break
      // Same durability contract as implementation: a review fix that leaves
      // the worktree dirty is unreviewable and squash-merge-lost, so fail
      // closed before the next review round or integration.
      const fix = await dispatchFixAndVerify(task, worktree, plan, blocking, `fix:${tag} r${round}`, round)
      roundRecord.fix = summarizeFixReport(fix.report)
      if (fix.dirtyDetail) {
        return { id: tag, status: 'failed', stage: 'implement', detail: `FIX DURABILITY: the review-fix round left uncommitted state (${fix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra }
      }
    }

    if (!reviewsPass) {
      const lastRound = reviewRounds[reviewRounds.length - 1] as { blocking?: string[] } | undefined
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
    let integration: StageIntegration | null = null
    if (AUTO_MERGE) {
      const attempt = await integrateTask(task, worktree, mergeLock, proposals, kindExtra)
      if (attempt.fault) return attempt.fault
      integration = attempt.integration ?? null
      if (!integration?.ok || !integration.rebased || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
        return { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+rebased+squashMerged+pushed+roadmapMarkedDone)', worktree, proposals, ...kindExtra }
      }
    } else {
      return { id: tag, status: 'manual-merge-ready', plan, impl, integration, worktree, proposals, ...(coderabbitDeferred.length ? { openIssues: coderabbitDeferred } : {}), ...kindExtra }
    }

    return { id: tag, status: 'done', plan, impl, integration, worktree, proposals, ...(coderabbitDeferred.length ? { openIssues: coderabbitDeferred } : {}), ...kindExtra }
  }

  async function runTask(task: SelectedTask, mergeLock: MergeLock): Promise<StageResult> {
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
      const impl = (await buildLock(() => withInfraRetry(() => agent(implementAddendumPrompt(task, worktree), buildAgentOptions({ phase: 'Implement', label: `addendum:${tag}`, schema: IMPL_SCHEMA })), `addendum:${tag}`))) as StageImpl | null
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
      // Host-verified durability gate, same contract as the normal pipeline
      // (finishImplementationStage): ok=true with a dirty worktree means
      // unreviewable, squash-merge-lost work — fail fast with the paths.
      const committed = await verifyWorktreeCommitted(worktree)
      if (!committed.ok) {
        return await attachAssessment(task, wt, { id: tag, status: 'failed', stage: 'addendum', detail: `addendum implementation returned ok but left uncommitted state in the worktree (${committed.detail}); every sub-task must be committed before returning`, openIssues, worktree, proposals: [], kind: 'addendum' })
      }
      const proposals: Array<Record<string, unknown>> = []
      const addendumOpenIssues: string[] = []
      // Host-verified gates: addenda have no review rounds, so a gatesGreen
      // claim the host cannot reproduce fails here, before any review spend.
      if (HOST_COMMIT_GATES) {
        const hostGates = await hostGateLock(() => runHostCommitGates(worktree, tag, 'addendum'))
        if (!hostGates.green) {
          return await attachAssessment(task, wt, { id: tag, status: 'failed', stage: 'addendum', detail: `addendum reported green gates but the host could not reproduce them: ${hostGates.detail}`, openIssues, worktree, proposals, kind: 'addendum' })
        }
      }
      // CodeScene code-health check, after the gates and before CodeRabbit.
      // Addenda have no fix loop, so a regression halts for assessment.
      if (CS_CHECK) {
        const cs = await hostGateLock(() => runCodeSceneCheck(worktree, tag, 'addendum'))
        if (!cs.clean) {
          return await attachAssessment(task, wt, { id: tag, status: 'failed', stage: 'addendum', detail: `addendum committed work with unresolved CodeScene code-health issues: ${cs.detail}`, openIssues, worktree, proposals, kind: 'addendum' })
        }
      }
      // Host-run CodeRabbit review of the committed addendum work. Blocking
      // severities halt the addendum for assessment (addenda have no fix loop);
      // a persistent rate limit or CLI fault defers with a documented open
      // issue, mirroring the dual-review contract.
      if (CODERABBIT_HOST_REVIEW) {
        phase('Code Review')
        const coderabbit = await runCoderabbitHostReview(worktree, `coderabbit:${tag} addendum`)
        await recordCoderabbitReview(`${tag} addendum`, coderabbit)
        if (coderabbit.outcome === 'auth') {
          return { id: tag, status: 'fatal-auth', stage: 'auth', detail: `CodeRabbit host review is not authenticated: ${coderabbit.detail}`, worktree, proposals, kind: 'addendum' }
        }
        const blockingFindings = coderabbitBlockingItems(coderabbit.findings)
        if (blockingFindings.length) {
          return await attachAssessment(task, wt, { id: tag, status: 'halted', stage: 'addendum-review', detail: `CodeRabbit host review found blocking issue(s): ${blockingFindings.join('; ')}`, impl, worktree, proposals, kind: 'addendum' })
        }
        if (coderabbit.outcome === 'rate-limited' || coderabbit.outcome === 'error') {
          coderabbitCapture.deferred += 1
          addendumOpenIssues.push(`CodeRabbit review deferred (${coderabbit.outcome} after ${coderabbit.attempts} attempt(s)): ${coderabbit.detail}`)
          log(`[task ${tag}] CodeRabbit host review deferred for the addendum: ${coderabbit.outcome} (${coderabbit.detail})`)
        }
      }
      let addendumReview: StageReview | null = null
      if (onlyDeferredReviewIssues) {
        phase('Code Review')
        addendumReview = (await withInfraRetry(() => agent(addendumReviewPrompt(task, worktree, impl), reviewAgentOptions({ phase: 'Code Review', label: `addendum-review:${tag}`, schema: REVIEW_SCHEMA })), `addendum-review:${tag}`)) as StageReview | null
        if (addendumReview?.proposedRoadmapItems?.length) {
          proposals.push(...addendumReview.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })))
        }
        const blocking = addendumReview?.blocking || []
        if (!addendumReview || addendumReview.verdict !== 'pass' || blocking.length > 0) {
          return await attachAssessment(task, wt, { id: tag, status: 'halted', stage: 'addendum-review', detail: blocking.join('; ') || addendumReview?.summary || 'addendum fallback review did not pass', impl, addendumReview, worktree, proposals, kind: 'addendum' })
        }
        log(`[task ${tag}] addendum fallback review passed after deferred CodeRabbit review`)
      }
      let integration: StageIntegration | null = null
      if (AUTO_MERGE) {
        const attempt = await integrateTask(task, worktree, mergeLock, proposals, { kind: 'addendum' })
        if (attempt.fault) return attempt.fault
        integration = attempt.integration ?? null
        if (!integration?.ok || !integration.rebased || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
          return await attachAssessment(task, wt, { id: tag, status: 'halted', stage: 'integrate', detail: integration?.conflicts || integration?.summary || 'integration incomplete (need ok+rebased+squashMerged+pushed+roadmapMarkedDone)', worktree, proposals, kind: 'addendum' })
        }
      } else {
        return { id: tag, status: 'manual-merge-ready', impl, addendumReview, integration, worktree, proposals, ...(addendumOpenIssues.length ? { openIssues: addendumOpenIssues } : {}), kind: 'addendum' }
      }
      return { id: tag, status: 'done', impl, addendumReview, integration, worktree, proposals, ...(addendumOpenIssues.length ? { openIssues: addendumOpenIssues } : {}), kind: 'addendum' }
    }

    // --- Plan <-> Design review (adversarial loop) --------------------------
    const planned = await runPlanDesignLoop(task, worktree)
    if (planned.fail) return await attachAssessment(task, wt, planned.fail)
    const plan = planned.plan as StagePlan

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
    const impl = built.impl as StageImpl

    // --- Dual review + integration (shared with review-mode recovery resume) --
    const outcome = await runDualReviewAndIntegration(task, worktree, plan, impl, mergeLock)
    if (outcome.status === 'failed' || outcome.status === 'halted') {
      return await attachAssessment(task, wt, outcome)
    }
    return outcome
    } catch (error) {
      const detail = `unhandled agent error: ${((error as Error | null) && (error as Error).message) || String(error)}`
      const result = resultFromUnhandledAgentError(tag, detail, { worktree })
      return await attachAssessment(task, wt, result)
    }
  }

  return { runPlanDesignLoop, runWorkItemBuildLoop, runImplementationStage, runDualReviewAndIntegration, runTask }
}
