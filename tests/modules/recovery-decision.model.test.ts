// Differential test pinning the Dafny-verified twin (verify/
// recovery-decision.model.ts) to the production decision tables. The twin's
// theorems only transfer to production if the two implementations agree, so
// fast-check drives both through the same abstracted input space and demands
// field-for-field equal verdicts.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  recoveryContinueDecision,
  recoveryDecision,
} from '../../src/workflows/df12-build-odw/recovery-decision.ts'
import { decideContinue, decideReview } from '../../verify/recovery-decision.model'

const CLASSIFICATION = {
  'adopt-complete': 'AdoptComplete',
  'continue-manual': 'ContinueManual',
  restart: 'Restart',
  abandon: 'Abandon',
  '': 'NoClassification',
} as const

const MODE = { assess: 'Assess', review: 'Review', continue: 'Continue', '': 'OtherMode' } as const

const STATUS = {
  draft: 'Draft',
  approved: 'Approved',
  'in-progress': 'InProgress',
  blocked: 'Blocked',
  complete: 'Complete',
  missing: 'Missing',
  unreadable: 'Unreadable',
  unknown: 'Unknown',
} as const

const ACTION = { report: 'Report', resume: 'Resume' } as const

const REASON = {
  '': 'NoReason',
  'addendum-branch': 'AddendumBranch',
  'evidence-collection-error': 'EvidenceCollectionError',
  'dirty-worktree': 'DirtyWorktree',
  'no-committed-work': 'NoCommittedWork',
  'not-task-scoped': 'NotTaskScoped',
  'missing-validation-evidence': 'MissingValidationEvidence',
  'missing-execplan': 'MissingExecplan',
  'plan-unreadable': 'PlanUnreadable',
  'plan-blocked': 'PlanBlocked',
  'dry-run': 'DryRun',
} as const

const STAGE = { plan: 'PlanStage', implement: 'ImplementStage', review: 'ReviewStage' } as const

const candidateArb = fc.record({
  isAddendum: fc.boolean(),
  execplanPath: fc.constantFrom('', 'docs/execplans/roadmap-1-2-3.md'),
})

const evidenceArb = fc.record({
  collectionErrors: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
  dirtyState: fc.constantFrom('clean', 'dirty', 'unknown', ''),
  recentCommits: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
})

const assessmentArb = fc.record({
  classification: fc.constantFrom(...(Object.keys(CLASSIFICATION) as Array<keyof typeof CLASSIFICATION>)),
  taskScoped: fc.oneof(fc.boolean(), fc.constant(undefined)),
  validation: fc.constantFrom('gates green: make all', '   ', ''),
  missingEvidence: fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }),
})

type ProdCandidate = typeof candidateArb extends fc.Arbitrary<infer T> ? T : never
type ProdEvidence = typeof evidenceArb extends fc.Arbitrary<infer T> ? T : never
type ProdAssessment = typeof assessmentArb extends fc.Arbitrary<infer T> ? T : never

const abstractCandidate = (candidate: ProdCandidate) => ({
  isAddendum: candidate.isAddendum,
  hasExecplan: candidate.execplanPath !== '',
})

const abstractEvidence = (evidence: ProdEvidence) => ({
  hasCollectionErrors: evidence.collectionErrors.length > 0,
  isClean: evidence.dirtyState === 'clean',
  hasCommits: evidence.recentCommits.length > 0,
})

const abstractAssessment = (assessment: ProdAssessment) => ({
  classification: CLASSIFICATION[assessment.classification],
  taskScoped: assessment.taskScoped === true,
  hasValidation: assessment.validation.trim() !== '',
  hasMissingEvidence: assessment.missingEvidence.length > 0,
})

describe('verified twin ≡ production decision tables', () => {
  test('review-mode: decideReview agrees with recoveryDecision on every field', () => {
    fc.assert(
      fc.property(
        candidateArb,
        evidenceArb,
        assessmentArb,
        fc.constantFrom(...(Object.keys(MODE) as Array<keyof typeof MODE>)),
        fc.boolean(),
        (candidate, evidence, assessment, mode, dryRun) => {
          const production = recoveryDecision(candidate, evidence, assessment, mode, { dryRun })
          const twin = decideReview(
            abstractCandidate(candidate),
            abstractEvidence(evidence),
            abstractAssessment(assessment),
            MODE[mode],
            dryRun,
          )
          expect(ACTION[production.action as keyof typeof ACTION]).toBe(twin.action)
          expect(production.skip).toBe(twin.skip)
          expect(REASON[production.reason as keyof typeof REASON]).toBe(twin.reason)
          expect(CLASSIFICATION[production.classification as keyof typeof CLASSIFICATION]).toBe(twin.classification)
        },
      ),
    )
  })

  test('continue-mode: decideContinue agrees with recoveryContinueDecision on every field', () => {
    fc.assert(
      fc.property(
        candidateArb,
        evidenceArb,
        fc.constantFrom(...(Object.keys(STATUS) as Array<keyof typeof STATUS>)),
        fc.boolean(),
        (candidate, evidence, status, dryRun) => {
          const production = recoveryContinueDecision(candidate, evidence, { status, ticked: 0, unticked: 0 }, { dryRun })
          const twin = decideContinue(abstractCandidate(candidate), abstractEvidence(evidence), STATUS[status], dryRun)
          expect(ACTION[production.action as keyof typeof ACTION]).toBe(twin.action)
          expect(production.skip).toBe(twin.skip)
          expect(REASON[production.reason as keyof typeof REASON]).toBe(twin.reason)
          const productionStage =
            production.stage === null ? 'NoStage' : STAGE[production.stage as keyof typeof STAGE]
          expect(productionStage).toBe(twin.stage)
        },
      ),
    )
  })
})
