/**
 * @file Docstring-coverage gate for the ODW module tree. AGENTS.md requires each
 * module to open with a `@file` docblock and — so the public surface stays
 * self-documenting — a recognised JSDoc block on every EXPORTED declaration.
 * CodeRabbit's docstring-coverage check flagged the salvage additions at 28.57%;
 * this gate makes that signal a deterministic, local, reproducible check rather
 * than a review-time surprise.
 *
 * It parses each listed module with the TypeScript compiler API (a stable,
 * direct devDependency), counts exported top-level declarations, and treats a
 * declaration as documented only when a JSDoc block immediately precedes it (a
 * plain `//` comment does NOT count — the distinction CodeRabbit draws). A
 * module with zero exports still must carry the `@file` block. The gate fails
 * when any module lacks the `@file` block or falls below the coverage threshold
 * (default 80%).
 *
 * Usage: node scripts/docstring-coverage.mjs [--min <pct>] <file.ts> ...
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'

const DEFAULT_MIN = 80

function parseArgs(argv) {
  const files = []
  let min = DEFAULT_MIN
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--min') {
      min = Number(argv[i + 1])
      i += 1
    } else {
      files.push(arg)
    }
  }
  if (!Number.isFinite(min) || min < 0 || min > 100) {
    throw new Error(`--min must be a percentage in [0, 100]; got ${min}`)
  }
  return { files, min }
}

// A leading `/** … */` block is a JSDoc doc-comment; a `//` block or a plain
// `/* … */` block is not. Returns true when the comment range closest to the
// declaration (the one that documents it) is a JSDoc block.
function hasJsDocImmediatelyBefore(fullText, node) {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || []
  if (!ranges.length) return false
  const last = ranges[ranges.length - 1]
  if (last.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return false
  return fullText.slice(last.pos, last.end).startsWith('/**')
}

// The exported names a top-level statement introduces (empty for non-exports and
// for bare `export { … }` re-exports, which have no declaration site to document
// here).
function exportedNames(statement) {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  const isExported = (modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (!isExported) return []
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((decl) => (ts.isIdentifier(decl.name) ? decl.name.text : null))
      .filter(Boolean)
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : []
  }
  return []
}

function hasFileDocblock(fullText, sourceFile) {
  const anchor = sourceFile.statements.length ? sourceFile.statements[0].getFullStart() : fullText.length
  const ranges = ts.getLeadingCommentRanges(fullText, 0) || ts.getLeadingCommentRanges(fullText, anchor) || []
  return ranges.some(
    (range) =>
      range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
      /^\/\*\*/.test(fullText.slice(range.pos, range.end)) &&
      /@file\b/.test(fullText.slice(range.pos, range.end)),
  )
}

function analyseFile(file) {
  const fullText = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, fullText, ts.ScriptTarget.ESNext, true)
  const exportsFound = []
  for (const statement of sourceFile.statements) {
    const names = exportedNames(statement)
    if (!names.length) continue
    const documented = hasJsDocImmediatelyBefore(fullText, statement)
    for (const name of names) exportsFound.push({ name, documented })
  }
  const total = exportsFound.length
  const documented = exportsFound.filter((entry) => entry.documented).length
  // A module with no exports is vacuously covered; the @file block is still
  // required so the module explains itself.
  const coverage = total === 0 ? 100 : (documented / total) * 100
  return {
    file,
    total,
    documented,
    coverage,
    fileDocblock: hasFileDocblock(fullText, sourceFile),
    undocumented: exportsFound.filter((entry) => !entry.documented).map((entry) => entry.name),
  }
}

function main() {
  const { files, min } = parseArgs(process.argv.slice(2))
  if (!files.length) {
    console.error('docstring-coverage: no files given')
    process.exit(2)
  }
  let failed = false
  for (const file of files) {
    const report = analyseFile(file)
    const problems = []
    if (!report.fileDocblock) problems.push('missing `/** @file … */` module docblock')
    if (report.coverage < min) {
      problems.push(
        `${report.coverage.toFixed(2)}% export docstring coverage (${report.documented}/${report.total}) is below the ${min}% threshold; undocumented: ${report.undocumented.join(', ')}`,
      )
    }
    if (problems.length) {
      failed = true
      console.error(`FAIL ${file}`)
      for (const problem of problems) console.error(`  - ${problem}`)
    } else {
      console.log(`ok   ${file}: ${report.coverage.toFixed(2)}% (${report.documented}/${report.total} exports)${report.total === 0 ? ' [no exports]' : ''}`)
    }
  }
  if (failed) {
    console.error(`docstring-coverage: threshold ${min}% not met`)
    process.exit(1)
  }
  console.log(`docstring-coverage: all files meet the ${min}% threshold`)
}

main()
