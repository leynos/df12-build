/**
 * JSON Schema contracts for every structured agent hand-off in the
 * df12-build-odw workflow: plan, design verdict, implementation, dual review,
 * fix rounds, integration, post-merge audit, and the ADR 002 partial-branch
 * assessment. Downstream JavaScript dereferences `required` fields without
 * optional chaining, and iterates keys assuming `additionalProperties` is
 * false, so treat these as contracts, not documentation;
 * tests/modules/schemas.test.ts pins them.
 *
 * @module
 */
/** @internal */
export const PLAN_SCHEMA = {
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
/**
 * The design-review verdict on a submitted plan: whether the plan is
 * implementable, design-conformant, and complete (`satisfied`), and the
 * must-fix defects that block acceptance (`blocking`, empty iff satisfied).
 * Downstream JavaScript dereferences `required` fields and assumes
 * `additionalProperties: false`, so treat this as a contract, not
 * documentation.
 */
/** @internal */
export const DESIGN_VERDICT_SCHEMA = {
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
/**
 * The implementation agent's report on a completed round of work: `ok`,
 * `gatesGreen`, a `summary`, and any `openIssues` left unresolved, keyed to
 * the `execplanPath` driving the round. Downstream JavaScript dereferences
 * `required` fields and assumes `additionalProperties: false`, so treat this
 * as a contract, not documentation.
 */
/** @internal */
export const IMPL_SCHEMA = {
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

/**
 * A reviewer's verdict on the implementation: `verdict` (pass or
 * changes-requested), `blocking` items that must be fixed before the task is
 * done, and a `summary`. Downstream JavaScript dereferences `required`
 * fields and assumes `additionalProperties: false`, so treat this as a
 * contract, not documentation.
 */
/** @internal */
export const REVIEW_SCHEMA = {
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

/**
 * A fix round's report, returned after a reviewer's blocking items are
 * addressed: `gatesGreen`, a `summary`, and how each blocking item was
 * `resolved`. Without this structured contract, the gate and CodeRabbit
 * evidence a fix agent produces evaporates with its transcript, and a later
 * assessment of the branch cannot see that the workflow already
 * re-validated the current tip (issue #24). Downstream JavaScript
 * dereferences `required` fields and assumes `additionalProperties: false`,
 * so treat this as a contract, not documentation.
 */
/** @internal */
export const FIX_SCHEMA = {
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

/**
 * The integration agent's claim about landing the branch: whether it
 * succeeded (`ok`), was `rebased`, `squashMerged`, and `pushed`, and whether
 * the roadmap entry was marked done (`roadmapMarkedDone`). Downstream
 * JavaScript dereferences `required` fields and assumes
 * `additionalProperties: false`, so treat this as a contract, not
 * documentation.
 */
/** @internal */
export const INTEGRATE_SCHEMA = {
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
  required: ['ok', 'roadmapMarkedDone', 'rebased', 'squashMerged', 'pushed', 'summary'],
}

/**
 * The post-merge audit's findings on the integrated change: categorized
 * `findings` (each with `category`, `location`, `description`, and
 * `proposedFix`) and a `summary`. Downstream JavaScript dereferences
 * `required` fields and assumes `additionalProperties: false`, so treat
 * this as a contract, not documentation.
 */
/** @internal */
export const AUDIT_SCHEMA = {
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

/**
 * The enum of allowed classification strings for an ADR 002 partial-branch
 * assessment: `adopt-complete`, `adopt-partial`, `continue-manual`, and
 * `discard`. Referenced by `ASSESSMENT_SCHEMA`'s `classification` property,
 * so treat this as a contract, not documentation.
 */
export const ASSESSMENT_CLASSIFICATIONS = [
  'adopt-complete',
  'adopt-partial',
  'continue-manual',
  'discard',
]

/**
 * The ADR 002 partial-branch assessment: the resume `classification`,
 * branch/worktree identity, and two carry-forward channels — the
 * `missingEvidence` BLOCKING channel (genuinely missing validation/review
 * evidence that must prevent an adopt-complete resume) and the
 * `residualRisk` ADVISORY channel (non-blocking risk threaded to
 * review/integration context that must not downgrade an otherwise-eligible
 * adopt-complete resume). Downstream JavaScript dereferences `required`
 * fields and assumes `additionalProperties: false`, so treat this as a
 * contract, not documentation.
 */
/** @internal */
export const ASSESSMENT_SCHEMA = {
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
    missingEvidence: { type: 'array', items: { type: 'string' }, description: 'BLOCKING evidence gaps: genuinely missing validation/review evidence that must prevent an adopt-complete resume' },
    residualRisk: { type: 'array', items: { type: 'string' }, description: 'ADVISORY, non-blocking residual risk carried forward as review/integration context; must NOT downgrade an otherwise-eligible adopt-complete resume' },
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
    'residualRisk',
    'risks',
    'rationale',
    'recommendation',
    'nextActions',
  ],
}
