/**
 * Whole-body simulation driver for workflows/df12-build-odw.js.
 *
 * Mirrors ODW's loader transform (strip the meta export, wrap the body in an
 * AsyncFunction with the injected-parameter order), then executes the whole
 * control loop with label-scripted primitives. Runs as a subprocess so the
 * workflow's `process.chdir(projectRoot)` and any PATH overrides for fake
 * auth CLIs stay isolated from the test process.
 *
 * Usage: node run-odw-simulation.mjs <scenario.json>
 * Scenario: {
 *   args: {...workflow args...},
 *   pathPrefix?: "<dir prepended to PATH before the body runs>",
 *   assessment?: {...overrides for the scripted ADR 002 assessment reply...},
 *   review?: {...full scripted reply for code-review/expert-review labels...},
 *   fix?: {...full scripted reply for fix: labels...},
 *   failures?: { "<exact label>": { error?: "<message>", times?: N } }
 *     — the scripted agent throws `error` for the first `times` calls with
 *       that label (every call when `times` is omitted), then answers
 *       normally; used to simulate adapter/infrastructure faults.
 * }
 * Prints JSON: { result, error, calls, phases }
 */
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

import { probeDetailsFromPrompt } from './recovery-repo.mjs'

const scenarioPath = process.argv[2]
if (!scenarioPath) {
  process.stderr.write('usage: run-odw-simulation.mjs <scenario.json>\n')
  process.exit(2)
}
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
if (scenario.pathPrefix) {
  process.env.PATH = `${scenario.pathPrefix}:${process.env.PATH}`
}

function scriptedAssessment(overrides = {}) {
  return {
    classification: 'adopt-complete',
    branchName: 'roadmap-1-2-3',
    worktreePath: '/tmp/wt',
    baseCommit: 'abc',
    currentCommit: 'def',
    dirtyState: 'clean',
    changedFiles: ['roadmap-1-2-3.txt'],
    taskScoped: true,
    execPlan: 'ExecPlan complete with retrospective',
    roadmap: 'task unchecked',
    validation: 'make all green at HEAD',
    missingEvidence: [],
    risks: [],
    rationale: 'complete slice',
    recommendation: 'review and integrate',
    nextActions: [],
    ...(overrides || {}),
  }
}

async function respond(label, prompt) {
  if (label.startsWith('recover-assess:') || label.startsWith('assess:')) return scriptedAssessment(scenario.assessment)
  if (label.startsWith('write-probe:')) {
    // Behave as a compliant sandbox: honour the probe by writing the token,
    // so scenarios exercise flows beyond the write gate.
    const details = probeDetailsFromPrompt(prompt)
    if (details) await writeFile(details.file, details.token, 'utf8')
    return { ok: true }
  }
  if (label.startsWith('plan:')) {
    return scenario.plan || {
      execplanPath: 'docs/execplans/roadmap-1-2-3.md',
      workItems: ['work item 1'],
      summary: 'plan completed and committed',
    }
  }
  if (label.startsWith('design-review:')) {
    return scenario.designReview || { satisfied: true, blocking: [] }
  }
  if (label.startsWith('implement:')) {
    return scenario.implement || {
      ok: true,
      gatesGreen: true,
      execplanPath: 'docs/execplans/roadmap-1-2-3.md',
      workItemsCompleted: 1,
      workItemsTotal: 1,
      commits: ['Finish remaining work items'],
      coderabbitRuns: 1,
      openIssues: [],
      summary: 'resumed and completed the remaining work items',
    }
  }
  if (label.startsWith('code-review:') || label.startsWith('expert-review:')) {
    return scenario.review || { verdict: 'pass', blocking: [], summary: 'ship it' }
  }
  if (label.startsWith('integrate:')) {
    return {
      ok: true,
      roadmapMarkedDone: true,
      rebased: true,
      squashMerged: true,
      mergeSha: 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      pushed: true,
      conflicts: '',
      summary: 'squash merged and pushed',
    }
  }
  if (label.startsWith('fix:')) {
    return scenario.fix || { gatesGreen: true, commits: [], coderabbitRuns: 0, resolved: [], openIssues: [], summary: 'applied fixes' }
  }
  throw new Error(`unexpected agent label in simulation: ${label}`)
}

let source = await readFile(new URL('../../workflows/df12-build-odw.js', import.meta.url), 'utf8')
source = source.replace(/^export const meta\s*=/m, 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const body = new AsyncFunction(
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'args',
  'budget',
  'workflow',
  'validate',
  source,
)

const calls = []
const phases = []
const failures = scenario.failures || {}
const agent = async (prompt, opts = {}) => {
  const label = opts.label || opts.adapter || ''
  calls.push(label)
  const fault = failures[label]
  if (fault && (fault.times === undefined || fault.times > 0)) {
    if (fault.times !== undefined) fault.times -= 1
    throw new Error(fault.error || "adapter 'claude' timed out")
  }
  return respond(label, prompt)
}
const parallel = (thunks) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)))
const pipeline = async (items, ...stages) =>
  Promise.all(
    items.map(async (item, index) => {
      try {
        let value = item
        for (const stage of stages) value = await stage(value, item, index)
        return value
      } catch {
        return null
      }
    }),
  )

let result = null
let error = null
try {
  result = await body(
    agent,
    parallel,
    pipeline,
    (title) => phases.push(title),
    () => {},
    scenario.args || {},
    { total: null, spent: () => 0, remaining: () => Infinity },
    async () => {
      throw new Error('nested workflow not scripted')
    },
    () => ({ ok: true, errors: [], warnings: [] }),
  )
} catch (err) {
  error = { message: (err && err.message) || String(err) }
}

process.stdout.write(JSON.stringify({ result, error, calls, phases }))
