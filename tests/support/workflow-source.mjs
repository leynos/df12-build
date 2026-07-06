// Shared source-invariant reader for the ODW workflow test suites. Source
// invariants read the src tree verbatim: the build reprints the artefact
// (normalized quotes, stripped comments), so raw-source assertions belong
// against the source, and `make workflow-freshness` ties the artefact back to
// it. Concatenate the whole tree (meta banner first, entry last) so the
// invariants keep matching as helpers migrate between modules.
import { readFile, readdir } from 'node:fs/promises'

export const WORKFLOW_SRC_DIR = new URL('../../src/workflows/df12-build-odw/', import.meta.url)

/**
 * Returns a sorted, presence-oriented concatenation of the module source
 * files (meta first, entry last, others alphabetical). This is suitable
 * only for presence-style / single-module invariant checks, not for
 * assertions that depend on cross-file relative ordering.
 */
/**
 * Reads ONE module's verbatim source, for source invariants whose tokens all
 * live in a single module — scoping avoids a cross-file `[\\s\\S]*?` match
 * that readWorkflowSource()'s sorted concatenation could otherwise allow.
 */
export async function readModuleSource(name) {
  return await readFile(new URL(name, WORKFLOW_SRC_DIR), 'utf8')
}

export async function readWorkflowSource() {
  const names = (await readdir(WORKFLOW_SRC_DIR))
    .filter(
      (name) =>
        (name.endsWith('.js') || name.endsWith('.ts')) &&
        !name.endsWith('.d.ts') &&
        !['meta.js', 'main.ts'].includes(name),
    )
    .sort()
  const parts = [await readFile(new URL('meta.js', WORKFLOW_SRC_DIR), 'utf8')]
  for (const name of names) parts.push(await readFile(new URL(name, WORKFLOW_SRC_DIR), 'utf8'))
  parts.push(await readFile(new URL('main.ts', WORKFLOW_SRC_DIR), 'utf8'))
  return parts.join('\n')
}
