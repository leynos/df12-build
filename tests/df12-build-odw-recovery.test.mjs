import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

async function loadRecoverySurface(args = {}) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/, 'const meta =')
  const markerIndex = source.indexOf(CONTROL_LOOP_MARKER)
  assert.notEqual(markerIndex, -1, 'workflow control-loop marker should exist')
  const helperSource = source.slice(0, markerIndex)
  const factory = new Function(
    'args',
    'phase',
    'log',
    'agent',
    'parallel',
    'budget',
    `${helperSource}
return {
  RESUME_PARTIAL_BRANCHES,
  RESUME_MODE,
  RESUME_TASK_ID,
  RESUME_MAX_CANDIDATES,
}
`,
  )
  return factory(
    args,
    () => {},
    () => {},
    async () => null,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
}

test('recovery configuration defaults are non-mutating', async () => {
  const surface = await loadRecoverySurface({})

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, false)
  assert.equal(surface.RESUME_MODE, 'assess')
  assert.equal(surface.RESUME_TASK_ID, null)
  assert.equal(surface.RESUME_MAX_CANDIDATES, 4)
})

test('recovery configuration accepts explicit operator overrides', async () => {
  const surface = await loadRecoverySurface({
    resumePartialBranches: true,
    resumeMode: 'Review',
    resumeTaskId: '1.2.3',
    resumeMaxCandidates: 2,
  })

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, true)
  assert.equal(surface.RESUME_MODE, 'review')
  assert.equal(surface.RESUME_TASK_ID, '1.2.3')
  assert.equal(surface.RESUME_MAX_CANDIDATES, 2)
})

test('recovery discovery is opt-in: truthy but non-true values stay disabled', async () => {
  const surface = await loadRecoverySurface({ resumePartialBranches: 'yes' })

  assert.equal(surface.RESUME_PARTIAL_BRANCHES, false)
})

test('unsupported resumeMode values fail fast', async () => {
  await assert.rejects(
    loadRecoverySurface({ resumeMode: 'merge' }),
    /Unsupported resumeMode: merge/,
  )
})

test('resumeMaxCandidates is clamped to a sane positive bound', async () => {
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 0 })).RESUME_MAX_CANDIDATES, 1)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: -3 })).RESUME_MAX_CANDIDATES, 1)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 2.9 })).RESUME_MAX_CANDIDATES, 2)
  assert.equal((await loadRecoverySurface({ resumeMaxCandidates: 'many' })).RESUME_MAX_CANDIDATES, 4)
})
