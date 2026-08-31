/**
 * Exercise the non-evaluating command tokenizer shared by CodeScene probing
 * and run-summary secret redaction. The examples pin shell syntax boundaries,
 * while properties preserve source spans without ever evaluating a command.
 *
 * @file
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'

import {
  dakarInvocationFromCommand,
  redactedShellCommand,
  tokenizeShellCommand,
  validateDakarInvocation,
} from '../../src/workflows/df12-build-odw/shell-command.ts'

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

  test.each([
    ['unterminated single quote', "TOKEN='secret cs-check-changed"],
    ['unterminated double quote', 'TOKEN="secret cs-check-changed'],
    ['trailing backslash', 'TOKEN=secret\\'],
    ['unquoted backtick substitution', 'TOKEN=`read secret` cs-check-changed'],
    ['unterminated backtick substitution', 'TOKEN=`read secret cs-check-changed'],
    ['unquoted braced expansion', 'TOKEN=${secret} cs-check-changed'],
    ['unterminated braced expansion', 'TOKEN=${secret cs-check-changed'],
  ])('fails closed for %s', (_name, command) => {
    expect(tokenizeShellCommand(command)).toBeNull()
  })

  test('keeps a command without a leading assignment executable', () => {
    const tokens = tokenizeShellCommand('cs-check-changed --changed')

    expect(tokens?.leadingAssignments).toEqual([])
    expect(tokens?.words[0]?.value).toBe('cs-check-changed')
  })

  test.each([
    ['quoted name', "'TOKEN'=secret cs-check-changed"],
    ['escaped name', 'TO\\KEN=secret cs-check-changed'],
    ['escaped equals sign', 'TOKEN\\=secret cs-check-changed'],
  ])('does not classify a %s as a leading assignment', (_name, command) => {
    expect(tokenizeShellCommand(command)?.leadingAssignments).toEqual([])
  })

  test('accepts a quoted assignment value when the name and equals sign are literal', () => {
    expect(tokenizeShellCommand('TOKEN="secret value" cs-check-changed')?.leadingAssignments).toHaveLength(1)
  })

  test('collects assignments following a bare env invocation', () => {
    const command = 'env TOKEN=secret OTHER=value cs-check-changed --changed'
    const tokens = tokenizeShellCommand(command)

    expect(tokens?.leadingAssignments.map((assignment) => assignment.name)).toEqual(['TOKEN', 'OTHER'])
    expect(tokens?.words[tokens.executableWordIndex]?.value).toBe('cs-check-changed')
  })

  test('fails closed for env options rather than treating them as executables', () => {
    expect(tokenizeShellCommand('env -i TOKEN=secret cs-check-changed')).toBeNull()
  })

  test('preserves every generated literal assignment span', () => {
    const names = fc.constantFrom('A', 'TOKEN', 'DF12_CS_MARKER')
    const values = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { maxLength: 12 })
      .map((characters) => characters.join(''))
    fc.assert(fc.property(
      fc.array(fc.tuple(names, values), { minLength: 1, maxLength: 4 }),
      fc.constantFrom('cs-check-changed', 'code-scene-check'),
      (assignments, executable) => {
        const command = `${assignments.map(([name, value]) => `${name}=${value}`).join(' ')} ${executable}`
        const tokens = tokenizeShellCommand(command)

        expect(tokens).not.toBeNull()
        expect(tokens?.leadingAssignments.map((assignment) => assignment.name)).toEqual(assignments.map(([name]) => name))
        for (const [index, assignment] of (tokens?.leadingAssignments || []).entries()) {
          const pair = assignments[index]
          if (!pair) throw new Error(`Expected generated assignment at index ${index}`)
          const [name, value] = pair
          expect(command.slice(assignment.start, assignment.end)).toBe(`${name}=${value}`)
        }
      },
    ), { numRuns: 100 })
  })

  test('rejects generated malformed quote, escape, and expansion forms', () => {
    const malformed = fc.oneof(
      fc.array(fc.constantFrom(...'abc 123'), { maxLength: 20 }).map((characters) => `TOKEN='${characters.join('')}`),
      fc.array(fc.constantFrom(...'abc 123'), { maxLength: 20 }).map((characters) => `${characters.join('')}\\`),
      fc.array(fc.constantFrom(...'abc 123'), { maxLength: 20 }).map((characters) => `TOKEN=\`${characters.join('')}`),
      fc.array(fc.constantFrom(...'abc 123'), { maxLength: 20 }).map((characters) => `TOKEN=\${${characters.join('')}`),
    )
    fc.assert(fc.property(malformed, (command) => {
      expect(tokenizeShellCommand(command)).toBeNull()
    }), { numRuns: 100 })
  })

  test('redacts many leading assignments in one ordered projection', () => {
    const assignments = Array.from({ length: 1_000 }, (_, index) => `TOKEN_${index}=secret-${index}`)
    const command = `${assignments.join(' ')} cs-check-changed --changed`
    const redacted = redactedShellCommand(command)

    expect(redacted).not.toContain('secret-0')
    expect(redacted).not.toContain('secret-999')
    expect(redacted).toContain('TOKEN_0=<redacted>')
    expect(redacted).toContain('TOKEN_999=<redacted>')
    expect(redacted).toEndWith('cs-check-changed --changed')
  })
})

describe('Dakar command validation', () => {
  test.each([
    '',
    'dakar-review "unterminated',
    'TOKEN=secret dakar-review',
    'env TOKEN=secret dakar-review',
    'dakar-review; echo unsafe',
  ])('rejects unsafe configured commands: %s', (command) => {
    expect(dakarInvocationFromCommand(command)).toBeNull()
  })

  test('preserves quoted fixed arguments for the Dakar executable', () => {
    expect(dakarInvocationFromCommand('dakar-review --fixed "argument with spaces"'))
      .toEqual(['dakar-review', '--fixed', 'argument with spaces'])
  })

  test('rejects invocation arrays that can bypass command validation', () => {
    for (const invocation of [
      [],
      [''],
      ['TOKEN=secret', 'dakar-review'],
      ['env', 'TOKEN=secret', 'dakar-review'],
      ['dakar-review', ';'],
    ]) expect(validateDakarInvocation(invocation)).toBeNull()
  })
})
