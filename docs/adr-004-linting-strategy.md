# Architectural decision record (ADR) 004: Oxlint rules for ODW source

## Status

Accepted. The source lint gate applies the Unicorn and deslop recommended
profiles to the authored workflow module tree.

## Date

2026-10-27.

## Context and problem statement

The decomposed ODW workflow is authored as TypeScript under
`src/workflows/df12-build-odw/` and bundled into a JavaScript workflow
artefact. The compiler and documentation gates already constrain its types and
module structure. The repository also needs consistent source-level rules for
correctness and maintainability without linting the generated workflow
artefacts as if they were authored source.

## Decision drivers

- Pin the linter, its type-aware backend, and the deslop plug-in for repeatable
  local and CI results.
- Apply the supported Unicorn recommended rules and the deslop recommended
  configuration to `src/`.
- Exclude the object code under `workflows/`; check those artefacts with the
  existing workflow parse and freshness gates.
- Keep the ODW runtime contract intact: lint dependencies are build tooling and
  do not become runtime imports in the generated workflow.
- Resolve only documented conflicts and correct source findings instead of
  suppressing them.

## Decision outcome

`make lint` runs Oxlint against `src/` using
[`oxlint.config.mjs`](../oxlint.config.mjs). The configuration enables the
Unicorn plug-in rules supported by the pinned Oxlint release, imports the
recommended `ai-deslop` rules, enables type-aware linting, and turns the other
Oxlint categories off. It excludes `workflows/**`. Tests remain outside this
source lint target and are exercised by `make test`.

The exact development dependency pins are:

| Package           | Version    | Purpose                           |
| ----------------- | ---------- | --------------------------------- |
| `oxlint`          | `1.82.0`   | Linter and built-in Unicorn rules |
| `ai-deslop`       | `0.4.9`    | Recommended `deslop/*` rules      |
| `oxlint-tsgolint` | `7.0.2004` | Type-aware rule backend           |

Table 1: pinned Oxlint dependencies.

Unicorn's `prefer-reflect-apply` recommends `Reflect.apply`, while deslop's
`no-reflect-apply` rejects it. Keep Unicorn's recommendation and disable
`deslop/no-reflect-apply`.

The ODW module tree has a scoped override for five rules that conflict with its
runtime and input-boundary contracts:

- `unicorn/no-null` is disabled because ODW uses `null` for failed
  `parallel` and `pipeline` slots, and JSON contracts can require explicit
  `null` values. Replacing them with `undefined` changes those contracts.
- `deslop/no-unknown-parameters`, `deslop/no-unknown-returns`, and
  `deslop/no-unsafe-dictionary-type` are disabled because workflow arguments,
  injected primitive results, and filesystem data can be untrusted before
  validation. `unknown` and dictionaries of `unknown` preserve that boundary in
  the type system.
- `deslop/no-runtime-typeof` is disabled because these boundaries use native
  type guards, and the ODW dialect forbids runtime validator-library imports.
  Agent outputs remain contracted with JSON Schema at the ODW boundary.

These exceptions apply only to `src/workflows/df12-build-odw/**/*.ts`. The
remaining selected rules stay enabled, including the requirement to justify
type assertions.

## Consequences

- New authored modules under `src/` are included in the Oxlint gate.
- Workflow object code under `workflows/` is checked by `workflow-parse`; the
  generated ODW artefact is also checked by `workflow-freshness`.
- Test behaviour continues to be checked by `make test`.
- A lint dependency upgrade requires reviewing the supported Unicorn rule
  list, deslop's recommended configuration, and the documented exceptions.

## References

- [Oxlint built-in plug-ins](https://oxc.rs/docs/guide/usage/linter/plugins.html)
- [Deslop recommended configuration](https://github.com/maharshi365/deslop#usage)
- [Simulacat Core plug-in adoption](https://github.com/leynos/simulacat-core/pull/121)
