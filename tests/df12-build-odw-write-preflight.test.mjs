import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/df12-build-odw.js', import.meta.url)
const CONTROL_LOOP_MARKER = '// --- Worker-pool control loop'

async function loadPreflightSurface(args = {}, agentImpl = async () => null) {
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
  WORKTREE_WRITE_PREFLIGHT,
  WRITE_PROBE_SCHEMA,
  writeProbeTargets,
  writeProbePath,
  writeProbeToken,
  writeProbePrompt,
  verifyWriteProbe,
  runTaskAgentWritePreflight,
  ensureTaskAgentWriteAccess,
  shouldAssessFailure,
}
`,
  )
  return factory(
    args,
    () => {},
    () => {},
    agentImpl,
    async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    { total: null, remaining: () => Infinity, spent: () => 0 },
  )
}

function probeDetailsFromPrompt(prompt) {
  const file = /^PROBE_FILE: (.+)$/m.exec(prompt)
  const token = /^PROBE_TOKEN: (.+)$/m.exec(prompt)
  assert.ok(file && token, 'probe prompt should carry machine-parsable PROBE_FILE and PROBE_TOKEN lines')
  return { file: file[1], token: token[1] }
}

test('write preflight is on by default and disable is explicit', async () => {
  assert.equal((await loadPreflightSurface({})).WORKTREE_WRITE_PREFLIGHT, true)
  assert.equal(
    (await loadPreflightSurface({ worktreeWritePreflight: false })).WORKTREE_WRITE_PREFLIGHT,
    false,
  )
})

test('write probe targets cover plan and build adapters without duplicates', async () => {
  const surface = await loadPreflightSurface({})
  assert.deepEqual(
    surface.writeProbeTargets().map((target) => [target.role, target.adapter]),
    [['plan', 'claude'], ['build', 'codex-medium']],
  )

  const merged = await loadPreflightSurface({ planAdapter: 'codex', buildAdapter: 'codex' })
  assert.deepEqual(merged.writeProbeTargets().map((target) => target.adapter), ['codex'])
})

test('host verification accepts only the exact token and removes the probe file', async () => {
  const surface = await loadPreflightSurface({})
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))
  const probeFile = surface.writeProbePath(dir, 'claude')
  const token = surface.writeProbeToken('1.2.3', 'claude')

  writeFileSync(probeFile, `${token}\n`)
  const good = await surface.verifyWriteProbe(probeFile, token)
  assert.equal(good.ok, true)
  assert.equal(existsSync(probeFile), false, 'verified probe file should be deleted')

  writeFileSync(probeFile, 'something else entirely')
  const mismatch = await surface.verifyWriteProbe(probeFile, token)
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.detail, /content mismatch/)

  const missing = await surface.verifyWriteProbe(probeFile, token)
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /missing or unreadable/)
})

test('preflight passes when every adapter probe lands on disk', async () => {
  const labels = []
  const compliantAgent = async (prompt, opts = {}) => {
    labels.push(opts.label)
    const { file, token } = probeDetailsFromPrompt(prompt)
    await writeFile(file, token, 'utf8')
    return { ok: true }
  }
  const surface = await loadPreflightSurface({}, compliantAgent)
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))

  const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')
  assert.deepEqual(outcome, { ok: true, failures: [] })
  assert.deepEqual(labels.sort(), ['write-probe:claude', 'write-probe:codex-medium'])
})

test('preflight fails per adapter when the probe never reaches the disk', async () => {
  const claims = async () => ({ ok: true })
  const surface = await loadPreflightSurface({}, claims)
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))

  const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.failures.map((failure) => failure.adapter).sort(), ['claude', 'codex-medium'])
  for (const failure of outcome.failures) {
    assert.match(failure.detail, /missing or unreadable/)
  }
})

test('preflight surfaces agent-reported sandbox rejections and thrown errors', async () => {
  const rejecting = async (prompt, opts = {}) => {
    if (opts.label === 'write-probe:claude') {
      return { ok: false, detail: 'sandbox denied write outside workspace root' }
    }
    throw new Error('adapter exited with code 1: workspace-write rejected path')
  }
  const surface = await loadPreflightSurface({}, rejecting)
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))

  const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')
  assert.equal(outcome.ok, false)
  const byAdapter = new Map(outcome.failures.map((failure) => [failure.adapter, failure.detail]))
  assert.match(byAdapter.get('claude'), /sandbox denied write/)
  assert.match(byAdapter.get('codex-medium'), /workspace-write rejected path/)
})

test('verification rejects a symlink at the probe path without reading its target', async () => {
  const surface = await loadPreflightSurface({})
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))
  const secret = path.join(dir, 'secret.txt')
  const token = surface.writeProbeToken('1.2.3', 'claude')
  writeFileSync(secret, token, 'utf8')
  const probeFile = surface.writeProbePath(dir, 'claude')
  symlinkSync(secret, probeFile)

  const verdict = await surface.verifyWriteProbe(probeFile, token)

  assert.equal(verdict.ok, false)
  assert.match(verdict.detail, /not a regular file/)
  assert.ok(!verdict.detail.includes(token), 'target content must not leak into the failure detail')
  assert.equal(existsSync(probeFile), false, 'the symlink itself should be removed')
  assert.equal(readFileSync(secret, 'utf8'), token, 'the symlink target must be untouched')
})

test('a committed decoy at the probe path cannot pre-satisfy the preflight', async () => {
  const surface = await loadPreflightSurface({ planAdapter: 'codex', buildAdapter: 'codex' }, async () => ({ ok: true }))
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))
  const probeFile = surface.writeProbePath(dir, 'codex')
  writeFileSync(probeFile, surface.writeProbeToken('1.2.3', 'codex'), 'utf8')

  const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')

  assert.equal(outcome.ok, false, 'a decoy with a predictable token must not stand in for the agent write')
  assert.deepEqual(outcome.failures.map((failure) => failure.adapter), ['codex'])
})

test('the host probe clears a committed symlink instead of writing through it', async () => {
  const surface = await loadPreflightSurface({ planAdapter: 'codex', buildAdapter: 'codex' }, async (prompt) => {
    const { file, token } = probeDetailsFromPrompt(prompt)
    await writeFile(file, token, 'utf8')
    return { ok: true }
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'df12-probe-target-'))
  const target = path.join(outside, 'victim.txt')
  writeFileSync(target, 'operator data\n', 'utf8')
  symlinkSync(target, path.join(dir, '.df12-write-probe-host'))

  const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')

  assert.equal(outcome.ok, true)
  assert.equal(readFileSync(target, 'utf8'), 'operator data\n', 'the symlink target must never be overwritten')
  assert.equal(existsSync(path.join(dir, '.df12-write-probe-host')), false)
})

// chmod-based denial does not bind root, so this scenario cannot fail there.
test('preflight fails fast on an unwritable host root before spawning agents', { skip: process.getuid?.() === 0 }, async () => {
  let agentCalls = 0
  const surface = await loadPreflightSurface({}, async () => {
    agentCalls += 1
    return { ok: true }
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))
  chmodSync(dir, 0o500)
  try {
    const outcome = await surface.runTaskAgentWritePreflight(dir, '1.2.3')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failures[0].adapter, 'host')
    assert.equal(agentCalls, 0)
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('disabled preflight short-circuits without probing', async () => {
  let agentCalls = 0
  const surface = await loadPreflightSurface({ worktreeWritePreflight: false }, async () => {
    agentCalls += 1
    return { ok: true }
  })

  const outcome = await surface.ensureTaskAgentWriteAccess('/nonexistent', '1.2.3')
  assert.deepEqual(outcome, { ok: true, skipped: true, failures: [] })
  assert.equal(agentCalls, 0)
})

test('preflight verdict is computed once and shared across tasks', async () => {
  let agentCalls = 0
  const compliantAgent = async (prompt) => {
    agentCalls += 1
    const { file, token } = probeDetailsFromPrompt(prompt)
    await writeFile(file, token, 'utf8')
    return { ok: true }
  }
  const surface = await loadPreflightSurface({ planAdapter: 'codex', buildAdapter: 'codex' }, compliantAgent)
  const dir = mkdtempSync(path.join(tmpdir(), 'df12-probe-'))

  const first = await surface.ensureTaskAgentWriteAccess(dir, '1.2.3')
  const second = await surface.ensureTaskAgentWriteAccess(dir, '1.2.4')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(agentCalls, 1, 'single deduped adapter should be probed exactly once per run')
})

test('worktree-write failures stay out of partial-branch assessment', async () => {
  const surface = await loadPreflightSurface({})
  const wt = { branch: 'roadmap-1-2-3', worktreePath: '/tmp/x', baseSha: 'abc' }
  assert.equal(
    surface.shouldAssessFailure({ status: 'failed', stage: 'worktree-write', detail: 'probe failed' }, wt),
    false,
  )
})

test('runTask gates on the write preflight before any planning or addendum work', async () => {
  const source = await readFile(WORKFLOW_PATH, 'utf8')
  assert.match(
    source,
    new RegExp(
      String.raw`const writeAccess = await ensureTaskAgentWriteAccess\(worktree, tag\)` +
        String.raw`[\s\S]*?stage: 'worktree-write'` +
        String.raw`[\s\S]*?if \(task\.isAddendum\)`,
    ),
  )
})
