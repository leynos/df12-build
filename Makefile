BASE ?= origin/main

MARKDOWN_FILES := $(shell find . \
	-path './.git' -prune -o \
	-path './image_out' -prune -o \
	-name '*.md' -print | sort)
WORKFLOW_FILES := workflows/df12-build-odw.js workflows/df12-build.js

.PHONY: all check-fmt lint typecheck markdownlint nixie test workflow-parse

all: check-fmt lint typecheck markdownlint nixie test

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

workflow-parse:
	node -e "const fs=require('fs'); for (const path of process.argv.slice(1)) { let source=fs.readFileSync(path,'utf8').replace(/^export const meta\s*=/,'const meta ='); new Function('return (async function __workflow_wrapped__() {\n' + source + '\n})'); console.log(path + ': wrapped JavaScript parses'); }" $(WORKFLOW_FILES)
