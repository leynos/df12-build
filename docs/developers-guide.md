# df12-build developers guide

This guide is for contributors changing `df12-build` workflow assets or
documentation. It complements the user-facing launch instructions in
`docs/users-guide.md` and the operator runbook in the `df12-build-supervisor`
skill.

## Normative references

Read these before changing launch or workflow behaviour:

- `docs/architecture.md` for the repository, target-project, and sidecar state
  boundaries.
- `docs/adr-001-adopt-odw-sidecar-launches.md` for the accepted sidecar launch
  decision.
- `docs/users-guide.md` for the public launch flow and configuration surface.
- `skills/df12-build-supervisor/SKILL.md` for the detailed operator playbook.
- `workflows/df12-build-odw.js` for the ODW/Codex workflow implementation.
- `workflows/df12-build.js` for the baseline roadmap workflow that the ODW
  variant was derived from.

## Repository shape

The repository currently contains workflow scripts, skill documentation, and
docs. It does not contain a project roadmap, ExecPlan, package manifest, or
`Makefile`.

Relevant paths:

- `workflows/df12-build-odw.js`: ODW/Codex workflow.
- `workflows/df12-build.js`: baseline workflow.
- `skills/df12-build-supervisor/SKILL.md`: operator skill.
- `docs/users-guide.md`: user-facing launch guide.
- `docs/developers-guide.md`: contributor-facing maintenance guide.
- `docs/architecture.md`: design-level sidecar and workflow contract.
- `docs/adr-001-adopt-odw-sidecar-launches.md`: accepted launch decision.

If a future branch adds `docs/roadmap.md` or `docs/execplans/`, update the
matching task or ExecPlan whenever the branch lands planned work.

## ODW workflow contract

`workflows/df12-build-odw.js` is an ODW script, not a conventional Node module.
Keep the ODW script contract intact:

- Keep `meta` as a literal `export const meta = { ... }` object.
- Do not import ODW primitives. `args`, `agent`, `parallel`, `phase`, `log`,
  and `budget` are injected by ODW.
- Use schemas where JavaScript consumes agent output as structured data.
- Keep phase and label names explicit enough to make the dashboard useful.
- Keep target-project mutation inside agent prompts and real git worktrees;
  ODW copy isolation is not a persistent handoff mechanism for this workflow.
- Serialize operations that advance `origin/<base>` through the merge lock.

Changes to workflow behaviour must update all relevant prompts, schemas, docs,
and validation notes in the same branch.

## Sidecar tooling contract

ODW/Codex launches use a `.workshop` sidecar outside the target project's Git
worktree. The sidecar must hold the copied workflow script, `odw.config.json`,
`args.json`, and `operator-notes.md`.

Contributor rules:

- Do not document `.claude/`, `/tmp`, the target source tree, or
  `...worktrees/roadmap-*` as durable launch locations.
- Treat `origin/<base>` in the target project as the product source of truth.
- Treat sidecar-local workflow patches as temporary recovery changes until they
  are promoted back to this repository.
- When adding or renaming an argument, update `docs/users-guide.md`,
  `docs/architecture.md`, this guide, and the supervisor skill as needed.
- When changing adapter/model routing, update both the code defaults and the
  configuration examples that describe them.

## Documentation maintenance

Keep documentation layers aligned:

- User guide: what an operator runs and which files they maintain.
- Developer guide: how contributors change the workflow and docs safely.
- Architecture: state boundaries, workflow structure, configuration contract,
  and verification contract.
- ADRs: accepted decisions and alternatives for durable architectural choices.
- Supervisor skill: detailed runbook procedures, failure diagnosis, and
  cleanup guidance.

Use en-GB Oxford spelling in prose and commit messages. Prefer `artefact`,
`behaviour`, `configuration`, and `synchronized` spelling where those words
appear in documentation.

## Validation

This repository has no repo-wide `make` gates yet. Until that changes, run the
available checks sequentially and capture output with `tee`:

```bash
rev="$(git rev-parse --short HEAD)"

git diff --check "$(git merge-base HEAD origin/main)..HEAD" 2>&1 \
  | tee "/tmp/diff-check-$(get-project)-${rev}.out"

markdownlint-cli2 docs/users-guide.md docs/developers-guide.md \
  docs/architecture.md docs/adr-001-adopt-odw-sidecar-launches.md \
  skills/df12-build-supervisor/SKILL.md 2>&1 \
  | tee "/tmp/markdownlint-$(get-project)-${rev}.out"
```

For changes that touch `workflows/df12-build-odw.js`, also run an ODW wrapper
parse check. This validates host-authored workflow syntax without spawning
agents:

```bash
node - <<'NODE'
const fs = require('fs');
const path = 'workflows/df12-build-odw.js';
let source = fs.readFileSync(path, 'utf8');
source = source.replace(/^export const meta\s*=/, 'const meta =');
new Function(`return (async function __odw_wrapped__() {\n${source}\n})`);
console.log(`${path}: ODW-wrapped JavaScript parses`);
NODE
```

Do not use a live `odw run` as a routine gate. Run it only when the task
explicitly asks for execution or smoke testing, because it can spawn agents and
mutate target-project state.
