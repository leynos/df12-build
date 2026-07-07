// Workflow-level wiring test for the shared git-donkey worktree safety-net
// (issue #2). The module suites (tests/modules/*.test.ts) exercise the prompt
// builders in isolation and STUB the injected worktreeSafetyNet, so they cannot
// prove that the REAL helper reaches both the audit and the triage prompt, nor
// that it survives the esbuild bundle into the shipped artefact. This suite
// closes that boundary: it slices the helper surface out of the built
// `workflows/df12-build-odw.js` — the same artefact the sidecar ships — takes
// the already-composed `auditPrompt`, `triagePrompt`, and `worktreeSafetyNet`
// bindings (wired exactly as main.ts composes them), and asserts audit and
// triage embed one byte-identical safety-net that roots on the CONFIGURED base
// rather than git donkey's built-in `main` default.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { readModuleSource } from './support/workflow-source.mjs'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

// Slice the artefact's helper region (everything above the control-loop marker)
// and hand back the ALREADY-WIRED audit/triage/safety-net bindings. This is the
// real composition: `auditPrompt` comes from `makePrompts(CONFIG)` and
// `triagePrompt` from `makeRemediation({ worktreeSafetyNet, base: BASE, … })`,
// both bound at the artefact's top level — nothing is stubbed.
async function loadAuditTriageSurface(args = {}) {
  let source = await readFile(WORKFLOW_PATH, 'utf8')
  source = source.replace(/^export const meta\s*=/m, 'const meta =')
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
return { BASE, worktreeSafetyNet, auditPrompt, triagePrompt }
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

const TASK = { id: '1.2.3', title: 'Implement the parser', isAddendum: false, subtasks: [] }
const PROPOSALS = [{ title: 'Fix flaky teardown', rationale: 'audit:1.2.3', severity: 'low' }]

test('audit and triage share one real worktree safety-net (no stub, from the built artefact)', async () => {
  const surface = await loadAuditTriageSurface()
  const safety = surface.worktreeSafetyNet(surface.BASE)

  const audit = surface.auditPrompt(TASK, '/tmp/project.worktrees/roadmap-1-2-3')
  const triage = surface.triagePrompt('1.2', PROPOSALS)

  // The identical helper text reaches BOTH prompts: audit calls it directly,
  // triage receives it through RemediationDeps.worktreeSafetyNet. One authority,
  // no drift — asserted against the shipped artefact, not the source.
  assert.ok(audit.includes(safety), 'auditPrompt should embed the real worktreeSafetyNet text')
  assert.ok(triage.includes(safety), 'triagePrompt should embed the real worktreeSafetyNet text')
})

test('the shipped safety-net passes the configured base to git donkey, not the no-arg main default', async () => {
  const surface = await loadAuditTriageSurface()
  const safety = surface.worktreeSafetyNet(surface.BASE)

  // The fix: `git donkey <slug> <base>` roots on the configured base. Omitting
  // the base falls back to git donkey's built-in `main` default
  // (choose_base_branch("main") for a null origin arg), which is the wrong tree
  // for any non-main base.
  assert.ok(
    safety.includes(`git donkey <slug> ${surface.BASE}`),
    'safety-net must pass the configured base as the git donkey parent',
  )
  // The remote-qualified ref is still refused (git donkey misparses it as
  // origin/origin/<base>).
  assert.ok(safety.includes(`origin/origin/${surface.BASE}`))
  // And the verify/reset discipline is intact.
  assert.ok(safety.includes(`git reset --hard origin/${surface.BASE}`))
})

test('a non-main base roots audit and triage worktrees on that base end to end', async () => {
  // Bind the artefact with base=trunk (a repo with no `main`): both prompts must
  // now instruct `git donkey <slug> trunk`, proving the bug the review flagged —
  // rooting on the `main` default — cannot recur for a non-main base.
  const surface = await loadAuditTriageSurface({ base: 'trunk' })
  assert.equal(surface.BASE, 'trunk')

  const audit = surface.auditPrompt(TASK, null)
  const triage = surface.triagePrompt('1.2', PROPOSALS)

  assert.ok(audit.includes('git donkey <slug> trunk'), 'audit worktree must root on the configured base')
  assert.ok(triage.includes('git donkey <slug> trunk'), 'triage worktree must root on the configured base')
})

test('main.ts injects the shared helper into remediation rather than re-importing it', async () => {
  // Source invariant on the wiring itself: worktreeSafetyNet is imported from
  // prompts.ts and threaded into makeRemediation. This fails loudly if a
  // refactor drops the injection (even if the two prompts happened to stay
  // textually identical), keeping remediation.ts import-free by contract.
  const main = await readModuleSource('main.ts')
  assert.match(
    main,
    /import\s*\{[^}]*\bworktreeSafetyNet\b[^}]*\}\s*from\s*'\.\/prompts\.ts'/,
    'main.ts should import worktreeSafetyNet from prompts.ts',
  )
  assert.match(
    main,
    /makeRemediation\(\{[\s\S]*?\bworktreeSafetyNet\b[\s\S]*?\}\)/,
    'main.ts should inject worktreeSafetyNet into makeRemediation',
  )
})
