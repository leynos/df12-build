// Property tests for the shared git-donkey worktree safety-net (issue #2).
// `worktreeSafetyNet(base)` is a pure function whose whole job is to weave ONE
// base branch through a fixed chain of git commands. The example tests in
// prompts.test.ts pin the wording for a couple of concrete bases; these
// properties pin the INVARIANT that holds for every base: the fetch, the
// git-donkey invocation, the reset, and the verify all reference the SAME base,
// origin-namespaced where they must be, and the git-donkey call always carries
// the base so it can never fall back to git donkey's built-in `main` default.
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import { worktreeSafetyNet } from '../../src/workflows/df12-build-odw/prompts.ts'

// Branch-name-like strings: a non-empty run over the git-ref-ish alphabet
// (letters, digits, and `-_/.`). Whitespace is excluded so a generated base
// cannot smuggle a newline into the `\n`-joined step list or a space into a
// command token, which would make the linkage assertions meaningless rather
// than test the helper.
const branchChar = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.'.split(''),
)
const baseArb = fc.array(branchChar, { minLength: 1, maxLength: 40 }).map((chars) => chars.join(''))

describe('worktreeSafetyNet properties', () => {
  test('every step references the same base, origin-namespaced where required', () => {
    fc.assert(
      fc.property(baseArb, (base) => {
        const text = worktreeSafetyNet(base)
        // Fetch → git donkey → reset → verify all thread the one base.
        expect(text).toContain(`git fetch origin ${base}`)
        expect(text).toContain(`git donkey <slug> ${base}`)
        expect(text).toContain(`git reset --hard origin/${base}`)
        expect(text).toContain(`git rev-parse origin/${base}`)
        // The HEAD read the verify/reset gate compares against is present and
        // base-independent.
        expect(text).toContain('git -C <worktree> rev-parse HEAD')
        // The remote-qualified ref the agent must NOT pass is base-linked too.
        expect(text).toContain(`origin/origin/${base}`)
      }),
    )
  })

  test('the sole git donkey invocation always carries the base (no no-arg main default)', () => {
    fc.assert(
      fc.property(baseArb, (base) => {
        const text = worktreeSafetyNet(base)
        // Exactly one git-donkey invocation, and it passes the base. A bare
        // `git donkey <slug>` with no argument would root on git donkey's
        // built-in `main` default; this invariant forbids that form for every
        // base, including `main` itself.
        const invocations = text.split('git donkey <slug>').length - 1
        expect(invocations).toBe(1)
        expect(text).toContain(`git donkey <slug> ${base}`)
      }),
    )
  })
})
