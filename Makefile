BASE ?= origin/main

MARKDOWN_FILES := $(shell find . \
	-path './.git' -prune -o \
	-path './image_out' -prune -o \
	-name '*.md' -print | sort)
WORKFLOW_FILES := workflows/df12-build-odw.js workflows/df12-build.js

.PHONY: all check-fmt lint typecheck markdownlint nixie test test-modules test-workflow verify-modules workflow-parse workflow-build workflow-freshness

all: check-fmt lint typecheck markdownlint nixie test workflow-freshness verify-modules

# Regenerate the ODW workflow artifact from the module tree under src/.
workflow-build:
	bun scripts/build-workflow.mjs

# Fail when the committed artifact is stale relative to the src tree.
workflow-freshness: workflow-build
	git diff --exit-code -- workflows/df12-build-odw.js

check-fmt:
	git diff --check "$$(git merge-base HEAD $(BASE))..HEAD"

lint: markdownlint workflow-parse

typecheck: workflow-parse

markdownlint:
	markdownlint-cli2 $(MARKDOWN_FILES)

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
# Skips when dafny is not on PATH so the gate stays runnable everywhere.
verify-modules:
	@if command -v dafny >/dev/null 2>&1; then \
		node_modules/.bin/lsc check --backend=dafny verify/recovery-decision.model.ts; \
	else \
		echo "verify-modules: dafny not on PATH; skipping LemmaScript verification"; \
	fi

workflow-parse:
	node -e "const fs=require('fs'); for (const path of process.argv.slice(1)) { let source=fs.readFileSync(path,'utf8').replace(/^export const meta\s*=/m,'const meta ='); new Function('return (async function __workflow_wrapped__() {\n' + source + '\n})'); console.log(path + ': wrapped JavaScript parses'); }" $(WORKFLOW_FILES)
