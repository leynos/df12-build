// Unit tests for the non-evaluating command tokenizer shared by CodeScene
// availability probing and run-summary secret redaction.
import { describe, expect, test } from 'bun:test'

import { tokenizeShellCommand } from '../../src/workflows/df12-build-odw/shell-command.ts'

describe('tokenizeShellCommand', () => {
  test.each([
    ['TOKEN=$(read simple-secret) cs-check-changed', 'TOKEN=$(read simple-secret)', ['TOKEN=$(read simple-secret)', 'cs-check-changed']],
    ['TOKEN="$(read quoted-secret)" cs-check-changed', 'TOKEN="$(read quoted-secret)"', ['TOKEN=$(read quoted-secret)', 'cs-check-changed']],
    ['TOKEN=$(outer "$(inner nested-secret)") "code scene check"', 'TOKEN=$(outer "$(inner nested-secret)")', ['TOKEN=$(outer "$(inner nested-secret)")', 'code scene check']],
  ])('keeps command substitutions and quoted whitespace within one word', (command, rawAssignment, words) => {
    const tokens = tokenizeShellCommand(command)

    expect(tokens?.words.map((word) => word.value)).toEqual(words)
    expect(tokens?.leadingAssignments).toHaveLength(1)
    const assignment = tokens?.leadingAssignments[0]
    expect(command.slice(assignment?.start, assignment?.end)).toBe(rawAssignment)
  })

  test('fails closed for an unterminated command substitution', () => {
    expect(tokenizeShellCommand('TOKEN=$(read secret cs-check-changed')).toBeNull()
  })
})
