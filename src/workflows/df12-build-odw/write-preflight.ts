// Task-agent writable-root preflight — ODW launches every adapter with the
// control checkout as its working directory, so a sandbox scoped to that
// checkout silently rejects writes to sibling ...worktrees/roadmap-* paths.
// Prompt text cannot fix that, so the workflow proves writability once per
// run: each adapter that must write into task worktrees (planner and builder)
// is asked to write a token file inside the first task worktree, and the HOST
// verifies the bytes on disk. A failed probe is a launch/sandbox fault, so the
// task fails fast at stage "worktree-write" instead of burning design rounds,
// and that stage is excluded from partial-branch assessment. The probe
// targets and the enable flag come from run configuration, bound once via
// makeWritePreflight so the exported runners keep their two-argument shape.

export interface WriteProbeTarget {
  role: string
  adapter: string
  options: (options: Record<string, unknown>) => Record<string, unknown>
}

export interface WritePreflightOutcome {
  ok: boolean
  skipped?: boolean
  failures: Array<{ adapter: string; detail: string }>
}

export const WRITE_PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true when the probe file was written with the exact token' },
    detail: { type: 'string', description: 'the error encountered, empty when ok' },
  },
  required: ['ok'],
}

export function writeProbePath(worktree: string, adapter: string): string {
  const path = process.getBuiltinModule('node:path')
  return path.join(worktree, `.df12-write-probe-${String(adapter).replace(/[^0-9a-zA-Z._-]+/g, '-')}`)
}

export function writeProbeToken(tag: string, adapter: string): string {
  return `df12-write-probe v1 task=${tag} adapter=${adapter}`
}

export function writeProbePrompt(probeFile: string, token: string): string {
  return [
    'You are a sub-agent in the df12-build roadmap workflow. Your final message IS your return value — return data, not chat.',
    '',
    'TASK: Writable-root probe. Write EXACTLY the token below (no trailing newline required) to the probe file path below, using your shell or file-edit tooling. Do not write anywhere else, do not commit, and do not delete the file afterwards — the workflow host verifies and removes it.',
    '',
    `PROBE_FILE: ${probeFile}`,
    `PROBE_TOKEN: ${token}`,
    '',
    'Return ok=true only if the write succeeded. If the write is rejected (sandbox, permissions, missing directory), return ok=false with the exact error text in detail.',
  ].join('\n')
}

// The worktree is untrusted content: a branch can commit a symlink or a decoy
// file at a probe path. `fs.rm` removes the link itself (never its target),
// so clearing before writing or dispatching keeps the host from writing
// through, reading through, or trusting anything it did not create.
export async function clearProbeArtifact(probeFile: string): Promise<void> {
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    await fs.lstat(probeFile)
  } catch {
    return // nothing at the path
  }
  await fs.rm(probeFile, { force: true, recursive: true })
}

export async function verifyWriteProbe(probeFile: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const fs = process.getBuiltinModule('node:fs/promises')
  const { constants } = process.getBuiltinModule('node:fs')
  // Open once with O_NOFOLLOW and verify/read through the handle: the check
  // and the read then target the same inode, so a symlink (or a swap between
  // a check and a separate path-based read) can never redirect the read.
  let handle = null
  let content: string | null = null
  try {
    handle = await fs.open(probeFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (stat.isFile()) {
      content = await handle.readFile({ encoding: 'utf8' })
    }
  } catch (error) {
    const failure = error as (Error & { code?: string }) | null
    // Linux reports ELOOP for O_NOFOLLOW on a symlink; FreeBSD uses EMLINK.
    if (failure && (failure.code === 'ELOOP' || failure.code === 'EMLINK')) {
      await fs.rm(probeFile, { force: true, recursive: true })
      return { ok: false, detail: 'probe path is not a regular file (symlink or special file rejected)' }
    }
    return { ok: false, detail: `probe file missing or unreadable: ${(failure && failure.message) || String(error)}` }
  } finally {
    if (handle) await handle.close()
  }
  await fs.rm(probeFile, { force: true, recursive: true })
  if (content === null) {
    return { ok: false, detail: 'probe path is not a regular file (symlink or special file rejected)' }
  }
  if (content.trim() === token) return { ok: true, detail: '' }
  return { ok: false, detail: `probe file content mismatch (${content.trim().slice(0, 80) || '<empty>'})` }
}

export async function hostWriteProbe(worktree: string): Promise<{ ok: boolean; detail: string }> {
  const fs = process.getBuiltinModule('node:fs/promises')
  const path = process.getBuiltinModule('node:path')
  const hostProbe = path.join(worktree, '.df12-write-probe-host')
  try {
    // Clear any committed artefact first, then create exclusively ('wx'
    // fails on any pre-existing path), so the write can never follow a
    // symlink out of the worktree.
    await clearProbeArtifact(hostProbe)
    await fs.writeFile(hostProbe, 'df12-write-probe host', { encoding: 'utf8', flag: 'wx' })
    await fs.rm(hostProbe, { force: true })
    return { ok: true, detail: '' }
  } catch (error) {
    return { ok: false, detail: ((error as Error | null) && (error as Error).message) || String(error) }
  }
}

export function makeWritePreflight({ enabled, targets }: { enabled: boolean; targets: () => WriteProbeTarget[] }) {
  async function runTaskAgentWritePreflight(worktree: string, tag: string): Promise<WritePreflightOutcome> {
    const failures: Array<{ adapter: string; detail: string }> = []
    const host = await hostWriteProbe(worktree)
    if (!host.ok) {
      return { ok: false, failures: [{ adapter: 'host', detail: host.detail }] }
    }
    for (const target of targets()) {
      const probeFile = writeProbePath(worktree, target.adapter)
      const token = writeProbeToken(tag, target.adapter)
      // Clear committed decoys before dispatch: the token is predictable, so a
      // pre-existing file (or symlink) at the probe path must never be able to
      // satisfy — or redirect — the verification that follows.
      await clearProbeArtifact(probeFile)
      let reply: { ok?: boolean; detail?: string } | null = null
      let agentError = ''
      try {
        reply = (await agent(writeProbePrompt(probeFile, token), target.options({
          phase: 'Worktree',
          label: `write-probe:${target.adapter}`,
          schema: WRITE_PROBE_SCHEMA,
        }))) as { ok?: boolean; detail?: string } | null
      } catch (error) {
        agentError = ((error as Error | null) && (error as Error).message) || String(error)
      }
      const verified = await verifyWriteProbe(probeFile, token)
      if (!verified.ok) {
        const detail = [verified.detail, reply && reply.ok === false ? reply.detail : '', agentError]
          .filter(Boolean)
          .join('; ')
        failures.push({ adapter: target.adapter, detail })
      }
    }
    return { ok: failures.length === 0, failures }
  }

  // One probe per run: sandbox scope does not vary between sibling worktrees,
  // so every task shares the first task's verdict (concurrent tasks await the
  // same promise and fail fast together when the environment is broken).
  let taskAgentWritePreflight: Promise<WritePreflightOutcome> | null = null
  function ensureTaskAgentWriteAccess(worktree: string, tag: string): Promise<WritePreflightOutcome> {
    if (!enabled) return Promise.resolve({ ok: true, skipped: true, failures: [] })
    if (!taskAgentWritePreflight) taskAgentWritePreflight = runTaskAgentWritePreflight(worktree, tag)
    return taskAgentWritePreflight
  }

  return { runTaskAgentWritePreflight, ensureTaskAgentWriteAccess }
}
