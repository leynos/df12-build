/**
 * @file Workflow-entrypoint smoke of artefact salvage through the REAL odw
 * runtime (issue #18). It proves that workflowMain() wires summarizeSalvages()
 * into both the public result object (`result.salvages`) and the terminal
 * summary string (the `| salvaged artefacts on N branch(es)` suffix) — not just
 * that the helper is correct in isolation (that is
 * tests/modules/assessment.test.ts). A single normal task runs; its planner
 * writes a task-scoped docs/execplans artefact and then fails as an ODW
 * infrastructure fault, so the host salvages the artefact. Skips when the `odw`
 * CLI is not installed.
 */

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WORKFLOW = fileURLToPath(new URL('../workflows/df12-build-odw.js', import.meta.url))
const MOCK_AGENT = fileURLToPath(new URL('./fixtures/salvage-smoke-agent.mjs', import.meta.url))

function odwAvailable() {
  try {
    execFileSync('odw', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'df12-test',
      GIT_AUTHOR_EMAIL: 'df12-test@example.invalid',
      GIT_COMMITTER_NAME: 'df12-test',
      GIT_COMMITTER_EMAIL: 'df12-test@example.invalid',
    },
  }).trim()
}

const ROADMAP = ['# Fixture roadmap', '', '### 1.1. The step', '', '- [ ] 1.1.1. Implement the thing.', ''].join('\n')

// A throwaway repo with an `origin` remote and one open, unblocked roadmap task
// (1.1.1) and no pre-existing branches, so the normal pipeline selects it and
// creates a fresh `roadmap-1-1-1` worktree.
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'df12-salvage-smoke-'))
  const dir = path.join(root, 'project')
  const originDir = path.join(root, 'origin.git')
  mkdirSync(dir)
  git(root, 'init', '--bare', originDir)
  git(root, 'init', '-b', 'main', dir)
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  mkdirSync(path.join(dir, 'docs', 'execplans'), { recursive: true })
  writeFileSync(path.join(dir, 'docs', 'roadmap.md'), ROADMAP)
  // Track docs/execplans/ up front (as a real repo does) so a fresh artefact
  // surfaces as an individual untracked path rather than a collapsed untracked
  // directory that git status reports as `docs/execplans/`.
  writeFileSync(path.join(dir, 'docs', 'execplans', '.gitkeep'), '')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Initial fixture')
  git(dir, 'remote', 'add', 'origin', originDir)
  git(dir, 'push', 'origin', 'main')
  return { root, dir }
}

async function runSalvageSmoke(mode) {
  const repo = makeRepo()
  const sidecar = mkdtempSync(path.join(tmpdir(), 'df12-salvage-run-'))
  const runsRoot = path.join(sidecar, 'runs')
  const configPath = path.join(sidecar, 'odw.config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: 'mock',
      workspaceMode: 'inplace',
      schemaRetries: 1,
      concurrency: 1,
      timeout: 120,
      runsRoot,
      adapters: {
        mock: { command: [process.execPath, MOCK_AGENT, mode], stdin: '{prompt}' },
      },
    }),
  )
  const argsPath = path.join(sidecar, 'args.json')
  writeFileSync(
    argsPath,
    JSON.stringify({
      projectRoot: repo.dir,
      taskId: '1.1.1',
      authPreflight: false,
      coderabbitHostReview: false,
      hostCommitGates: false,
      perWorkItemBuild: false,
      // Skip the once-per-run write probe so planning is the FIRST stage the
      // mock adapter answers (and fails).
      worktreeWritePreflight: false,
      // One attempt per stage: the planner's infra fault is terminal at once.
      stageAttempts: 1,
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
    { encoding: 'utf8', timeout: 360_000, maxBuffer: 16 * 1024 * 1024 },
  )

  const runDirs = readdirSync(runsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'result.json')
    .map((entry) => entry.parentPath)
  assert.equal(runDirs.length, 1, `expected exactly one completed run under ${runsRoot}`)
  const result = JSON.parse(readFileSync(path.join(runDirs[0], 'result.json'), 'utf8')).value
  return { repo, result }
}

test('smoke: workflowMain surfaces a committed salvage in result.salvages and the summary suffix', { skip: !odwAvailable() }, async () => {
  const { result } = await runSalvageSmoke('commit')

  assert.ok(Array.isArray(result.salvages), 'result.salvages must be an array')
  const salvage = result.salvages.find((entry) => entry.id === '1.1.1')
  assert.ok(salvage, `expected a salvages row for task 1.1.1; got ${JSON.stringify(result.salvages)}`)
  assert.equal(salvage.classification, 'infra-fault')
  assert.deepEqual(salvage.committed, ['docs/execplans/roadmap-1-1-1.md'])
  assert.equal(salvage.skipped, 0)
  assert.match(salvage.sha, /^[0-9a-f]{40}$/)
  assert.match(
    result.summary,
    / \| salvaged artefacts on 1 branch\(es\)/,
    `terminal summary must carry the salvage suffix; got: ${result.summary}`,
  )
})

test('smoke: a salvage that commits nothing is a row with no committed paths and no summary suffix', { skip: !odwAvailable() }, async () => {
  const { result } = await runSalvageSmoke('skip')

  const salvage = result.salvages.find((entry) => entry.id === '1.1.1')
  assert.ok(salvage, `expected a salvages row for task 1.1.1; got ${JSON.stringify(result.salvages)}`)
  assert.equal(salvage.classification, 'infra-fault')
  assert.deepEqual(salvage.committed, [])
  assert.doesNotMatch(
    result.summary,
    /salvaged artefacts/,
    `a skip-only run must not add the salvage suffix; got: ${result.summary}`,
  )
})
