/** @file Shared fixtures for focused host-review module tests. */
import { makeHostReview } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { HostReviewCompositionDeps } from '../../src/workflows/df12-build-odw/host-review.ts'
import type { ExecOptions, ExecStatus } from '../../src/workflows/df12-build-odw/exec.ts'

/** Build a host-review surface with deterministic, review-neutral defaults. */
export function hostReview(overrides: Partial<Parameters<typeof makeHostReview>[0]> = {}, composition: HostReviewCompositionDeps = {}) {
  return makeHostReview({
    base: 'main',
    reviewAttempts: 3,
    reviewBackoffMinutes: [45, 90],
    reviewFindingsFile: '',
    commitGates: ['make all'],
    commitGateTimeoutSeconds: 5,
    csCheck: false,
    csCheckCommand: 'cs-check-changed',
    reviewTool: 'coderabbit',
    dakarCommand: 'dakar-review',
    reviewTimeoutSeconds: 3600,
    dakarBudgetGbp: 0,
    ...overrides,
  }, composition)
}

/** Capture host-review subprocess calls while returning one scripted status. */
export function recordingExec(result: Partial<ExecStatus>) {
  const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = []
  const exec = async (command: string, args: readonly string[], options: ExecOptions = {}) => {
    calls.push({ command, args: [...args], options })
    return { ok: true, stdout: '', stderr: '', ...result }
  }
  return { calls, exec }
}

/** Return a fixture value after making absence explicit to TypeScript. */
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fixture value')
  return value
}
