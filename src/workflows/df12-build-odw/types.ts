// Shared runtime shapes for the df12-build-odw module tree. These name the
// structures that cross module boundaries so later peels can `import type`
// them instead of re-deriving the shape from call sites. Only shapes that are
// already observable in the code belong here; speculative fields do not.

// One roadmap checkbox line as parsed by parseRoadmap: `- [x] 1.2.3. Title`.
// Addendum sub-tasks nest under a completed parent via `subtasks`.
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

// A task as selected for the worker pool (normal or addendum lane). For an
// addendum pass, `subtasks` carries the open sub-task ids, not task records.
export interface SelectedTask {
  id: string
  title: string
  requires: string[]
  rationale: string
  isAddendum: boolean
  subtasks: string[]
}

// A surviving roadmap-* branch reconstructed from durable git state by
// fresh-run recovery discovery, enriched with the canonical ExecPlan path
// once the on-disk check has run.
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

// Bounded-cardinality fault counters surfaced verbatim in the run result.
// Fixed keys only — never keyed by task id or error text.
export interface FaultMetrics {
  infraRetries: number
  infraFaults: number
  providerFaults: number
  authFaults: number
  usageLimitFaults: number
}
