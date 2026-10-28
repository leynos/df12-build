/** Validate pipeline results before the pool reads optional result fields.
 * @module
 */
import type { StageResult } from './run-task.ts'
import type { SalvageRecord } from './assessment.ts'

/** A pipeline result with the optional fields consumed by the worker pool. */
export interface TaskOutcome extends StageResult {
  /** Integration details used to determine whether the task was pushed. */
  integration?: {
    /** Whether integration pushed the task to the target branch. */
    pushed?: boolean
  } | null
  /** Task kind, including the addendum marker used to skip recursive audit. */
  kind?: string
  /** Proposed roadmap items awaiting triage. */
  proposals?: Record<string, unknown>[]
  /** Assessment details attached to a failed task. */
  assessment?: Record<string, unknown>
  /** Error encountered while assessing the task. */
  assessmentError?: string
  /** Evidence of artefacts salvaged from the task branch. */
  salvage?: SalvageRecord
}

function isOutcomeRecord<T>(value: T): value is T & Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject malformed optional fields without dropping unrelated result data. */
export function checkedTaskOutcome(result: StageResult): TaskOutcome {
  const { integration, kind, proposals, assessment, assessmentError, salvage } = result
  const validIntegration = integration === undefined || integration === null ||
    (isOutcomeRecord(integration) && (integration.pushed === undefined || typeof integration.pushed === 'boolean'))
  const validProposals = proposals === undefined || (Array.isArray(proposals) && proposals.every((item: unknown) => isOutcomeRecord(item)))
  const validSalvage = salvage === undefined || (isOutcomeRecord(salvage) &&
    typeof salvage.classification === 'string' && typeof salvage.sha === 'string' && typeof salvage.detail === 'string' &&
    Array.isArray(salvage.committed) && salvage.committed.every((item: unknown) => typeof item === 'string') &&
    Array.isArray(salvage.skipped) && salvage.skipped.every((item: unknown) =>
      isOutcomeRecord(item) && typeof item.path === 'string' && typeof item.reason === 'string'))
  if (!validIntegration || !validProposals || !validSalvage ||
      (kind !== undefined && typeof kind !== 'string') ||
      (assessment !== undefined && !isOutcomeRecord(assessment)) ||
      (assessmentError !== undefined && typeof assessmentError !== 'string')) {
    throw new Error('Invalid task outcome')
  }
  // SAFETY: The checks above validate every optional field read by the pool;
  // StageResult already guarantees the required id and status fields.
  return result as TaskOutcome
}
