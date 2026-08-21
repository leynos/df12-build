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
  /** Environment assignments before the executed command, preserving source spans. */
  leadingAssignments: ShellCommandAssignment[]
  /** Index of the executable word after assignments and a bare `env` command. */
  executableWordIndex: number
  /** Whether an unquoted shell control operator makes redaction fail closed. */
  hasUnquotedControlOperator: boolean
}

/** Return the exclusive end offset of a balanced shell command substitution. */
function commandSubstitutionEnd(command: string, start: number): number | null {
  let cursor = start + 2
  let quote = ''
  let depth = 1
  while (cursor < command.length) {
    const character = command[cursor]
    if (character === undefined) return null
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

/** Return an unquoted, unescaped assignment name, or null for an executable word. */
function assignmentName(command: string, word: ShellCommandWord): string | null {
  let cursor = word.start
  let name = ''
  while (cursor < word.end) {
    const character = command[cursor]
    if (character === undefined) return null
    if (character === '=') return name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null
    if (!/[A-Za-z0-9_]/.test(character)) return null
    name += character
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
  let hasUnquotedControlOperator = false
  while (cursor < command.length) {
    while (cursor < command.length) {
      const whitespace = command[cursor]
      if (whitespace === undefined || !/\s/.test(whitespace)) break
      if (whitespace === '\n') hasUnquotedControlOperator = true
      cursor += 1
    }
    if (cursor >= command.length) break
    const start = cursor
    let value = ''
    let quote = ''
    let hasWord = false
    while (cursor < command.length) {
      const character = command[cursor]
      if (character === undefined) return null
      if (!quote && /\s/.test(character)) break
      if (!quote && (character === ';' || character === '&' || character === '|')) {
        hasUnquotedControlOperator = true
      }
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
      if (!quote && (character === '`' || (character === '$' && command[cursor + 1] === '{'))) return null
      if (character === '\\' && quote !== "'") {
        cursor += 1
        if (cursor >= command.length) return null
        const escaped = command[cursor]
        if (escaped === undefined) return null
        value += escaped
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
  let executableWordIndex = 0
  for (; executableWordIndex < words.length; executableWordIndex++) {
    const word = words[executableWordIndex]
    if (!word) return null
    const name = assignmentName(command, word)
    if (!name) break
    leadingAssignments.push({ name, start: word.start, end: word.end })
  }
  if (words[executableWordIndex]?.value === 'env') {
    executableWordIndex += 1
    // `env` accepts options that alter its assignment and command semantics.
    // This limited parser deliberately supports only the bare invocation, so
    // an option cannot become an unredacted executable or probe target.
    if (words[executableWordIndex]?.value.startsWith('-')) return null
    for (; executableWordIndex < words.length; executableWordIndex++) {
      const word = words[executableWordIndex]
      if (!word) return null
      const name = assignmentName(command, word)
      if (!name) break
      leadingAssignments.push({ name, start: word.start, end: word.end })
    }
  }
  return { words, leadingAssignments, executableWordIndex, hasUnquotedControlOperator }
}

/** Redact environment assignments without changing the command that will execute. */
export function redactedShellCommand(command: string): string {
  const tokens = tokenizeShellCommand(command)
  if (!tokens || tokens.hasUnquotedControlOperator) return '<redacted command>'
  const parts: string[] = []
  let cursor = 0
  for (const assignment of tokens.leadingAssignments) {
    parts.push(command.slice(cursor, assignment.start), `${assignment.name}=<redacted>`)
    cursor = assignment.end
  }
  parts.push(command.slice(cursor))
  return parts.join('')
}
