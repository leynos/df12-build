// Step definitions for recovery-decision.feature. Scenarios build a
// candidate/evidence/assessment triple, run one of the two decision tables
// from the recovery-decision module, and assert on the structured verdict.
// ExecPlan statuses go through parseExecplanState so the Gherkin table
// exercises the parser and the dispatch together.
import { expect } from 'bun:test'
import { withState } from '@aboviq/bun-test-cucumber'

import {
  parseExecplanState,
  recoveryContinueDecision,
  recoveryDecision,
} from '../../src/workflows/df12-build-odw/recovery-decision.ts'

interface Candidate {
  isAddendum: boolean
  execplanPath: string
}

interface Evidence {
  collectionErrors: string[]
  dirtyState: string
  recentCommits: string[]
}

interface Assessment {
  classification: string
  taskScoped: boolean
  validation: string
  missingEvidence: string[]
  residualRisk: string[]
}

interface Decision {
  action: string
  classification?: string
  stage?: string | null
  reason: string
  skip: boolean
}

interface RecoveryState {
  candidate: Candidate
  evidence: Evidence
  assessment: Assessment
  planState: ReturnType<typeof parseExecplanState>
  decision: Decision | null
}

const { Before, Given, When, Then } = withState<RecoveryState>()

Before((state) => ({
  ...state,
  candidate: { isAddendum: false, execplanPath: 'docs/execplans/roadmap-1-2-3.md' },
  evidence: { collectionErrors: [], dirtyState: 'clean', recentCommits: ['abc123 Implement the task'] },
  assessment: { classification: '', taskScoped: true, validation: 'gates green: make all', missingEvidence: [], residualRisk: [] },
  planState: parseExecplanState(''),
  decision: null,
}))

Given('a clean recovery candidate with committed work', (state) => state)

Given('the assessment classifies the branch as {string}', (state, [classification]) => ({
  ...state,
  assessment: { ...state.assessment, classification },
}))

Given('the committed ExecPlan says {string}', (state, [statusLine]) => ({
  ...state,
  planState: parseExecplanState(`# ExecPlan\n\n${statusLine}\n`),
}))

Given('the assessment carries advisory residual risk', (state) => ({
  ...state,
  assessment: { ...state.assessment, residualRisk: ['advisory: telemetry counter not yet wired up'] },
}))

Given('the assessment reports blocking missing evidence', (state) => ({
  ...state,
  assessment: { ...state.assessment, missingEvidence: ['no gate log for the final commit'] },
}))

Given('the worktree is dirty', (state) => ({
  ...state,
  evidence: { ...state.evidence, dirtyState: 'dirty' },
}))

Given('the branch has no committed work', (state) => ({
  ...state,
  evidence: { ...state.evidence, recentCommits: [] },
}))

Given('the candidate is an addendum branch', (state) => ({
  ...state,
  candidate: { ...state.candidate, isAddendum: true },
}))

When('the review-mode decision runs in {string} mode', (state, [mode]) => ({
  ...state,
  decision: recoveryDecision(state.candidate, state.evidence, state.assessment, mode, {}),
}))

When('the review-mode decision runs in {string} mode with dry-run', (state, [mode]) => ({
  ...state,
  decision: recoveryDecision(state.candidate, state.evidence, state.assessment, mode, { dryRun: true }),
}))

When('the continue-mode decision runs', (state) => ({
  ...state,
  decision: recoveryContinueDecision(state.candidate, state.evidence, state.planState, {}),
}))

Then('the decision action is {string}', (state, [action]) => {
  expect(state.decision?.action).toBe(action)
  return state
})

Then('the decision classification is {string}', (state, [classification]) => {
  expect(state.decision?.classification).toBe(classification)
  return state
})

Then('the dispatch stage is {string}', (state, [stage]) => {
  expect(state.decision?.stage).toBe(stage)
  return state
})

Then('the decision skips with reason {string}', (state, [reason]) => {
  expect(state.decision?.skip).toBe(true)
  expect(state.decision?.reason).toBe(reason)
  return state
})

Then('the decision does not skip', (state) => {
  expect(state.decision?.skip).toBe(false)
  expect(state.decision?.reason).toBe('')
  return state
})
