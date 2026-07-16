#!/usr/bin/env node
/**
 * Deterministic mock adapter for the salvage smoke test (odw-testing skill,
 * layer 6). It reproduces issue #18: a planner writes a task-scoped
 * `docs/execplans/<branch-leaf>.md` artefact into its worktree and then the
 * stage fails as an ODW infrastructure fault (a reply no schema can accept ->
 * schema-retry exhaustion). The host then salvages the dirty artefact.
 *
 * Mode is argv[2]: `commit` writes the artefact before failing (so salvage
 * commits it); `skip` fails WITHOUT writing (so salvage finds nothing and the
 * run summary carries no suffix). Either way the FIRST stage the workflow runs
 * (planning) fails, so no later schema needs a valid reply.
 *
 * The worktree path is read from the prompt preamble ("… worktree at <path>. …")
 * rather than assumed, mirroring how the real planner is told where to work.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const mode = process.argv[2] === 'skip' ? 'skip' : 'commit'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  if (mode === 'commit') {
    // The preamble reads "… worktree at <path>. cd into it …". Capture the whole
    // non-whitespace path (it can itself contain dots, e.g. `project.worktrees`)
    // and strip the trailing sentence period.
    const match = /worktree at (\S+)/.exec(input)
    if (match) {
      const worktree = match[1].replace(/\.+$/, '')
      const leaf = path.basename(worktree)
      try {
        mkdirSync(path.join(worktree, 'docs', 'execplans'), { recursive: true })
        writeFileSync(
          path.join(worktree, 'docs', 'execplans', `${leaf}.md`),
          `# ExecPlan draft for ${leaf}\n\nStatus: DRAFT\n`,
        )
      } catch {
        // Best effort: if the write fails the test will observe an empty
        // salvage and fail loudly, which is the correct signal.
      }
    }
  }
  // A reply no JSON Schema can accept: the ODW bridge exhausts its schema
  // retries and raises an infrastructure fault, exactly the failure class this
  // smoke test drives.
  process.stdout.write('SALVAGE_SMOKE_NO_SCHEMA_JSON')
})
