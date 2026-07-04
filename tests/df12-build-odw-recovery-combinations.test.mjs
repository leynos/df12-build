// Whole-workflow combination tests for recovery modes: the entire control
// loop executes in a subprocess (tests/fixtures/run-odw-simulation.mjs)
// against fixture repositories, with only agent replies scripted by label.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { makeRecoveryRepo, repoStateSnapshot } from './fixtures/recovery-repo.mjs'

const execFileAsync = promisify(execFile)
const DRIVER = fileURLToPath(new URL('./fixtures/run-odw-simulation.mjs', import.meta.url))

// Whole-body simulation of the workflow control loop (see the odw-testing
// skill, layer 5): the real selection, recovery, and git code runs against a
// fixture repository; only agent() replies are scripted, keyed on labels.
// `taskId: '9.9.9'` pins normal selection to a non-existent task so the pool
// never opens ordinary work, keeping each combination focused on recovery.
async function runSimulation({ repo, args = {}, pathPrefix = '', assessment = null }) {
  const scenarioDir = mkdtempSync(path.join(tmpdir(), 'df12-scenario-'))
  const scenarioPath = path.join(scenarioDir, 'scenario.json')
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      args: {
        projectRoot: repo.dir,
        taskId: '9.9.9',
        authPreflight: false,
        ...args,
      },
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(assessment ? { assessment } : {}),
    }),
  )
  const { stdout } = await execFileAsync(process.execPath, [DRIVER, scenarioPath], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = JSON.parse(stdout)
  assert.equal(output.error, null, `simulation must complete: ${JSON.stringify(output.error)}`)
  return output
}

// Fake auth CLIs for the preflight-failure combination: codex reports a
// signed-out state; claude and coderabbit report healthy sessions.
function makeFakeAuthBin() {
  const bin = mkdtempSync(path.join(tmpdir(), 'df12-fake-bin-'))
  const write = (name, body, exitCode) => {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\necho "${body}"\nexit ${exitCode}\n`)
    chmodSync(file, 0o755)
  }
  write('codex', 'Not logged in', 1)
  write('claude', 'Logged in as operator@example.invalid', 0)
  write('coderabbit', 'Session active', 0)
  return bin
}

test('combination: resumePartialBranches=false leaves recovery disabled and spawns no agents', async () => {
  const repo = makeRecoveryRepo()
  const before = repoStateSnapshot(repo)

  const { result, calls } = await runSimulation({ repo })

  assert.equal(result.recovery.enabled, false)
  assert.equal(result.recovery.candidates, 0)
  assert.deepEqual(result.recovery.results, [])
  assert.deepEqual(result.processed, [])
  assert.deepEqual(result.results, [])
  assert.equal(result.halted, null)
  assert.deepEqual(calls, [], 'no agent may run when recovery is off and no task is selectable')
  assert.deepEqual(repoStateSnapshot(repo), before)
})

test('combination: assess-only recovery reports candidates and mutates nothing', async () => {
  const repo = makeRecoveryRepo()
  const before = repoStateSnapshot(repo)

  const { result, calls, phases } = await runSimulation({
    repo,
    args: { resumePartialBranches: true, resumeMode: 'assess' },
  })

  assert.equal(result.recovery.enabled, true)
  assert.equal(result.recovery.mode, 'assess')
  assert.equal(result.recovery.candidates, 1)
  assert.equal(result.recovery.assessed, 1)
  assert.equal(result.recovery.resumed, 0)
  assert.deepEqual(
    result.recovery.results.map((entry) => [entry.id, entry.classification, entry.action]),
    [['1.2.3', 'adopt-complete', 'reported']],
  )
  const reasonByBranch = new Map(result.recovery.skipped.map((entry) => [entry.branchName, entry.reason]))
  assert.equal(reasonByBranch.get('roadmap-2-1-1'), 'already-complete', 'completed roadmap task must be skipped')
  assert.equal(reasonByBranch.get('roadmap-1-2-4'), 'missing-worktree')
  assert.deepEqual(result.processed, [])
  assert.deepEqual(result.results, [])
  assert.deepEqual(calls, ['recover-assess:1.2.3'])
  assert.ok(phases.includes('Recovery'))
  assert.match(result.summary, /recovery\(assess\): 1 assessed, 0 resumed/)
  assert.deepEqual(repoStateSnapshot(repo), before)
})

test('combination: review-mode resume integrates the clean adopt-complete branch', async () => {
  const repo = makeRecoveryRepo()

  const { result, calls } = await runSimulation({
    repo,
    args: { resumePartialBranches: true, resumeMode: 'review' },
  })

  assert.equal(result.recovery.resumed, 1)
  assert.deepEqual(
    result.recovery.results.map((entry) => [entry.id, entry.action]),
    [['1.2.3', 'resumed']],
  )
  assert.deepEqual(result.processed, ['1.2.3'], 'a pushed resume enters processed')
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].status, 'done')
  assert.equal(result.results[0].kind, 'recovery-resume')
  assert.deepEqual(calls, [
    'recover-assess:1.2.3',
    'write-probe:claude',
    'write-probe:codex-medium',
    'code-review:1.2.3 r1',
    'expert-review:1.2.3 r1',
    'integrate:1.2.3',
  ])
  assert.equal(result.halted, null)
})

test('combination: review-mode resume skips a dirty branch fail-closed', async () => {
  const repo = makeRecoveryRepo()
  writeFileSync(path.join(repo.parserWorktree, 'dirty.txt'), 'uncommitted operator work\n')
  const before = repoStateSnapshot(repo)

  const { result, calls } = await runSimulation({
    repo,
    args: { resumePartialBranches: true, resumeMode: 'review' },
  })

  assert.equal(result.recovery.resumed, 0)
  assert.deepEqual(
    result.recovery.results.map((entry) => [entry.classification, entry.action, entry.reason]),
    [['continue-manual', 'reported', 'dirty-worktree']],
  )
  assert.ok(
    result.recovery.skipped.some(
      (entry) => entry.branchName === 'roadmap-1-2-3' && entry.reason === 'dirty-worktree',
    ),
  )
  assert.deepEqual(result.processed, [])
  assert.deepEqual(calls, ['recover-assess:1.2.3'], 'no review or integration effort on a dirty branch')
  assert.deepEqual(repoStateSnapshot(repo), before)
})

test('combination: auth preflight failure blocks recovery entirely', async () => {
  const repo = makeRecoveryRepo()
  const before = repoStateSnapshot(repo)

  const { result, calls } = await runSimulation({
    repo,
    args: { resumePartialBranches: true, resumeMode: 'review', authPreflight: true },
    pathPrefix: makeFakeAuthBin(),
  })

  assert.match(result.halted, /fatal auth preflight failed/)
  assert.equal(result.recovery.enabled, true)
  assert.equal(result.recovery.blocked, 'auth-preflight-failed')
  assert.equal(result.recovery.candidates, 0)
  assert.deepEqual(result.recovery.results, [])
  assert.deepEqual(result.processed, [])
  assert.deepEqual(calls, [], 'no assessment or resume agents after a fatal auth preflight')
  assert.deepEqual(repoStateSnapshot(repo), before)
})
