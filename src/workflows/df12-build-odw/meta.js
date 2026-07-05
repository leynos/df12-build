// df12-build-odw — ODW/Codex workflow that drives a df12-house GIST roadmap
// to completion: deterministic selection, real git-worktree task isolation,
// adversarial plan/design review, implementation with deterministic gates,
// dual review, merge-lock integration, post-merge audit, remediation triage,
// fresh-run recovery of surviving task branches (failure-resume design), and
// a host-verified task-agent write preflight. Built from the module tree in
// src/workflows/df12-build-odw/ (make workflow-build); helpers land above the
// worker-pool control-loop marker so the test suites in tests/ can compile
// them in isolation; see docs/architecture.md for the enforcement boundary.
export const meta = {
  name: 'df12-build-odw',
  description:
    'ODW/Codex variant of df12-build: drive a roadmap to completion with a parallel worker pool, Claude Opus planning/review routing, branch-local verification guidance, serialized integration, and post-merge audit.',
  whenToUse:
    'When you want to autonomously advance docs/roadmap.md across MULTIPLE independent unblocked tasks at once, each fully planned, reviewed, implemented, gated, merged, and audited. Opt-in only (heavy, many agents in parallel, performs commits/merges). Recovery model is fresh-restart against git state, not cache-resume.',
  phases: [
    { title: 'Select' },
    { title: 'Auth Preflight' },
    { title: 'Recovery' },
    { title: 'Worktree' },
    { title: 'Plan' },
    { title: 'Design Review' },
    { title: 'Implement' },
    { title: 'Code Review' },
    { title: 'Expert Review' },
    { title: 'Assess' },
    { title: 'Integrate' },
    { title: 'Audit' },
    { title: 'Remediation' },
  ],
}
