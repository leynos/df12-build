/**
 * @file Shared runtime shapes for the df12-build-odw module tree. These name the
 * structures that cross module boundaries so peeled-out modules can `import type`
 * them instead of re-deriving the shape from call sites. Only shapes already
 * observable in the code belong here; speculative fields do not. Pure type
 * declarations — no runtime code — imported by roadmap parsing, recovery, the
 * fault classifiers (faults.ts owns the `FaultMetrics` value), and the entry.
 */

/**
 * One roadmap checkbox line as parsed by `parseRoadmap` (`- [x] 1.2.3. Title`).
 * Addendum sub-tasks nest under a completed parent via `subtasks`; `checked` is
 * the raw marker character so callers can distinguish done from in-progress.
 */
export interface RoadmapTask {
  id: string
  checked: string
  title: string
  requires: string[]
  line: number
  indent: number
  subtasks: RoadmapTask[]
  parentId?: string
  isAddendumSubtask?: boolean
}

/**
 * A task as selected for the worker pool (normal or addendum lane). For an
 * addendum pass, `subtasks` carries the open sub-task ids (strings), not full
 * task records, and `isAddendum` routes the task down the addendum pipeline.
 */
export interface SelectedTask {
  id: string
  title: string
  requires: string[]
  rationale: string
  isAddendum: boolean
  subtasks: string[]
}

/**
 * A surviving `roadmap-*` branch reconstructed from durable git state by
 * fresh-run recovery discovery, enriched with the canonical ExecPlan path once
 * the on-disk check has run. `baseCommit`/`currentCommit` bound the branch's
 * work so the assessment can judge what landed.
 */
export interface RecoveryCandidate {
  taskId: string
  taskTitle: string
  branchName: string
  worktreePath: string
  baseCommit: string
  currentCommit: string
  roadmapComplete: boolean
  isAddendum: boolean
  line: number
  execplanPath?: string
}

/**
 * Bounded-cardinality fault counters surfaced verbatim in the run result: the
 * `*Retries` keys count retry attempts, the `*Faults` keys count terminal
 * classifications. Fixed keys only — never keyed by task id or error text — so
 * the metric cardinality stays constant. The live counter lives in faults.ts.
 */
export interface FaultMetrics {
  infraRetries: number
  providerRetries: number
  infraFaults: number
  providerFaults: number
  authFaults: number
}
