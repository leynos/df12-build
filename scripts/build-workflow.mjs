// Build workflows/df12-build-odw.js from the module tree under
// src/workflows/df12-build-odw/.
//
// The ODW loader demands a single file whose only export is a literal
// `export const meta`, with the body executed as an async function body
// (top-level `return` legal, primitives injected as parameters). No bundler
// emits that shape, so the artifact is framed from three pieces:
//
//   banner  — src/.../meta.js, concatenated VERBATIM (never parsed by the
//             bundler, so the literal survives byte-for-byte);
//   bundle  — esbuild output for src/.../main.js: format 'esm' with a
//             no-export entry produces flat top-level code with no
//             import/export statements, free identifiers (agent, log, args,
//             ...) left untouched, and top-level names preserved;
//   footer  — a generated `return await workflowMain()`.
//
// Tree shaking is disabled so an unused helper can never silently vanish
// from the artifact, and the script fails closed on every loader-contract
// hazard it can detect (module closure wrappers, import/export tokens,
// duplicate or missing workflowMain, unparsable output).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC_DIR = path.join(ROOT, 'src', 'workflows', 'df12-build-odw')
const ENTRY = path.join(SRC_DIR, 'main.ts')
const BANNER = path.join(SRC_DIR, 'meta.js')
const OUT = path.join(ROOT, 'workflows', 'df12-build-odw.js')
const MARKER = '// --- Worker-pool control loop -----------------------------------------------'

function fail(message) {
  console.error(`build-workflow: ${message}`)
  process.exit(1)
}

const banner = readFileSync(BANNER, 'utf8')
const bannerExports = banner.match(/^export const meta\s*=/gm) || []
if (bannerExports.length !== 1) {
  fail(`expected exactly one 'export const meta =' in ${BANNER}, found ${bannerExports.length}`)
}

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  treeShaking: false,
  write: false,
  legalComments: 'inline',
  logLevel: 'silent',
})
let bundle = result.outputFiles[0].text

// The loader rejects any import/export keyword outside the meta literal, and
// the helper-surface tests need flat top-level declarations, so a module
// that esbuild had to wrap in a lazy closure (cycles, CJS) is a build error.
for (const wrapper of ['__esm(', '__commonJS(', '__toESM(', '__require(']) {
  if (bundle.includes(wrapper)) fail(`bundle contains module wrapper ${wrapper}; keep src modules acyclic ESM`)
}
if (/^\s*(import|export)\b/m.test(bundle)) fail('bundle emitted an import/export statement')
if (/\bimport\s*\(/.test(bundle) || bundle.includes('import.meta')) {
  fail('bundle contains dynamic import or import.meta, which the ODW loader rejects')
}

// esbuild renames top-level symbols on cross-module collision (foo -> foo2),
// which would silently break the helper-surface tests that slice the artefact
// and return helpers by name. Require every name a src module exports to
// survive into the bundle as a top-level declaration under its own name.
const moduleFiles = readdirSync(SRC_DIR).filter(
  (name) =>
    (name.endsWith('.js') || name.endsWith('.ts')) &&
    !name.endsWith('.d.ts') &&
    !['meta.js', 'main.js', 'main.ts'].includes(name),
)
for (const file of moduleFiles) {
  const text = readFileSync(path.join(SRC_DIR, file), 'utf8')
  for (const match of text.matchAll(/^export (?:async )?(?:function|class|const|let|var) ([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1]
    const declared = new RegExp(`^(?:async )?(?:function|class|var|let|const) ${name}\\b`, 'm')
    if (!declared.test(bundle)) {
      fail(`top-level name '${name}' from ${file} is missing or was renamed in the bundle`)
    }
  }
}

const mainMatches = bundle.match(/^async function workflowMain\(\) \{$/gm) || []
if (mainMatches.length !== 1) {
  fail(`expected exactly one top-level 'async function workflowMain() {', found ${mainMatches.length}`)
}
// Re-insert the control-loop marker the bundler stripped, purely for human
// orientation when reading the artifact; tests slice the src tree instead.
bundle = bundle.replace(/^async function workflowMain\(\) \{$/m, `${MARKER}\nasync function workflowMain() {`)

const artifact = [
  '// GENERATED FILE — built by `make workflow-build` from src/workflows/df12-build-odw/.',
  '// Do not edit directly; edit the src tree and rebuild.',
  banner.trimEnd(),
  '',
  bundle.trimEnd(),
  '',
  '// --- Entry (generated footer) ------------------------------------------------',
  'return await workflowMain()',
  '',
].join('\n')

// Mirror the ODW loader's wrap before writing: strip the meta export, then
// require the result to parse as an async function body.
const wrapped = artifact.replace(/^export const meta\s*=/m, 'const meta =')
try {
  new Function(`return (async function __workflow_wrapped__() {\n${wrapped}\n})`)
} catch (error) {
  fail(`artifact does not parse under the loader wrap: ${error && error.message}`)
}

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, artifact)
console.log(`${path.relative(ROOT, OUT)}: built from src (${artifact.length} bytes)`)
