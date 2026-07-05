// Bounded end-to-end smoke of recovery through the real odw runtime with
// deterministic mock adapters (roadmap task 2.3.2); skips when the odw CLI
// is not installed.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { makeRecoveryRepo } from './fixtures/recovery-repo.mjs'

const execFileAsync = promisify(execFile)
const WORKFLOW = fileURLToPath(new URL('../workflows/df12-build-odw.js', import.meta.url))
const MOCK_AGENT = fileURLToPath(new URL('./fixtures/recovery-mock-agent.mjs', import.meta.url))

// Bounded smoke test through the REAL odw runtime (roadmap task 2.3.2):
// deterministic mock adapters, a throwaway fixture repository, and a
// hermetic runsRoot. No model calls, no real pushes; the run directory's
// result.json and events.jsonl are the assertion surface. Skips when the
// `odw` CLI is not installed.
function odwAvailable() {
  try {
    execFileSync('odw', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

async function runSmoke(resumeMode) {
  const repo = makeRecoveryRepo({ withAddendumWorktree: true })
  const sidecar = mkdtempSync(path.join(tmpdir(), 'df12-smoke-'))
  const runsRoot = path.join(sidecar, 'runs')
  const configPath = path.join(sidecar, 'odw.config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: 'mock',
      workspaceMode: 'inplace',
      schemaRetries: 1,
      concurrency: 4,
      timeout: 120,
      runsRoot,
      adapters: {
        mock: { command: [process.execPath, MOCK_AGENT], stdin: '{prompt}' },
      },
    }),
  )
  const argsPath = path.join(sidecar, 'args.json')
  writeFileSync(
    argsPath,
    JSON.stringify({
      projectRoot: repo.dir,
      taskId: '9.9.9',
      authPreflight: false,
      // Host review would exec the REAL coderabbit CLI (it does not route
      // through the mock adapters) and burn review quota; host gates would
      // run `make all` in the Makefile-less fixture repo.
      coderabbitHostReview: false,
      hostCommitGates: false,
      // The mock implement adapter does not tick ExecPlan Progress items.
      perWorkItemBuild: false,
      resumePartialBranches: true,
      resumeMode,
      planAdapter: 'mock',
      buildAdapter: 'mock',
      reviewAdapter: 'mock',
      triageAdapter: 'mock',
      assessmentAdapter: 'mock',
    }),
  )

  await execFileAsync(
    'odw',
    ['run', WORKFLOW, '--source', repo.dir, '--config', configPath, '--args', `@${argsPath}`, '--wait', '--timeout', '180'],
    // Generous headroom over ODW's own --timeout 180: when ODW times out
    // internally it still needs time to write result.json before this outer
    // guard fires, so keep the two limits far apart.
    { encoding: 'utf8', timeout: 360_000, maxBuffer: 16 * 1024 * 1024 },
  )

  const runDirs = readdirSync(runsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'result.json')
    .map((entry) => entry.parentPath)
  assert.equal(runDirs.length, 1, `expected exactly one completed run under ${runsRoot}`)
  const runDir = runDirs[0]
  const result = JSON.parse(readFileSync(path.join(runDir, 'result.json'), 'utf8')).value
  const events = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return [] // tolerate a torn final line per the odw-supervision contract
      }
    })
  const startedLabels = events.filter((event) => event.type === 'agent_started').map((event) => event.label)
  return { repo, result, startedLabels }
}

test('smoke: resumeMode="assess" reports the surviving branches through real odw', { skip: !odwAvailable() }, async () => {
  const { result, startedLabels } = await runSmoke('assess')

  assert.equal(result.recovery.enabled, true)
  assert.equal(result.recovery.mode, 'assess')
  assert.equal(result.recovery.assessed, 2)
  assert.equal(result.recovery.resumed, 0)
  assert.deepEqual(
    result.recovery.results.map((entry) => [entry.id, entry.action]).sort(),
    [
      ['1.2.3', 'reported'],
      ['2.1.2', 'reported'],
    ],
  )
  assert.deepEqual(result.processed, [])
  assert.deepEqual(
    startedLabels.sort(),
    ['recover-assess:1.2.3', 'recover-assess:2.1.2-addendum'],
    'assess mode spawns assessment agents only',
  )
})

test('smoke: resumeMode="review" attempts only the eligible branch through real odw', { skip: !odwAvailable() }, async () => {
  const { result, startedLabels } = await runSmoke('review')

  assert.equal(result.recovery.resumed, 1)
  const actionById = new Map(result.recovery.results.map((entry) => [entry.id, entry]))
  assert.equal(actionById.get('1.2.3').action, 'resumed')
  assert.equal(actionById.get('2.1.2').action, 'reported')
  assert.equal(actionById.get('2.1.2').reason, 'addendum-branch')
  assert.deepEqual(result.processed, ['1.2.3'])

  const reviewLabels = startedLabels.filter(
    (label) => label.startsWith('code-review:') || label.startsWith('expert-review:') || label.startsWith('integrate:'),
  )
  assert.deepEqual(
    reviewLabels.sort(),
    ['code-review:1.2.3 r1', 'expert-review:1.2.3 r1', 'integrate:1.2.3'],
    'review effort must be spent on the eligible branch only',
  )
})
