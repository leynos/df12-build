/**
 * @file Process and filesystem helpers: execFile wrappers with attached
 * stream output, shell quoting, and the absent-vs-fault file probe. All host
 * I/O goes through `process.getBuiltinModule` so the module loads without
 * imports under the ODW wrapper.
 */

/**
 * Outcome of a host command run through `execFileStatus`. Unlike
 * `execFileText`, a non-zero exit or timeout is reported here rather than
 * thrown, so callers that need to inspect a failed command's stdout/stderr
 * (rather than just detect failure) should use this form.
 */
export interface ExecStatus {
  /** True when the command exited zero; `false` covers non-zero exit, timeout, or signal kill. */
  ok: boolean
  /** Captured standard output, empty on failure unless the process wrote before failing. */
  stdout: string
  /** Captured standard error, empty on success. */
  stderr: string
  /** Error message when `ok` is false; absent on success. */
  message?: string
  /**
   * Set when the child was killed (e.g. by the timeoutMs option); the
   * message alone does not say so.
   */
  killed?: boolean
  /** Signal that terminated the child, if any. */
  signal?: string
}

/** Options shared by the `execFile*` wrappers. */
export interface ExecOptions {
  /** Working directory for the child process; defaults to `process.cwd()`. */
  cwd?: string
  /** Kill the child and reject/report failure if it runs longer than this, in milliseconds. */
  timeoutMs?: number
}

/** Result of probing whether a path names an existing regular file. */
export interface FileState {
  /** True when the probe itself succeeded (regardless of whether the file exists); false on an unexpected stat fault the caller must surface. */
  ok: boolean
  /** True when the path names an existing regular file. */
  exists: boolean
  /** Fault description when `ok` is false; empty otherwise. */
  detail: string
}

type ExecError = Error & { stdout?: string; stderr?: string }

/**
 * Run a host command and resolve with its stdout, or reject with the
 * captured error (stdout/stderr attached) on a non-zero exit, timeout, or
 * spawn failure. Prefer `execFileStatus` when the caller needs to branch on
 * failure without a try/catch.
 */
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

/**
 * Run a host command and always resolve, reporting success or failure via
 * `ExecStatus.ok` instead of throwing. Wraps `execFileText`, capturing the
 * partial stdout/stderr a failed child produced so callers can log or act on
 * it without a try/catch.
 */
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

/**
 * Single-quote a value for safe interpolation into a POSIX shell command
 * line, escaping embedded single quotes. Coerces non-string values with
 * `String()` first.
 */
export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * Distinguish "the file is absent" from "the filesystem would not answer":
 * ENOENT/ENOTDIR mean absent; anything else (permissions, I/O) is a fault the
 * caller must surface rather than conflate with a missing file. Probes with
 * `lstat` and requires a REGULAR file: callers pass worktree paths that are
 * untrusted content (see write-preflight.ts), so a committed symlink at the
 * probed path must read as absent (fail closed), never as the file it points
 * at.
 *
 * @param pathValue Path to probe; a falsy value short-circuits to "absent"
 *   without touching the filesystem.
 * @param baseDir Base directory used to resolve `pathValue` when it is not
 *   already absolute.
 */
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
