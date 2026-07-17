BASE ?= origin/main

MARKDOWN_FILES := $(shell find . \
	-path './.git' -prune -o \
	-path './image_out' -prune -o \
	-name '*.md' -print | sort)
WORKFLOW_FILES := workflows/df12-build-odw.js workflows/df12-build.js
TYPOS_VERSION ?= 1.48.0
TYPOS := uv tool run typos@$(TYPOS_VERSION)
.PHONY: all clean check-fmt lint typecheck markdownlint nixie spelling test test-modules test-workflow verify-modules verify-modules-strict workflow-parse workflow-build workflow-freshness docs-check

all: check-fmt lint typecheck markdownlint nixie docs-check test workflow-freshness verify-modules

# Reset fetched dependencies. The generated workflow artefact is deliberately
# NOT removed: it is a committed file (the sidecar copies it verbatim), so its
# reset path is `make workflow-build`, and `make workflow-freshness` polices
# staleness.
clean:
	rm -rf node_modules
	rm -f .typos-oxendict-base.json .typos-oxendict-base.toml

# Regenerate the ODW workflow artifact from the module tree under src/.
workflow-build:
	bun scripts/build-workflow.mjs

# Fail when the committed artifact is stale relative to the src tree.
workflow-freshness: workflow-build
	git diff --exit-code -- workflows/df12-build-odw.js

check-fmt:
	git diff --check "$$(git merge-base HEAD $(BASE))..HEAD"

lint: markdownlint workflow-parse

# The src tree is TypeScript restricted to erasable syntax; tsc enforces the
# restriction (erasableSyntaxOnly, verbatimModuleSyntax in tsconfig.json).
typecheck: workflow-parse
	node_modules/.bin/tsc -p tsconfig.json --noEmit

markdownlint:
	markdownlint-cli2 $(MARKDOWN_FILES)
	+$(MAKE) spelling

spelling:
	@uv run scripts/generate_typos_config.py
	@printf '%s\0' $(MARKDOWN_FILES) | \
		xargs -0 -r $(TYPOS) --config typos.toml --force-exclude

nixie:
	nixie $(MARKDOWN_FILES)

test: test-modules test-workflow

# Bun-run suites for the individual src modules: Gherkin BDD scenarios via
# bun-test-cucumber, fast-check properties, and the verified-twin
# differential test.
test-modules:
	bun test tests/modules

# Suites that exercise the workflow as a whole (helper-surface slicing,
# control-loop simulation, mock-adapter smoke) run against the built
# artefact, so they depend on a fresh build.
test-workflow: workflow-build
	node --test 'tests/*.test.mjs'
	uv run tests/run-odw-script-tests.py

# LemmaScript -> Dafny verification of the recovery decision-table model.
# Skips when dafny is not on PATH so the gate stays runnable everywhere;
# `make all` uses this lenient form so local runs without Dafny stay friendly.
verify-modules:
	@if command -v dafny >/dev/null 2>&1; then \
		node_modules/.bin/lsc check --backend=dafny verify/recovery-decision.model.ts; \
	else \
		echo "verify-modules: dafny not on PATH; skipping LemmaScript verification"; \
	fi

# Strict verification that FAILS when Dafny is absent. CI must run this (not
# the lenient verify-modules) so the Dafny-backed proof is a real PR gate
# rather than advisory. The CI job is responsible for installing Dafny.
verify-modules-strict:
	@command -v dafny >/dev/null 2>&1 || { echo "verify-modules-strict: dafny is required but not on PATH"; exit 1; }
	node_modules/.bin/lsc check --backend=dafny verify/recovery-decision.model.ts

workflow-parse:
	node -e "const fs=require('fs'); for (const path of process.argv.slice(1)) { let source=fs.readFileSync(path,'utf8').replace(/^export const meta\s*=/m,'const meta ='); new Function('return (async function __workflow_wrapped__() {\n' + source + '\n})'); console.log(path + ': wrapped JavaScript parses'); }" $(WORKFLOW_FILES)

# Zero-tolerance documentation gate: TypeDoc's notDocumented validation over
# the whole ODW module tree (typedoc.json). Every module needs a leading
# `@module` block and every exported declaration a JSDoc block; warnings are
# errors and no documentation artefacts are emitted.
docs-check:
	bun run docs:check
