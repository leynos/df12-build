BASE ?= origin/main

MARKDOWN_FILES := $(shell find . \
	-path './.git' -prune -o \
	-path './image_out' -prune -o \
	-name '*.md' -print | sort)
WORKFLOW_FILES := workflows/df12-build-odw.js workflows/df12-build.js

.PHONY: all check-fmt lint typecheck markdownlint nixie test workflow-parse workflow-build workflow-freshness

all: check-fmt lint typecheck markdownlint nixie test

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

test:
	node --test
	uv run tests/run-odw-script-tests.py

workflow-parse:
	node -e "const fs=require('fs'); for (const path of process.argv.slice(1)) { let source=fs.readFileSync(path,'utf8').replace(/^export const meta\s*=/m,'const meta ='); new Function('return (async function __workflow_wrapped__() {\n' + source + '\n})'); console.log(path + ': wrapped JavaScript parses'); }" $(WORKFLOW_FILES)
