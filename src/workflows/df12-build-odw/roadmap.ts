/**
 * Deterministic roadmap parsing and selection. The roadmap markdown is
 * the single source of scheduling truth: checkbox task lines, `Requires`
 * lines (with step ranges), and addendum sub-tasks nested under completed
 * parents. Everything here is pure text-in, data-out; reading the canonical
 * roadmap ref stays with the caller.
 *
 * @module
 */
import type { RoadmapTask, SelectedTask } from './types.ts'

/** The outcome of {@link selectRoadmapTask}: either the chosen task, or why nothing was selected. */
export interface SelectionResult {
  /** True when `task` was selected; false when every candidate is blocked or already taken. */
  hasTask: boolean
  /** The selected task; present only when `hasTask` is true. */
  task?: SelectedTask
  /** IDs of the remaining unblocked candidates not selected, in scheduling order (addendum candidates suffixed `(addendum)`). */
  remainingUnblocked: string[]
  /** A human-readable summary of blocked candidates and their missing dependencies; empty when none are blocked. */
  blockedSummary: string
}

/** Matches a roadmap checkbox task line, capturing indent, checked state, dotted id, and title. */
export const TASK_LINE_RE = /^(\s*)-\s+\[([ xX])\]\s+(\d+(?:\.\d+)+)\.\s*(.*)$/
/** Matches a `- Requires ...` line nested under a task, capturing the dependency text. */
export const REQUIRES_LINE_RE = /^\s*-\s+Requires\s+(.+?)\.?\s*$/
/** Matches a `steps X.Y-X.Z` range phrase within `Requires` text, for expansion into individual ids. */
export const STEP_RANGE_RE = /\bsteps?\s+(\d+\.\d+)\s*-\s*(\d+\.\d+)\b/gi
/** Matches a dotted roadmap task id (e.g. `1.2.3`) anywhere in free text. */
export const ROADMAP_ID_RE = /\b\d+(?:\.\d+)+\b/g

/**
 * One canonical sanitizer for roadmap ids in branch and file names:
 * `1.2.3` -> `1-2-3` (used for roadmap-* branches, execplan leaf names, and
 * integrate-* temp branches).
 */
export function roadmapIdSlug(id: unknown): string {
  return String(id).replace(/[^0-9a-zA-Z]+/g, '-')
}

/** The parent id of a dotted roadmap id (`1.2.3` -> `1.2`), or `''` for a top-level id. */
export function parentIdOf(id: string): string {
  const parts = id.split('.')
  return parts.length > 1 ? parts.slice(0, -1).join('.') : ''
}

/** Whether a task or subtask's checkbox is ticked (case-insensitive `x`); tolerant of a missing task. */
export function isComplete(task: { checked?: string } | null | undefined): boolean {
  return task?.checked?.toLowerCase() === 'x'
}

/**
 * Every roadmap id referenced in free text, with `steps X.Y-X.Z` range
 * phrases expanded into their constituent ids rather than left as the two
 * range endpoints.
 */
export function extractRoadmapIds(text: string): string[] {
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

/**
 * Expand a `steps X.Y-X.Z` range into its constituent ids. Returns `[]` for a
 * malformed or cross-phase range (differing phase numbers, non-integer
 * steps, or a start after the end) rather than throwing, so a caller parsing
 * free text can simply skip the phrase.
 */
export function expandStepRange(start: string, end: string): string[] {
  if (!/^\d+\.\d+$/.test(start) || !/^\d+\.\d+$/.test(end)) return []
  const startParts = start.split('.').map(Number)
  const endParts = end.split('.').map(Number)
  if (startParts.length !== 2 || endParts.length !== 2 || startParts[0] !== endParts[0]) return []
  const [phaseId, firstStep] = startParts
  const lastStep = endParts[1]
  if (!Number.isInteger(phaseId) || !Number.isInteger(firstStep) || !Number.isInteger(lastStep) || firstStep > lastStep) return []
  return Array.from({ length: lastStep - firstStep + 1 }, (_, index) => `${phaseId}.${firstStep + index}`)
}

/**
 * Parse the roadmap markdown into an ordered task list and the set of
 * completed ids. An addendum sub-task is nested under its parent's
 * `subtasks` (not the top-level `tasks` array) when the parent is already
 * complete and the sub-task line is indented deeper than it — the convention
 * for post-completion follow-up work.
 */
export function parseRoadmap(text: string): {
  /** Top-level tasks in roadmap order; addendum sub-tasks are nested under their parent, not listed here. */
  tasks: RoadmapTask[]
  /** IDs treated as complete: fully-ticked tasks, ticked addendum sub-tasks, and prefix ids whose whole subtree is complete. */
  completed: Set<string>
} {
  const tasks: RoadmapTask[] = []
  const byId = new Map<string, RoadmapTask>()
  let currentTask: RoadmapTask | null = null

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const taskMatch = line.match(TASK_LINE_RE)
    if (taskMatch) {
      const [, indent, checked, id, rawTitle] = taskMatch
      const task: RoadmapTask = {
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

/**
 * Derive the completed-id set from a task list: each fully-complete task and
 * its ticked subtasks, plus every dotted-prefix id whose entire subtree
 * (every task sharing that prefix) is fully complete — so a phase id like
 * `1` counts as complete once all of `1.1`, `1.2`, … are.
 */
export function completedIds(tasks: readonly RoadmapTask[]): Set<string> {
  const completed = new Set<string>()
  const prefixes = new Map<string, RoadmapTask[]>()

  for (const task of tasks) {
    if (isTaskFullyComplete(task)) completed.add(task.id)
    for (const subtask of task.subtasks || []) {
      if (isComplete(subtask)) completed.add(subtask.id)
    }
    const parts = task.id.split('.')
    for (let length = 1; length < parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('.')
      if (!prefixes.has(prefix)) prefixes.set(prefix, [])
      prefixes.get(prefix)!.push(task)
    }
  }

  for (const [prefix, groupedTasks] of prefixes.entries()) {
    if (groupedTasks.length && groupedTasks.every(isTaskFullyComplete)) completed.add(prefix)
  }

  return completed
}

/** A task is fully complete only when its own checkbox AND every addendum subtask are ticked. */
export function isTaskFullyComplete(task: RoadmapTask): boolean {
  return isComplete(task) && task.subtasks.every(isComplete)
}

/**
 * Whether a candidate matches the `--only` task filter: no filter selects
 * everything; otherwise the candidate's own id or one of its addendum
 * subtask ids must match, so `--only` on a parent still surfaces its open
 * addendum work.
 */
export function taskMatchesOnlyTask(candidate: { task: SelectedTask }, onlyTask: string | null): boolean {
  if (!onlyTask) return true
  if (candidate.task.id === onlyTask) return true
  return Boolean(candidate.task.subtasks?.includes(onlyTask))
}

/** Render up to five blocked-task reasons plus an overflow count; `''` when nothing is blocked. */
export function blockedSummary(blocked: readonly string[]): string {
  if (!blocked.length) return ''
  const sample = blocked.slice(0, 5).join('; ')
  const suffix = blocked.length > 5 ? `; ${blocked.length - 5} more` : ''
  return `${blocked.length} blocked task(s): ${sample}${suffix}`
}

/**
 * Choose the next task to run: normal tasks whose dependencies are all
 * complete, or addendum passes on tasks that are complete but still have
 * open sub-tasks, excluding whatever `taken` already claims (so concurrent
 * task pipelines do not double-select). Candidates are ordered by roadmap
 * line number so scheduling matches document order.
 */
export function selectRoadmapTask(
  roadmapText: string,
  taken: { normal?: readonly string[]; addendum?: readonly string[] } | null | undefined,
  onlyTask: string | null,
): SelectionResult {
  const { tasks, completed } = parseRoadmap(roadmapText)
  const normalTaken = new Set(taken?.normal || [])
  const addendumTaken = new Set(taken?.addendum || [])
  const candidates: Array<{ order: number; kind: 'normal' | 'addendum'; task: SelectedTask }> = []
  const blocked: string[] = []

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

  const matchingCandidates = candidates
    .filter((candidate) => taskMatchesOnlyTask(candidate, onlyTask))
    .sort((left, right) => left.order - right.order)
  const selected = matchingCandidates[0]
  if (!selected) {
    const reason = onlyTask
      ? `Task ${onlyTask} is not currently unblocked as a normal task or addendum pass. ${blockedSummary(blocked)}`
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

/** A lookup from id to task for every top-level task AND every addendum subtask, for O(1) id resolution. */
export function roadmapTaskIndex(roadmapText: string): Map<string, RoadmapTask> {
  const { tasks } = parseRoadmap(roadmapText)
  const byId = new Map<string, RoadmapTask>()
  for (const task of tasks) {
    byId.set(task.id, task)
    for (const subtask of task.subtasks || []) byId.set(subtask.id, subtask)
  }
  return byId
}

/**
 * A normal branch is stale once its task checkbox is ticked; an addendum
 * branch is stale once the parent AND every addendum sub-task are ticked.
 */
export function candidateRoadmapComplete(task: RoadmapTask, isAddendum: boolean): boolean {
  if (!isAddendum) return isComplete(task)
  return isTaskFullyComplete(task)
}
