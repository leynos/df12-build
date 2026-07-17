/**
 * @file Remediation triage — when a step quiesces (no task from it still
 * building), GIST-triage the review/audit proposals it accrued into three
 * lanes instead of dumping them as full tasks into the current step:
 *   - addendum  -> small fix folded onto a completed task's execplan + a
 *     nested [ ] sub-task (consumed by the lightweight addendum lane);
 *   - step-task -> substantial work that serves THIS step's hypothesis;
 *   - reroute   -> substantial work filed under the step/phase whose
 *     hypothesis it actually serves (a new step is created when none fits).
 * Routing by hypothesis keeps a step carrying only debt that advances it,
 * and the cheap addendum lane (no audit) is what stops the amplification
 * spiral. The run wiring (preamble, base branch, roadmap path, adapter
 * routing) binds once via makeRemediation.
 */

/** A single review/audit follow-up proposal awaiting triage. */
export interface RemediationProposal extends Record<string, unknown> {
  /** Short title used as the dedup key (normalized: trimmed, lower-cased). */
  title?: string
  /** Rationale text; also used as a legacy fallback source tag. */
  rationale?: string
  /** Severity as reported by the originating review or audit. */
  severity?: string
  // The audit/review origin tag (e.g. `review:1.2.3`, `audit:1.2.4`) that
  // run-task.ts stamps onto every proposal; the canonical identity for
  // multi-source escalation. `rationale` is only a legacy fallback.
  /** Canonical origin tag stamped by run-task.ts, e.g. `review:1.2.3`. */
  source?: string
}

/** Run-scoped dependencies {@link makeRemediation} closes over. */
export interface RemediationDeps {
  /** Shared standing-rules preamble, sourced from prompts.ts. */
  preamble: (worktree: string | null | undefined) => string
  // The verified git-donkey worktree-creation sequence, sourced from
  // prompts.ts so audit and triage share one authority and cannot drift.
  // Injected (rather than imported) to keep this module import-free.
  /** Verified git-donkey worktree-creation sequence, sourced from prompts.ts. */
  worktreeSafetyNet: (base: string) => string
  /** Integration branch name the triage worktree roots on. */
  base: string
  /** Path to the roadmap file the triage agent reads and edits. */
  roadmap: string
  /** Adapter-routing hook applied to the triage agent's call options. */
  triageAgentOptions: (options: Record<string, unknown>) => Record<string, unknown>
  /** Stronger model used when {@link triageNeedsEscalation} returns true. */
  triageEscalationModel: string
}

/**
 * JSON Schema contract for the triage agent's routing decisions: one
 * decision per proposal (addendum / step-task / reroute / editorial /
 * dropped), any new steps it created, and whether it pushed its roadmap
 * edits.
 *
 * @internal
 */
export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposal: { type: 'string', description: 'short title of the proposal triaged' },
          lane: { type: 'string', enum: ['addendum', 'step-task', 'reroute', 'editorial', 'dropped'] },
          newId: { type: 'string', description: 'roadmap id created — a sub-task id like "1.2.8.5" for addendum, a task id for step-task/reroute, empty if dropped' },
          target: { type: 'string', description: 'addendum: parent task id + execplan folded onto; step-task/reroute: the step filed under; dropped: why' },
          reason: { type: 'string', description: 'GIST rationale — which step hypothesis it serves, or why it does not serve the settling step' },
        },
        required: ['proposal', 'lane', 'reason'],
      },
    },
    newSteps: { type: 'array', items: { type: 'string' }, description: 'any new step headings created to home reroutes, e.g. "7.4 Harden …"' },
    pushed: { type: 'boolean' },
    commitSha: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['ok', 'decisions', 'summary'],
}

/**
 * Derives the step prefix (`"<phase>.<step>"`) a roadmap id belongs to, so
 * proposals and new tasks can be grouped and filed under the right step
 * regardless of how many task/sub-task segments the full id carries.
 */
export const stepOf = (id: unknown): string => String(id).split('.').slice(0, 2).join('.')

/**
 * Deterministic pre-pass: collapses exact-duplicate proposals by normalized
 * title before the routing agent sees them, so the model spends nothing on
 * obvious repeats (multiple reviews/audits raising the same item). Order
 * and first-seen metadata are preserved; the deduped source tags are
 * unioned so a later multi-source escalation check still sees every origin.
 */
export function dedupeProposals(proposals: readonly RemediationProposal[]): RemediationProposal[] {
  const byKey = new Map<string, RemediationProposal & { sources?: string[] }>()
  for (const proposal of proposals || []) {
    const key = String(proposal?.title || '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (!key) continue
    // Canonical origin is `source` (the tag run-task.ts stamps); rationale is a
    // legacy fallback only.
    const source = String(proposal?.source || proposal?.rationale || '')
    const existing = byKey.get(key)
    if (existing) {
      if (source && !(existing.sources || []).includes(source)) existing.sources = [...(existing.sources || []), source]
      continue
    }
    byKey.set(key, { ...proposal, sources: source ? [source] : [] })
  }
  return [...byKey.values()]
}

/**
 * The escalation signal for the routing agent: proposals drawn from more
 * than one distinct audit/review source are the ones that can conflict or
 * route across phases, so they warrant the stronger model. A
 * single-source, small set is medium-model work.
 */
export function triageNeedsEscalation(deduped: readonly (RemediationProposal & { sources?: string[] })[]): boolean {
  const sources = new Set<string>()
  for (const proposal of deduped) {
    for (const source of proposal.sources || []) sources.add(source)
    // Fall back to the proposal's own source tag (rationale only as a last
    // resort for legacy inputs) when the merged `sources` was not threaded.
    if (!(proposal.sources || []).length) {
      const fallback = String(proposal.source || proposal.rationale || '')
      if (fallback) sources.add(fallback)
    }
  }
  return sources.size > 1
}

/**
 * Builds the triage prompt and its runner for one workflow run, closing
 * over the run's preamble, base branch, roadmap path, and adapter routing
 * so the returned functions take only the per-call step/proposal
 * arguments.
 */
export function makeRemediation({ preamble, worktreeSafetyNet, base, roadmap, triageAgentOptions, triageEscalationModel }: RemediationDeps) {
  function triagePrompt(stepPrefix: string, proposals: readonly RemediationProposal[]): string {
    return [
      preamble(null),
      `TASK: GIST-triage the remediation proposals accrued during step ${stepPrefix} (now settled) and file each onto the correct roadmap lane. They came from the reviews and audits of step ${stepPrefix}'s tasks. RECORD them correctly; do NOT implement them.`,
      '',
      worktreeSafetyNet(base),
      '',
      `Do all work in that worktree. Read ${roadmap} in full first. It is a GIST roadmap: each PHASE states an "Idea:", each STEP states a hypothesis it confirms or falsifies ("This step answers whether…"), and each TASK has Success criteria. Route by hypothesis. Re-read step ${stepPrefix}'s hypothesis specifically.`,
      '',
      'For EACH proposal below: first DE-DUPLICATE (merge near-identical items; DROP any already covered by an existing task or sub-task), then choose exactly ONE lane:',
      '',
      '  • ADDENDUM — a small, surgical correction to a SPECIFIC already-completed task (a doc fix, a localised bugfix, a small test/fixture refactor; about one focused commit, no design needed). File it as BOTH (a) a new item under a "## Addenda" section of that task\'s execplan in docs/execplans/ (create the section if absent), and (b) a nested unchecked sub-task on the roadmap directly under that [x] parent, numbered `<parent-id>.<next-n>` (e.g. `- [ ] 1.2.8.5.`) with one child bullet `- Addendum (from <source>; <sev>). <one-line scope>. Lightweight addendum pass.` and NO Requires line. The harness runs these as a no-plan, no-review lightweight pass.',
      '',
      `  • STEP-TASK — substantial work (warrants its own plan and review) that genuinely advances the settling step's hypothesis (${stepPrefix}). Append a full task in step ${stepPrefix}: \`- [ ] ${stepPrefix}.<next-n>. <title>\` with a description bullet, an appropriate \`- Requires …\` line, and a \`- Success:\` criterion. Use this lane ONLY if you can name the ${stepPrefix} hypothesis it serves.`,
      '',
      '  • REROUTE — substantial work that does NOT serve the settling step\'s hypothesis (hardening, cross-cutting quality, or a different concern). File it as a full task under the EXISTING step whose hypothesis it genuinely serves, with a `- Requires …` line so it is sequenced correctly and blocks nothing earlier. If NO existing step fits, CREATE a new step under the most appropriate phase (prefer the hardening or "deferred extensions" phase, typically the last phase): add a `### <phase>.<n>. <title>` heading with a one-paragraph hypothesis ("This step answers whether…") followed by the task(s). Record any new step in newSteps.',
      '',
      '  • EDITORIAL — the proposal is a correction to the roadmap text itself (a task description, success criterion, or wording — not code or other docs). APPLY it directly to the roadmap NOW, in this step (you are already editing the roadmap here), and do NOT file it as an addendum or task: the addendum/step-task/reroute lanes run later as sub-agents that are FORBIDDEN to edit the roadmap, so such an item is un-runnable and would halt the loop. Record lane "editorial" and note the corrected wording in reason.',
      '  • DROPPED — duplicate, already done, or not actionable. Record why in reason.',
      '',
      'Rules:',
      '  - Route by HYPOTHESIS, not by where the proposal was raised. A proposal raised during step ' + stepPrefix + ' that does not advance ' + stepPrefix + "'s hypothesis MUST be rerouted, never parked in " + stepPrefix + '.',
      '  - Prefer ADDENDUM for anything small and tied to one completed task — it is the cheap lane and skips the full plan/review cycle.',
      '  - Only append; keep the format and numbering of OTHER tasks intact. en-GB Oxford spelling throughout.',
      `  - When done, run \`make markdownlint\` and \`make nixie\`; fix any issues. Commit the roadmap and any execplan changes (en-GB imperative subject) and push it straight to the integration branch with \`git push origin HEAD:${base}\` (docs-only; re-fetch and rebase on a non-fast-forward reject, then retry). NEVER \`git switch ${base}\` or touch the control/root worktree.`,
      '',
      'Proposals to triage (JSON — each has title, rationale, optional severity, and a source tag like "audit:1.2.8" or "review:1.3.2"):',
      '```json',
      JSON.stringify(proposals, null, 2),
      '```',
      '',
      'Return one decision per proposal (proposal, lane, newId, target, reason), any newSteps created, whether you pushed, the commit sha, and a short summary.',
    ].join('\n')
  }

  async function runTriage(stepPrefix: string, proposals: readonly RemediationProposal[]) {
    phase('Remediation')
    // Deterministic dedup first (zero tokens), then route the remaining set at
    // the medium default, escalating to the stronger model only when the set
    // spans multiple audit/review sources (potential cross-phase / conflicting
    // routing).
    const deduped = dedupeProposals(proposals)
    if (!deduped.length) return { ok: true, decisions: [], summary: 'no proposals to triage after de-duplication' }
    const options: Record<string, unknown> = { phase: 'Remediation', label: `triage:${stepPrefix}`, schema: TRIAGE_SCHEMA }
    if (triageNeedsEscalation(deduped)) options.model = triageEscalationModel
    return await agent(triagePrompt(stepPrefix, deduped), triageAgentOptions(options))
  }

  return {
    /** Builds the triage agent's prompt for one settled step's proposals. */
    triagePrompt,
    /** Dedupes and dispatches the triage agent, escalating model choice when warranted. */
    runTriage,
    /** Re-exported for callers that need the dedup pass without a full triage run. */
    dedupeProposals,
    /** Re-exported for callers that need the escalation check without a full triage run. */
    triageNeedsEscalation,
  }
}
