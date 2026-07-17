// Shared git fixtures for the recovery test suites: a throwaway repository
// with an `origin` remote, surviving roadmap-* branches, live worktrees with
// committed canonical ExecPlans, a durable-state snapshot helper for the
// no-mutation assertions, and a complete eligible ADR 002 assessment reply.
// Consumed by tests/df12-build-odw-recovery*.test.mjs and
// tests/df12-build-odw-write-preflight.test.mjs.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Canonical parser for the write-probe wire format (the PROBE_FILE /
// PROBE_TOKEN lines in writeProbePrompt). Every harness that plays a
// compliant sandbox parses through this one helper, so a future
// marker-format change lands in exactly one place. Returns null when the
// prompt carries no probe markers; call sites decide how strict to be.
export function probeDetailsFromPrompt(prompt) {
  const file = /^PROBE_FILE: (.+)$/m.exec(prompt)
  const token = /^PROBE_TOKEN: (.+)$/m.exec(prompt)
  if (!file || !token) return null
  return { file: file[1], token: token[1] }
}

// Fixture roots are removed when the test process exits, so repeated runs
// do not accumulate orphaned df12-recovery-* repositories under the OS
// temp directory. Callers may also invoke the returned cleanup() earlier.
const FIXTURE_ROOTS = []
process.once('exit', () => {
  for (const root of FIXTURE_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // exit-time best effort: a vanished root is already what we want
    }
  }
})

// A registered throwaway directory for tests that need scratch space outside
// a full recovery repository; removed by the same exit hook.
export function makeFixtureDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  FIXTURE_ROOTS.push(dir)
  return dir
}

export function git(cwd, ...args) {
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

export const RECOVERY_ROADMAP = [
  '# Fixture roadmap',
  '',
  '### 1.2. Discovery step',
  '',
  '- [ ] 1.2.3. Implement the parser state machine.',
  '- [ ] 1.2.4. Another open task without a worktree.',
  '',
  '### 2.1. Completed step',
  '',
  '- [x] 2.1.1. Completed task.',
  '- [x] 2.1.2. Completed parent with an open addendum.',
  '  - [ ] 2.1.2.1. Addendum sub-task.',
  '',
].join('\n')

// A repo with an `origin` remote, surviving roadmap-* branches, and a live
// worktree for 1.2.3 — the durable state fresh-run discovery reads. Worktree
// branches also carry a committed canonical ExecPlan (resume eligibility
// requires one); pass withParserExecplan: false to model a branch that lost
// its plan.
export function makeRecoveryRepo({
  withAddendumWorktree = false,
  withParserExecplan = true,
  parserExecplanStatus = 'COMPLETE',
  parserExecplanProgress = [],
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'df12-recovery-'))
  FIXTURE_ROOTS.push(root)
  const dir = path.join(root, 'project')
  const originDir = path.join(root, 'origin.git')
  mkdirSync(dir)
  git(root, 'init', '--bare', originDir)
  git(root, 'init', '-b', 'main', dir)
  writeFileSync(path.join(dir, 'README.md'), '# Fixture\n')
  mkdirSync(path.join(dir, 'docs'))
  writeFileSync(path.join(dir, 'docs', 'roadmap.md'), RECOVERY_ROADMAP)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Initial fixture')
  git(dir, 'remote', 'add', 'origin', originDir)
  git(dir, 'push', 'origin', 'main')
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  const addBranch = (branch, { commit = true, worktree = false, execplan = true } = {}) => {
    git(dir, 'branch', branch, 'main')
    let worktreePath = ''
    if (worktree) {
      worktreePath = path.join(root, 'worktrees', branch)
      git(dir, 'worktree', 'add', worktreePath, branch)
      if (commit) {
        writeFileSync(path.join(worktreePath, `${branch}.txt`), 'work\n')
        if (execplan) {
          mkdirSync(path.join(worktreePath, 'docs', 'execplans'), { recursive: true })
          const progress = parserExecplanProgress.length
            ? `\n## Progress\n\n${parserExecplanProgress.join('\n')}\n`
            : ''
          writeFileSync(
            path.join(worktreePath, 'docs', 'execplans', `${branch}.md`),
            `# ExecPlan for ${branch}\n\nStatus: ${parserExecplanStatus}\n${progress}`,
          )
        }
        git(worktreePath, 'add', '.')
        git(worktreePath, 'commit', '-m', `Work on ${branch}`)
      }
    }
    return worktreePath
  }

  const parserWorktree = addBranch('roadmap-1-2-3', { worktree: true, execplan: withParserExecplan })
  addBranch('roadmap-1-2-4')
  addBranch('roadmap-2-1-1')
  addBranch('roadmap-9-9-9')
  addBranch('roadmap-x')
  let addendumWorktree = ''
  if (withAddendumWorktree) {
    addendumWorktree = addBranch('roadmap-2-1-2-addendum', { worktree: true })
  }

  const cleanup = () => rmSync(root, { recursive: true, force: true })
  return { root, dir, originDir, baseSha, parserWorktree, addendumWorktree, cleanup }
}

// Every observable piece of durable state assess-only recovery must not touch:
// local refs, origin refs, control-checkout dirt, worktree dirt, stashes, and
// the canonical roadmap text.
export function repoStateSnapshot(repo) {
  return {
    localRefs: git(repo.dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    originRefs: git(repo.originDir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    controlStatus: git(repo.dir, 'status', '--porcelain=v1'),
    worktreeStatus: repo.parserWorktree ? git(repo.parserWorktree, 'status', '--porcelain=v1') : '',
    stashes: git(repo.dir, 'stash', 'list'),
    worktrees: git(repo.dir, 'worktree', 'list', '--porcelain'),
    canonicalRoadmap: git(repo.dir, 'show', 'origin/main:docs/roadmap.md'),
  }
}

// A complete, eligible ADR 002 assessment reply; override fields per scenario.
export function sampleAssessment(overrides = {}) {
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
    residualRisk: [],
    risks: [],
    rationale: 'complete slice',
    recommendation: 'review and integrate',
    nextActions: [],
    ...overrides,
  }
}
