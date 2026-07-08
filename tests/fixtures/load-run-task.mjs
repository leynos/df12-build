// Shared harness for the dry-run suites (regression and property). It slices
// the helper surface out of the generated artefact and evaluates it, so tests
// drive the real runTask exactly as the write-preflight suite does, without
// importing the TypeScript source. The returned object exposes `runTask` plus a
// `logs` array capturing every log() line the workflow emits, so a test can
// assert on the structured trace at the dry-run boundary.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const WORKFLOW_PATH = new URL('../../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

export async function loadRunTask(args = {}, agentImpl = async () => null) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/m, 'const meta =')
  const markerIndex = source.indexOf(CONTROL_LOOP_MARKER)
  assert.notEqual(markerIndex, -1, 'workflow control-loop marker should exist')
  const helperSource = source.slice(0, markerIndex)
  const logs = []
  const factory = new Function(
    'args',
    'phase',
    'log',
    'agent',
    'parallel',
    'budget',
    `${helperSource}
return { runTask }
`,
  )
  const surface = factory(
    { coderabbitHostReview: false, hostCommitGates: false, perWorkItemBuild: false, ...args },
    () => {},
    (message) => logs.push(message),
    agentImpl,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
  return { ...surface, logs }
}
