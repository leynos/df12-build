# CodeRabbit agent-mode wire contract: observed live captures

The host-run CodeRabbit review (`src/workflows/df12-build-odw/host-review.ts`)
pins its parser and outcome classification to the NDJSON event stream that
`coderabbit review --agent` emits on stdout. That contract is pinned against
CLI internals rather than any published specification, so this page records
the evidence: bounded excerpts from real CLI sessions captured on the
development host between 2026-06-25 and 2026-07-06 (the `/tmp/coderabbit-*.out`
gate logs). Long string values are truncated with `…`; everything else is
verbatim.

Two properties observed across every capture drive the implementation:

1. The CLI exits `0` even when the review fails fatally (rate limit, auth,
   service errors). Outcome classification must therefore read the event
   stream, never the exit code.
2. Every event is a single JSON object per line with a `type` discriminator.
   Six types were observed: `review_context`, `status`, `heartbeat`,
   `finding`, `complete`, and `error`.

## A complete clean session

Captured 2026-07-06 while reviewing this branch (zero findings):

```json
{"type":"review_context","reviewType":"all","currentBranch":"odw-compilation","baseBranch":"main",
 "workingDirectory":"/home/leynos/Projects/df12-build.worktrees/odw-compilation"}
{"type":"status","phase":"connecting","status":"connecting_to_review_service"}
{"type":"status","phase":"setup","status":"setting_up"}
{"type":"status","phase":"setup","status":"preparing_sandbox"}
{"type":"status","phase":"analyzing","status":"summarizing"}
{"type":"status","phase":"analyzing","status":"tools_completed"}
{"type":"status","phase":"analyzing","status":"reviewing"}
{"type":"complete","status":"review_completed","findings":0}
```

The `review_context` line is wrapped here for line length; on the wire it is
one line, like every other event.

## `status` and `heartbeat`

Observed `phase` values: `connecting`, `setup`, `analyzing`. Long reviews
interleave heartbeats:

```json
{"type":"heartbeat","status":"reviewing"}
```

`status` events sometimes carry a human-readable `message`, observed when the
CLI could not attribute the repository to an organization plan:

```json
{"type":"status","phase":"analyzing","status":"setting_up",
 "message":"CodeRabbit couldn't verify this repository's organization right now, so this review will use the free…"}
```

Treat `message` as informational prose: it changes wording between CLI
versions and must never be parsed for control flow.

## `finding`

Observed keys: `type`, `severity`, `fileName`, `codegenInstructions`,
`suggestions` (an array), and sometimes `comment`. Observed severities:
`critical`, `major`, `minor`, `trivial`, `info`. Example (2026-06-28):

```json
{"type":"finding","severity":"major","fileName":"chutoro-benches/tests/neighbour_scoring_support.rs",
 "codegenInstructions":"Verify each finding against current code. Fix only still-valid issues, skip the rest…",
 "suggestions":[]}
```

`coderabbitBlockingItems` treats only `critical` and `major` as blocking;
every finding is counted in the run-result aggregate and, when configured,
appended to the `coderabbitFindingsFile` JSONL sink.

## `complete`

Always carries `status` and a numeric `findings` count:

```json
{"type":"complete","status":"review_completed","findings":0}
{"type":"complete","status":"review_completed","findings":12}
```

## `error` (rate limit)

The quota error is `errorType: "rate_limit"` with `recoverable: true` and a
humanized `waitTime` string inside `metadata` (not machine-parseable as a
duration — the workflow uses its own deterministic backoff instead). Two
shapes were captured live.

Organization-attributed (2026-07-05, this branch's first review attempt):

```json
{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded","recoverable":true,
 "metadata":{"isProUser":true,"waitTime":"11 minutes",
  "policyGuidance":"Enable usage-based reviews in Billing to review now. Otherwise, wait until the next included…",
  "orgAttributed":true,"cliReviewPolicyMode":"normal"}}
```

Free-tier fallback (2026-06-28, a repository without an organization
connection; note the extra `details` object and the optional
`cliReviewLightRequested` flag):

```json
{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded","recoverable":true,"details":{},
 "metadata":{"isProUser":false,"waitTime":"10 minutes and 59 seconds",
  "policyGuidance":"You've used all free CLI reviews for now. CodeRabbit can't apply an organization plan until…",
  "orgAttributed":false,"cliReviewLightRequested":true,"cliReviewPolicyMode":"light"}}
```

`classifyCoderabbitOutcome` keys on `errorType === "rate_limit"` (with a
regex fallback over the error text for older CLI builds), and treats any
other `error` event as `error` unless the text matches the auth patterns in
`faults.ts`, which classify as `auth`.

## Maintenance

When a CLI upgrade changes this stream, capture a fresh session
(`coderabbit review --agent --type committed --base <branch> | tee <log>`),
update the excerpts here, and re-run the wire-contract suites in
`tests/df12-build-odw-assessment.test.mjs` (parser and classification
tables) before adjusting `host-review.ts`.
