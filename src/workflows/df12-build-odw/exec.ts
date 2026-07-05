// Process and filesystem helpers: execFile wrappers with attached stream
// output, shell quoting, and the absent-vs-fault file probe. All host I/O
// goes through process.getBuiltinModule so the module loads without imports
// under the ODW wrapper.

export interface ExecStatus {
  ok: boolean
  stdout: string
  stderr: string
  message?: string
}

export interface FileState {
  ok: boolean
  exists: boolean
  detail: string
}

type ExecError = Error & { stdout?: string; stderr?: string }

export async function execFileText(command: string, commandArgs: readonly string[]): Promise<string> {
  const { execFile } = process.getBuiltinModule('node:child_process')
  return await new Promise((resolve, reject) => {
    execFile(command, [...commandArgs], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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

export async function execFileStatus(command: string, commandArgs: readonly string[]): Promise<ExecStatus> {
  try {
    return { ok: true, stdout: await execFileText(command, commandArgs), stderr: '' }
  } catch (error) {
    const failure = error as ExecError | null
    return {
      ok: false,
      stdout: failure?.stdout || '',
      stderr: failure?.stderr || '',
      message: (failure && failure.message) || String(error),
    }
  }
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

// Distinguish "the file is absent" from "the filesystem would not answer":
// ENOENT/ENOTDIR mean absent; anything else (permissions, I/O) is a fault the
// caller must surface rather than conflate with a missing file. Returns
// { ok, exists, detail }.
export async function fileState(pathValue: unknown, baseDir: string = process.cwd()): Promise<FileState> {
  if (!pathValue) return { ok: true, exists: false, detail: '' }
  const path = process.getBuiltinModule('node:path')
  const candidate = path.isAbsolute(String(pathValue))
    ? String(pathValue)
    : path.join(baseDir, String(pathValue))
  const fs = process.getBuiltinModule('node:fs/promises')
  try {
    const stat = await fs.stat(candidate)
    return { ok: true, exists: stat.isFile(), detail: '' }
  } catch (error) {
    const failure = error as (Error & { code?: string }) | null
    if (failure && (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')) {
      return { ok: true, exists: false, detail: '' }
    }
    return { ok: false, exists: false, detail: `stat failed for ${candidate}: ${(failure && failure.message) || String(error)}` }
  }
}
