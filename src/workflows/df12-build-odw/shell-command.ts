/**
 * Non-evaluating parsing for operator-configured shell commands. The host uses
 * it to identify the CodeScene executable, while the run summary uses the
 * preserved assignment spans to redact secrets without changing the command
 * that the shell executes.
 *
 * @module
 */

/** One parsed shell word, with its unquoted value and original command span. */
export interface ShellCommandWord {
  /** The word value after limited POSIX-style quote and backslash handling. */
  value: string
  /** Inclusive offset of this word in the original command. */
  start: number
  /** Exclusive offset of this word in the original command. */
  end: number
}

/** A leading `NAME=value` assignment and the source span to redact. */
export interface ShellCommandAssignment {
  /** Environment variable name. */
  name: string
  /** Inclusive offset of the assignment in the original command. */
  start: number
  /** Exclusive offset of the assignment in the original command. */
  end: number
}

/** Parsed shell words plus the contiguous leading environment assignments. */
export interface ShellCommandTokens {
  /** Every shell word in command order. */
  words: ShellCommandWord[]
  /** Leading environment assignments, preserving the original source spans. */
  leadingAssignments: ShellCommandAssignment[]
}

/** Return the exclusive end offset of a balanced shell command substitution. */
function commandSubstitutionEnd(command: string, start: number): number | null {
  let cursor = start + 2
  let quote = ''
  let depth = 1
  while (cursor < command.length) {
    const character = command[cursor]
    if (character === '\\' && quote !== "'") {
      cursor += 2
      continue
    }
    if (quote) {
      if (character === quote) quote = ''
      cursor += 1
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      cursor += 1
      continue
    }
    if (character === '$' && command[cursor + 1] === '(') {
      depth += 1
      cursor += 2
      continue
    }
    if (character === ')') {
      depth -= 1
      cursor += 1
      if (!depth) return cursor
      continue
    }
    cursor += 1
  }
  return null
}

/**
 * Parse a limited POSIX-style command without evaluating expansions. Quoting,
 * escapes, and nested command substitutions keep whitespace inside a word;
 * malformed quotes or substitutions return `null` so callers can fail closed.
 */
export function tokenizeShellCommand(command: string): ShellCommandTokens | null {
  const words: ShellCommandWord[] = []
  let cursor = 0
  while (cursor < command.length) {
    while (cursor < command.length && /\s/.test(command[cursor])) cursor += 1
    if (cursor >= command.length) break
    const start = cursor
    let value = ''
    let quote = ''
    let hasWord = false
    while (cursor < command.length) {
      const character = command[cursor]
      if (!quote && /\s/.test(character)) break
      if (!quote && (character === "'" || character === '"')) {
        quote = character
        hasWord = true
        cursor += 1
        continue
      }
      if (quote && character === quote) {
        quote = ''
        cursor += 1
        continue
      }
      if (character === '$' && command[cursor + 1] === '(' && quote !== "'") {
        const end = commandSubstitutionEnd(command, cursor)
        if (end === null) return null
        value += command.slice(cursor, end)
        hasWord = true
        cursor = end
        continue
      }
      if (character === '\\' && quote !== "'") {
        cursor += 1
        if (cursor >= command.length) return null
        value += command[cursor]
        hasWord = true
        cursor += 1
        continue
      }
      value += character
      hasWord = true
      cursor += 1
    }
    if (quote || !hasWord) return null
    words.push({ value, start, end: cursor })
  }

  const leadingAssignments: ShellCommandAssignment[] = []
  for (const word of words) {
    const match = word.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match) break
    leadingAssignments.push({ name: match[1], start: word.start, end: word.end })
  }
  return { words, leadingAssignments }
}
