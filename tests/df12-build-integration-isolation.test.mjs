// Source-invariant coverage for the linked-worktree isolation guarantees in
// the Claude workflow's integration flow (`workflows/df12-build.js`). The
// monolith is hand-maintained and exports only `meta` plus its entry point, so
// these invariants read the file source verbatim (mirroring the ODW `.mjs`
// suites) and pin the load-bearing git data-flow — not freely editable prose —
// so a future edit cannot silently reintroduce a `git switch ${BASE}` in the
// linked worktree or a dependence on the control worktree's local ${BASE}.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build.js', import.meta.url)

async function readWorkflow() {
  return await readFile(WORKFLOW_PATH, 'utf8')
}

// Returns the body of `integratePrompt` so the temp-branch/squash/push cluster
// is asserted where it actually lands, not incidentally elsewhere in the file.
function integratePromptBody(source) {
  const start = source.indexOf('function integratePrompt(')
  assert.notEqual(start, -1, 'integratePrompt must exist in the monolith')
  const rest = source.slice(start + 1)
  const next = rest.indexOf('\nfunction ')
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next)
}

test('integration lands via a temp branch cut from origin/${BASE} inside the worktree', async () => {
  const body = integratePromptBody(await readWorkflow())

  // A fresh, disposable integrate-<slug> branch is cut from origin/${BASE}
  // (never the control worktree's local ${BASE}).
  assert.match(
    body,
    /git switch -c integrate-\$\{task\.id\.replace\([^)]*\)\} origin\/\$\{BASE\}/,
    'integrate branch must be cut from origin/${BASE}',
  )
  // The task branch is squash-merged onto that temp branch, then pushed
  // straight to the integration branch with HEAD:${BASE}.
  assert.match(body, /git merge --squash/, 'the task branch is squash-merged')
  assert.match(
    body,
    /git push origin HEAD:\$\{BASE\}/,
    'the squash is pushed with HEAD:${BASE}, not by advancing local ${BASE}',
  )
})

test('integration prohibits switching to ${BASE} inside the linked worktree', async () => {
  const source = await readWorkflow()
  const body = integratePromptBody(source)

  // The prohibition is load-bearing: `git switch ${BASE}` fails when ${BASE} is
  // checked out elsewhere and pollutes the control/root worktree.
  assert.match(
    body,
    /NEVER \\`git switch \$\{BASE\}\\`/,
    'integratePrompt must forbid `git switch ${BASE}`',
  )

  // Negative invariant: every `git switch ${BASE}` in the workflow is a
  // prohibition (NEVER-prefixed). No instruction switches to it affirmatively.
  const allSwitches = source.match(/git switch \$\{BASE\}/g) || []
  const forbiddenSwitches = source.match(/NEVER \\`git switch \$\{BASE\}\\`/g) || []
  assert.ok(allSwitches.length > 0, 'the prohibition text must be present')
  assert.equal(
    forbiddenSwitches.length,
    allSwitches.length,
    'every `git switch ${BASE}` occurrence must be a NEVER-prefixed prohibition',
  )
})

test('integration never advances the control worktree’s local ${BASE}', async () => {
  const source = await readWorkflow()

  // Pushing the local ${BASE} ref (`git push origin ${BASE}`) or fast-forwarding
  // it would advance the control worktree's base; the flow must only ever push
  // HEAD:${BASE} from the disposable integrate branch.
  assert.doesNotMatch(
    source,
    /git push origin \$\{BASE\}(?!\s*:)/,
    'the flow must not push the local ${BASE} ref',
  )
  assert.doesNotMatch(
    source,
    /git merge --ff-only \$\{BASE\}/,
    'the flow must not fast-forward the local ${BASE}',
  )
})
