// Process and filesystem helpers: execFile wrappers with attached stream
// output, shell quoting, and the absent-vs-fault file probe. All host I/O
// goes through process.getBuiltinModule so the module loads without imports
// under the ODW wrapper.

export interface ExecStatus {
  ok: boolean
  stdout: string
  stderr: string
  message?: string
  // Set when the child was killed (e.g. by the timeoutMs option); the
  // message alone does not say so.
  killed?: boolean
  signal?: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
}

export interface FileState {
  ok: boolean
  exists: boolean
  detail: string
}

type ExecError = Error & { stdout?: string; stderr?: string }

export async function execFileText(command: string, commandArgs: readonly string[], options: ExecOptions = {}): Promise<string> {
  const { execFile } = process.getBuiltinModule('node:child_process')
  return await new Promise((resolve, reject) => {
    execFile(command, [...commandArgs], { cwd: options.cwd || process.cwd(), maxBuffer: 16 * 1024 * 1024, ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}) }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecError
        failure.stdout = stdout
        failure.stderr = stderr
        reject(failure)
        return
      }
      resolve(stdout)
    })
  })
}

// Flatten an error thrown by execFileText into one human-readable line: the
// message plus any stderr/stdout the failing child attached. Shared by the
// call sites that surface a git failure as an operator-facing note.
export function execFailureDetail(error: unknown): string {
  const failure = error as ExecError | null
  return [
    (failure && failure.message) || String(error),
    failure?.stderr ? `stderr: ${failure.stderr.trim()}` : '',
    failure?.stdout ? `stdout: ${failure.stdout.trim()}` : '',
  ].filter(Boolean).join('; ')
}

export async function execFileStatus(command: string, commandArgs: readonly string[], options: ExecOptions = {}): Promise<ExecStatus> {
  try {
    return { ok: true, stdout: await execFileText(command, commandArgs, options), stderr: '' }
  } catch (error) {
    const failure = error as (ExecError & { killed?: boolean; signal?: string }) | null
    return {
      ok: false,
      stdout: failure?.stdout || '',
      stderr: failure?.stderr || '',
      message: (failure && failure.message) || String(error),
      // Set when the child was killed (e.g. by the timeoutMs option); the
      // message alone does not say so.
      killed: Boolean(failure?.killed),
      signal: failure?.signal || '',
    }
  }
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

// Distinguish "the file is absent" from "the filesystem would not answer":
// ENOENT/ENOTDIR mean absent; anything else (permissions, I/O) is a fault the
// caller must surface rather than conflate with a missing file. Probes with
// lstat and requires a REGULAR file: callers pass worktree paths that are
// untrusted content (see write-preflight.ts), so a committed symlink at the
// probed path must read as absent (fail closed), never as the file it
// points at. Returns { ok, exists, detail }.
export async function fileState(pathValue: unknown, baseDir: string = process.cwd()): Promise<FileState> {
  if (!pathValue) return { ok: true, exists: false, detail: '' }
  const path = process.getBuiltinModule('node:path')
  const candidate = path.isAbsolute(String(pathValue))
    ? String(pathValue)
    : path.join(baseDir, String(pathValue))
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    const stat = await fs.lstat(candidate)
    return { ok: true, exists: stat.isFile(), detail: '' }
  } catch (error) {
    const failure = error as (Error & { code?: string }) | null
    if (failure && (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')) {
      return { ok: true, exists: false, detail: '' }
    }
    return { ok: false, exists: false, detail: `stat failed for ${candidate}: ${(failure && failure.message) || String(error)}` }
  }
}
