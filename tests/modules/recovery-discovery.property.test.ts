// Property tests for the pure held-set computation the always-on stale-branch
// guard (issue #33) depends on. computeHeldFromDiscovery maps a discovery to the
// roadmap ids whose surviving branch must be held out of ordinary selection, so
// its lane routing and hold-reason filtering are correctness boundaries: a
// dropped id would let ordinary selection re-open a branch and collide on
// `git worktree add -b`, and a mis-routed lane would free (or hold) the wrong
// task. The invariants are checked over generated discovery results rather than
// hand-picked examples.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import { RECOVERY_HOLD_REASONS, computeHeldFromDiscovery } from '../../src/workflows/df12-build-odw/recovery-discovery.ts'
import { branchToRoadmapId } from '../../src/workflows/df12-build-odw/recovery-decision.ts'
import type { RecoveryDiscovery, RecoverySkip } from '../../src/workflows/df12-build-odw/recovery-discovery.ts'
import type { RecoveryCandidate } from '../../src/workflows/df12-build-odw/types.ts'

const HOLD_REASONS = [...RECOVERY_HOLD_REASONS]
// Reasons the discovery pass emits that must NOT hold their branch.
const NON_HOLD_REASONS = ['unmapped-branch', 'already-complete']

const idPartsArb = fc.array(fc.nat(20), { minLength: 1, maxLength: 3 })
const dottedIdArb = idPartsArb.map((parts) => parts.join('.'))

// A well-formed roadmap branch together with its parsed id and lane.
const mappedBranchArb = fc.record({ parts: idPartsArb, isAddendum: fc.boolean() }).map(({ parts, isAddendum }) => ({
  branchName: `roadmap-${parts.join('-')}${isAddendum ? '-addendum' : ''}`,
  id: parts.join('.'),
  isAddendum,
}))

// Branch names that branchToRoadmapId rejects (unmapped): these must never hold.
const unmappedBranchArb = fc.constantFrom('main', 'roadmap-x', 'feature/parser', 'roadmap-1-2-3-extra', '')

function candidateOf(branchName: string, taskId: string, isAddendum: boolean): RecoveryCandidate {
  return {
    taskId,
    taskTitle: '',
    branchName,
    worktreePath: '',
    baseCommit: '',
    currentCommit: '',
    roadmapComplete: false,
    isAddendum,
    line: 0,
  }
}

const candidateArb: fc.Arbitrary<RecoveryCandidate> = fc.oneof(
  mappedBranchArb.chain((branch) =>
    fc.oneof(fc.constant(''), dottedIdArb).map((taskId) => candidateOf(branch.branchName, taskId, branch.isAddendum)),
  ),
  unmappedBranchArb.map((branchName) => candidateOf(branchName, '', false)),
)

const skipArb: fc.Arbitrary<RecoverySkip> = fc.oneof(
  fc
    .record({ branch: mappedBranchArb, id: fc.oneof(fc.constant(''), dottedIdArb), reason: fc.constantFrom(...HOLD_REASONS, ...NON_HOLD_REASONS) })
    .map(({ branch, id, reason }) => ({ id, branchName: branch.branchName, reason })),
  unmappedBranchArb.map((branchName) => ({ id: '', branchName, reason: 'unmapped-branch' })),
)

const discoveryArb: fc.Arbitrary<RecoveryDiscovery> = fc.record({
  candidates: fc.array(candidateArb, { maxLength: 6 }),
  skipped: fc.array(skipArb, { maxLength: 6 }),
  errors: fc.array(fc.string(), { maxLength: 3 }),
})

describe('computeHeldFromDiscovery (properties)', () => {
  test('a single mapped candidate holds its id in exactly its branch lane', () => {
    fc.assert(
      fc.property(mappedBranchArb, fc.oneof(fc.constant(''), dottedIdArb), (branch, taskId) => {
        const held = computeHeldFromDiscovery({ candidates: [candidateOf(branch.branchName, taskId, branch.isAddendum)], skipped: [], errors: [] })
        const expectedId = taskId || branch.id
        const [thisLane, otherLane] = branch.isAddendum ? [held.addendum, held.normal] : [held.normal, held.addendum]
        expect(thisLane.has(expectedId)).toBe(true)
        expect(otherLane.size).toBe(0)
      }),
    )
  })

  test('a hold-reason skip holds its id in its branch lane; a non-hold reason holds nothing', () => {
    fc.assert(
      fc.property(mappedBranchArb, fc.oneof(fc.constant(''), dottedIdArb), fc.constantFrom(...HOLD_REASONS, ...NON_HOLD_REASONS), (branch, id, reason) => {
        const held = computeHeldFromDiscovery({ candidates: [], skipped: [{ id, branchName: branch.branchName, reason }], errors: [] })
        const expectedId = id || branch.id
        if (RECOVERY_HOLD_REASONS.has(reason)) {
          const lane = branch.isAddendum ? held.addendum : held.normal
          expect(lane.has(expectedId)).toBe(true)
        } else {
          expect(held.normal.size + held.addendum.size).toBe(0)
        }
      }),
    )
  })

  test('unmapped branches are never held, whether candidate or skip', () => {
    fc.assert(
      fc.property(fc.array(unmappedBranchArb, { maxLength: 4 }), fc.array(unmappedBranchArb, { maxLength: 4 }), (candBranches, skipBranches) => {
        const held = computeHeldFromDiscovery({
          candidates: candBranches.map((branchName) => candidateOf(branchName, '', false)),
          skipped: skipBranches.map((branchName) => ({ id: '', branchName, reason: HOLD_REASONS[0] })),
          errors: [],
        })
        expect(held.normal.size + held.addendum.size).toBe(0)
      }),
    )
  })

  test('the held set is invariant to discovery.errors', () => {
    fc.assert(
      fc.property(discoveryArb, fc.array(fc.string(), { maxLength: 4 }), (discovery, extraErrors) => {
        const base = computeHeldFromDiscovery({ ...discovery, errors: [] })
        const withErrors = computeHeldFromDiscovery({ ...discovery, errors: extraErrors })
        expect([...withErrors.normal].sort()).toEqual([...base.normal].sort())
        expect([...withErrors.addendum].sort()).toEqual([...base.addendum].sort())
      }),
    )
  })

  test('every held id is attributable to a mapped contributor in the matching lane (soundness)', () => {
    fc.assert(
      fc.property(discoveryArb, (discovery) => {
        const held = computeHeldFromDiscovery(discovery)
        const eligibleNormal = new Set<string>()
        const eligibleAddendum = new Set<string>()
        const admit = (branchName: string, taskId: string) => {
          const parsed = branchToRoadmapId(branchName)
          if (!parsed) return
          ;(parsed.isAddendum ? eligibleAddendum : eligibleNormal).add(taskId || parsed.id)
        }
        for (const candidate of discovery.candidates) admit(candidate.branchName, candidate.taskId)
        for (const skip of discovery.skipped) if (RECOVERY_HOLD_REASONS.has(skip.reason)) admit(skip.branchName, skip.id)
        for (const id of held.normal) expect(eligibleNormal.has(id)).toBe(true)
        for (const id of held.addendum) expect(eligibleAddendum.has(id)).toBe(true)
      }),
    )
  })
})
