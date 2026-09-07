/**
 * @file Pin the wiring that makes the commit gates run in CI.
 *
 * `tests/modules/typedoc-gate.test.ts` proves the documentation gate decides,
 * and the Makefile recipe assertion there proves `make all` reaches it without
 * ignoring its exit status. Neither notices if CI stops invoking `make all` at
 * all, which is the last link in the chain and the easiest one to sever by
 * accident.
 *
 * The assertions parse the workflow rather than searching its text, because a
 * gate can be disarmed without touching the command. Each one kills a distinct
 * mutation, verified on 2026-09-07:
 *
 * - `if: false` on the step, or any condition at all such as a push-only one,
 *   skips the command with the run value untouched. Falsy spellings are not
 *   enumerated; YAML parses `false` to a boolean, and the assertion is that the
 *   key is absent, which rejects every condition including a plausible one.
 * - `if: false` on the job skips every step in it.
 * - Wrapping the command as `if false; then make all; fi` leaves a step whose
 *   run value contains the command but runs nothing, so the whole run value
 *   must be the command rather than merely contain it.
 * - Changing the command, removing the job, or removing the `pull_request`
 *   trigger each break a separate assertion.
 *
 * @module
 */
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW_PATH = path.join(REPO, '.github', 'workflows', 'ci.yml')
const WORKFLOW = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as {
  on?: Record<string, unknown>
  jobs?: Record<string, { if?: unknown, steps?: { if?: unknown, run?: unknown }[] }>
}

/** The job that runs the repository's commit gates. */
const GATE_JOB = 'test'
/** The command whose exit status is the gate. */
const GATE_COMMAND = 'make all'
/** The command proving Dafny actually ran rather than being skipped. */
const STRICT_COMMAND = 'make verify-modules-strict'

const job = WORKFLOW.jobs?.[GATE_JOB]
const steps = job?.steps ?? []

/**
 * Find the steps whose entire `run` value is one command.
 *
 * Equality rather than containment is the point: a step reading
 * `if false; then make all; fi` contains the command and runs nothing.
 *
 * @param command Command the step must run and nothing else.
 * @returns Every matching step, so a test can assert there is exactly one.
 */
function stepsRunning(command: string): { if?: unknown, run?: unknown }[] {
  return steps.filter((step) => typeof step.run === 'string' && step.run.trim() === command)
}

describe('CI runs the commit gates', () => {
  test('the workflow triggers on pull requests', () => {
    expect(WORKFLOW.on, `${WORKFLOW_PATH} has no trigger block`).toBeDefined()
    expect(Object.keys(WORKFLOW.on ?? {})).toContain('pull_request')
  })

  test('the gate job exists and carries no condition', () => {
    expect(job, `${WORKFLOW_PATH} has no ${GATE_JOB} job`).toBeDefined()
    // A condition on the job skips every step in it, leaving each run value
    // intact and every other assertion here satisfied.
    expect(Object.keys(job ?? {})).not.toContain('if')
  })

  test('one unconditional step runs the commit gates and nothing else', () => {
    const matches = stepsRunning(GATE_COMMAND)

    expect(matches.length, `expected exactly one step whose run value is "${GATE_COMMAND}"`).toBe(1)
    expect(Object.keys(matches[0] ?? {})).not.toContain('if')
  })

  test('one unconditional step proves the Dafny verification ran', () => {
    // make all uses the lenient verify-modules, which skips when Dafny is
    // absent, so this second step is what makes the proof a real gate.
    const matches = stepsRunning(STRICT_COMMAND)

    expect(matches.length, `expected exactly one step whose run value is "${STRICT_COMMAND}"`).toBe(1)
    expect(Object.keys(matches[0] ?? {})).not.toContain('if')
  })
})
