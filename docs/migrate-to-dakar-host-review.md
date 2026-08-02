# Migrate to Dakar host review

This guide moves an existing workshop configuration from the previous
CodeRabbit default to the host-run Dakar review gate. New configurations use
Dakar by default; existing operators should complete these checks before their
next implementation run.

## Prerequisites

- Put `dakar-review` and `pi` on the review host's `PATH`.
- Export a non-empty `OPENAI_API_KEY` in the environment that launches the
  workflow.
- Keep the target repository available to the workflow host. Dakar reviews the
  committed diff from the task worktree, not uncommitted agent output.

## Adopt Dakar

1. Remove any implicit reliance on CodeRabbit being the default, or set the
   reviewer explicitly in `args.json`:

   ```json
   {
     "reviewTool": "dakar"
   }
   ```

2. If the defaults do not fit the host, set the bounded Dakar options:

   ```json
   {
     "dakarCommand": "dakar-review",
     "dakarTimeoutSeconds": 3600,
     "dakarBudgetGbp": 0
   }
   ```

   `dakarTimeoutSeconds` is clamped to 60–7200 seconds. `dakarBudgetGbp` is
   clamped to 0–10; `0` lets Dakar apply its own hard admission budget.

3. Launch the workflow normally. With authentication preflight enabled, a
   missing or empty `OPENAI_API_KEY` stops the run before task work begins.

Dakar runs host-side even if an older configuration contains
`coderabbitHostReview: false`. The historical flag restores agent-run review
only when CodeRabbit is selected explicitly.

## Retain CodeRabbit

To retain the previous NDJSON CLI path, select it explicitly:

```json
{
  "reviewTool": "coderabbit"
}
```

The existing CodeRabbit host-review and legacy-agent configuration continues
to apply in this mode. See the [CodeRabbit wire
contract](coderabbit-wire-contract.md) for its parser and outcome contract.

## See also

- [User guide](users-guide.md) for the complete configuration reference.
- [Architecture](architecture.md) for the host-review dispatch and retry
  boundary.
