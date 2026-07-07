// Property tests for the recovery-decision module. The decision tables are
// safety boundaries — a wrong 'resume' can spend agents on, or mutate, a
// branch that should have been parked — so the invariants are checked over
// generated input space rather than hand-picked examples.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  EXECPLAN_STATUS_MAP,
  TASK_BRANCH_RE,
  branchToRoadmapId,
  parseExecplanState,
  parseWorktreeList,
  recoveryContinueDecision,
  recoveryDecision,
  recoveryResumeEligibility,
} from '../../src/workflows/df12-build-odw/recovery-decision.ts'

const idParts = fc.array(fc.nat(99), { minLength: 1, maxLength: 5 })

const candidateArb = fc.record({
  isAddendum: fc.boolean(),
  execplanPath: fc.oneof(fc.constant(''), fc.constant('docs/execplans/roadmap-1-2-3.md')),
})

const evidenceArb = fc.record({
  collectionErrors: fc.array(fc.string(), { maxLength: 2 }),
  dirtyState: fc.constantFrom('clean', 'dirty', 'unknown', ''),
  recentCommits: fc.array(fc.string(), { maxLength: 3 }),
})

const assessmentArb = fc.record({
  classification: fc.constantFrom('adopt-complete', 'continue-manual', 'restart', 'abandon', ''),
  taskScoped: fc.oneof(fc.boolean(), fc.constant(undefined)),
  validation: fc.constantFrom('gates green: make all', '   ', ''),
  missingEvidence: fc.array(fc.string(), { maxLength: 2 }),
  // Advisory residual risk is generated but must never affect the decision
  // (issue #23); it is deliberately absent from the abstraction below.
  residualRisk: fc.array(fc.string(), { maxLength: 2 }),
})

const flagsArb = fc.record({ dryRun: fc.boolean() })

describe('branchToRoadmapId', () => {
  test('parses every well-formed task branch back to its roadmap id', () => {
    fc.assert(
      fc.property(idParts, fc.boolean(), (parts, isAddendum) => {
        const branch = `roadmap-${parts.join('-')}${isAddendum ? '-addendum' : ''}`
        expect(branchToRoadmapId(branch)).toEqual({ id: parts.join('.'), isAddendum })
      }),
    )
  })

  test('any accepted string round-trips back to the same branch name', () => {
    fc.assert(
      fc.property(fc.string(), (branch) => {
        const parsed = branchToRoadmapId(branch)
        if (parsed === null) {
          expect(TASK_BRANCH_RE.test(branch)).toBe(false)
        } else {
          const rebuilt = `roadmap-${parsed.id.replace(/\./g, '-')}${parsed.isAddendum ? '-addendum' : ''}`
          expect(rebuilt).toBe(branch)
        }
      }),
    )
  })
})

describe('parseWorktreeList', () => {
  const entryArb = fc.record({
    worktreePath: fc
      .stringMatching(/^[A-Za-z0-9._/ -]+$/)
      .filter((s) => s.trim().length > 0),
    head: fc.stringMatching(/^[0-9a-f]{7,40}$/),
    branch: fc.oneof(fc.constant(''), fc.stringMatching(/^[A-Za-z0-9._/-]+$/)),
  })

  test('round-trips rendered porcelain output, including detached worktrees', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 5 }), (entries) => {
        const porcelain = entries
          .map(
            (entry) =>
              `worktree ${entry.worktreePath}\nHEAD ${entry.head}\n` +
              (entry.branch ? `branch refs/heads/${entry.branch}\n` : 'detached\n'),
          )
          .join('\n')
        expect(parseWorktreeList(porcelain)).toEqual(entries)
      }),
    )
  })
})

describe('parseExecplanState', () => {
  test('maps every documented status token regardless of case and padding', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(EXECPLAN_STATUS_MAP)),
        fc.boolean(),
        fc.nat(4),
        (token, upper, pad) => {
          const rendered = upper ? token.toUpperCase() : token
          const text = `# Plan\n\nStatus: ${rendered}${' '.repeat(pad)}\n`
          expect(parseExecplanState(text).status).toBe(
            EXECPLAN_STATUS_MAP[token as keyof typeof EXECPLAN_STATUS_MAP],
          )
        },
      ),
    )
  })

  test('tallies progress checkboxes exactly, ignoring other sections', () => {
    fc.assert(
      fc.property(fc.nat(6), fc.nat(6), (ticked, unticked) => {
        const progress = [
          ...Array.from({ length: ticked }, (_, i) => `- [x] step ${i}`),
          ...Array.from({ length: unticked }, (_, i) => `- [ ] step t${i}`),
        ].join('\n')
        const text = `# Plan\n\nStatus: DRAFT\n\n## Notes\n\n- [x] not progress\n\n## Progress\n\n${progress}\n`
        const state = parseExecplanState(text)
        expect(state.status).toBe('draft')
        expect(state.ticked).toBe(ticked)
        expect(state.unticked).toBe(unticked)
        expect(state.items).toHaveLength(ticked + unticked)
        expect(state.items.filter((item) => item.ticked)).toHaveLength(ticked)
      }),
    )
  })
})

describe('recoveryDecision fail-closed invariants', () => {
  test('resume requires review mode, adopt-complete, clean eligibility, and no dry-run', () => {
    fc.assert(
      fc.property(
        candidateArb,
        evidenceArb,
        assessmentArb,
        fc.constantFrom('assess', 'review', 'continue', ''),
        flagsArb,
        (candidate, evidence, assessment, mode, flags) => {
          const decision = recoveryDecision(candidate, evidence, assessment, mode, flags)
          expect(['report', 'resume']).toContain(decision.action)
          if (decision.action === 'resume') {
            expect(mode).toBe('review')
            expect(assessment.classification).toBe('adopt-complete')
            expect(flags.dryRun).toBe(false)
            expect(recoveryResumeEligibility(candidate, evidence, assessment)).toBe('')
          }
          if (decision.skip) expect(decision.action).toBe('report')
        },
      ),
    )
  })
})

describe('recoveryContinueDecision fail-closed invariants', () => {
  const planStateArb = fc.record({
    status: fc.constantFrom(
      'draft',
      'approved',
      'in-progress',
      'blocked',
      'complete',
      'missing',
      'unreadable',
      'unknown',
    ),
    ticked: fc.nat(9),
    unticked: fc.nat(9),
  })

  test('resume requires clean hygiene and dispatches only to a valid stage', () => {
    fc.assert(
      fc.property(candidateArb, evidenceArb, planStateArb, flagsArb, (candidate, evidence, planState, flags) => {
        const decision = recoveryContinueDecision(candidate, evidence, planState, flags)
        if (decision.action === 'resume') {
          expect(candidate.isAddendum).toBe(false)
          expect(evidence.collectionErrors).toEqual([])
          expect(evidence.dirtyState).toBe('clean')
          expect(flags.dryRun).toBe(false)
          expect(['plan', 'implement', 'review']).toContain(decision.stage as string)
          expect(['blocked', 'unreadable']).not.toContain(planState.status)
          if (decision.stage === 'review') expect(evidence.recentCommits.length).toBeGreaterThan(0)
        } else {
          expect(decision.action).toBe('report')
          expect(decision.skip).toBe(true)
        }
      }),
    )
  })
})
