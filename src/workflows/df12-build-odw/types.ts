/**
 * Shared runtime shapes for the df12-build-odw module tree. These name
 * the structures that cross module boundaries so later peels can `import
 * type` them instead of re-deriving the shape from call sites. Only shapes
 * that are already observable in the code belong here; speculative fields do
 * not.
 *
 * @module
 */

/**
 * One roadmap checkbox line as parsed by `parseRoadmap`: `- [x] 1.2.3.
 * Title`. Addendum sub-tasks nest under a completed parent via `subtasks`.
 */
export interface RoadmapTask {
  /** Dotted roadmap id, e.g. `1.2.3`, as it appears in the checkbox line. */
  id: string
  /** Raw checkbox mark (`x`, `X`, or a blank/other character); compare case-insensitively via `isComplete`. */
  checked: string
  /** Task title text following the checkbox and id. */
  title: string
  /** Ids of other roadmap tasks this one depends on, deduplicated. */
  requires: string[]
  /** 1-based source line number of the checkbox in the roadmap file. */
  line: number
  /** Leading whitespace width of the checkbox line, used to detect addendum nesting under a completed parent. */
  indent: number
  /** Addendum sub-tasks nested under this (completed) task, if any. */
  subtasks: RoadmapTask[]
  /** Id of the completed parent task, set only when this task is an addendum sub-task. */
  parentId?: string
  /** True when this task was discovered nested under a completed parent rather than at the top level. */
  isAddendumSubtask?: boolean
}

/**
 * A task as selected for the worker pool (normal or addendum lane). For an
 * addendum pass, `subtasks` carries the open sub-task ids, not task records.
 */
export interface SelectedTask {
  /** Dotted roadmap id of the selected task. */
  id: string
  /** Task title, carried through from the source `RoadmapTask`. */
  title: string
  /** Ids of dependencies that were confirmed complete before selection. */
  requires: string[]
  /** Human-readable explanation of why the task was eligible for selection. */
  rationale: string
  /** True when this selection belongs to the addendum lane rather than the normal task lane. */
  isAddendum: boolean
  /** Open sub-task ids awaiting completion (addendum lane only; empty otherwise). */
  subtasks: string[]
}

/**
 * A surviving roadmap-* branch reconstructed from durable git state by
 * fresh-run recovery discovery, enriched with the canonical ExecPlan path
 * once the on-disk check has run.
 */
export interface RecoveryCandidate {
  /** Dotted roadmap id the branch was working on. */
  taskId: string
  /** Task title recovered from the roadmap for operator-facing reporting. */
  taskTitle: string
  /** Name of the surviving `roadmap-*` git branch. */
  branchName: string
  /** Filesystem path of the branch's worktree, if one still exists. */
  worktreePath: string
  /** Commit the branch diverged from, used to bound evidence collection. */
  baseCommit: string
  /** Latest commit on the branch at discovery time. */
  currentCommit: string
  /** Whether the roadmap already marks this task's checkbox complete. */
  roadmapComplete: boolean
  /** True when the candidate belongs to the addendum lane. */
  isAddendum: boolean
  /** Source line number of the task's checkbox in the roadmap file. */
  line: number
  /** Path to the committed ExecPlan for this task, once the on-disk check confirms it exists. */
  execplanPath?: string
}

/**
 * Bounded-cardinality fault counters surfaced verbatim in the run result.
 * Fixed keys only — never keyed by task id or error text.
 */
export interface FaultMetrics {
  /** Count of infrastructure-fault retries attempted (not necessarily all successful). */
  infraRetries: number
  /** Count of terminal infrastructure faults (retry budget exhausted or non-retryable). */
  infraFaults: number
  /** Count of terminal provider faults (rate limiting, gateway/server errors). */
  providerFaults: number
  /** Count of terminal authentication faults. */
  authFaults: number
}
