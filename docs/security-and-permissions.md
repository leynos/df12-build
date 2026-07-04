# df12-build security and permissions guide

`df12-build` is not a passive documentation tool. A normal ODW/Codex workshop
can create branches, create worktrees, edit source, run commands, commit,
push, request CodeRabbit review, write audit files, and update roadmap state in
another repository. Do not run it with credentials or filesystem access that
would not be granted to an autonomous engineer working on that target project.

The workflow's prompts are part of the control system, but they are not a
sandbox. Runtime permissions, GitHub rights, branch protection, repository
gates, and operator review are the hard boundary.

## Required permissions

File access:

- Read access to this `df12-build` checkout, so the operator can copy the
  checked-in workflow into the sidecar.
- Read and write access to the `.workshop` sidecar for `df12-build-odw.js`,
  `odw.config.json`, `args.json`, `operator-notes.md`, and temporary
  validation logs.
- Read and write access to the target project checkout and its sibling
  `...worktrees/roadmap-*` worktrees.
- Adapter sandbox write scope for task agents must include the assigned
  `roadmap-*` worktree. A sandbox rooted only at the target project's control
  checkout is not enough when the workflow creates sibling worktrees; planning
  can report an ExecPlan path while the file cannot be written.
- Read and write access to the target project's normal build caches and package
  caches. Do not point build outputs at `/tmp`; use the project's normal cache
  policy.
- Read access to installed skills and sub-agents used by the workflow, such as
  `execplans`, `logisphere-design-review`, `logisphere-experts`,
  `code-review`, `scrutineer`, `leta`, `sem`, `rebase`, `roadmap-doc`,
  `roadmap-grooming`, `tech-design-doc`, `commit-message`, and
  `pr-creation`.

Git access:

- Fetch access to the target project's remote integration branch,
  `origin/<base>`.
- Permission to create and update task branches.
- Permission to create sibling worktrees and prune finished worktrees.
- Permission to commit on task, audit, triage, and integration branches.
- Permission to push the integration branch when `autoMerge=true`.
- Permission to leave branches unmerged when `autoMerge=false`, so a human can
  inspect and merge them later.

Network access:

- Access to GitHub or the configured Git remote.
- Access to the selected ODW adapter providers, such as Codex, Claude, Gemini,
  Qwen, or Kimi, depending on `odw.config.json`.
- Access to the configured code-search backend: GrepAI when
  `searchBackend=grepai`, or the Memtrace MCP server when
  `searchBackend=memtrace`.
- Access to CodeRabbit for `coderabbit review --agent`.
- Access to package registries needed by the target project's gates.
- Access to Firecrawl or official documentation sources only when a plan or
  review explicitly requires external-library verification.

GitHub access:

- Repository read access for the target project.
- Branch push permission for task and integration branches.
- Permission to create or update pull requests if the operator uses PR-based
  recovery.
- Permission to read review comments and CodeRabbit output.
- Permission to comment on PRs only when the operator intentionally enables a
  tool or sub-agent that writes comments.

## External services

Workshops may contact:

- GitHub or the configured Git hosting service.
- ODW adapter providers named in `odw.config.json`.
- GrepAI semantic search.
- CodeRabbit.
- Package registries used by the target project's gates.
- Documentation fetch services such as Firecrawl, when the task asks for
  external verification.

Partial branch assessment may also send branch names, worktree paths, commit
ids, changed-file lists, dirty-state summaries, ExecPlan text, roadmap text,
validation evidence, and failure details to the selected assessment adapter.
Fresh-run recovery (`resumePartialBranches=true`) sends the same evidence for
every discovered surviving branch, so enabling recovery on a repository shares
the content of abandoned task branches with the assessment adapter.

Treat prompts, code snippets, logs, roadmap text, design documents, audit
findings, review comments, and assessment evidence as data that may be sent to
those services. Do not run a workshop on a repository whose confidentiality
requirements forbid that data flow.

## Prompt-injection surface

The workflow deliberately feeds repository text into autonomous agents:

- `docs/roadmap.md` controls task selection and task wording.
- Design docs and ADRs are passed through `designDocs`.
- ExecPlans are written by agents and then read by other agents.
- Review and audit findings are passed into fix, triage, and remediation
  prompts.
- Partial branch assessment prompts include host-collected git evidence and ask
  an agent to classify surviving task branches.
- `AGENTS.md` and skill instructions shape command execution and gates.

Any of those files can contain prompt injection. A malicious or sloppy roadmap
item can ask an agent to ignore scope, exfiltrate tokens, weaken gates, skip
review, push to the wrong branch, or edit unrelated files. The workflow tells
agents not to do those things, but text instructions are not sufficient.

Controls that matter:

- Keep secrets out of roadmap, design, audit, and review text.
- Use least-privilege GitHub tokens for workshop runs.
- Prefer branch protection and required checks on protected branches.
- Keep `autoMerge=false` when evaluating an unfamiliar or untrusted roadmap.
- Keep `documentAudit=false` when audit files should not be pushed
  automatically.
- Review `pendingProposals`, `remediationTriage`, and addenda before
  accepting roadmap churn.
- Treat `assessment` recommendations as advisory. They are designed to guide
  operator judgement, not to bypass review, gates, or branch protection.
- Treat recovered branch content as prompt-injection input. A surviving branch
  may contain commits, ExecPlans, or notes written by an earlier compromised or
  confused agent; recovery assessment reads them, and review-mode resume asks
  reviewers to judge them. The resume path fails closed (only clean, committed,
  task-scoped `adopt-complete` branches with validation evidence enter review),
  and everything still passes the ordinary review and integration gates, but
  `resumeMode="review"` should only be enabled for branches an operator would
  willingly hand to a reviewer.
- Treat sidecar-local patches as untrusted until promoted through the normal
  `df12-build` review path.

## Recommended sandbox profiles

Use the narrowest profile that still lets the intended run complete.

Read-only planning profile:

- Allow reading the target project, sidecar, skills, and docs.
- Allow creating temporary sidecar logs.
- Deny Git push and target-project writes.
- Use `dryRun=true`, `autoMerge=false`, and `documentAudit=false`.
- Use this for first contact with an unfamiliar roadmap or design corpus.
- Assess-only recovery (`resumePartialBranches=true` with the default
  `resumeMode="assess"`) fits this profile: it reads branches, worktrees,
  roadmap text, ExecPlans, and validation evidence, and writes nothing.
  Review-mode resume does not fit here — it needs the trusted workshop profile
  because it can merge and push through the ordinary integration path.

Manual-merge profile:

- Allow target-project worktree writes, task branch commits, build caches, and
  package-manager caches.
- Ensure the adapter's writable root is the active task worktree, or explicitly
  includes the sibling `...worktrees/roadmap-*` directory.
- Deny pushes to the integration branch.
- Use `autoMerge=false`.
- Use this when agents may implement but a human must inspect branches before
  they land.

Trusted workshop profile:

- Allow sidecar writes, sibling worktree writes, normal build caches, package
  registries, GitHub, selected model providers, GrepAI, and CodeRabbit.
- Verify early that a planner can write `docs/execplans/<branch-leaf>.md` in
  the assigned task worktree; a missing ExecPlan after planning is a sandbox or
  workflow launch fault, not a roadmap design decision.
- Allow pushing task, audit, triage, and integration branches.
- Keep branch protection and required repository gates enabled where possible.
- Use only for repositories and credentials where autonomous branch, commit,
  push, review, and remediation behaviour is acceptable.

Never grant broad home-directory, system-directory, or unrelated-repository
write access merely because a model prompt says it is convenient. If a task
needs wider access, record why in `operator-notes.md` before relaunching.
