// GENERATED FILE — built by `make workflow-build` from src/workflows/df12-build-odw/.
// Do not edit directly; edit the src tree and rebuild.
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

// src/workflows/df12-build-odw/recovery-decision.ts
var TASK_BRANCH_RE = /^roadmap-((?:\d+-)*\d+)(-addendum)?$/;
function branchToRoadmapId(branch) {
  const match = TASK_BRANCH_RE.exec(String(branch || ""));
  if (!match) return null;
  return { id: match[1].replace(/-/g, "."), isAddendum: Boolean(match[2]) };
}
function parseWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const spaceIndex = line.indexOf(" ");
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
    if (key === "worktree") {
      current = { worktreePath: value, branch: "", head: "" };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}
var RECOVERY_SKIP_REASONS = [
  "unmapped-branch",
  "already-complete",
  "unreadable-commit",
  "missing-worktree",
  "worktree-probe-fault",
  "candidate-cap",
  "assessment-error",
  "addendum-branch",
  "evidence-collection-error",
  "dirty-worktree",
  "no-committed-work",
  "not-task-scoped",
  "missing-validation-evidence",
  "missing-execplan",
  "plan-blocked",
  "plan-unreadable",
  "execplan-stat-error",
  "dry-run"
];
function recoveryResumeEligibility(candidate, evidence, assessment) {
  if (candidate?.isAddendum) return "addendum-branch";
  if ((evidence?.collectionErrors || []).length) return "evidence-collection-error";
  if (evidence?.dirtyState !== "clean") return "dirty-worktree";
  if (!(evidence?.recentCommits || []).length) return "no-committed-work";
  if (assessment?.taskScoped !== true) return "not-task-scoped";
  if (!String(assessment?.validation || "").trim()) return "missing-validation-evidence";
  if ((assessment?.missingEvidence || []).length) return "missing-validation-evidence";
  if (!candidate?.execplanPath) return "missing-execplan";
  return "";
}
function recoveryDecision(candidate, evidence, assessment, mode, flags = {}) {
  const classification = assessment?.classification || "";
  if (mode !== "review" || classification !== "adopt-complete") {
    return { action: "report", classification, reason: "", skip: false };
  }
  const reason = recoveryResumeEligibility(candidate, evidence, assessment);
  if (reason) {
    return { action: "report", classification: "continue-manual", reason, skip: true };
  }
  if (flags.dryRun) {
    return { action: "report", classification, reason: "dry-run", skip: true };
  }
  return { action: "resume", classification, reason: "", skip: false };
}
var EXECPLAN_STATUS_MAP = {
  draft: "draft",
  approved: "approved",
  "in progress": "in-progress",
  blocked: "blocked",
  complete: "complete"
};
function parseExecplanState(text) {
  const source = String(text || "");
  let status = "unknown";
  const statusMatch = source.match(/^Status:\s*([A-Za-z ]+?)\s*$/m);
  if (statusMatch) {
    const value = statusMatch[1].trim().toLowerCase().replace(/\s+/g, " ");
    status = EXECPLAN_STATUS_MAP[value] || "unknown";
  }
  let ticked = 0;
  let unticked = 0;
  const items = [];
  const progressSection = source.split(/^##\s+/m).find((section) => /^progress\b/i.test(section)) || "";
  for (const line of progressSection.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s*(.*)$/);
    if (!match) continue;
    const isTicked = match[1] !== " ";
    if (isTicked) ticked += 1;
    else unticked += 1;
    items.push({ text: match[2].trim(), ticked: isTicked });
  }
  return { status, ticked, unticked, items };
}
function recoveryContinueDecision(candidate, evidence, planState, flags = {}) {
  const report = (reason) => ({ action: "report", stage: null, reason, skip: true });
  if (candidate?.isAddendum) return report("addendum-branch");
  if ((evidence?.collectionErrors || []).length) return report("evidence-collection-error");
  if (evidence?.dirtyState !== "clean") return report("dirty-worktree");
  if (planState.status === "unreadable") return report("plan-unreadable");
  if (planState.status === "blocked") return report("plan-blocked");
  const stage = planState.status === "approved" || planState.status === "in-progress" ? "implement" : planState.status === "complete" ? "review" : "plan";
  if (stage === "review" && !(evidence?.recentCommits || []).length) return report("no-committed-work");
  if (flags.dryRun) return { action: "report", stage, reason: "dry-run", skip: true };
  return { action: "resume", stage, reason: "", skip: false };
}

// src/workflows/df12-build-odw/schemas.ts
var PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    execplanPath: { type: "string" },
    workItems: { type: "array", items: { type: "string" }, description: "ordered execplan work-item titles" },
    docsCited: { type: "array", items: { type: "string" } },
    skillsCited: { type: "array", items: { type: "string" } },
    addressedSince: { type: "string", description: "how the previous design-review blocking points were resolved (empty on round 1)" },
    summary: { type: "string" }
  },
  required: ["execplanPath", "workItems", "summary"]
};
var DESIGN_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    satisfied: { type: "boolean", description: "true only when the plan is implementable, design-conformant, and complete" },
    blocking: { type: "array", items: { type: "string" }, description: "must-fix design defects; empty iff satisfied" },
    advisory: { type: "array", items: { type: "string" } },
    rationale: { type: "string" }
  },
  required: ["satisfied", "blocking"]
};
var IMPL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", description: "true when every work item is implemented, committed, and every project commit gate is green" },
    execplanPath: { type: "string" },
    workItemsCompleted: { type: "integer" },
    workItemsTotal: { type: "integer" },
    commits: { type: "array", items: { type: "string" } },
    gatesGreen: { type: "boolean", description: "every project commit gate (plus markdownlint/nixie where markdown changed) passes at HEAD" },
    coderabbitRuns: { type: "integer" },
    openIssues: { type: "array", items: { type: "string" }, description: "anything left unresolved, with reason" },
    summary: { type: "string" }
  },
  required: ["ok", "execplanPath", "gatesGreen", "summary"]
};
var REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "changes-requested"] },
    blocking: { type: "array", items: { type: "string" }, description: "must-fix before the task can be called done" },
    advisory: { type: "array", items: { type: "string" } },
    coverage: {
      type: "object",
      additionalProperties: false,
      properties: {
        correctness: { type: "string" },
        planAdherence: { type: "string" },
        documentation: { type: "string" },
        validation: { type: "string" }
      }
    },
    proposedRoadmapItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" }, rationale: { type: "string" }, severity: { type: "string" } },
        required: ["title", "rationale"]
      },
      description: "follow-up work surfaced by the review \u2014 PROPOSED ONLY, never written to the roadmap by you"
    },
    summary: { type: "string" }
  },
  required: ["verdict", "blocking", "summary"]
};
var FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    commits: { type: "array", items: { type: "string" }, description: "commit subjects added in this fix round" },
    gatesGreen: { type: "boolean", description: "every project commit gate (plus markdownlint/nixie where markdown changed) passes at HEAD after the fixes" },
    coderabbitRuns: { type: "integer" },
    resolved: { type: "array", items: { type: "string" }, description: "how each blocking item was resolved" },
    openIssues: { type: "array", items: { type: "string" }, description: "anything left unresolved, with reason" },
    summary: { type: "string" }
  },
  required: ["gatesGreen", "summary"]
};
var INTEGRATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    roadmapMarkedDone: { type: "boolean" },
    rebased: { type: "boolean" },
    squashMerged: { type: "boolean" },
    mergeSha: { type: "string" },
    pushed: { type: "boolean" },
    conflicts: { type: "string", description: "description of any conflict encountered and how it was handled, empty if none" },
    summary: { type: "string" }
  },
  required: ["ok", "summary"]
};
var AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    issueFile: { type: "string", description: `path written under docs/issues/, empty if nothing recorded` },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", description: "duplication | complexity | ergonomics | similarity | inconsistency | separation-of-concerns | cqs | docs-gap | test-gap" },
          location: { type: "string" },
          description: { type: "string" },
          proposedFix: { type: "string" },
          severity: { type: "string" }
        },
        required: ["category", "location", "description", "proposedFix"]
      }
    },
    proposedRoadmapItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" }, rationale: { type: "string" }, severity: { type: "string" } },
        required: ["title", "rationale"]
      },
      description: "PROPOSED ONLY \u2014 adding these to the roadmap is reserved to the root agent"
    },
    summary: { type: "string" }
  },
  required: ["findings", "summary"]
};
var ASSESSMENT_CLASSIFICATIONS = [
  "adopt-complete",
  "adopt-partial",
  "continue-manual",
  "discard"
];
var ASSESSMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: { type: "string", enum: ASSESSMENT_CLASSIFICATIONS },
    branchName: { type: "string" },
    worktreePath: { type: "string" },
    baseCommit: { type: "string" },
    currentCommit: { type: "string" },
    dirtyState: { type: "string", enum: ["clean", "dirty", "unknown"] },
    changedFiles: { type: "array", items: { type: "string" } },
    taskScoped: { type: "boolean" },
    execPlan: { type: "string" },
    roadmap: { type: "string" },
    validation: { type: "string" },
    missingEvidence: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    recommendation: { type: "string" },
    nextActions: { type: "array", items: { type: "string" } }
  },
  required: [
    "classification",
    "branchName",
    "worktreePath",
    "baseCommit",
    "currentCommit",
    "dirtyState",
    "changedFiles",
    "taskScoped",
    "execPlan",
    "roadmap",
    "validation",
    "missingEvidence",
    "risks",
    "rationale",
    "recommendation",
    "nextActions"
  ]
};

// src/workflows/df12-build-odw/roadmap.ts
var TASK_LINE_RE = /^(\s*)-\s+\[([ xX])\]\s+(\d+(?:\.\d+)+)\.\s*(.*)$/;
var REQUIRES_LINE_RE = /^\s*-\s+Requires\s+(.+?)\.?\s*$/;
var STEP_RANGE_RE = /\bsteps?\s+(\d+\.\d+)\s*-\s*(\d+\.\d+)\b/gi;
var ROADMAP_ID_RE = /\b\d+(?:\.\d+)+\b/g;
function roadmapIdSlug(id) {
  return String(id).replace(/[^0-9a-zA-Z]+/g, "-");
}
function parentIdOf(id) {
  const parts = id.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
}
function isComplete(task) {
  return task?.checked?.toLowerCase() === "x";
}
function extractRoadmapIds(text) {
  const ids = new Set([...text.matchAll(ROADMAP_ID_RE)].map((match) => match[0]));
  for (const match of text.matchAll(STEP_RANGE_RE)) {
    const expanded = expandStepRange(match[1], match[2]);
    if (expanded.length) {
      ids.delete(match[1]);
      ids.delete(match[2]);
      for (const id of expanded) ids.add(id);
    }
  }
  return [...ids];
}
function expandStepRange(start, end) {
  const startParts = start.split(".").map(Number);
  const endParts = end.split(".").map(Number);
  if (startParts.length !== 2 || endParts.length !== 2 || startParts[0] !== endParts[0]) return [];
  const [phaseId, firstStep] = startParts;
  const lastStep = endParts[1];
  if (!Number.isInteger(phaseId) || !Number.isInteger(firstStep) || !Number.isInteger(lastStep) || firstStep > lastStep) return [];
  return Array.from({ length: lastStep - firstStep + 1 }, (_, index) => `${phaseId}.${firstStep + index}`);
}
function parseRoadmap(text) {
  const tasks = [];
  const byId = /* @__PURE__ */ new Map();
  let currentTask = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const taskMatch = line.match(TASK_LINE_RE);
    if (taskMatch) {
      const [, indent, checked, id, rawTitle] = taskMatch;
      const task = {
        id,
        checked,
        title: rawTitle.trim(),
        requires: [],
        line: index + 1,
        indent: indent.length,
        subtasks: []
      };
      const parent = byId.get(parentIdOf(id));
      if (parent && isComplete(parent) && task.indent > parent.indent) {
        task.parentId = parent.id;
        task.isAddendumSubtask = true;
        parent.subtasks.push(task);
      } else {
        tasks.push(task);
      }
      byId.set(id, task);
      currentTask = task;
      continue;
    }
    const requiresMatch = line.match(REQUIRES_LINE_RE);
    if (requiresMatch && currentTask) {
      currentTask.requires.push(...extractRoadmapIds(requiresMatch[1]));
    }
  }
  for (const task of byId.values()) {
    task.requires = [...new Set(task.requires)];
  }
  return {
    tasks,
    completed: completedIds(tasks)
  };
}
function completedIds(tasks) {
  const completed = /* @__PURE__ */ new Set();
  const prefixes = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (isTaskFullyComplete(task)) completed.add(task.id);
    for (const subtask of task.subtasks || []) {
      if (isComplete(subtask)) completed.add(subtask.id);
    }
    const parts = task.id.split(".");
    for (let length = 1; length < parts.length; length += 1) {
      const prefix = parts.slice(0, length).join(".");
      if (!prefixes.has(prefix)) prefixes.set(prefix, []);
      prefixes.get(prefix).push(task);
    }
  }
  for (const [prefix, groupedTasks] of prefixes.entries()) {
    if (groupedTasks.length && groupedTasks.every(isTaskFullyComplete)) completed.add(prefix);
  }
  return completed;
}
function isTaskFullyComplete(task) {
  return isComplete(task) && task.subtasks.every(isComplete);
}
function taskMatchesOnlyTask(candidate, onlyTask) {
  if (!onlyTask) return true;
  if (candidate.task.id === onlyTask) return true;
  return Boolean(candidate.task.subtasks?.includes(onlyTask));
}
function blockedSummary(blocked) {
  if (!blocked.length) return "";
  const sample = blocked.slice(0, 5).join("; ");
  const suffix = blocked.length > 5 ? `; ${blocked.length - 5} more` : "";
  return `${blocked.length} blocked task(s): ${sample}${suffix}`;
}
function selectRoadmapTask(roadmapText, taken, onlyTask) {
  const { tasks, completed } = parseRoadmap(roadmapText);
  const normalTaken = new Set(taken?.normal || []);
  const addendumTaken = new Set(taken?.addendum || []);
  const candidates = [];
  const blocked = [];
  for (const task of tasks) {
    const openSubtasks = task.subtasks.filter((subtask) => !isComplete(subtask));
    if (isComplete(task) && openSubtasks.length && !addendumTaken.has(task.id)) {
      candidates.push({
        order: task.line,
        kind: "addendum",
        task: {
          id: task.id,
          title: task.title,
          requires: [],
          rationale: `Completed parent ${task.id} has open addendum sub-task(s): ${openSubtasks.map((subtask) => subtask.id).join(", ")}.`,
          isAddendum: true,
          subtasks: openSubtasks.map((subtask) => subtask.id)
        }
      });
    }
    if (!isComplete(task) && !normalTaken.has(task.id)) {
      const missing = task.requires.filter((id) => !completed.has(id));
      if (missing.length) {
        blocked.push(`${task.id} requires ${missing.join(", ")}`);
      } else {
        candidates.push({
          order: task.line,
          kind: "normal",
          task: {
            id: task.id,
            title: task.title,
            requires: task.requires,
            rationale: task.requires.length ? `Every declared dependency is complete: ${task.requires.join(", ")}.` : "The task has no declared dependencies.",
            isAddendum: false,
            subtasks: []
          }
        });
      }
    }
  }
  const matchingCandidates = candidates.filter((candidate) => taskMatchesOnlyTask(candidate, onlyTask)).sort((left, right) => left.order - right.order);
  const selected = matchingCandidates[0];
  if (!selected) {
    const reason = onlyTask ? `Task ${onlyTask} is not currently unblocked as a normal task or addendum pass. ${blockedSummary(blocked)}` : blockedSummary(blocked);
    return { hasTask: false, remainingUnblocked: [], blockedSummary: reason.trim() };
  }
  return {
    hasTask: true,
    task: selected.task,
    remainingUnblocked: matchingCandidates.slice(1).map((candidate) => candidate.kind === "addendum" ? `${candidate.task.id} (addendum)` : candidate.task.id),
    blockedSummary: blockedSummary(blocked)
  };
}
function roadmapTaskIndex(roadmapText) {
  const { tasks } = parseRoadmap(roadmapText);
  const byId = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    byId.set(task.id, task);
    for (const subtask of task.subtasks || []) byId.set(subtask.id, subtask);
  }
  return byId;
}
function candidateRoadmapComplete(task, isAddendum) {
  if (!isAddendum) return isComplete(task);
  return isTaskFullyComplete(task);
}

// src/workflows/df12-build-odw/exec.ts
async function execFileText(command, commandArgs, options = {}) {
  const { execFile } = process.getBuiltinModule("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(command, [...commandArgs], { cwd: options.cwd || process.cwd(), maxBuffer: 16 * 1024 * 1024, ...options.timeoutMs ? { timeout: options.timeoutMs } : {} }, (error, stdout, stderr) => {
      if (error) {
        const failure = error;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve(stdout);
    });
  });
}
async function execFileStatus(command, commandArgs, options = {}) {
  try {
    return { ok: true, stdout: await execFileText(command, commandArgs, options), stderr: "" };
  } catch (error) {
    const failure = error;
    return {
      ok: false,
      stdout: failure?.stdout || "",
      stderr: failure?.stderr || "",
      message: failure && failure.message || String(error),
      // Set when the child was killed (e.g. by the timeoutMs option); the
      // message alone does not say so.
      killed: Boolean(failure?.killed),
      signal: failure?.signal || ""
    };
  }
}
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
async function fileState(pathValue, baseDir = process.cwd()) {
  if (!pathValue) return { ok: true, exists: false, detail: "" };
  const path = process.getBuiltinModule("node:path");
  const candidate = path.isAbsolute(String(pathValue)) ? String(pathValue) : path.join(baseDir, String(pathValue));
  const fs = process.getBuiltinModule("node:fs/promises");
  try {
    const stat = await fs.lstat(candidate);
    return { ok: true, exists: stat.isFile(), detail: "" };
  } catch (error) {
    const failure = error;
    if (failure && (failure.code === "ENOENT" || failure.code === "ENOTDIR")) {
      return { ok: true, exists: false, detail: "" };
    }
    return { ok: false, exists: false, detail: `stat failed for ${candidate}: ${failure && failure.message || String(error)}` };
  }
}

// src/workflows/df12-build-odw/faults.ts
var faultMetrics = { infraRetries: 0, infraFaults: 0, providerFaults: 0, authFaults: 0 };
function authFailureDetail(value) {
  const text = String(value || "");
  const patterns = [
    /401 Unauthorized/i,
    /Missing bearer or basic authentication/i,
    /no Codex credentials/i,
    /\bNot logged in\b/i,
    /\bsigned out\b/i,
    /no token is available/i,
    /\bauth(?:entication)? failed\b/i,
    /\bbrowser login required\b/i,
    /\btoken missing\b/i,
    /\bmissing token\b/i,
    /\btoken expired\b/i,
    /\bnot authenticated\b/i,
    /"loggedIn"\s*:\s*false/i,
    /Run `?coderabbit auth login`?/i,
    /Run codex login/i
  ];
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : "";
}
function providerFailureDetail(value) {
  const text = String(value || "");
  const patterns = [
    /\bAPI Error:\s*(?:429|500|502|503|504|529)\b/i,
    /\b(?:429|500|502|503|504|529)\b.*\b(?:gateway|overload|rate limit|server-side|temporar|timeout|unavailable)\b/i,
    /\b(?:gateway timeout|model overloaded|overloaded|rate limited|server-side issue|service unavailable|temporarily unavailable|try again in a moment)\b/i
  ];
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : "";
}
function infrastructureFailureDetail(value) {
  const text = String(value || "");
  const patterns = [
    /\badapter '[^']*' timed out\b/i,
    /\badapter '[^']*' exited with code \d+/i,
    /\bAdapterExecutionError\b/,
    /\bSchemaValidationError\b/,
    /did not satisfy the schema after \d+ attempt/i,
    /\bno JSON value found in the reply\b/i
  ];
  return patterns.some((pattern) => pattern.test(text)) ? text.trim() : "";
}
function makeWithInfraRetry(attempts) {
  return async function withInfraRetry2(run, label) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const message = error && error.message || String(error);
        if (attempt >= attempts || !infrastructureFailureDetail(message)) {
          if (infrastructureFailureDetail(message)) {
            log(`[${label}] infrastructure fault persisted after ${attempt} of ${attempts} attempt(s); giving up: ${message}`);
          } else {
            log(`[${label}] non-infrastructure failure; not retried: ${message}`);
          }
          throw error;
        }
        faultMetrics.infraRetries += 1;
        log(`[${label}] infrastructure fault (${message}); retrying the stage agent (attempt ${attempt + 1} of ${attempts})`);
      }
    }
  };
}
function resultFromUnhandledAgentError(id, detail, extra = {}) {
  const authDetail = authFailureDetail(detail);
  if (authDetail) {
    faultMetrics.authFaults += 1;
    return {
      id,
      status: "fatal-auth",
      stage: "auth",
      detail,
      proposals: [],
      ...extra
    };
  }
  const providerDetail = providerFailureDetail(detail);
  if (providerDetail) {
    faultMetrics.providerFaults += 1;
    return {
      id,
      status: "provider-fault",
      stage: "provider",
      detail,
      proposals: [],
      ...extra
    };
  }
  const infraDetail = infrastructureFailureDetail(detail);
  if (infraDetail) {
    faultMetrics.infraFaults += 1;
    return {
      id,
      status: "infra-fault",
      stage: "infrastructure",
      detail,
      proposals: [],
      ...extra
    };
  }
  return {
    id,
    status: "failed",
    stage: "error",
    detail,
    proposals: [],
    ...extra
  };
}

// src/workflows/df12-build-odw/git-evidence.ts
function parseNameStatus(output) {
  return String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [status, firstPath, secondPath] = line.split(/\t+/);
    return secondPath ? { status, path: secondPath, oldPath: firstPath } : { status, path: firstPath || "" };
  }).filter((entry) => entry.path);
}
function parsePorcelainDirty(output) {
  return String(output || "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const status = line.slice(0, 2);
    const pathText = line.slice(3).trim();
    if (!pathText) return [];
    if (status === "??") return [{ status, path: pathText }];
    if (status[1] && status[1] !== " ") return [{ status: status[1], path: pathText }];
    return [];
  });
}
async function gitEvidence(worktreePath, commandArgs, parse = ((text) => String(text || "").trim())) {
  const result = await execFileStatus("git", ["-C", worktreePath, ...commandArgs]);
  if (result.ok) {
    return { ok: true, value: parse(result.stdout) };
  }
  return {
    ok: false,
    value: parse(result.stdout),
    error: [result.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim()
  };
}
async function collectAssessmentEvidence(task, wt) {
  const worktreePath = wt?.worktreePath || "";
  const baseCommit = wt?.baseSha || "";
  const branchName = wt?.branch || "";
  const errors = [];
  const [current, branch, status, committed, dirty, staged, commits] = await Promise.all([
    gitEvidence(worktreePath, ["rev-parse", "HEAD"]),
    branchName ? Promise.resolve({ ok: true, value: branchName }) : gitEvidence(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitEvidence(worktreePath, ["status", "--porcelain=v1"]),
    baseCommit ? gitEvidence(worktreePath, ["diff", "--name-status", `${baseCommit}...HEAD`], parseNameStatus) : Promise.resolve({ ok: false, value: [], error: "missing base commit" }),
    gitEvidence(worktreePath, ["diff", "--name-status"], parseNameStatus),
    gitEvidence(worktreePath, ["diff", "--cached", "--name-status"], parseNameStatus),
    baseCommit ? gitEvidence(worktreePath, ["log", "--oneline", "--max-count=20", `${baseCommit}..HEAD`], (text) => String(text || "").trim().split(/\r?\n/).filter(Boolean)) : Promise.resolve({ ok: false, value: [], error: "missing base commit" })
  ]);
  if (!current.ok) errors.push(`rev-parse HEAD: ${current.error}`);
  if (!branch.ok) errors.push(`rev-parse --abbrev-ref HEAD: ${branch.error}`);
  if (!status.ok) errors.push(`status --porcelain=v1: ${status.error}`);
  if (!committed.ok) errors.push(`diff base...HEAD: ${committed.error}`);
  if (!dirty.ok) errors.push(`diff --name-status: ${dirty.error}`);
  if (!staged.ok) errors.push(`diff --cached --name-status: ${staged.error}`);
  if (!commits.ok) errors.push(`log base..HEAD: ${commits.error}`);
  const untrackedOrModified = parsePorcelainDirty(status.value);
  const dirtyPaths = new Set(dirty.value.map((item) => item.path));
  const dirtyChanges = [
    ...dirty.value,
    ...untrackedOrModified.filter((entry) => !dirtyPaths.has(entry.path))
  ];
  const allChanged = /* @__PURE__ */ new Set([
    ...committed.value.map((entry) => entry.path),
    ...dirtyChanges.map((entry) => entry.path),
    ...staged.value.map((entry) => entry.path)
  ]);
  return {
    taskId: task?.id || "",
    taskTitle: task?.title || "",
    branchName: branch.value || branchName,
    worktreePath,
    baseCommit,
    currentCommit: current.value || "",
    dirtyState: status.ok ? String(status.value || "").trim() ? "dirty" : "clean" : "unknown",
    changedFiles: [...allChanged].sort(),
    committedChanges: committed.value,
    dirtyChanges,
    stagedChanges: staged.value,
    recentCommits: commits.value,
    collectionErrors: errors.filter(Boolean)
  };
}
async function readFileText(filePath, rootDir) {
  const fs = process.getBuiltinModule("node:fs/promises");
  const path = process.getBuiltinModule("node:path");
  const { constants } = process.getBuiltinModule("node:fs");
  if (rootDir) {
    const realRoot = await fs.realpath(rootDir);
    const realParent = await fs.realpath(path.dirname(filePath));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`ExecPlan path escapes the worktree via a parent symlink: ${filePath}`);
    }
  }
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
async function directoryExists(pathValue) {
  if (!pathValue) return { ok: true, exists: false, detail: "" };
  const fs = process.getBuiltinModule("node:fs/promises");
  try {
    const stat = await fs.stat(String(pathValue));
    return { ok: true, exists: stat.isDirectory(), detail: "" };
  } catch (error) {
    const failure = error;
    if (failure && (failure.code === "ENOENT" || failure.code === "ENOTDIR")) {
      return { ok: true, exists: false, detail: "" };
    }
    return { ok: false, exists: false, detail: `stat failed for ${String(pathValue)}: ${failure && failure.message || String(error)}` };
  }
}

// src/workflows/df12-build-odw/recovery-discovery.ts
function makeRecoveryDiscovery(limits) {
  return async function discoverRecoveryCandidates2(roadmapText, gitRoot) {
    const root = gitRoot || process.cwd();
    const skipped = [];
    const errors = [];
    const branchList = await execFileStatus("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads/roadmap-*"]);
    if (!branchList.ok) {
      errors.push(`for-each-ref failed: ${[branchList.message, branchList.stderr].filter(Boolean).join("; ")}`);
      return { candidates: [], skipped, errors };
    }
    const branches = branchList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const worktreeList = await execFileStatus("git", ["-C", root, "worktree", "list", "--porcelain"]);
    if (!worktreeList.ok) {
      errors.push(`worktree list failed: ${[worktreeList.message, worktreeList.stderr].filter(Boolean).join("; ")}`);
    }
    const worktreeByBranch = new Map(
      parseWorktreeList(worktreeList.stdout).filter((entry) => entry.branch).map((entry) => [entry.branch, entry.worktreePath])
    );
    const byId = roadmapTaskIndex(roadmapText);
    const mapped = [];
    for (const branch of branches) {
      const parsed = branchToRoadmapId(branch);
      const task = parsed ? byId.get(parsed.id) : null;
      if (!parsed || !task) {
        skipped.push({ id: parsed?.id || "", branchName: branch, reason: "unmapped-branch" });
        continue;
      }
      if (candidateRoadmapComplete(task, parsed.isAddendum)) {
        skipped.push({ id: parsed.id, branchName: branch, reason: "already-complete" });
        continue;
      }
      const commit = await execFileStatus("git", ["-C", root, "rev-parse", "--verify", `${branch}^{commit}`]);
      if (!commit.ok) {
        skipped.push({ id: parsed.id, branchName: branch, reason: "unreadable-commit" });
        continue;
      }
      const mergeBase = await execFileStatus("git", ["-C", root, "merge-base", `origin/${limits.base}`, branch]);
      const worktreePath = worktreeByBranch.get(branch) || "";
      const worktreeDir = await directoryExists(worktreePath);
      if (!worktreeDir.ok) {
        skipped.push({ id: parsed.id, branchName: branch, reason: "worktree-probe-fault" });
        errors.push(`worktree probe failed for ${branch}: ${worktreeDir.detail}`);
        continue;
      }
      mapped.push({
        taskId: parsed.id,
        taskTitle: task.title || "",
        branchName: branch,
        worktreePath: worktreeDir.exists ? worktreePath : "",
        baseCommit: mergeBase.ok ? mergeBase.stdout.trim() : "",
        currentCommit: commit.stdout.trim(),
        roadmapComplete: false,
        isAddendum: parsed.isAddendum,
        line: task.line || Number.MAX_SAFE_INTEGER
      });
    }
    mapped.sort((left, right) => left.line - right.line || left.branchName.localeCompare(right.branchName));
    const candidates = [];
    for (const candidate of mapped) {
      if (limits.resumeTaskId && candidate.taskId !== limits.resumeTaskId) continue;
      if (!candidate.worktreePath) {
        skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: "missing-worktree" });
        continue;
      }
      if (candidates.length >= limits.resumeMaxCandidates) {
        skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: "candidate-cap" });
        continue;
      }
      candidates.push(candidate);
    }
    return { candidates, skipped, errors };
  };
}
async function readExecplanState(candidate) {
  if (!candidate?.execplanPath) return { status: "missing", ticked: 0, unticked: 0, items: [] };
  const path = process.getBuiltinModule("node:path");
  try {
    const text = await readFileText(path.join(candidate.worktreePath || "", candidate.execplanPath), candidate.worktreePath || void 0);
    return parseExecplanState(text);
  } catch (error) {
    const failure = error;
    if (failure && (failure.code === "ENOENT" || failure.code === "ENOTDIR")) {
      return { status: "missing", ticked: 0, unticked: 0, items: [] };
    }
    return {
      status: "unreadable",
      ticked: 0,
      unticked: 0,
      items: [],
      error: `${candidate.execplanPath}: ${failure && failure.message || String(error)}`
    };
  }
}
var RECOVERY_HOLD_REASONS = /* @__PURE__ */ new Set(["missing-worktree", "worktree-probe-fault", "candidate-cap", "unreadable-commit", "assessment-error"]);
async function recoveryExecplanPath(candidate) {
  const canonicalPlan = `docs/execplans/${candidate.branchName}.md`;
  const state = await fileState(canonicalPlan, candidate.worktreePath);
  if (!state.ok) return { execplanPath: "", error: state.detail };
  return { execplanPath: state.exists ? canonicalPlan : "", error: "" };
}
async function syntheticRecoveryImpl(candidate, evidence) {
  const resolved = typeof candidate.execplanPath === "string" ? { execplanPath: candidate.execplanPath, error: "" } : await recoveryExecplanPath(candidate);
  return {
    ok: true,
    gatesGreen: true,
    execplanPath: resolved.execplanPath,
    workItemsCompleted: 0,
    workItemsTotal: 0,
    commits: evidence?.recentCommits || [],
    coderabbitRuns: 0,
    openIssues: [
      "recovered branch requires fresh review",
      ...resolved.error ? [`could not verify the durable ExecPlan: ${resolved.error}`] : []
    ],
    summary: "Recovered adopt-complete branch from durable git state."
  };
}

// src/workflows/df12-build-odw/config.ts
function makeConfig(rawArgs) {
  const cfg = rawArgs || {};
  const PROJECT_ROOT2 = cfg.projectRoot || process.cwd();
  const BASE2 = cfg.base || "main";
  const ROADMAP2 = cfg.roadmap || "docs/roadmap.md";
  const DESIGN_DOCS = cfg.designDocs || "the design document(s) and the ADRs (docs/adr-*.md) under docs/";
  const RESEARCH_NOTE = cfg.researchNote || null;
  const ONLY_TASK2 = cfg.taskId || null;
  const MAX_TASKS2 = ONLY_TASK2 ? 1 : cfg.maxTasks || 12;
  const MAX_PARALLEL2 = ONLY_TASK2 ? 1 : Math.max(1, cfg.maxParallel || 16);
  const MAX_PLANNING_PARALLEL2 = Math.max(1, cfg.maxPlanningParallel || cfg.maxPlanParallel || 8);
  const MAX_BUILD_PARALLEL2 = Math.max(1, cfg.maxBuildParallel || 8);
  const MAX_DESIGN_ROUNDS2 = cfg.maxDesignRounds || 4;
  const MAX_REVIEW_ROUNDS2 = cfg.maxReviewRounds || 3;
  const STAGE_ATTEMPTS2 = Math.max(1, Math.trunc(Number(cfg.stageAttempts) || 2));
  const PER_WORK_ITEM_BUILD2 = cfg.perWorkItemBuild !== false;
  const MAX_WORK_ITEM_ROUNDS2 = Math.max(1, Math.trunc(Number(cfg.maxWorkItemRounds) || 16));
  const AUTO_MERGE2 = cfg.autoMerge !== false;
  const DOCUMENT_AUDIT2 = cfg.documentAudit !== false;
  const DRY_RUN2 = cfg.dryRun === true;
  const AUTH_PREFLIGHT2 = cfg.authPreflight !== false;
  const REQUIRE_CODERABBIT_AUTH2 = cfg.requireCoderabbitAuth !== false && !DRY_RUN2;
  const ASSESS_PARTIAL_BRANCHES2 = cfg.assessPartialBranches !== false;
  const RESUME_PARTIAL_BRANCHES2 = cfg.resumePartialBranches === true;
  const RESUME_MODE2 = String(cfg.resumeMode || "assess").toLowerCase();
  if (!["assess", "review", "continue"].includes(RESUME_MODE2)) {
    throw new Error(`Unsupported resumeMode: ${RESUME_MODE2} (use "assess", "review", or "continue")`);
  }
  const RESUME_TASK_ID2 = cfg.resumeTaskId ? String(cfg.resumeTaskId) : null;
  const RESUME_MAX_CANDIDATES_RAW = Number(cfg.resumeMaxCandidates ?? 4);
  const RESUME_MAX_CANDIDATES2 = Number.isFinite(RESUME_MAX_CANDIDATES_RAW) ? Math.max(1, Math.floor(RESUME_MAX_CANDIDATES_RAW)) : 4;
  const WORKTREE_WRITE_PREFLIGHT2 = cfg.worktreeWritePreflight !== false;
  const WRITE_PROBE_EFFORT2 = String(cfg.writeProbeEffort || "minimal");
  const WRITE_PROBE_MODEL_BY_ADAPTER2 = Object.fromEntries(
    Object.entries(cfg.writeProbeModelByAdapter || {}).map(([adapter, model]) => [String(adapter).toLowerCase(), String(model)])
  );
  const BUDGET_RESERVE2 = 8e4;
  const SEARCH_BACKEND = String(cfg.searchBackend || cfg.codeSearchBackend || (cfg.memtraceRepoId ? "memtrace" : "grepai")).toLowerCase();
  const GREPAI_WORKSPACE = cfg.grepaiWorkspace || "Projects";
  const GREPAI_PROJECT = cfg.grepaiProject || (SEARCH_BACKEND === "grepai" ? cfg.project : null) || null;
  const MEMTRACE_REPO_ID = cfg.memtraceRepoId || (SEARCH_BACKEND === "memtrace" ? cfg.project : null) || null;
  const BUILD_ADAPTER2 = cfg.buildAdapter || "codex-medium";
  const PLAN_ADAPTER2 = cfg.planAdapter || "claude";
  const REVIEW_ADAPTER2 = cfg.reviewAdapter || "claude";
  const TRIAGE_ADAPTER2 = cfg.triageAdapter || "codex";
  const ASSESSMENT_ADAPTER2 = cfg.assessmentAdapter || REVIEW_ADAPTER2;
  const BUILD_MODEL2 = cfg.buildModel || "gpt-5.5";
  const PLAN_MODEL2 = cfg.planModel || "claude-opus-4-8";
  const REVIEW_MODEL2 = cfg.reviewModel || "claude-opus-4-8";
  const TRIAGE_MODEL2 = cfg.triageModel || "gpt-5.5";
  const TRIAGE_ESCALATION_MODEL2 = cfg.triageEscalationModel || "gpt-5.5@high";
  const ASSESSMENT_MODEL2 = cfg.assessmentModel || "claude-sonnet-5";
  const ASSESSMENT_ESCALATION_MODEL2 = cfg.assessmentEscalationModel || REVIEW_MODEL2;
  const AUTH_REQUIRED_ADAPTERS2 = new Set([
    BUILD_ADAPTER2,
    PLAN_ADAPTER2,
    REVIEW_ADAPTER2,
    TRIAGE_ADAPTER2,
    ASSESSMENT_ADAPTER2
  ].map((adapter) => String(adapter || "").toLowerCase()));
  const CODERABBIT_REVIEW_COMMAND2 = cfg.coderabbitReviewCommand || "coderabbit review --agent";
  const CODERABBIT_HOST_REVIEW2 = cfg.coderabbitHostReview !== false;
  const CODERABBIT_BETWEEN_WORK_ITEMS2 = cfg.coderabbitBetweenWorkItems !== false;
  const CODERABBIT_ATTEMPTS2 = Math.max(1, Math.trunc(Number(cfg.coderabbitAttempts) || 3));
  const CODERABBIT_BACKOFF_MINUTES2 = (() => {
    const range = Array.isArray(cfg.coderabbitBackoffMinutes) ? cfg.coderabbitBackoffMinutes : [];
    const low = Math.max(1, Math.trunc(Number(range[0]) || 45));
    const high = Math.max(low, Math.trunc(Number(range[1]) || 90));
    return [low, high];
  })();
  const CODERABBIT_FINDINGS_FILE2 = String(cfg.coderabbitFindingsFile || "");
  const COMMIT_GATES2 = (Array.isArray(cfg.commitGates) && cfg.commitGates.length ? cfg.commitGates : ["make all"]).map((command) => String(command));
  const COMMIT_GATE_TEXT2 = COMMIT_GATES2.map((command) => `\`${command}\``).join(" then ");
  const HOST_COMMIT_GATES2 = cfg.hostCommitGates !== false;
  const HOST_GATES_BETWEEN_WORK_ITEMS2 = cfg.hostGatesBetweenWorkItems !== false;
  const COMMIT_GATE_TIMEOUT_SECONDS2 = Math.max(1, Math.trunc(Number(cfg.commitGateTimeoutSeconds) || 3600));
  const COMMIT_GATE_GUIDANCE2 = `The deterministic commit gates for this run are ${COMMIT_GATE_TEXT2}. AGENTS.md is authoritative for the gate set: if AGENTS.md names different or additional gate targets (for example sequential \`make check-fmt\`, \`make typecheck\`, \`make lint\`, \`make test\`), run those named targets as well \u2014 NEVER assume \`make all\` aggregates them, and never report gates as green unless every project-required gate passed at HEAD.${HOST_COMMIT_GATES2 ? " The workflow host independently re-runs the configured gates against your committed HEAD before review and integration; a gatesGreen claim the host cannot reproduce fails the stage with the host gate log as evidence." : ""}`;
  const CS_CHECK2 = cfg.csCheck !== false;
  const CS_CHECK_COMMAND2 = String(cfg.csCheckCommand || "cs-check-changed");
  const CS_CHECK_GUIDANCE2 = CS_CHECK2 ? [
    `A deterministic CodeScene code-health check (\`${CS_CHECK_COMMAND2}\`) runs on your committed changed files AFTER the commit gates and BEFORE CodeRabbit. Clear a flagged code-health regression by refactoring the code. ONLY when further refinement would genuinely be deleterious to clarity or correctness, suppress a specific smell with a \`@codescene(disable:"Complex Method")\` comment (combine several as \`@codescene(disable:"Complex Method", disable:"Bumpy Road Ahead")\`) placed immediately before the affected function or method, and precede that suppression with a plain-language comment explaining why it is justified.`,
    "What the flagged smells mean:",
    "Module smells \u2014 Low Cohesion: the module/class carries several unrelated responsibilities (measured by LCOM4), breaking the single-responsibility principle. Brain Class (God Class): a large module with many functions and at least one Brain Method, holding too much responsibility at once. Developer Congestion: the code has become a coordination bottleneck because too many people must change it in parallel. Complex code by former contributors: a low-health hotspot whose original author has left the organisation carries heightened maintenance risk. Lines of Code: the file is simply too large.",
    "Function smells \u2014 Brain Method (God Function): one complex function concentrates the module's behaviour and becomes a local hotspot. DRY violations: duplicated logic that is actually changed together in predictable patterns. Complex Method: high cyclomatic complexity from many conditionals (if/for/while). Primitive Obsession: heavy use of raw primitives (integers, strings, floats) where a domain type would encapsulate the validation and meaning of the values. Large Method: a function with too many lines to comprehend easily.",
    "Implementation smells \u2014 Nested Complexity: if-statements nested inside other ifs and/or loops, which sharply raises defect risk. Bumpy Road: a function that fails to encapsulate its responsibilities and instead holds several separate chunks of logic \u2014 extract each chunk into its own function. Complex Conditional: a single branch condition (in an if/for/while) combining multiple logical operators such as AND/OR. Large Assertion Blocks (test smell): a long run of consecutive assert statements that signals a missing abstraction. Duplicated Assertion Blocks (test smell): the same assertion block copy-pasted across the suite \u2014 a DRY violation."
  ].join("\n") : "";
  const CODERABBIT_REVIEW_GUIDANCE = CODERABBIT_HOST_REVIEW2 ? "Do NOT run coderabbit yourself and do not spend context waiting on its rate limits: the workflow host runs `coderabbit review --agent` against your COMMITTED work after the stage returns, absorbs any rate-limit backoff without agent tokens, and feeds actionable findings back to you as blocking review items. Your responsibilities are the deterministic commit gates and committing every piece of work \u2014 only committed changes reach the host review." : `Use \`coderabbit review --agent\` as the per-work-item AI review after deterministic gates are green, and clear all actionable concerns before advancing to the next work item or declaring the fix round complete. CodeRabbit is a shared, rate-limited quota: do not ask it to find errors that the project commit gates, markdown gates, linting, typechecking, or tests can catch locally. If the CodeRabbit rate limit is exceeded, treat the backoff as expected and sleep (use the \`vsleep\` command) for \`$(shuf -i ${CODERABBIT_BACKOFF_MINUTES2[0]}-${CODERABBIT_BACKOFF_MINUTES2[1]} -n 1)\` minutes before trying again; never shorten this backoff. You are not in any rush, and there is no wallclock time limit for this task. Retry at most three times after the initial CodeRabbit attempt, then record the deferred review with the exact error/output as an open issue so the supervisor can decide whether to relaunch, fallback-review, or wait for the quota to recover.`;
  const SPARK_DELEGATION_GUIDANCE = "You are free to delegate to the `wyvern` fast Codex subagent for bounded read-only tasks on known surfaces as needed; use 5.4-mini in place of 5.3 Codex Spark when Spark quota is unavailable. Quick surface maps, candidate-file recon, targeted consistency searches, and medium-grain 'what changed / where is the seam' checks.";
  const SCRUTINEER_DELEGATION_GUIDANCE = CODERABBIT_HOST_REVIEW2 ? `Delegate deterministic gate execution to the \`scrutineer\` sub-agent: ask it to run the repository commit gates/test suites. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until the gates are green. ${CODERABBIT_REVIEW_GUIDANCE}` : `Delegate deterministic gate execution and CodeRabbit invocation to the \`scrutineer\` sub-agent: ask it to run the repository commit gates/test suites and, only after those pass, to run \`${CODERABBIT_REVIEW_COMMAND2}\` from inside the worktree. The scrutineer must not edit tracked files; use its structured failure report to make fixes yourself, then summon it again until gates and CodeRabbit are green or a documented rate-limit/deferred-review open issue remains. ${CODERABBIT_REVIEW_GUIDANCE}`;
  return {
    PROJECT_ROOT: PROJECT_ROOT2,
    BASE: BASE2,
    ROADMAP: ROADMAP2,
    DESIGN_DOCS,
    RESEARCH_NOTE,
    ONLY_TASK: ONLY_TASK2,
    MAX_TASKS: MAX_TASKS2,
    MAX_PARALLEL: MAX_PARALLEL2,
    MAX_PLANNING_PARALLEL: MAX_PLANNING_PARALLEL2,
    MAX_BUILD_PARALLEL: MAX_BUILD_PARALLEL2,
    MAX_DESIGN_ROUNDS: MAX_DESIGN_ROUNDS2,
    MAX_REVIEW_ROUNDS: MAX_REVIEW_ROUNDS2,
    STAGE_ATTEMPTS: STAGE_ATTEMPTS2,
    PER_WORK_ITEM_BUILD: PER_WORK_ITEM_BUILD2,
    MAX_WORK_ITEM_ROUNDS: MAX_WORK_ITEM_ROUNDS2,
    AUTO_MERGE: AUTO_MERGE2,
    DOCUMENT_AUDIT: DOCUMENT_AUDIT2,
    DRY_RUN: DRY_RUN2,
    AUTH_PREFLIGHT: AUTH_PREFLIGHT2,
    REQUIRE_CODERABBIT_AUTH: REQUIRE_CODERABBIT_AUTH2,
    ASSESS_PARTIAL_BRANCHES: ASSESS_PARTIAL_BRANCHES2,
    RESUME_PARTIAL_BRANCHES: RESUME_PARTIAL_BRANCHES2,
    RESUME_MODE: RESUME_MODE2,
    RESUME_TASK_ID: RESUME_TASK_ID2,
    RESUME_MAX_CANDIDATES: RESUME_MAX_CANDIDATES2,
    WORKTREE_WRITE_PREFLIGHT: WORKTREE_WRITE_PREFLIGHT2,
    WRITE_PROBE_EFFORT: WRITE_PROBE_EFFORT2,
    WRITE_PROBE_MODEL_BY_ADAPTER: WRITE_PROBE_MODEL_BY_ADAPTER2,
    BUDGET_RESERVE: BUDGET_RESERVE2,
    SEARCH_BACKEND,
    GREPAI_WORKSPACE,
    GREPAI_PROJECT,
    MEMTRACE_REPO_ID,
    BUILD_ADAPTER: BUILD_ADAPTER2,
    PLAN_ADAPTER: PLAN_ADAPTER2,
    REVIEW_ADAPTER: REVIEW_ADAPTER2,
    TRIAGE_ADAPTER: TRIAGE_ADAPTER2,
    ASSESSMENT_ADAPTER: ASSESSMENT_ADAPTER2,
    BUILD_MODEL: BUILD_MODEL2,
    PLAN_MODEL: PLAN_MODEL2,
    REVIEW_MODEL: REVIEW_MODEL2,
    TRIAGE_MODEL: TRIAGE_MODEL2,
    TRIAGE_ESCALATION_MODEL: TRIAGE_ESCALATION_MODEL2,
    ASSESSMENT_MODEL: ASSESSMENT_MODEL2,
    ASSESSMENT_ESCALATION_MODEL: ASSESSMENT_ESCALATION_MODEL2,
    AUTH_REQUIRED_ADAPTERS: AUTH_REQUIRED_ADAPTERS2,
    CODERABBIT_REVIEW_COMMAND: CODERABBIT_REVIEW_COMMAND2,
    CODERABBIT_HOST_REVIEW: CODERABBIT_HOST_REVIEW2,
    CODERABBIT_BETWEEN_WORK_ITEMS: CODERABBIT_BETWEEN_WORK_ITEMS2,
    CODERABBIT_ATTEMPTS: CODERABBIT_ATTEMPTS2,
    CODERABBIT_BACKOFF_MINUTES: CODERABBIT_BACKOFF_MINUTES2,
    CODERABBIT_FINDINGS_FILE: CODERABBIT_FINDINGS_FILE2,
    HOST_COMMIT_GATES: HOST_COMMIT_GATES2,
    CS_CHECK: CS_CHECK2,
    CS_CHECK_COMMAND: CS_CHECK_COMMAND2,
    HOST_GATES_BETWEEN_WORK_ITEMS: HOST_GATES_BETWEEN_WORK_ITEMS2,
    COMMIT_GATE_TIMEOUT_SECONDS: COMMIT_GATE_TIMEOUT_SECONDS2,
    COMMIT_GATES: COMMIT_GATES2,
    COMMIT_GATE_TEXT: COMMIT_GATE_TEXT2,
    COMMIT_GATE_GUIDANCE: COMMIT_GATE_GUIDANCE2,
    CS_CHECK_GUIDANCE: CS_CHECK_GUIDANCE2,
    CODERABBIT_REVIEW_GUIDANCE,
    SPARK_DELEGATION_GUIDANCE,
    SCRUTINEER_DELEGATION_GUIDANCE
  };
}

// src/workflows/df12-build-odw/prompts.ts
function makePrompts(config) {
  const {
    BASE: BASE2,
    ROADMAP: ROADMAP2,
    DESIGN_DOCS,
    RESEARCH_NOTE,
    DRY_RUN: DRY_RUN2,
    DOCUMENT_AUDIT: DOCUMENT_AUDIT2,
    SEARCH_BACKEND,
    GREPAI_WORKSPACE,
    GREPAI_PROJECT,
    MEMTRACE_REPO_ID,
    COMMIT_GATE_TEXT: COMMIT_GATE_TEXT2,
    COMMIT_GATE_GUIDANCE: COMMIT_GATE_GUIDANCE2,
    CS_CHECK: CS_CHECK2,
    CS_CHECK_GUIDANCE: CS_CHECK_GUIDANCE2,
    CODERABBIT_REVIEW_COMMAND: CODERABBIT_REVIEW_COMMAND2,
    CODERABBIT_HOST_REVIEW: CODERABBIT_HOST_REVIEW2,
    CODERABBIT_REVIEW_GUIDANCE,
    SPARK_DELEGATION_GUIDANCE,
    SCRUTINEER_DELEGATION_GUIDANCE
  } = config;
  function grepaiSearchCommand() {
    const workspaceArg = shellQuote(GREPAI_WORKSPACE);
    const projectArg = GREPAI_PROJECT ? shellQuote(GREPAI_PROJECT) : "$(get-project)";
    return `grepai search --workspace ${workspaceArg} --project ${projectArg} "<English intent query>" --toon --compact`;
  }
  function memtraceRepoGuidance() {
    return MEMTRACE_REPO_ID ? `Use repo_id ${shellQuote(MEMTRACE_REPO_ID)} for Memtrace calls after confirming it appears in list_indexed_repositories.` : "Call list_indexed_repositories first and select the repo_id for this project before using other Memtrace tools.";
  }
  function codeSearchGuidance2() {
    if (SEARCH_BACKEND === "memtrace") {
      return `Use the Memtrace MCP server as the PRIMARY tool for canonical main-branch code search and graph context. ${memtraceRepoGuidance()} Use find_code for intent/concept search, find_symbol for exact identifiers, list_communities/find_central_symbols for orientation, get_symbol_context/get_impact/get_timeline before changing load-bearing symbols, and get_source_window only for bounded source reads. Treat Memtrace's committed/main view as canonical context, not branch-local evidence; verify every branch-local or newly changed fact directly inside your worktree with \`leta\`, exact text search, or file inspection before acting. If a Memtrace MCP call is unavailable because the host session rejects, cancels, or lacks the tool, record that exact tooling failure in the ExecPlan and continue with bounded branch-local evidence; do not make the plan impossible to execute solely because Memtrace was unavailable in the planning session. Memtrace unavailability is not a valid reason to set ExecPlan status to BLOCKED.`;
    }
    if (SEARCH_BACKEND !== "grepai") {
      throw new Error(`Unsupported searchBackend: ${SEARCH_BACKEND}`);
    }
    return `Use \`${grepaiSearchCommand()}\` as the PRIMARY tool for intent/concept code search against the canonical main-branch index. The grepai index reflects \`main\` only: never treat it as evidence for branch-local or newly changed code. Verify every branch-local fact directly inside your worktree with \`leta\`, exact text search, or file inspection before acting. If GrepAI is unavailable in the agent session, record the exact tooling failure in the ExecPlan and continue with bounded branch-local evidence; do not make the plan impossible to execute solely because GrepAI was unavailable.`;
  }
  function preamble2(worktree) {
    const loc = worktree ? `Work EXCLUSIVELY inside the git-donkey worktree at ${worktree}. cd into it before doing anything. Never read-modify-write any file in the root/control worktree; it is off-limits for edits.` : `This is a read-only / setup step. Do not edit any file in the root/control worktree.`;
    return [
      "You are a sub-agent in the df12-build roadmap workflow. Your final message IS your return value \u2014 return data, not chat.",
      "",
      "Standing rules (apply to every step, no exceptions):",
      `- ${loc}`,
      "- File edits must target the assigned git-donkey worktree. When using an edit tool whose target is not scoped by shell `cd` or command `workdir`, use absolute paths under the assigned worktree; never let relative edit paths hit the root/control worktree.",
      `- ${codeSearchGuidance2()}`,
      "- Use `leta` for symbol navigation, references, call graphs, and branch-local verification (leta show / refs / grep / files) instead of ad-hoc ripgrep or read-file. If Leta is unavailable because its daemon or workspace tooling fails, record the exact failure and fall back to precise file inspection for the current task; do not add a hard implementation blocker solely for a transient Leta startup failure. Leta unavailability is not a valid reason to set ExecPlan status to BLOCKED.",
      "- Use `sem` for codebase history navigation (semantic, entity-level diffs and blame) instead of raw git log/blame.",
      "- Load the appropriate language router skill for any code you touch: python-router for Python, rust-router for Rust, and the matching router for other languages. Follow the smaller skills it routes you to.",
      `- Treat docs/ as the source of truth: ${DESIGN_DOCS}, the developers guide, any users guide present, the coding/scripting standards, and AGENTS.md. Obey AGENTS.md quality gates and the en-GB Oxford-spelling ("-ize"/"-yse"/"-our") convention in all prose, comments, and commits.`,
      `- ${COMMIT_GATE_GUIDANCE2}`,
      `- The integration branch is "${BASE2}"; treat origin/${BASE2} as canonical. The roadmap lives at ${ROADMAP2}.`,
      "- Format ONLY the files you changed: run the markdown formatter on the specific paths you touched (`mdtablefix \u2026 <files>` then `markdownlint-cli2 --fix <files>`), then gate. Do NOT run a repo-global format such as `make fmt` / `mdformat-all` that reformats unrelated files \u2014 that churn only has to be parked and discarded.",
      '- Never `git stash` with a bare or default message. Name every stash so a deterministic sweeper can tie it to a task and clear it safely: `df12-stash v1 task=<this roadmap id> kind=<discard|park|keep> reason="<short>"`. Formatter or build churn you park is kind=discard; anything you must re-apply later is kind=keep.',
      "- Signpost the documentation and skills you relied on in your output so the next agent can follow the same trail.",
      ""
    ].join("\n");
  }
  function planPrompt2(task, worktree, priorVerdict, round, opts = {}) {
    const revision = round === 1 ? "This is the first planning round." : [
      `This is planning round ${round}. The design reviewer was NOT satisfied. Resolve every blocking point below by revising the execplan, then explain in addressedSince how each was resolved:`,
      ...(priorVerdict?.blocking || []).map((b, i) => `  ${i + 1}. ${b}`)
    ].join("\n");
    return [
      preamble2(worktree),
      `TASK: Produce (or revise) a self-contained ExecPlan for roadmap task ${task.id} \u2014 "${task.title}".`,
      "",
      ...opts.resume ? [
        "RESUME: this branch survived a previous run. A committed ExecPlan draft may already exist at docs/execplans/<branch-leaf>.md, and the branch may already carry commits. Read the existing draft (Status, Progress, Decision Log) and the branch history FIRST, then complete or revise the plan IN PLACE rather than starting over. Account for any work already committed on the branch.",
        ""
      ] : [],
      SPARK_DELEGATION_GUIDANCE,
      "",
      'Use the `execplans` skill and follow it exactly. Name the plan docs/execplans/<branch-leaf>.md within the worktree (branch leaf = the part after the last "/").',
      "The plan must:",
      "- Decompose the task into ordered, atomic work items, each independently committable and gate-passable.",
      "- Record the work items in the `## Progress` section as one checklist line each, `- [ ] WI-<n>: <imperative title>`, in execution order. The workflow host reads this checklist to dispatch the build one work item at a time, so every implementable work item must appear as its own unticked line \u2014 preparation notes that are not build work must not be checklist lines.",
      `- Adhere to the design documents (${DESIGN_DOCS}), the developers guide, the coding standards, and AGENTS.md. Cite the exact sections/ADRs each work item implements.`,
      "- Signpost, per work item, the documentation to read and the skills to load (router skills, hypothesis/crosshair/mutmut for verification, etc.).",
      "- Specify the tests (unit, behavioural, property, snapshot, e2e) each work item must add or update, per the AGENTS.md testing rules.",
      "- The ExecPlan must be implementable as written. Do NOT set Status: BLOCKED merely because Memtrace, GrepAI, Leta, Firecrawl, sem, or another advisory tool is unavailable in your agent session. Record the failed command and use bounded local docs/source/tests as fallback evidence. Only mark blocked for a true product/design ambiguity or missing requirement that cannot be resolved from the repository.",
      `- State the validation commands (${COMMIT_GATE_TEXT2}; plus \`make markdownlint\` and \`make nixie\` for markdown changes). ${COMMIT_GATE_GUIDANCE2}`,
      `- VALIDATION COMMANDS MUST BE PATH-SAFE: prefer repository gates such as ${COMMIT_GATE_TEXT2}, \`make markdownlint\`, and \`make nixie\` over hand-written file lists. If a work item lists direct formatter/linter commands, every listed path must definitely exist at that point in the work item. Do not include a file that the same work item may delete, an optional file such as an optional snapshot, or a file that the work item does not edit. If a path is conditional, make the command conditional (\`test -e path && \u2026\`) or omit that path and rely on the repository gate. This is a blocking design-review requirement.`,
      "",
      "RESEARCH before you commit to any mechanism \u2014 do not leave the implementer a menu of unverified workarounds:",
      "- For every external or locked library the plan leans on, verify its REAL behaviour before relying on it: read the actual source (a vendored or sibling checkout if the project has one) and the official docs (use the `firecrawl` skill / firecrawl_* tools). Pin every load-bearing API to what the LOCKED version genuinely supports and cite the file/symbol or doc you verified against. If the library cannot express what a work item needs, say so explicitly and specify the justified, scoped alternative rather than hedging.",
      ...RESEARCH_NOTE ? [`- Project-specific research guidance: ${RESEARCH_NOTE}`] : [],
      "- Every load-bearing behavioural claim must be either verified-and-cited or pinned by a test in the plan. No undecided forks.",
      "",
      revision,
      "",
      "EXECPLAN DURABILITY CONTRACT: the committed ExecPlan is the durable source of truth for where this task stands \u2014 an uncommitted plan is lost when the run dies. COMMIT the ExecPlan on the task branch as soon as it is first written, and commit again after EVERY revision (en-GB imperative subject). Keep the header Status field accurate: it stays `DRAFT` while planning; the design reviewer flips it to `APPROVED`. Never return with the ExecPlan uncommitted or the worktree dirty.",
      "",
      "Write/update the execplan file on disk in the worktree and COMMIT it. Return its path, the ordered work-item titles, the docs and skills cited, and a short summary. Do NOT begin implementation."
    ].join("\n");
  }
  function designReviewPrompt2(task, worktree, plan, round) {
    return [
      preamble2(worktree),
      `TASK: Conduct an ADVERSARIAL Logisphere DESIGN review of the ExecPlan for roadmap task ${task.id} at ${plan.execplanPath}. Round ${round}.`,
      "",
      "Invoke the `logisphere-design-review` skill and run the plan past the full crew (Pandalump structural integrity, Wafflecat alternatives, Buzzy Bee scaling, Telefono contracts, Doggylump failure modes, Dinolump long-term viability), plus the pre-mortem and alternatives checkpoint.",
      `Be genuinely adversarial: assume the plan is flawed until proven otherwise. Check it against the design documents, ADRs, developers guide, and AGENTS.md. Verify the work items are atomic, ordered, testable, and complete; that validation includes the project commit gates (${COMMIT_GATE_TEXT2}, cross-checked against the gate targets AGENTS.md actually names) plus markdown gates when markdown changes; that direct formatter/linter file lists only name files guaranteed to exist and changed by that work item; that no standalone red-test commit is required; and that nothing contradicts the deterministic/judgemental boundary or the established contracts.`,
      "",
      "Read the execplan from disk yourself \u2014 do not trust the planner's summary. You may leave review notes in the execplan or an adjacent review file, but do NOT implement anything and do NOT relax the design to make it pass.",
      "Where the plan asserts any external or locked-library behaviour, verify it against the REAL source (a vendored or sibling checkout if the project has one) and the official docs. Treat any uncited memory-based claim about library behaviour as a blocking defect: the plan must verify and cite official docs when tools permit, or pin the behaviour with a test. Do not reject an otherwise implementable plan solely because Memtrace, GrepAI, Leta, Firecrawl, or sem was unavailable in the planner session; reject it if that unavailability was turned into a hard blocker instead of a documented fallback.",
      "",
      "Set satisfied=true ONLY when you would stake your name on the plan being implementable and design-conformant as written. Otherwise list precise, addressable blocking defects (these go straight back to the planner).",
      "",
      "STATUS TRANSITION: when you set satisfied=true, the workflow itself records the `APPROVED` status flip as a deterministic commit \u2014 you do not need to edit the plan header. If you are NOT satisfied, leave Status as `DRAFT`, and commit any review notes you chose to leave in the worktree so nothing is lost if the run dies."
    ].join("\n");
  }
  function implementPrompt2(task, worktree, plan, opts = {}) {
    return [
      preamble2(worktree),
      `TASK: Implement roadmap task ${task.id} ("${task.title}") by executing the approved ExecPlan at ${plan.execplanPath}, work item by work item, in order.`,
      "",
      ...opts.resume ? [
        "RESUME: this branch survived a previous run, and the committed ExecPlan is the source of truth for where the build stands. Read its Status, Progress checkboxes, and Decision Log FIRST. Verify already-ticked work items briefly (their commits exist on the branch and gates still pass) rather than redoing them, then continue from the first unticked work item.",
        ""
      ] : [],
      SPARK_DELEGATION_GUIDANCE,
      "",
      SCRUTINEER_DELEGATION_GUIDANCE,
      "",
      "For EACH execplan work item, in this exact order:",
      "  1. Implement the work item (code + tests + docs) per the plan and AGENTS.md.",
      `  2. DETERMINISTIC GATE FIRST: summon \`scrutineer\` to run the project commit gates (${COMMIT_GATE_TEXT2}, plus any further gate targets AGENTS.md names). If it reports failures, fix them yourself (format, lint, typecheck, tests, audit) and summon \`scrutineer\` again until green. For any markdown you touched, also have \`scrutineer\` run \`make markdownlint\` and \`make nixie\` and fix failures.`,
      ...CODERABBIT_HOST_REVIEW2 ? [`  3. ${CODERABBIT_REVIEW_GUIDANCE}`] : [
        `  3. THEN summon \`scrutineer\` to run \`${CODERABBIT_REVIEW_COMMAND2}\` from inside the worktree. Address actionable feedback yourself (highest severity first). After applying fixes, summon \`scrutineer\` again to re-run the commit gates and confirm they are still green.`,
        `     - ${CODERABBIT_REVIEW_GUIDANCE}`
      ],
      "  4. Update the execplan IN PLACE with findings, progress (tick the work item), and any decisions or deviations, with rationale.",
      "  5. Commit the work item and the execplan update together as one atomic commit (en-GB imperative subject ~50 cols, wrapped body explaining what and why).",
      "",
      "EXECPLAN DURABILITY CONTRACT: the committed ExecPlan (Status + Progress checkboxes) is the durable source of truth for where this task stands. Before starting the first work item, set the header Status to `IN PROGRESS` and commit it. When every work item is complete and the gates are green, set Status to `COMPLETE` together with the Outcomes & Retrospective update, and commit. Never leave the ExecPlan stale or uncommitted at any stopping point \u2014 if you must stop early, commit the plan reflecting exactly what is done and what remains.",
      "",
      "Use leta for navigation, sem for history, and the language router skill for the languages you touch. Follow the per-work-item skill and documentation signposts in the plan.",
      "",
      `${DRY_RUN2 ? "DRY RUN: do not run this step \u2014 it is skipped by the orchestrator." : ""}`,
      `When all work items are done, ensure the project commit gates (${COMMIT_GATE_TEXT2}) are green at HEAD. Return the completion counts, commit subjects, whether gates are green, the number of coderabbit runs, and any open issues.`
    ].join("\n");
  }
  function implementWorkItemPrompt2(task, worktree, plan, item, opts = {}) {
    return [
      preamble2(worktree),
      `TASK: Implement EXACTLY ONE work item of roadmap task ${task.id} ("${task.title}") from the approved ExecPlan at ${plan.execplanPath}.`,
      "",
      "THE WORK ITEM (the first unticked entry in the plan's ## Progress checklist):",
      `  ${item.text}`,
      "",
      "Read the ExecPlan first: it carries the design citations, signposted docs and skills, and the tests this work item must add. Implement THIS work item completely (code + tests + docs per the plan) and NOTHING ELSE \u2014 do not start later work items and do not refactor beyond this item; the next builder turn continues from the committed state you leave.",
      ...opts.noProgressNote ? ["", `PREVIOUS TURN DEFECT: ${opts.noProgressNote}`] : [],
      "",
      SPARK_DELEGATION_GUIDANCE,
      "",
      SCRUTINEER_DELEGATION_GUIDANCE,
      "",
      "Then, in this exact order:",
      `  1. DETERMINISTIC GATE: summon \`scrutineer\` to run the project commit gates (${COMMIT_GATE_TEXT2}, plus any further gate targets AGENTS.md names; \`make markdownlint\` and \`make nixie\` for any markdown you touched). Fix failures yourself and re-run until green. ${COMMIT_GATE_GUIDANCE2}`,
      ...CS_CHECK2 ? [`  1b. CODE HEALTH: after the gates are green, the host runs a CodeScene code-health check on your committed changes before CodeRabbit. Keep functions small, cohesive, and free of nested or overly complex conditionals so it passes; a regression bounces back to you with the specific smells and the option \u2014 only where refactoring would be deleterious \u2014 to suppress a smell with a justified \`@codescene(disable:"...")\` comment.`] : [],
      CODERABBIT_HOST_REVIEW2 ? `  2. ${CODERABBIT_REVIEW_GUIDANCE}` : `  2. Summon \`scrutineer\` to run \`${CODERABBIT_REVIEW_COMMAND2}\` from inside the worktree; address actionable feedback yourself (highest severity first); summon \`scrutineer\` again to confirm the gates are still green. ${CODERABBIT_REVIEW_GUIDANCE}`,
      "  3. Update the ExecPlan IN PLACE: tick this work item in ## Progress and record findings, decisions, and deviations. If this was the first work item, also set the header Status to `IN PROGRESS`; if it was the LAST unticked item, set Status to `COMPLETE` together with the Outcomes & Retrospective update.",
      "  4. Commit the work item and the ExecPlan update together as one atomic commit (en-GB imperative subject ~50 cols, wrapped body explaining what and why).",
      "",
      "EXECPLAN DURABILITY CONTRACT: never return with the worktree dirty or the Progress tick uncommitted \u2014 the host verifies both after every turn and bounces the defect back to you.",
      "",
      "Return using the IMPL schema: ok=true only when this work item is complete, every gate is green at HEAD, and the tick is committed. Set workItemsCompleted/workItemsTotal to the plan's ticked/total counts after your commit."
    ].join("\n");
  }
  function fixPrompt2(task, worktree, plan, blocking, round) {
    return [
      preamble2(worktree),
      `TASK: Address blocking review findings for roadmap task ${task.id} (fix round ${round}). Execplan: ${plan.execplanPath}.`,
      "",
      SPARK_DELEGATION_GUIDANCE,
      "",
      SCRUTINEER_DELEGATION_GUIDANCE,
      "",
      "The dual review returned the following BLOCKING items. Resolve every one:",
      ...blocking.map((b, i) => `  ${i + 1}. ${b}`),
      "",
      ...CS_CHECK_GUIDANCE2 ? [CS_CHECK_GUIDANCE2, ""] : [],
      CODERABBIT_HOST_REVIEW2 ? `Same per-change discipline as implementation: summon \`scrutineer\` for the deterministic gates (${COMMIT_GATE_TEXT2}, plus markdownlint/nixie for markdown) first and green, then one atomic commit that includes the execplan update recording what changed and why (the committed ExecPlan is the durable source of truth \u2014 never leave it stale or uncommitted). ${CODERABBIT_REVIEW_GUIDANCE} Do not introduce scope beyond the blocking items.` : `Same per-change discipline as implementation: summon \`scrutineer\` for the deterministic gates (${COMMIT_GATE_TEXT2}, plus markdownlint/nixie for markdown) first and green, THEN summon \`scrutineer\` for \`${CODERABBIT_REVIEW_COMMAND2}\`, then one atomic commit that includes the execplan update recording what changed and why (the committed ExecPlan is the durable source of truth \u2014 never leave it stale or uncommitted). ${CODERABBIT_REVIEW_GUIDANCE} Do not introduce scope beyond the blocking items.`,
      "",
      "Return the commit subjects you added, whether every deterministic gate is green at HEAD after your fixes, the number of CodeRabbit runs you completed, how each blocking item was resolved, any open issues with reasons, and a short summary. This structured report is durable validation evidence for the branch \u2014 be precise about which gates ran and at which commit."
    ].join("\n");
  }
  function codeReviewPrompt2(task, worktree, plan) {
    return [
      preamble2(worktree),
      `TASK: Benchmark the implementation of roadmap task ${task.id} against its plan using the \`code-review\` skill.`,
      "",
      `Compare the committed work on this branch against the execplan at ${plan.execplanPath} and the design documents. Judge four axes explicitly:`,
      "- correctness (does it do what the task and plan specify; any bugs or regressions?),",
      "- plan adherence (were all work items delivered as planned; were deviations justified and recorded?),",
      "- documentation coverage (docstrings, developers/users guide, ADR/design updates per AGENTS.md),",
      "- validation coverage (unit, behavioural, property, snapshot, e2e per AGENTS.md; do the gates actually exercise the new behaviour?).",
      "",
      `Use leta to inspect the code and sem to inspect the change history. Use the commit-gate output (${COMMIT_GATE_TEXT2}) as evidence but do not rely on it alone.`,
      "Return verdict=pass only if you would ship it. List precise blocking items otherwise. Any follow-up ideas go in proposedRoadmapItems (PROPOSAL ONLY \u2014 do not touch the roadmap)."
    ].join("\n");
  }
  function expertReviewPrompt2(task, worktree, plan) {
    return [
      preamble2(worktree),
      `TASK: Run an ADVERSARIAL community-of-experts review of roadmap task ${task.id}, scoped STRICTLY to the work delivered for this task.`,
      "",
      "Invoke the `logisphere-experts` skill and bring the full crew to bear (architecture, alternatives, performance/observability, type-safety/contracts, reliability/ops, developer experience). Be adversarial: actively try to find what is wrong, brittle, or under-tested in THIS task's diff only \u2014 do not review unrelated code.",
      `Ground the review in the execplan at ${plan.execplanPath}, the design documents, and AGENTS.md. Use leta and sem.`,
      "",
      "Return verdict=pass only when the crew is collectively satisfied the task is correct, conformant, and production-ready within its scope. List precise blocking items otherwise. Surface broader follow-ups as proposedRoadmapItems (PROPOSAL ONLY \u2014 never edit the roadmap)."
    ].join("\n");
  }
  function addendumReviewPrompt2(task, worktree, impl) {
    const ids = (task.subtasks || []).join(", ");
    const parentPlan = `docs/execplans/roadmap-${roadmapIdSlug(task.id)}.md`;
    return [
      preamble2(worktree),
      `TASK: Review the committed addendum implementation for completed roadmap task ${task.id}, scoped ONLY to sub-task(s): ${ids}.`,
      "",
      "CodeRabbit review was deferred or unavailable for this addendum, so you are the high-model fallback reviewer. Use the `code-review` skill. Be strict, but keep the scope surgical: this is not a full design review and not a licence to expand the task.",
      "",
      `Compare the branch diff against the Addenda checklist in ${parentPlan}, the relevant design/developer docs, and AGENTS.md. Confirm:`,
      "- each listed addendum sub-task is actually implemented and ticked in the execplan,",
      "- the implementation is correct and does not regress existing behaviour,",
      "- tests or property checks cover the new edge, and repository gates are meaningful evidence,",
      "- documentation changes are present where AGENTS.md or the addendum requires them.",
      "",
      `Do not treat unchecked entries in ${ROADMAP2} as a blocking issue for this review. The implementation agent is forbidden to edit the roadmap; the serialized integration phase ticks the roadmap after this review passes.`,
      "",
      "Implementation summary from the builder:",
      impl?.summary || "",
      "",
      "Builder-reported deferred/open issues:",
      ...(impl?.openIssues || []).map((issue, index) => `  ${index + 1}. ${issue}`),
      "",
      "Use leta for branch-local code navigation and sem for the committed diff. Return verdict=pass only if you would ship this addendum despite the deferred CodeRabbit review. If not, list precise blocking items. Follow-up ideas go in proposedRoadmapItems only."
    ].join("\n");
  }
  function implementAddendumPrompt2(task, worktree) {
    const ids = (task.subtasks || []).join(", ");
    const parentPlan = `docs/execplans/roadmap-${roadmapIdSlug(task.id)}.md`;
    return [
      preamble2(worktree),
      `TASK: Lightweight ADDENDUM PASS for completed roadmap task ${task.id}. Implement ONLY its open sub-tasks: ${ids}. This is an addendum, NOT a full task \u2014 there is deliberately NO plan, NO design review, and NO dual logisphere review. Keep every change surgical and strictly in-scope; an addendum that grows into a redesign is a defect.`,
      "",
      SPARK_DELEGATION_GUIDANCE,
      "",
      SCRUTINEER_DELEGATION_GUIDANCE,
      "",
      `These sub-tasks are recorded as unchecked items under an "## Addenda" section of the parent task's execplan (start at ${parentPlan}; if the leaf differs, find the execplan whose Addenda list contains ${ids}). Read that section for the precise scope and gate of each sub-task.`,
      "",
      "For EACH open sub-task, in id order:",
      "  1. Make ONLY the change the Addenda item describes. Do not expand scope.",
      `  2. DETERMINISTIC GATE: summon \`scrutineer\` to run the project commit gates (${COMMIT_GATE_TEXT2}, plus any further gate targets AGENTS.md names). For any Markdown you touched, also have it run \`make markdownlint\` and \`make nixie\`. Fix until green.`,
      CODERABBIT_HOST_REVIEW2 ? `  3. ${CODERABBIT_REVIEW_GUIDANCE}` : `  3. Summon \`scrutineer\` to run \`${CODERABBIT_REVIEW_COMMAND2}\` from inside the worktree; address actionable feedback yourself (highest severity first); summon \`scrutineer\` again to re-run the commit gates and confirm green. ${CODERABBIT_REVIEW_GUIDANCE}`,
      `  4. Tick the sub-task in the Addenda checklist of its execplan (\`- [ ] ${task.id}.<n>\` \u2192 \`- [x] \u2026\`).`,
      "  5. Commit the sub-task and Addenda tick together as one atomic commit (en-GB imperative subject).",
      "",
      `Use leta for navigation, sem for history, and the language router skill for the languages you touch. Do NOT edit the roadmap \u2014 integration ticks the roadmap sub-tasks. When all listed sub-tasks are done, ensure the project commit gates (${COMMIT_GATE_TEXT2}) are green at HEAD. Return using the IMPL schema (execplanPath = the parent execplan): completion counts, commit subjects, gatesGreen, coderabbit run count, and any open issues.`
    ].join("\n");
  }
  function integratePrompt2(task, worktree) {
    const markStep = task.isAddendum ? `Tick each completed sub-task in ${ROADMAP2}: for every id in [${(task.subtasks || []).join(", ")}], change its nested \`- [ ] ${task.id}.<n>.\` to \`- [x] \u2026\`. LEAVE the parent ${task.id} as \`[x]\` (it was already done). Run \`make markdownlint\` and \`make nixie\`; commit the roadmap update (en-GB).` : `Mark the task done in ${ROADMAP2}: change its \`- [ ] ${task.id}.\` to \`- [x] ${task.id}.\`. Run \`make markdownlint\` and \`make nixie\`; commit the roadmap update (en-GB).`;
    return [
      preamble2(worktree),
      `TASK: Integrate completed ${task.isAddendum ? `addendum pass for roadmap task ${task.id} (sub-tasks ${(task.subtasks || []).join(", ")})` : `roadmap task ${task.id} ("${task.title}")`}.`,
      "",
      `CONCURRENCY: sibling tasks are being built in parallel and merge through a single merge queue. You hold the merge lock for the duration of this step, so you are the only one merging right now \u2014 but origin/${BASE2} may have advanced since your branch was created (a sibling merged, or a remediation flush landed). Always reconcile against the LATEST origin/${BASE2} immediately before merging.`,
      "",
      `Steps, in order, from inside the worktree:`,
      `  1. ${markStep}`,
      `  2. Fetch and rebase the branch onto the current origin/${BASE2} (\`git fetch origin ${BASE2}\` then rebase). Use the \`rebase\` skill for functionality-aware conflict resolution: resolve each conflict by preserving the INTENT of both sides (favour the design docs and existing contracts), not by blindly taking one side. If a conflict genuinely cannot be resolved safely, set ok=false, describe it in conflicts, and STOP without merging.`,
      `  3. Re-run the project commit gates (${COMMIT_GATE_TEXT2}) after the rebase to confirm the branch is still green.`,
      `  4. Land the squash ENTIRELY inside this worktree. NEVER \`git switch ${BASE2}\` and never touch the control/root worktree or its checked-out ${BASE2}: that switch fails when ${BASE2} is checked out elsewhere, and it pollutes the control worktree (the root of recurring detritus). Step 2 left the task branch rebased on the current origin/${BASE2}; from here, create a fresh temp branch there (\`git switch -c integrate-${roadmapIdSlug(task.id)} origin/${BASE2}\`), squash-merge the task branch onto it (\`git merge --squash <task-branch>\` then \`git commit\` with a clear squash message summarising the task), and push it straight to the integration branch with \`git push origin HEAD:${BASE2}\`. If the push is rejected non-fast-forward (a sibling advanced origin/${BASE2} since step 2), go back to step 2 \u2014 re-fetch and re-rebase the task branch onto the new origin/${BASE2} \u2014 then redo this step. Retry until it lands.`,
      "",
      "Return what you actually did (roadmapMarkedDone, rebased, squashMerged, mergeSha, pushed) and any conflict notes. Do not delete the worktree unless git donkey expects you to; leave the repo in a clean state."
    ].join("\n");
  }
  function auditPrompt2(task, worktree) {
    const writeClause = DOCUMENT_AUDIT2 ? `Record your findings as a structured markdown file at docs/issues/audit-${task.id}.md (create docs/issues/ if absent), one section per finding with location and a concrete proposed fix. Run \`make markdownlint\` and \`make nixie\` on it, then commit it on your own worktree branch and push it straight to the integration branch with \`git push origin HEAD:${BASE2}\` (re-fetch and rebase on a non-fast-forward reject, then retry). NEVER \`git switch ${BASE2}\` or touch the control/root worktree.` : `Do NOT write any file; return findings only.`;
    return [
      preamble2(worktree),
      `TASK: Post-step codebase audit, run after roadmap task ${task.id} merged. Create a fresh git-donkey worktree off origin/${BASE2} for your inspection (no work in the root worktree); explore with leta and trace history with sem.`,
      "",
      "Run this audit verbatim:",
      '"""',
      "Please audit the codebase for refactoring opportunities, places with repeated code, complex conditionals, ergonomic awkwardness, functions with high similarity, inconsistencies, poor separation of concerns or domain, command query segregation violation, or gaps in documentation comments, developer/user documentation and behavioural/unit test coverage. Propose actionable fixes for any issues identified.",
      '"""',
      "",
      writeClause,
      "",
      "Return every finding (category, location, description, proposed fix, severity) and any proposedRoadmapItems. Adding items to the roadmap is reserved to the root agent \u2014 propose only, never edit the roadmap."
    ].join("\n");
  }
  return {
    grepaiSearchCommand,
    memtraceRepoGuidance,
    codeSearchGuidance: codeSearchGuidance2,
    preamble: preamble2,
    planPrompt: planPrompt2,
    designReviewPrompt: designReviewPrompt2,
    implementPrompt: implementPrompt2,
    implementWorkItemPrompt: implementWorkItemPrompt2,
    fixPrompt: fixPrompt2,
    codeReviewPrompt: codeReviewPrompt2,
    expertReviewPrompt: expertReviewPrompt2,
    addendumReviewPrompt: addendumReviewPrompt2,
    implementAddendumPrompt: implementAddendumPrompt2,
    integratePrompt: integratePrompt2,
    auditPrompt: auditPrompt2
  };
}

// src/workflows/df12-build-odw/write-preflight.ts
var WRITE_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", description: "true when the probe file was written with the exact token" },
    detail: { type: "string", description: "the error encountered, empty when ok" }
  },
  required: ["ok"]
};
function writeProbePath(worktree, adapter) {
  const path = process.getBuiltinModule("node:path");
  return path.join(worktree, `.df12-write-probe-${String(adapter).replace(/[^0-9a-zA-Z._-]+/g, "-")}`);
}
function writeProbeToken(tag, adapter) {
  return `df12-write-probe v1 task=${tag} adapter=${adapter}`;
}
function writeProbePrompt(probeFile, token) {
  return [
    "You are a sub-agent in the df12-build roadmap workflow. Your final message IS your return value \u2014 return data, not chat.",
    "",
    "TASK: Writable-root probe. Write EXACTLY the token below (no trailing newline required) to the probe file path below, using your shell or file-edit tooling. Do not write anywhere else, do not commit, and do not delete the file afterwards \u2014 the workflow host verifies and removes it.",
    "",
    `PROBE_FILE: ${probeFile}`,
    `PROBE_TOKEN: ${token}`,
    "",
    "Return ok=true only if the write succeeded. If the write is rejected (sandbox, permissions, missing directory), return ok=false with the exact error text in detail."
  ].join("\n");
}
async function clearProbeArtifact(probeFile) {
  const fs = process.getBuiltinModule("node:fs/promises");
  try {
    await fs.lstat(probeFile);
  } catch {
    return;
  }
  await fs.rm(probeFile, { force: true, recursive: true });
}
async function verifyWriteProbe(probeFile, token) {
  const fs = process.getBuiltinModule("node:fs/promises");
  const { constants } = process.getBuiltinModule("node:fs");
  let handle = null;
  let content = null;
  try {
    handle = await fs.open(probeFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.isFile()) {
      content = await handle.readFile({ encoding: "utf8" });
    }
  } catch (error) {
    const failure = error;
    if (failure && (failure.code === "ELOOP" || failure.code === "EMLINK")) {
      await fs.rm(probeFile, { force: true, recursive: true });
      return { ok: false, detail: "probe path is not a regular file (symlink or special file rejected)" };
    }
    return { ok: false, detail: `probe file missing or unreadable: ${failure && failure.message || String(error)}` };
  } finally {
    if (handle) await handle.close();
  }
  await fs.rm(probeFile, { force: true, recursive: true });
  if (content === null) {
    return { ok: false, detail: "probe path is not a regular file (symlink or special file rejected)" };
  }
  if (content.trim() === token) return { ok: true, detail: "" };
  return { ok: false, detail: `probe file content mismatch (${content.trim().slice(0, 80) || "<empty>"})` };
}
async function hostWriteProbe(worktree) {
  const fs = process.getBuiltinModule("node:fs/promises");
  const path = process.getBuiltinModule("node:path");
  const hostProbe = path.join(worktree, ".df12-write-probe-host");
  try {
    await clearProbeArtifact(hostProbe);
    await fs.writeFile(hostProbe, "df12-write-probe host", { encoding: "utf8", flag: "wx" });
    await fs.rm(hostProbe, { force: true });
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: error && error.message || String(error) };
  }
}
function makeWritePreflight({ enabled, targets }) {
  async function runTaskAgentWritePreflight2(worktree, tag) {
    const host = await hostWriteProbe(worktree);
    if (!host.ok) {
      return { ok: false, failures: [{ adapter: "host", detail: host.detail }] };
    }
    const outcomes = await Promise.all(targets().map(async (target) => {
      const probeFile = writeProbePath(worktree, target.adapter);
      const token = writeProbeToken(tag, target.adapter);
      await clearProbeArtifact(probeFile);
      let reply = null;
      let agentError = "";
      try {
        reply = await agent(writeProbePrompt(probeFile, token), target.options({
          phase: "Worktree",
          label: `write-probe:${target.adapter}`,
          schema: WRITE_PROBE_SCHEMA
        }));
      } catch (error) {
        agentError = error && error.message || String(error);
      }
      const verified = await verifyWriteProbe(probeFile, token);
      if (verified.ok) return null;
      const detail = [verified.detail, reply && reply.ok === false ? reply.detail : "", agentError].filter(Boolean).join("; ");
      return { adapter: target.adapter, detail };
    }));
    const failures = outcomes.filter((outcome) => outcome !== null);
    return { ok: failures.length === 0, failures };
  }
  let taskAgentWritePreflight = null;
  function ensureTaskAgentWriteAccess2(worktree, tag) {
    if (!enabled) return Promise.resolve({ ok: true, skipped: true, failures: [] });
    if (!taskAgentWritePreflight) taskAgentWritePreflight = runTaskAgentWritePreflight2(worktree, tag);
    return taskAgentWritePreflight;
  }
  return { runTaskAgentWritePreflight: runTaskAgentWritePreflight2, ensureTaskAgentWriteAccess: ensureTaskAgentWriteAccess2 };
}

// src/workflows/df12-build-odw/assessment.ts
function fastAssessmentClassification(evidence) {
  const collectionErrors = evidence?.collectionErrors || [];
  if (collectionErrors.length) {
    return { classification: "continue-manual", reason: `host evidence collection reported error(s) (${collectionErrors.slice(0, 3).join("; ")}); operator judgement required` };
  }
  const hasCommittedWork = (evidence?.recentCommits || []).length > 0;
  const dirtyState = evidence?.dirtyState || "unknown";
  if (!hasCommittedWork && dirtyState === "clean") {
    return { classification: "discard", reason: "the branch has no committed work and a clean worktree; nothing durable to adopt" };
  }
  return null;
}
function deterministicAssessment(classification, evidence, reason) {
  return {
    classification,
    branchName: evidence.branchName || "",
    worktreePath: evidence.worktreePath || "",
    baseCommit: evidence.baseCommit || "",
    currentCommit: evidence.currentCommit || "",
    dirtyState: evidence.dirtyState || "unknown",
    changedFiles: evidence.changedFiles || [],
    taskScoped: false,
    execPlan: "",
    roadmap: "",
    validation: "",
    missingEvidence: [],
    risks: [],
    rationale: reason,
    recommendation: reason,
    nextActions: [],
    classifier: "deterministic",
    hostEvidence: evidence
  };
}
function isDeferredReviewIssue(issue) {
  const text = String(issue || "").toLowerCase();
  const deferredReviewMarkers = [
    "rate limit",
    "rate_limit",
    "rate-limit",
    "ratelimit",
    "429",
    "retry after",
    "waittime",
    "wait time",
    "deferred review",
    "deferred coderabbit review",
    "coderabbit review deferred",
    "unavailable"
  ];
  return text.includes("coderabbit") && deferredReviewMarkers.some((marker) => text.includes(marker));
}
function hasOnlyDeferredReviewIssues(openIssues) {
  const issues = openIssues || [];
  return issues.length > 0 && issues.every(isDeferredReviewIssue);
}
function implementationAuthFailureDetail(impl) {
  const detail = [impl?.summary, ...impl?.openIssues || []].filter(Boolean).join("\n");
  return authFailureDetail(detail);
}
function addendumImplementationNeedsManualMerge(impl) {
  if (!impl || impl.ok || !impl.gatesGreen) return false;
  const openIssues = impl.openIssues || [];
  if (openIssues.length > 0 && !hasOnlyDeferredReviewIssues(openIssues)) return false;
  const completed = Number(impl.workItemsCompleted);
  const total = Number(impl.workItemsTotal);
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total;
}
function makeAssessment({ preamble: preamble2, assessPartialBranches, assessmentAgentOptions: assessmentAgentOptions2, assessmentEscalationModel, withInfraRetry: withInfraRetry2 }) {
  function assessmentPromptLines(taskHeader, worktreePath, evidence, contextTitle, contextValue) {
    return [
      preamble2(worktreePath),
      taskHeader,
      "",
      "This is a READ-ONLY recovery assessment. Do not edit files, commit, stash, merge, cherry-pick, push, delete worktrees, mark roadmap checkboxes, or run any command that mutates repository state. Do not resume or rely on the failed agent transcript. Inspect only durable state that exists on disk or in Git.",
      "",
      "Use ADR 002 (`docs/adr-002-assess-partial-task-branches.md`) as the classification contract. Return exactly one classification:",
      "- `adopt-complete`: the branch satisfies the roadmap task success criterion, has an up-to-date ExecPlan, required gates are green, and can proceed through the ordinary review and integration path.",
      "- `adopt-partial`: the branch contains a coherent useful slice, but the roadmap task must remain unchecked and the work should be preserved only through Git state.",
      "- `continue-manual`: the branch is promising, but scope, roadmap state, validation, or review evidence needs operator judgement before any merge.",
      "- `discard`: the branch is stale, unsafe, incoherent, unrelated, or too incomplete to keep.",
      "",
      "Assess evidence first:",
      "- branch name, worktree path, base commit, and current commit;",
      "- dirty-state summary;",
      "- changed files and whether they are scoped to the task;",
      "- ExecPlan status, progress notes, decision log, and retrospective state;",
      "- roadmap checkbox state for the task;",
      "- available validation evidence;",
      "- missing validation or review evidence;",
      "- safety risks and recommended operator next actions.",
      "",
      "Evidence freshness rules:",
      "- Judge the branch at the CURRENT commit recorded in the host-collected evidence below. ExecPlan prose, earlier assessments, and logs that predate later commits are historical context, not the current validation state.",
      "- When the failure context includes `reviewRounds`, those review verdicts and structured fix-round reports were produced by this workflow AFTER any earlier snapshot: treat the latest fix round's gate and CodeRabbit report, together with the host-collected git evidence, as the branch's current validation state. Do not list evidence as missing when the latest fix round reports the named gates green at the current tip \u2014 cite that report instead.",
      "- Gate logs under /tmp are not durable; their absence is not, by itself, missing evidence when a structured fix-round or implementation report records the gates that ran and their outcomes.",
      "",
      "Host-collected git evidence:",
      "```json",
      JSON.stringify(evidence, null, 2),
      "```",
      "",
      contextTitle,
      "```json",
      JSON.stringify(contextValue, null, 2),
      "```",
      "",
      "Return only the schema-bound assessment object. Free-text recommendations do not drive integration; make the enum classification and evidence fields precise."
    ].join("\n");
  }
  function assessmentPrompt2(task, wt, result, evidence) {
    return assessmentPromptLines(
      `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") after a workflow failure.`,
      wt.worktreePath,
      evidence,
      "Original workflow failure result:",
      result
    );
  }
  function recoveryAssessmentPrompt2(task, candidate, evidence) {
    return assessmentPromptLines(
      `TASK: Assess the surviving task branch for roadmap task ${task.id} ("${task.title}") discovered during fresh-run recovery.`,
      candidate.worktreePath,
      evidence,
      "Recovery discovery context (fresh launch; the failed run's transcript and result are unavailable by design):",
      candidate
    );
  }
  function assessmentModelTier(evidence) {
    const hasExecplan = (evidence.changedFiles || []).some((entry) => /^docs\/execplans\/.+\.md$/.test(String(entry)));
    return hasExecplan ? "escalated" : "medium";
  }
  async function runModelAssessment(buildPrompt, phaseName, label, evidence) {
    const tier = assessmentModelTier(evidence);
    const options = { phase: phaseName, label, schema: ASSESSMENT_SCHEMA };
    if (tier === "escalated") options.model = assessmentEscalationModel;
    const assessment = await withInfraRetry2(() => agent(buildPrompt(), assessmentAgentOptions2(options)), label);
    if (!assessment) return null;
    return { ...assessment, assessmentTier: tier };
  }
  async function assessRecoveryCandidate2(candidate) {
    const task = { id: candidate.taskId, title: candidate.taskTitle };
    const wt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit };
    phase("Recovery");
    const evidence = await collectAssessmentEvidence(task, wt);
    const fast = fastAssessmentClassification(evidence);
    if (fast) {
      return { evidence, assessment: deterministicAssessment(fast.classification, evidence, fast.reason), assessmentError: "" };
    }
    try {
      const label = `recover-assess:${candidate.taskId}${candidate.isAddendum ? "-addendum" : ""}`;
      const assessment = await runModelAssessment(() => recoveryAssessmentPrompt2(task, candidate, evidence), "Recovery", label, evidence);
      if (!assessment) {
        return { evidence, assessment: null, assessmentError: "assessment agent returned no structured output" };
      }
      return { evidence, assessment: { ...assessment, hostEvidence: evidence }, assessmentError: "" };
    } catch (error) {
      return { evidence, assessment: null, assessmentError: error && error.message || String(error) };
    }
  }
  function shouldAssessFailure2(result, wt) {
    if (!assessPartialBranches) return false;
    if (!wt?.branch || !wt?.worktreePath) return false;
    if (!result || !["failed", "halted"].includes(result.status || "")) return false;
    if (result.stage === "worktree" || result.stage === "worktree-write" || result.stage === "auth" || result.stage === "provider" || result.stage === "infrastructure" || result.status === "fatal-auth" || result.status === "provider-fault" || result.status === "infra-fault") return false;
    const detail = [result.detail, ...result.openIssues || []].filter(Boolean).join("\n");
    return !authFailureDetail(detail) && !providerFailureDetail(detail) && !infrastructureFailureDetail(detail);
  }
  async function attachAssessment2(task, wt, result) {
    if (!shouldAssessFailure2(result, wt)) return result;
    phase("Assess");
    const evidence = await collectAssessmentEvidence(task, wt);
    const fast = fastAssessmentClassification(evidence);
    if (fast) {
      return { ...result, assessment: deterministicAssessment(fast.classification, evidence, fast.reason) };
    }
    try {
      const assessment = await runModelAssessment(() => assessmentPrompt2(task, wt, result, evidence), "Assess", `assess:${task.id}`, evidence);
      if (!assessment) {
        return { ...result, assessmentError: "assessment agent returned no structured output", assessmentEvidence: evidence };
      }
      return { ...result, assessment: { ...assessment, hostEvidence: evidence } };
    } catch (error) {
      return {
        ...result,
        assessmentError: error && error.message || String(error),
        assessmentEvidence: evidence
      };
    }
  }
  return { assessmentPrompt: assessmentPrompt2, recoveryAssessmentPrompt: recoveryAssessmentPrompt2, assessRecoveryCandidate: assessRecoveryCandidate2, shouldAssessFailure: shouldAssessFailure2, attachAssessment: attachAssessment2 };
}

// src/workflows/df12-build-odw/remediation.ts
var TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          proposal: { type: "string", description: "short title of the proposal triaged" },
          lane: { type: "string", enum: ["addendum", "step-task", "reroute", "editorial", "dropped"] },
          newId: { type: "string", description: 'roadmap id created \u2014 a sub-task id like "1.2.8.5" for addendum, a task id for step-task/reroute, empty if dropped' },
          target: { type: "string", description: "addendum: parent task id + execplan folded onto; step-task/reroute: the step filed under; dropped: why" },
          reason: { type: "string", description: "GIST rationale \u2014 which step hypothesis it serves, or why it does not serve the settling step" }
        },
        required: ["proposal", "lane", "reason"]
      }
    },
    newSteps: { type: "array", items: { type: "string" }, description: 'any new step headings created to home reroutes, e.g. "7.4 Harden \u2026"' },
    pushed: { type: "boolean" },
    commitSha: { type: "string" },
    summary: { type: "string" }
  },
  required: ["ok", "decisions", "summary"]
};
var stepOf = (id) => String(id).split(".").slice(0, 2).join(".");
function dedupeProposals(proposals) {
  const byKey = /* @__PURE__ */ new Map();
  for (const proposal of proposals || []) {
    const key = String(proposal?.title || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) continue;
    const source = String(proposal?.source || proposal?.rationale || "");
    const existing = byKey.get(key);
    if (existing) {
      if (source && !(existing.sources || []).includes(source)) existing.sources = [...existing.sources || [], source];
      continue;
    }
    byKey.set(key, { ...proposal, sources: source ? [source] : [] });
  }
  return [...byKey.values()];
}
function triageNeedsEscalation(deduped) {
  const sources = /* @__PURE__ */ new Set();
  for (const proposal of deduped) {
    for (const source of proposal.sources || []) sources.add(source);
    if (!(proposal.sources || []).length) {
      const fallback = String(proposal.source || proposal.rationale || "");
      if (fallback) sources.add(fallback);
    }
  }
  return sources.size > 1;
}
function makeRemediation({ preamble: preamble2, base, roadmap, triageAgentOptions: triageAgentOptions2, triageEscalationModel }) {
  function triagePrompt2(stepPrefix, proposals) {
    return [
      preamble2(null),
      `TASK: GIST-triage the remediation proposals accrued during step ${stepPrefix} (now settled) and file each onto the correct roadmap lane. They came from the reviews and audits of step ${stepPrefix}'s tasks. RECORD them correctly; do NOT implement them.`,
      "",
      `Create a fresh git-donkey worktree off origin/${base} (no edits in the root worktree); do all work there. Read ${roadmap} in full first. It is a GIST roadmap: each PHASE states an "Idea:", each STEP states a hypothesis it confirms or falsifies ("This step answers whether\u2026"), and each TASK has Success criteria. Route by hypothesis. Re-read step ${stepPrefix}'s hypothesis specifically.`,
      "",
      "For EACH proposal below: first DE-DUPLICATE (merge near-identical items; DROP any already covered by an existing task or sub-task), then choose exactly ONE lane:",
      "",
      '  \u2022 ADDENDUM \u2014 a small, surgical correction to a SPECIFIC already-completed task (a doc fix, a localised bugfix, a small test/fixture refactor; about one focused commit, no design needed). File it as BOTH (a) a new item under a "## Addenda" section of that task\'s execplan in docs/execplans/ (create the section if absent), and (b) a nested unchecked sub-task on the roadmap directly under that [x] parent, numbered `<parent-id>.<next-n>` (e.g. `- [ ] 1.2.8.5.`) with one child bullet `- Addendum (from <source>; <sev>). <one-line scope>. Lightweight addendum pass.` and NO Requires line. The harness runs these as a no-plan, no-review lightweight pass.',
      "",
      `  \u2022 STEP-TASK \u2014 substantial work (warrants its own plan and review) that genuinely advances the settling step's hypothesis (${stepPrefix}). Append a full task in step ${stepPrefix}: \`- [ ] ${stepPrefix}.<next-n>. <title>\` with a description bullet, an appropriate \`- Requires \u2026\` line, and a \`- Success:\` criterion. Use this lane ONLY if you can name the ${stepPrefix} hypothesis it serves.`,
      "",
      '  \u2022 REROUTE \u2014 substantial work that does NOT serve the settling step\'s hypothesis (hardening, cross-cutting quality, or a different concern). File it as a full task under the EXISTING step whose hypothesis it genuinely serves, with a `- Requires \u2026` line so it is sequenced correctly and blocks nothing earlier. If NO existing step fits, CREATE a new step under the most appropriate phase (prefer the hardening or "deferred extensions" phase, typically the last phase): add a `### <phase>.<n>. <title>` heading with a one-paragraph hypothesis ("This step answers whether\u2026") followed by the task(s). Record any new step in newSteps.',
      "",
      '  \u2022 EDITORIAL \u2014 the proposal is a correction to the roadmap text itself (a task description, success criterion, or wording \u2014 not code or other docs). APPLY it directly to the roadmap NOW, in this step (you are already editing the roadmap here), and do NOT file it as an addendum or task: the addendum/step-task/reroute lanes run later as sub-agents that are FORBIDDEN to edit the roadmap, so such an item is un-runnable and would halt the loop. Record lane "editorial" and note the corrected wording in reason.',
      "  \u2022 DROPPED \u2014 duplicate, already done, or not actionable. Record why in reason.",
      "",
      "Rules:",
      "  - Route by HYPOTHESIS, not by where the proposal was raised. A proposal raised during step " + stepPrefix + " that does not advance " + stepPrefix + "'s hypothesis MUST be rerouted, never parked in " + stepPrefix + ".",
      "  - Prefer ADDENDUM for anything small and tied to one completed task \u2014 it is the cheap lane and skips the full plan/review cycle.",
      "  - Only append; keep the format and numbering of OTHER tasks intact. en-GB Oxford spelling throughout.",
      `  - When done, run \`make markdownlint\` and \`make nixie\`; fix any issues. Commit the roadmap and any execplan changes (en-GB imperative subject) and push it straight to the integration branch with \`git push origin HEAD:${base}\` (docs-only; re-fetch and rebase on a non-fast-forward reject, then retry). NEVER \`git switch ${base}\` or touch the control/root worktree.`,
      "",
      'Proposals to triage (JSON \u2014 each has title, rationale, optional severity, and a source tag like "audit:1.2.8" or "review:1.3.2"):',
      "```json",
      JSON.stringify(proposals, null, 2),
      "```",
      "",
      "Return one decision per proposal (proposal, lane, newId, target, reason), any newSteps created, whether you pushed, the commit sha, and a short summary."
    ].join("\n");
  }
  async function runTriage2(stepPrefix, proposals) {
    phase("Remediation");
    const deduped = dedupeProposals(proposals);
    if (!deduped.length) return { ok: true, decisions: [], summary: "no proposals to triage after de-duplication" };
    const options = { phase: "Remediation", label: `triage:${stepPrefix}`, schema: TRIAGE_SCHEMA };
    if (triageNeedsEscalation(deduped)) options.model = triageEscalationModel;
    return await agent(triagePrompt2(stepPrefix, deduped), triageAgentOptions2(options));
  }
  return { triagePrompt: triagePrompt2, runTriage: runTriage2, dedupeProposals, triageNeedsEscalation };
}

// src/workflows/df12-build-odw/host-review.ts
function parseCoderabbitAgentOutput(stdout) {
  const events = [];
  const rawLines = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object") {
        events.push(event);
        continue;
      }
    } catch {
    }
    rawLines.push(trimmed);
  }
  return {
    events,
    rawLines,
    findings: events.filter((event) => event.type === "finding"),
    complete: events.find((event) => event.type === "complete") || null,
    error: events.find((event) => event.type === "error") || null
  };
}
var CODERABBIT_BLOCKING_SEVERITIES = /* @__PURE__ */ new Set(["critical", "major"]);
var CODERABBIT_SUCCESS_STATUSES = /* @__PURE__ */ new Set(["review_completed", "reviewed"]);
function classifyCoderabbitOutcome(execResult, parsed) {
  const errorText = [parsed.error?.message || "", execResult.stderr || "", execResult.message || ""].join("\n");
  if (parsed.error?.errorType === "rate_limit" || /\brate.?limit|review limit reached/i.test(errorText)) return "rate-limited";
  if (authFailureDetail(errorText)) return "auth";
  if (parsed.error || !execResult.ok && !parsed.complete) return "error";
  if (parsed.findings.length) return "findings";
  if (parsed.complete) return CODERABBIT_SUCCESS_STATUSES.has(String(parsed.complete.status)) ? "clean" : "error";
  return "error";
}
async function hostSleepMinutes(minutes) {
  await new Promise((resolve) => setTimeout(resolve, minutes * 6e4));
}
function coderabbitBlockingItems(findings) {
  return (findings || []).filter((finding) => CODERABBIT_BLOCKING_SEVERITIES.has(String(finding.severity || "").toLowerCase())).map((finding) => `CodeRabbit (${finding.severity}) ${finding.fileName || "unknown file"}: ${String(finding.comment || finding.codegenInstructions || "see the recorded suggestions").slice(0, 500)}`);
}
var coderabbitCapture = { reviews: 0, findings: 0, rateLimitedRuns: 0, deferred: 0, bySeverity: {}, sinkError: "" };
var hostGateMetrics = { runs: 0, failures: 0 };
var csCheckMetrics = { runs: 0, failures: 0, skipped: 0 };
var gateLogDirCache = null;
function gateLogRoot() {
  if (!gateLogDirCache) {
    const fs = process.getBuiltinModule("node:fs");
    const os = process.getBuiltinModule("node:os");
    const path = process.getBuiltinModule("node:path");
    gateLogDirCache = fs.mkdtempSync(path.join(os.tmpdir(), "df12-gates-"));
  }
  return gateLogDirCache;
}
function hostGateLogPath(tag, roundLabel, index) {
  const slug = (value) => String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const path = process.getBuiltinModule("node:path");
  return path.join(gateLogRoot(), `gate-${slug(tag)}-${slug(roundLabel)}-${index + 1}.out`);
}
function makeHostReview(config) {
  const {
    base,
    coderabbitAttempts,
    coderabbitBackoffMinutes: backoffRange,
    coderabbitFindingsFile,
    commitGates,
    commitGateTimeoutSeconds,
    csCheck,
    csCheckCommand
  } = config;
  function coderabbitBackoffMinutes2(seed) {
    let hash = 5381;
    for (const ch of String(seed)) hash = (hash * 33 ^ ch.codePointAt(0)) >>> 0;
    const [low, high] = backoffRange;
    return low + hash % (high - low + 1);
  }
  async function runCoderabbitHostReview2(worktree, label, deps = {}) {
    const exec = deps.exec || execFileStatus;
    const sleep = deps.sleep || hostSleepMinutes;
    const commandArgs = ["review", "--agent", "--type", "committed", "--base", base];
    for (let attempt = 1; ; attempt++) {
      log(`[${label}] CodeRabbit host review attempt ${attempt} of ${coderabbitAttempts}`);
      const result = await exec("coderabbit", commandArgs, { cwd: worktree });
      const parsed = parseCoderabbitAgentOutput(result.stdout);
      const outcome = classifyCoderabbitOutcome(result, parsed);
      if (outcome === "rate-limited" && attempt < coderabbitAttempts) {
        const minutes = coderabbitBackoffMinutes2(`${label}#${attempt}`);
        log(`[${label}] CodeRabbit rate limited; host backs off ${minutes} minutes before attempt ${attempt + 1} of ${coderabbitAttempts} (wall-clock only, no agent tokens)`);
        await sleep(minutes);
        continue;
      }
      const detail = outcome === "clean" || outcome === "findings" ? "" : (parsed.error?.message || result.message || result.stderr || parsed.rawLines.join("; ") || "coderabbit produced no parsable outcome").trim();
      return { outcome, attempts: attempt, findings: parsed.findings, detail };
    }
  }
  async function recordCoderabbitReview2(label, review) {
    coderabbitCapture.reviews += 1;
    if (review.outcome === "rate-limited") coderabbitCapture.rateLimitedRuns += 1;
    for (const finding of review.findings) {
      coderabbitCapture.findings += 1;
      const severity = String(finding.severity || "unknown").toLowerCase();
      coderabbitCapture.bySeverity[severity] = (coderabbitCapture.bySeverity[severity] || 0) + 1;
    }
    if (!coderabbitFindingsFile || !review.findings.length) return;
    const stamp = await execFileStatus("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"]);
    const ts = stamp.ok ? stamp.stdout.trim() : "";
    const lines = review.findings.map((finding) => JSON.stringify({
      ts,
      label,
      severity: String(finding.severity || ""),
      file: String(finding.fileName || ""),
      comment: String(finding.comment || "").slice(0, 2e3),
      codegenInstructions: String(finding.codegenInstructions || "").slice(0, 2e3),
      suggestions: Array.isArray(finding.suggestions) ? finding.suggestions.length : 0
    }));
    try {
      const fs = process.getBuiltinModule("node:fs/promises");
      await fs.appendFile(coderabbitFindingsFile, `${lines.join("\n")}
`, "utf8");
    } catch (error) {
      coderabbitCapture.sinkError = error && error.message || String(error);
      log(`[${label}] could not append CodeRabbit findings to ${coderabbitFindingsFile}: ${coderabbitCapture.sinkError}`);
    }
  }
  async function runHostCommitGates2(worktree, tag, roundLabel) {
    const results2 = [];
    for (const [index, command] of commitGates.entries()) {
      hostGateMetrics.runs += 1;
      log(`[task ${tag}] host gate ${index + 1}/${commitGates.length} (${roundLabel}): ${command}`);
      const logFile = hostGateLogPath(tag, roundLabel, index);
      const outcome = await streamGate(command, worktree, logFile);
      if (!outcome.ok) {
        hostGateMetrics.failures += 1;
        const timedOut = outcome.killed ? ` (killed after the ${commitGateTimeoutSeconds}s gate timeout)` : "";
        results2.push({ command, ok: false, logFile });
        return {
          green: false,
          results: results2,
          detail: `host gate \`${command}\` failed${timedOut}; full log: ${logFile}; output tail:
${outcome.tail}`
        };
      }
      results2.push({ command, ok: true, logFile });
    }
    return { green: true, results: results2, detail: "" };
  }
  function streamGate(command, cwd, logFile) {
    const TAIL_LINES = 12;
    const { spawn } = process.getBuiltinModule("node:child_process");
    const fs = process.getBuiltinModule("node:fs");
    return new Promise((resolve) => {
      const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
      const openFlags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
      const stream = fs.createWriteStream(logFile, { flags: openFlags, mode: 384 });
      const tail = [];
      let carry = "";
      let killed = false;
      let settled = false;
      const record = (chunk) => {
        if (!stream.write(chunk) && !killed) {
          child.stdout?.pause();
          child.stderr?.pause();
        }
        carry += chunk.toString("utf8");
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() || "";
        for (const line of lines) {
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      const finish = (ok, extraTail) => {
        if (settled) return;
        settled = true;
        if (carry) {
          tail.push(carry);
          if (tail.length > TAIL_LINES) tail.shift();
        }
        if (extraTail) tail.push(extraTail);
        stream.end(() => resolve({ ok, killed, tail: tail.slice(-TAIL_LINES).join("\n").trim() }));
      };
      stream.on("error", (error) => finish(false, `gate log write failed: ${error.message}`));
      const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      stream.on("drain", () => {
        child.stdout?.resume();
        child.stderr?.resume();
      });
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      const sigterm = setTimeout(() => {
        killed = true;
        child.stdout?.resume();
        child.stderr?.resume();
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2e3).unref();
      }, commitGateTimeoutSeconds * 1e3);
      child.on("close", (code) => {
        clearTimeout(sigterm);
        finish(code === 0 && !killed);
      });
      child.on("error", (error) => {
        clearTimeout(sigterm);
        finish(false, `spawn failed: ${error.message}`);
      });
    });
  }
  async function runCodeSceneCheck2(worktree, tag, label) {
    if (!csCheck) return { clean: true, skipped: true, detail: "", logFile: "" };
    const bin = csCheckCommand.trim().split(/\s+/)[0] || "cs-check-changed";
    const probe = await execFileStatus("sh", ["-c", 'command -v "$1"', "sh", bin], { cwd: worktree });
    if (!probe.ok) {
      csCheckMetrics.skipped += 1;
      log(`[task ${tag}] CodeScene check (${label}) skipped: ${bin} not on PATH`);
      return { clean: true, skipped: true, detail: `${bin} not on PATH`, logFile: "" };
    }
    csCheckMetrics.runs += 1;
    const logFile = hostGateLogPath(tag, `cs-${label}`, 0);
    log(`[task ${tag}] CodeScene check (${label}): ${csCheckCommand}`);
    const outcome = await streamGate(csCheckCommand, worktree, logFile);
    if (outcome.ok) return { clean: true, skipped: false, detail: "", logFile };
    csCheckMetrics.failures += 1;
    const timedOut = outcome.killed ? ` (killed after the ${commitGateTimeoutSeconds}s timeout)` : "";
    return { clean: false, skipped: false, detail: `CodeScene check \`${csCheckCommand}\` reported code-health issues${timedOut}; full log: ${logFile}; output tail:
${outcome.tail}`, logFile };
  }
  return { coderabbitBackoffMinutes: coderabbitBackoffMinutes2, runCoderabbitHostReview: runCoderabbitHostReview2, recordCoderabbitReview: recordCoderabbitReview2, runHostCommitGates: runHostCommitGates2, runCodeSceneCheck: runCodeSceneCheck2 };
}

// src/workflows/df12-build-odw/execplan-durability.ts
function execplanRelPath(worktree, planPath) {
  const path = process.getBuiltinModule("node:path");
  const raw = String(planPath || "");
  const rel = path.isAbsolute(raw) ? path.relative(worktree, raw) : path.normalize(raw);
  if (!raw || !rel || rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, relPath: "", detail: `ExecPlan path escapes the assigned worktree: ${raw || "<empty>"}` };
  }
  return { ok: true, relPath: rel, detail: "" };
}
async function verifyExecplanCommitted(worktree, planPath) {
  const contained = execplanRelPath(worktree, planPath);
  if (!contained.ok) return { ok: false, detail: contained.detail };
  const relPath = contained.relPath;
  const inHead = await execFileStatus("git", ["-C", worktree, "cat-file", "-e", `HEAD:${relPath}`]);
  if (!inHead.ok) return { ok: false, detail: `the plan file ${relPath} is not committed at HEAD` };
  const status = await execFileStatus("git", ["-C", worktree, "status", "--porcelain=v1", "--", relPath]);
  if (!status.ok) {
    return { ok: false, detail: `git status failed for ${relPath}: ${(status.message || status.stderr || "").trim()}` };
  }
  if (String(status.stdout).trim()) return { ok: false, detail: `the plan file ${relPath} has uncommitted modifications` };
  return { ok: true, detail: "" };
}
async function commitExecplanApproval(worktree, planPath, tag) {
  const fs = process.getBuiltinModule("node:fs/promises");
  const path = process.getBuiltinModule("node:path");
  const contained = execplanRelPath(worktree, planPath);
  if (!contained.ok) return { ok: false, detail: contained.detail };
  const relPath = contained.relPath;
  const absPath = path.join(worktree, relPath);
  try {
    const { constants } = process.getBuiltinModule("node:fs");
    let text;
    const readHandle = await fs.open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      text = await readHandle.readFile({ encoding: "utf8" });
    } finally {
      await readHandle.close();
    }
    if (parseExecplanState(text).status !== "approved") {
      const updated = /^Status:.*$/m.test(text) ? text.replace(/^Status:.*$/m, "Status: APPROVED") : `${text.trimEnd()}

Status: APPROVED
`;
      const writeHandle = await fs.open(absPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try {
        await writeHandle.writeFile(updated, { encoding: "utf8" });
      } finally {
        await writeHandle.close();
      }
    }
  } catch (error) {
    return { ok: false, detail: `could not update the plan status: ${error && error.message || String(error)}` };
  }
  const status = await execFileStatus("git", ["-C", worktree, "status", "--porcelain=v1", "--", relPath]);
  if (!status.ok) {
    return { ok: false, detail: `git status failed for ${relPath}: ${(status.message || status.stderr || "").trim()}` };
  }
  if (!String(status.stdout).trim()) return { ok: true, detail: "already committed as APPROVED" };
  const add = await execFileStatus("git", ["-C", worktree, "add", "--", relPath]);
  if (!add.ok) return { ok: false, detail: `git add failed: ${(add.message || add.stderr || "").trim()}` };
  const commit = await execFileStatus("git", [
    "-C",
    worktree,
    "-c",
    "user.name=df12-build",
    "-c",
    "user.email=df12-build@workflow.invalid",
    "commit",
    "-m",
    `Approve ExecPlan for task ${tag}`,
    "--",
    relPath
  ]);
  if (!commit.ok) return { ok: false, detail: `git commit failed: ${(commit.message || commit.stderr || "").trim()}` };
  return { ok: true, detail: "" };
}
async function commitExecplanDraft(worktree, relPath, tag) {
  const status = await execFileStatus("git", ["-C", worktree, "status", "--porcelain=v1"]);
  if (!status.ok) return { ok: false, detail: `git status failed: ${(status.message || status.stderr || "").trim()}` };
  const lines = String(status.stdout).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { ok: false, detail: "nothing to commit: the worktree is already clean" };
  const foreign = lines.filter((line) => line.slice(3).replace(/^"(.*)"$/, "$1") !== relPath);
  if (foreign.length) {
    const sample = foreign.slice(0, 8).map((line) => line.trim()).join("; ");
    return { ok: false, detail: `the worktree holds ${foreign.length} uncommitted path(s) beyond the plan file (${sample}${foreign.length > 8 ? "; \u2026" : ""})` };
  }
  const add = await execFileStatus("git", ["-C", worktree, "add", "--", relPath]);
  if (!add.ok) return { ok: false, detail: `git add failed: ${(add.message || add.stderr || "").trim()}` };
  const commit = await execFileStatus("git", [
    "-C",
    worktree,
    "-c",
    "user.name=df12-build",
    "-c",
    "user.email=df12-build@workflow.invalid",
    "commit",
    "-m",
    `Draft ExecPlan for task ${tag}`,
    "--",
    relPath
  ]);
  if (!commit.ok) return { ok: false, detail: `git commit failed: ${(commit.message || commit.stderr || "").trim()}` };
  return { ok: true, detail: "" };
}
async function verifyWorktreeCommitted(worktree) {
  const status = await execFileStatus("git", ["-C", worktree, "status", "--porcelain=v1"]);
  if (!status.ok) {
    return { ok: false, detail: `git status failed: ${(status.message || status.stderr || "").trim()}` };
  }
  const lines = String(status.stdout).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { ok: true, detail: "" };
  const sample = lines.slice(0, 8).map((line) => line.trim()).join("; ");
  return { ok: false, detail: `${lines.length} uncommitted path(s): ${sample}${lines.length > 8 ? "; \u2026" : ""}` };
}

// src/workflows/df12-build-odw/run-task.ts
function summarizeReviewVerdict(review) {
  if (!review) return null;
  return {
    verdict: review.verdict || "",
    blocking: review.blocking || [],
    summary: review.summary || ""
  };
}
function summarizeFixReport(fix) {
  if (!fix) return null;
  if (typeof fix === "string") return { summary: fix };
  return {
    commits: fix.commits || [],
    gatesGreen: fix.gatesGreen === true,
    coderabbitRuns: Number(fix.coderabbitRuns) || 0,
    resolved: fix.resolved || [],
    openIssues: fix.openIssues || [],
    summary: fix.summary || ""
  };
}
function makeTaskPipeline(deps) {
  const {
    MAX_DESIGN_ROUNDS: MAX_DESIGN_ROUNDS2,
    MAX_REVIEW_ROUNDS: MAX_REVIEW_ROUNDS2,
    MAX_WORK_ITEM_ROUNDS: MAX_WORK_ITEM_ROUNDS2,
    PER_WORK_ITEM_BUILD: PER_WORK_ITEM_BUILD2,
    HOST_COMMIT_GATES: HOST_COMMIT_GATES2,
    HOST_GATES_BETWEEN_WORK_ITEMS: HOST_GATES_BETWEEN_WORK_ITEMS2,
    CS_CHECK: CS_CHECK2,
    CODERABBIT_HOST_REVIEW: CODERABBIT_HOST_REVIEW2,
    CODERABBIT_BETWEEN_WORK_ITEMS: CODERABBIT_BETWEEN_WORK_ITEMS2,
    DRY_RUN: DRY_RUN2,
    AUTO_MERGE: AUTO_MERGE2,
    BASE: BASE2,
    planPrompt: planPrompt2,
    designReviewPrompt: designReviewPrompt2,
    implementPrompt: implementPrompt2,
    implementWorkItemPrompt: implementWorkItemPrompt2,
    fixPrompt: fixPrompt2,
    codeReviewPrompt: codeReviewPrompt2,
    expertReviewPrompt: expertReviewPrompt2,
    addendumReviewPrompt: addendumReviewPrompt2,
    implementAddendumPrompt: implementAddendumPrompt2,
    integratePrompt: integratePrompt2,
    planAgentOptions: planAgentOptions2,
    reviewAgentOptions: reviewAgentOptions2,
    buildAgentOptions: buildAgentOptions2,
    planningLock: planningLock2,
    buildLock: buildLock2,
    hostGateLock: hostGateLock2,
    withInfraRetry: withInfraRetry2,
    attachAssessment: attachAssessment2,
    ensureTaskAgentWriteAccess: ensureTaskAgentWriteAccess2,
    createWorktree: createWorktree2,
    runHostCommitGates: runHostCommitGates2,
    runCodeSceneCheck: runCodeSceneCheck2,
    runCoderabbitHostReview: runCoderabbitHostReview2,
    recordCoderabbitReview: recordCoderabbitReview2
  } = deps;
  async function runPlanDesignLoop2(task, worktree, opts = {}) {
    const tag = task.id;
    const extra = opts.extra || {};
    let plan = null;
    let designVerdict = null;
    for (let round = 1; round <= MAX_DESIGN_ROUNDS2; round++) {
      phase("Plan");
      plan = await planningLock2(() => withInfraRetry2(() => agent(planPrompt2(task, worktree, designVerdict, round, opts), planAgentOptions2({
        phase: "Plan",
        label: `plan:${tag} r${round}`,
        schema: PLAN_SCHEMA
      })), `plan:${tag} r${round}`));
      if (!plan) return { fail: { id: tag, status: "failed", stage: "plan", detail: "planner returned nothing", worktree, proposals: [], ...extra } };
      const contained = execplanRelPath(worktree, plan.execplanPath);
      if (!contained.ok) {
        return { fail: { id: tag, status: "failed", stage: "plan", detail: `planner returned an unusable ExecPlan path: ${contained.detail}`, plan, worktree, proposals: [], ...extra } };
      }
      const planFile = await fileState(contained.relPath, worktree);
      if (!planFile.ok) {
        return { fail: { id: tag, status: "failed", stage: "plan", detail: `could not verify the ExecPlan path: ${planFile.detail}`, plan, worktree, proposals: [], ...extra } };
      }
      if (!planFile.exists) {
        return {
          fail: {
            id: tag,
            status: "failed",
            stage: "plan",
            detail: `planner returned missing ExecPlan path: ${plan.execplanPath || "<empty>"}`,
            plan,
            worktree,
            proposals: [],
            ...extra
          }
        };
      }
      let durability = await verifyExecplanCommitted(worktree, plan.execplanPath);
      let salvageNote = "";
      if (!durability.ok) {
        const salvage = await commitExecplanDraft(worktree, contained.relPath, tag);
        if (salvage.ok) {
          log(`[task ${tag}] plan round ${round}: ${durability.detail}; host committed the drafted plan`);
          durability = await verifyExecplanCommitted(worktree, plan.execplanPath);
        } else {
          salvageNote = ` (host salvage declined: ${salvage.detail})`;
        }
      }
      if (!durability.ok) {
        log(`[task ${tag}] plan round ${round}: ExecPlan not durable (${durability.detail})${salvageNote}`);
        designVerdict = {
          satisfied: false,
          blocking: [
            `EXECPLAN DURABILITY: ${durability.detail}${salvageNote}. The committed ExecPlan is the durable source of truth \u2014 COMMIT the plan (and every file you changed) on the task branch with an en-GB imperative subject, then return the same plan.`
          ]
        };
        continue;
      }
      phase("Design Review");
      designVerdict = await planningLock2(() => withInfraRetry2(() => agent(designReviewPrompt2(task, worktree, plan, round), reviewAgentOptions2({
        phase: "Design Review",
        label: `design-review:${tag} r${round}`,
        schema: DESIGN_VERDICT_SCHEMA
      })), `design-review:${tag} r${round}`));
      if (designVerdict?.satisfied) {
        log(`[task ${tag}] design approved in round ${round}`);
        const approved = await commitExecplanApproval(worktree, plan.execplanPath, tag);
        if (!approved.ok) {
          return {
            fail: {
              id: tag,
              status: "failed",
              stage: "design-review",
              detail: `failed to record the committed ExecPlan approval: ${approved.detail}`,
              plan,
              worktree,
              proposals: [],
              ...extra
            }
          };
        }
        return { plan };
      }
      log(`[task ${tag}] design round ${round}: ${(designVerdict?.blocking || []).length} blocking point(s)`);
    }
    return {
      fail: {
        id: tag,
        status: "halted",
        stage: "design-review",
        detail: `design review unsatisfied after ${MAX_DESIGN_ROUNDS2} rounds: ${(designVerdict?.blocking || []).join("; ")}`,
        worktree,
        proposals: [],
        ...extra
      }
    };
  }
  async function dispatchFixAndVerify(task, worktree, plan, blocking, label, round) {
    phase("Implement");
    const report = await buildLock2(() => withInfraRetry2(() => agent(fixPrompt2(task, worktree, plan, blocking, round), buildAgentOptions2({ phase: "Implement", label, schema: FIX_SCHEMA })), label));
    const committed = await verifyWorktreeCommitted(worktree);
    return { report, dirtyDetail: committed.ok ? null : committed.detail };
  }
  async function runBetweenItemGates(task, worktree, plan, itemLabel, extra) {
    const tag = task.id;
    const runGates = HOST_COMMIT_GATES2 && HOST_GATES_BETWEEN_WORK_ITEMS2;
    const runFix = async (blocking, fixLabel, attempt) => {
      const { dirtyDetail } = await dispatchFixAndVerify(task, worktree, plan, blocking, fixLabel, attempt);
      if (dirtyDetail) {
        return { fail: { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the fix for ${itemLabel} left uncommitted state (${dirtyDetail}); every fix must be committed before the checks re-run`, worktree, proposals: [], ...extra } };
      }
      return null;
    };
    for (let attempt = 1; attempt <= MAX_REVIEW_ROUNDS2; attempt++) {
      if (runGates) {
        const gates = await hostGateLock2(() => runHostCommitGates2(worktree, tag, `${itemLabel} a${attempt}`));
        if (!gates.green) {
          log(`[task ${tag}] host commit gates red after ${itemLabel} (attempt ${attempt} of ${MAX_REVIEW_ROUNDS2})`);
          if (attempt === MAX_REVIEW_ROUNDS2) {
            return { fail: { id: tag, status: "failed", stage: "implement", detail: `HOST GATES RED after ${itemLabel}: ${gates.detail} The committed work item's gatesGreen claim could not be reproduced after ${MAX_REVIEW_ROUNDS2} fix attempt(s).`, worktree, proposals: [], ...extra } };
          }
          const durability2 = await runFix([`HOST GATES RED: ${gates.detail} The agent-reported gate status for ${itemLabel} was wrong or is stale \u2014 reproduce the failure from the log, fix it, re-run the gates to green, and commit.`], `fix:${tag} ${itemLabel} gate a${attempt}`, attempt);
          if (durability2) return durability2;
          continue;
        }
      }
      const cs = CS_CHECK2 ? await hostGateLock2(() => runCodeSceneCheck2(worktree, tag, `${itemLabel} a${attempt}`)) : { clean: true, skipped: true, detail: "", logFile: "" };
      if (cs.clean) return { ok: true };
      log(`[task ${tag}] CodeScene check red after ${itemLabel} (attempt ${attempt} of ${MAX_REVIEW_ROUNDS2})`);
      if (attempt === MAX_REVIEW_ROUNDS2) {
        return { fail: { id: tag, status: "failed", stage: "implement", detail: `CODESCENE RED after ${itemLabel}: ${cs.detail} The committed work item's code health could not be cleared after ${MAX_REVIEW_ROUNDS2} fix attempt(s).`, worktree, proposals: [], ...extra } };
      }
      const durability = await runFix([`CODESCENE RED: ${cs.detail} Clear these code-health regressions by refactoring, or \u2014 only where further refinement would be deleterious \u2014 suppress the specific smell with a justified @codescene(disable:"...") comment, then re-run the check to green and commit.`], `fix:${tag} ${itemLabel} cs a${attempt}`, attempt);
      if (durability) return durability;
    }
    return { ok: true };
  }
  async function runBetweenItemReview(task, worktree, plan, itemLabel, extra) {
    const tag = task.id;
    let runs = 0;
    for (let attempt = 1; attempt <= MAX_REVIEW_ROUNDS2; attempt++) {
      const review = await runCoderabbitHostReview2(worktree, `coderabbit:${tag} ${itemLabel} a${attempt}`);
      await recordCoderabbitReview2(`${tag} ${itemLabel} a${attempt}`, review);
      runs += 1;
      if (review.outcome === "auth") {
        return { fail: { id: tag, status: "fatal-auth", stage: "auth", detail: `CodeRabbit host review is not authenticated: ${review.detail}`, worktree, proposals: [], ...extra } };
      }
      if (review.outcome === "rate-limited" || review.outcome === "error") {
        coderabbitCapture.deferred += 1;
        return { fail: { id: tag, status: "halted", stage: "code-review", detail: `CodeRabbit between-item review could not complete for ${itemLabel} (${review.outcome} after ${review.attempts} attempt(s)): ${review.detail}; the work is committed but unreviewed \u2014 resolve the CodeRabbit quota/CLI fault and relaunch with resumeMode: "continue"`, worktree, proposals: [], ...extra } };
      }
      const blocking = coderabbitBlockingItems(review.findings);
      log(`[task ${tag}] between-item CodeRabbit ${itemLabel} attempt ${attempt}: ${review.findings.length} finding(s), ${blocking.length} blocking`);
      if (!blocking.length) return { ok: true, coderabbitRuns: runs };
      if (attempt === MAX_REVIEW_ROUNDS2) {
        return { fail: { id: tag, status: "failed", stage: "code-review", detail: `CodeRabbit between-item review left blocking finding(s) unresolved after ${MAX_REVIEW_ROUNDS2} fix attempt(s) on ${itemLabel}: ${blocking.join("; ")}`, worktree, proposals: [], ...extra } };
      }
      const { dirtyDetail } = await dispatchFixAndVerify(task, worktree, plan, blocking, `fix:${tag} ${itemLabel} a${attempt}`, attempt);
      if (dirtyDetail) {
        return { fail: { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the CodeRabbit fix for ${itemLabel} left uncommitted state (${dirtyDetail}); every fix must be committed before re-review`, worktree, proposals: [], ...extra } };
      }
    }
    return { ok: true, coderabbitRuns: runs };
  }
  async function runWorkItemBuildLoop2(task, worktree, plan, opts = {}) {
    const tag = task.id;
    const extra = opts.extra || {};
    const fail = (detail, openIssues2 = []) => ({ fail: { id: tag, status: "failed", stage: "implement", detail, openIssues: openIssues2, worktree, proposals: [], ...extra } });
    const contained = execplanRelPath(worktree, plan.execplanPath);
    if (!contained.ok) return fail(contained.detail);
    const planRef = { worktreePath: worktree, execplanPath: contained.relPath };
    const initial = await readExecplanState(planRef);
    if (initial.status === "unreadable") return fail(`could not read the committed ExecPlan: ${initial.error}`);
    if (initial.status === "missing") return fail(`the ExecPlan disappeared before the build: ${contained.relPath}`);
    if (!(initial.items || []).length) return null;
    const commits = [];
    const openIssues = [];
    let coderabbitRuns = 0;
    let lastImpl = null;
    let noProgressNote = "";
    let strikes = 0;
    for (let round = 1; round <= MAX_WORK_ITEM_ROUNDS2; round++) {
      const before = await readExecplanState(planRef);
      if (before.status === "unreadable") return fail(`could not read the committed ExecPlan: ${before.error}`, openIssues);
      if (before.status === "missing") return fail(`the committed ExecPlan disappeared mid-build: ${contained.relPath}`, openIssues);
      const item = (before.items || []).find((entry) => !entry.ticked);
      if (!item) break;
      const label = `implement:${tag} wi${round}`;
      const impl = await buildLock2(() => withInfraRetry2(() => agent(implementWorkItemPrompt2(task, worktree, plan, item, { ...opts, noProgressNote }), buildAgentOptions2({
        phase: "Implement",
        label,
        schema: IMPL_SCHEMA
      })), label));
      lastImpl = impl;
      const authDetail = implementationAuthFailureDetail(impl);
      if (authDetail) {
        return { fail: { id: tag, status: "fatal-auth", stage: "auth", detail: authDetail, openIssues: impl?.openIssues || [], worktree, proposals: [], ...extra } };
      }
      if (!impl || !impl.ok || !impl.gatesGreen) {
        return fail(impl?.summary || `work item did not reach a green state: ${item.text}`, impl?.openIssues || []);
      }
      if (Array.isArray(impl.commits)) commits.push(...impl.commits);
      openIssues.push(...impl.openIssues || []);
      coderabbitRuns += Number(impl.coderabbitRuns) || 0;
      const committed = await verifyWorktreeCommitted(worktree);
      if (!committed.ok) {
        return fail(`work item returned ok but left uncommitted state in the worktree (${committed.detail}); every work item must be committed before returning`, openIssues);
      }
      const after = await readExecplanState(planRef);
      if (after.status === "unreadable") return fail(`could not re-read the committed ExecPlan: ${after.error}`, openIssues);
      if (after.status === "missing") return fail(`the committed ExecPlan disappeared mid-build: ${contained.relPath}`, openIssues);
      if (after.unticked >= before.unticked) {
        strikes += 1;
        noProgressNote = `your previous turn returned ok but the committed ExecPlan still shows ${after.unticked} unticked Progress item(s) (it had ${before.unticked} before the turn); tick the work item you completed in ## Progress and commit the plan update together with the work`;
        log(`[task ${tag}] work-item round ${round}: no committed Progress movement (strike ${strikes} of 2)`);
        if (strikes >= 2) {
          return fail(`the work-item build made no committed ExecPlan progress in two consecutive turns; ${after.unticked} Progress item(s) remain unticked`, openIssues);
        }
      } else {
        strikes = 0;
        noProgressNote = "";
        log(`[task ${tag}] work-item round ${round}: ${after.ticked}/${after.ticked + after.unticked} Progress item(s) committed`);
        if (HOST_COMMIT_GATES2 && HOST_GATES_BETWEEN_WORK_ITEMS2 || CS_CHECK2) {
          const gate = await runBetweenItemGates(task, worktree, plan, `wi${round}`, extra);
          if ("fail" in gate) return gate;
        }
        if (CODERABBIT_HOST_REVIEW2 && CODERABBIT_BETWEEN_WORK_ITEMS2) {
          const gate = await runBetweenItemReview(task, worktree, plan, `wi${round}`, extra);
          if ("fail" in gate) return gate;
          coderabbitRuns += gate.coderabbitRuns;
        }
      }
    }
    const final = await readExecplanState(planRef);
    if (final.status === "unreadable") return fail(`could not read the committed ExecPlan after the build: ${final.error}`, openIssues);
    if (final.status === "missing") return fail(`the committed ExecPlan is absent after the build: ${contained.relPath}`, openIssues);
    const remaining = (final.items || []).filter((entry) => !entry.ticked);
    if (remaining.length) {
      return fail(`the work-item round cap (maxWorkItemRounds=${MAX_WORK_ITEM_ROUNDS2}) was reached with ${remaining.length} Progress item(s) still unticked; the first is: ${remaining[0].text}`, openIssues);
    }
    return {
      impl: {
        ok: true,
        gatesGreen: true,
        execplanPath: contained.relPath,
        workItemsCompleted: final.ticked,
        workItemsTotal: final.ticked + final.unticked,
        commits: commits.slice(0, 50),
        coderabbitRuns,
        openIssues: [...new Set(openIssues)].slice(0, 20),
        summary: lastImpl?.summary || "work-item build completed from the committed ExecPlan checklist"
      }
    };
  }
  async function runImplementationStage2(task, worktree, plan, opts = {}) {
    const tag = task.id;
    const extra = opts.extra || {};
    phase("Implement");
    if (PER_WORK_ITEM_BUILD2) {
      const itemised = await runWorkItemBuildLoop2(task, worktree, plan, opts);
      if (itemised) {
        if (itemised.fail) return itemised;
        return finishImplementationStage(task, worktree, plan, itemised.impl, extra);
      }
      log(`[task ${tag}] the committed ExecPlan has no Progress checklist; falling back to the single-turn build`);
    }
    const impl = await buildLock2(() => withInfraRetry2(() => agent(implementPrompt2(task, worktree, plan, opts), buildAgentOptions2({
      phase: "Implement",
      label: `implement:${tag}`,
      schema: IMPL_SCHEMA
    })), `implement:${tag}`));
    const authDetail = implementationAuthFailureDetail(impl);
    if (authDetail) {
      return { fail: { id: tag, status: "fatal-auth", stage: "auth", detail: authDetail, openIssues: impl?.openIssues || [], worktree, proposals: [], ...extra } };
    }
    if (!impl || !impl.ok || !impl.gatesGreen) {
      return {
        fail: {
          id: tag,
          status: "failed",
          stage: "implement",
          detail: impl?.summary || "implementation did not reach a green state",
          openIssues: impl?.openIssues || [],
          worktree,
          proposals: [],
          ...extra
        }
      };
    }
    return finishImplementationStage(task, worktree, plan, impl, extra);
  }
  async function finishImplementationStage(task, worktree, plan, impl, extra) {
    const tag = task.id;
    const committed = await verifyWorktreeCommitted(worktree);
    if (!committed.ok) {
      return {
        fail: {
          id: tag,
          status: "failed",
          stage: "implement",
          detail: `implementation returned ok but left uncommitted state in the worktree (${committed.detail}); every work item must be committed before returning`,
          openIssues: impl?.openIssues || [],
          worktree,
          proposals: [],
          ...extra
        }
      };
    }
    if (plan?.execplanPath) {
      const contained = execplanRelPath(worktree, plan.execplanPath);
      if (!contained.ok) {
        log(`[task ${tag}] skipping the post-implementation plan-status check: ${contained.detail}`);
      } else {
        const planState = await readExecplanState({ worktreePath: worktree, execplanPath: contained.relPath });
        if (planState.status !== "complete") {
          log(`[task ${tag}] implementation returned ok but the committed ExecPlan status is '${planState.status}' (expected COMPLETE)${planState.error ? `: ${planState.error}` : ""}`);
        }
      }
    }
    return { impl };
  }
  async function integrateTask(task, worktree, mergeLock2, proposals, kindExtra) {
    const tag = task.id;
    const doIntegrate = () => {
      phase("Integrate");
      return buildLock2(() => agent(integratePrompt2(task, worktree), buildAgentOptions2({ phase: "Integrate", label: `integrate:${tag}`, schema: INTEGRATE_SCHEMA })));
    };
    try {
      return { integration: mergeLock2 ? await mergeLock2(doIntegrate) : await doIntegrate() };
    } catch (error) {
      const message = error && error.message || String(error);
      if (!infrastructureFailureDetail(message)) throw error;
      faultMetrics.infraFaults += 1;
      return {
        fault: {
          id: tag,
          status: "infra-fault",
          stage: "integrate",
          detail: `integration agent died on an infrastructure fault (${message}); integration is never retried because the push to origin/${BASE2} is not idempotent \u2014 inspect origin/${BASE2} and the roadmap for a partial or hidden-success integration before relaunching with resumeMode: "continue"`,
          worktree,
          proposals,
          ...kindExtra
        }
      };
    }
  }
  async function runDualReviewAndIntegration2(task, worktree, plan, impl, mergeLock2, options = {}) {
    const tag = task.id;
    const kindExtra = options.kind ? { kind: options.kind } : {};
    const proposals = [];
    const reviewRounds = [];
    let reviewsPass = false;
    const coderabbitDeferred = [];
    for (let round = 1; round <= MAX_REVIEW_ROUNDS2; round++) {
      let hostGates = null;
      if (HOST_COMMIT_GATES2) {
        hostGates = await hostGateLock2(() => runHostCommitGates2(worktree, tag, `r${round}`));
        if (!hostGates.green) {
          log(`[task ${tag}] host commit gates red in round ${round}`);
          const gateBlocking = [`HOST GATES RED: ${hostGates.detail} The agent-reported gate status was wrong or is stale \u2014 reproduce the failure from the log, fix it, re-run the gates to green, and commit.`];
          reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: gateBlocking, hostGates: hostGates.results, fix: null });
          if (round === MAX_REVIEW_ROUNDS2) break;
          const gateFix = await dispatchFixAndVerify(task, worktree, plan, gateBlocking, `fix:${tag} r${round}`, round);
          reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(gateFix.report);
          if (gateFix.dirtyDetail) {
            return { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the gate-fix round left uncommitted state (${gateFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra };
          }
          continue;
        }
      }
      if (CS_CHECK2) {
        const cs = await hostGateLock2(() => runCodeSceneCheck2(worktree, tag, `r${round}`));
        if (!cs.clean) {
          log(`[task ${tag}] CodeScene check red in round ${round}`);
          const csBlocking = [`CODESCENE RED: ${cs.detail} Clear these code-health regressions by refactoring, or \u2014 only where further refinement would be deleterious \u2014 suppress the specific smell with a justified @codescene(disable:"...") comment, then re-run the check to green and commit.`];
          reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: csBlocking, ...hostGates ? { hostGates: hostGates.results } : {}, fix: null });
          if (round === MAX_REVIEW_ROUNDS2) break;
          const csFix = await dispatchFixAndVerify(task, worktree, plan, csBlocking, `fix:${tag} cs r${round}`, round);
          reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(csFix.report);
          if (csFix.dirtyDetail) {
            return { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the CodeScene-fix round left uncommitted state (${csFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra };
          }
          continue;
        }
      }
      if (CODERABBIT_HOST_REVIEW2) {
        const coderabbit = await runCoderabbitHostReview2(worktree, `coderabbit:${tag} r${round}`);
        await recordCoderabbitReview2(`${tag} r${round}`, coderabbit);
        if (coderabbit.outcome === "auth") {
          return { id: tag, status: "fatal-auth", stage: "review", detail: `CodeRabbit host review is not authenticated: ${coderabbit.detail}`, reviewRounds, worktree, proposals, ...kindExtra };
        }
        if (coderabbit.outcome === "rate-limited" || coderabbit.outcome === "error") {
          coderabbitCapture.deferred += 1;
          coderabbitDeferred.push(`CodeRabbit review deferred in round ${round} (${coderabbit.outcome} after ${coderabbit.attempts} attempt(s)): ${coderabbit.detail}`);
          log(`[task ${tag}] CodeRabbit host review deferred in round ${round}: ${coderabbit.outcome} (${coderabbit.detail})`);
        } else {
          const coderabbitBlocking = coderabbitBlockingItems(coderabbit.findings);
          log(`[task ${tag}] CodeRabbit host review round ${round}: ${coderabbit.findings.length} finding(s), ${coderabbitBlocking.length} blocking`);
          if (coderabbitBlocking.length) {
            reviewRounds.push({ round, codeReview: null, expertReview: null, blocking: coderabbitBlocking, ...hostGates ? { hostGates: hostGates.results } : {}, fix: null });
            if (round === MAX_REVIEW_ROUNDS2) break;
            const crFix = await dispatchFixAndVerify(task, worktree, plan, coderabbitBlocking, `fix:${tag} r${round}`, round);
            reviewRounds[reviewRounds.length - 1].fix = summarizeFixReport(crFix.report);
            if (crFix.dirtyDetail) {
              return { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the CodeRabbit-fix round left uncommitted state (${crFix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra };
            }
            continue;
          }
        }
      }
      const reviewInfraFaults = [];
      const runReviewAgent = (promptText, reviewPhase, label) => () => withInfraRetry2(() => agent(promptText, reviewAgentOptions2({ phase: reviewPhase, label, schema: REVIEW_SCHEMA })), label).catch((error) => {
        const message = error && error.message || String(error);
        if (!infrastructureFailureDetail(message)) throw error;
        reviewInfraFaults.push(`${label}: ${message}`);
        return null;
      });
      const [codeReview, expertReview] = await parallel([
        runReviewAgent(codeReviewPrompt2(task, worktree, plan), "Code Review", `code-review:${tag} r${round}`),
        runReviewAgent(expertReviewPrompt2(task, worktree, plan), "Expert Review", `expert-review:${tag} r${round}`)
      ]);
      for (const r of [codeReview, expertReview]) {
        if (r?.proposedRoadmapItems?.length) proposals.push(...r.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })));
      }
      if (!codeReview || !expertReview) {
        const missing = [
          !codeReview ? "code review" : null,
          !expertReview ? "expert review" : null
        ].filter(Boolean).join(" and ");
        reviewRounds.push({ round, codeReview: summarizeReviewVerdict(codeReview), expertReview: summarizeReviewVerdict(expertReview), blocking: [], fix: null });
        if (reviewInfraFaults.length) {
          faultMetrics.infraFaults += 1;
          return {
            id: tag,
            status: "infra-fault",
            stage: "review",
            detail: `dual review interrupted by infrastructure fault(s): ${reviewInfraFaults.join("; ")}; the branch is untouched \u2014 relaunch with resumeMode: "continue" to re-run review from the committed state`,
            reviewRounds,
            worktree,
            proposals,
            ...kindExtra
          };
        }
        return {
          id: tag,
          status: "failed",
          stage: "review",
          detail: `dual review failed to return a structured verdict from ${missing}; branch left unmerged for the root agent`,
          reviewRounds,
          worktree,
          proposals,
          ...kindExtra
        };
      }
      const blocking = [
        ...codeReview.blocking || [],
        ...expertReview.blocking || []
      ];
      const roundRecord = { round, codeReview: summarizeReviewVerdict(codeReview), expertReview: summarizeReviewVerdict(expertReview), blocking, ...hostGates ? { hostGates: hostGates.results } : {}, fix: null };
      reviewRounds.push(roundRecord);
      if (blocking.length === 0 && codeReview?.verdict === "pass" && expertReview?.verdict === "pass") {
        reviewsPass = true;
        log(`[task ${tag}] dual review passed in round ${round}`);
        break;
      }
      log(`[task ${tag}] review round ${round}: ${blocking.length} blocking item(s)`);
      if (round === MAX_REVIEW_ROUNDS2) break;
      const fix = await dispatchFixAndVerify(task, worktree, plan, blocking, `fix:${tag} r${round}`, round);
      roundRecord.fix = summarizeFixReport(fix.report);
      if (fix.dirtyDetail) {
        return { id: tag, status: "failed", stage: "implement", detail: `FIX DURABILITY: the review-fix round left uncommitted state (${fix.dirtyDetail}); every fix must be committed before re-review or integration`, reviewRounds, worktree, proposals, ...kindExtra };
      }
    }
    if (!reviewsPass) {
      const lastRound = reviewRounds[reviewRounds.length - 1];
      const finalBlocking = (lastRound?.blocking || []).slice(0, 6).join("; ");
      return {
        id: tag,
        status: "halted",
        stage: "review",
        detail: `reviewers not satisfied within cap; branch left unmerged for the root agent${finalBlocking ? `. Final blocking items: ${finalBlocking}` : ""}`,
        reviewRounds,
        worktree,
        proposals,
        ...kindExtra
      };
    }
    let integration = null;
    if (AUTO_MERGE2) {
      const attempt = await integrateTask(task, worktree, mergeLock2, proposals, kindExtra);
      if (attempt.fault) return attempt.fault;
      integration = attempt.integration ?? null;
      if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
        return { id: tag, status: "halted", stage: "integrate", detail: integration?.conflicts || integration?.summary || "integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)", worktree, proposals, ...kindExtra };
      }
    } else {
      return { id: tag, status: "manual-merge-ready", plan, impl, integration, worktree, proposals, ...coderabbitDeferred.length ? { openIssues: coderabbitDeferred } : {}, ...kindExtra };
    }
    return { id: tag, status: "done", plan, impl, integration, worktree, proposals, ...coderabbitDeferred.length ? { openIssues: coderabbitDeferred } : {}, ...kindExtra };
  }
  async function runTask2(task, mergeLock2) {
    const tag = `${task.id}`;
    log(`[task ${tag}] ${task.title}`);
    phase("Worktree");
    const wt = await createWorktree2(task);
    if (!wt || !wt.ok || !wt.worktreePath) {
      return { id: tag, status: "failed", stage: "worktree", detail: wt?.notes || "worktree creation failed", proposals: [] };
    }
    const worktree = wt.worktreePath;
    log(`[task ${tag}] worktree ${wt.branch} @ ${worktree}`);
    try {
      const writeAccess = await ensureTaskAgentWriteAccess2(worktree, tag);
      if (!writeAccess.ok) {
        return {
          id: tag,
          status: "failed",
          stage: "worktree-write",
          detail: `task-agent writable-root preflight failed (launch/sandbox fault, not a task defect): ${writeAccess.failures.map((failure) => `${failure.adapter}: ${failure.detail}`).join("; ")}`,
          worktree,
          proposals: []
        };
      }
      if (task.isAddendum) {
        if (DRY_RUN2) {
          return {
            id: tag,
            status: "dry-run",
            stage: "addendum",
            detail: "dry run stopped before addendum implementation",
            worktree,
            proposals: [],
            kind: "addendum"
          };
        }
        phase("Implement");
        const impl2 = await buildLock2(() => withInfraRetry2(() => agent(implementAddendumPrompt2(task, worktree), buildAgentOptions2({ phase: "Implement", label: `addendum:${tag}`, schema: IMPL_SCHEMA })), `addendum:${tag}`));
        const authDetail = implementationAuthFailureDetail(impl2);
        if (authDetail) {
          return {
            id: tag,
            status: "fatal-auth",
            stage: "auth",
            detail: authDetail,
            openIssues: impl2?.openIssues || [],
            worktree,
            proposals: [],
            kind: "addendum"
          };
        }
        const openIssues = impl2?.openIssues || [];
        const onlyDeferredReviewIssues = hasOnlyDeferredReviewIssues(openIssues);
        if (addendumImplementationNeedsManualMerge(impl2)) {
          const deferredEvidence = openIssues.length ? ` Outstanding deferred review evidence: ${openIssues.join("; ")}` : "";
          return {
            id: tag,
            status: "manual-merge-ready",
            stage: "addendum",
            detail: `addendum implementation reported completed work and green gates but did not set ok=true${openIssues.length ? " and left only deferred/recoverable review issues open" : " and no open issues"}; branch left for operator verification before integration.${deferredEvidence}`,
            openIssues,
            impl: impl2,
            worktree,
            proposals: [],
            kind: "addendum"
          };
        }
        if (!impl2 || !impl2.ok || !impl2.gatesGreen || openIssues.length > 0 && !onlyDeferredReviewIssues) {
          return await attachAssessment2(task, wt, { id: tag, status: "failed", stage: "addendum", detail: impl2?.summary || "addendum did not reach a green state or left open issues", openIssues: impl2?.openIssues || [], worktree, proposals: [], kind: "addendum" });
        }
        const committed = await verifyWorktreeCommitted(worktree);
        if (!committed.ok) {
          return await attachAssessment2(task, wt, { id: tag, status: "failed", stage: "addendum", detail: `addendum implementation returned ok but left uncommitted state in the worktree (${committed.detail}); every sub-task must be committed before returning`, openIssues, worktree, proposals: [], kind: "addendum" });
        }
        const proposals = [];
        const addendumOpenIssues = [];
        if (HOST_COMMIT_GATES2) {
          const hostGates = await hostGateLock2(() => runHostCommitGates2(worktree, tag, "addendum"));
          if (!hostGates.green) {
            return await attachAssessment2(task, wt, { id: tag, status: "failed", stage: "addendum", detail: `addendum reported green gates but the host could not reproduce them: ${hostGates.detail}`, openIssues, worktree, proposals, kind: "addendum" });
          }
        }
        if (CS_CHECK2) {
          const cs = await hostGateLock2(() => runCodeSceneCheck2(worktree, tag, "addendum"));
          if (!cs.clean) {
            return await attachAssessment2(task, wt, { id: tag, status: "failed", stage: "addendum", detail: `addendum committed work with unresolved CodeScene code-health issues: ${cs.detail}`, openIssues, worktree, proposals, kind: "addendum" });
          }
        }
        if (CODERABBIT_HOST_REVIEW2) {
          phase("Code Review");
          const coderabbit = await runCoderabbitHostReview2(worktree, `coderabbit:${tag} addendum`);
          await recordCoderabbitReview2(`${tag} addendum`, coderabbit);
          if (coderabbit.outcome === "auth") {
            return { id: tag, status: "fatal-auth", stage: "auth", detail: `CodeRabbit host review is not authenticated: ${coderabbit.detail}`, worktree, proposals, kind: "addendum" };
          }
          const blockingFindings = coderabbitBlockingItems(coderabbit.findings);
          if (blockingFindings.length) {
            return await attachAssessment2(task, wt, { id: tag, status: "halted", stage: "addendum-review", detail: `CodeRabbit host review found blocking issue(s): ${blockingFindings.join("; ")}`, impl: impl2, worktree, proposals, kind: "addendum" });
          }
          if (coderabbit.outcome === "rate-limited" || coderabbit.outcome === "error") {
            coderabbitCapture.deferred += 1;
            addendumOpenIssues.push(`CodeRabbit review deferred (${coderabbit.outcome} after ${coderabbit.attempts} attempt(s)): ${coderabbit.detail}`);
            log(`[task ${tag}] CodeRabbit host review deferred for the addendum: ${coderabbit.outcome} (${coderabbit.detail})`);
          }
        }
        let addendumReview = null;
        if (onlyDeferredReviewIssues) {
          phase("Code Review");
          addendumReview = await withInfraRetry2(() => agent(addendumReviewPrompt2(task, worktree, impl2), reviewAgentOptions2({ phase: "Code Review", label: `addendum-review:${tag}`, schema: REVIEW_SCHEMA })), `addendum-review:${tag}`);
          if (addendumReview?.proposedRoadmapItems?.length) {
            proposals.push(...addendumReview.proposedRoadmapItems.map((p) => ({ ...p, source: `review:${tag}` })));
          }
          const blocking = addendumReview?.blocking || [];
          if (!addendumReview || addendumReview.verdict !== "pass" || blocking.length > 0) {
            return await attachAssessment2(task, wt, { id: tag, status: "halted", stage: "addendum-review", detail: blocking.join("; ") || addendumReview?.summary || "addendum fallback review did not pass", impl: impl2, addendumReview, worktree, proposals, kind: "addendum" });
          }
          log(`[task ${tag}] addendum fallback review passed after deferred CodeRabbit review`);
        }
        let integration = null;
        if (AUTO_MERGE2) {
          const attempt = await integrateTask(task, worktree, mergeLock2, proposals, { kind: "addendum" });
          if (attempt.fault) return attempt.fault;
          integration = attempt.integration ?? null;
          if (!integration?.ok || !integration.pushed || !integration.squashMerged || !integration.roadmapMarkedDone) {
            return await attachAssessment2(task, wt, { id: tag, status: "halted", stage: "integrate", detail: integration?.conflicts || integration?.summary || "integration incomplete (need ok+pushed+squashMerged+roadmapMarkedDone)", worktree, proposals, kind: "addendum" });
          }
        } else {
          return { id: tag, status: "manual-merge-ready", impl: impl2, addendumReview, integration, worktree, proposals, ...addendumOpenIssues.length ? { openIssues: addendumOpenIssues } : {}, kind: "addendum" };
        }
        return { id: tag, status: "done", impl: impl2, addendumReview, integration, worktree, proposals, ...addendumOpenIssues.length ? { openIssues: addendumOpenIssues } : {}, kind: "addendum" };
      }
      const planned = await runPlanDesignLoop2(task, worktree);
      if (planned.fail) return await attachAssessment2(task, wt, planned.fail);
      const plan = planned.plan;
      if (DRY_RUN2) {
        return {
          id: tag,
          status: "dry-run",
          stage: "post-design",
          detail: "dry run stopped after planning and design review",
          plan,
          worktree,
          proposals: []
        };
      }
      const built = await runImplementationStage2(task, worktree, plan);
      if (built.fail) {
        return built.fail.status === "fatal-auth" ? built.fail : await attachAssessment2(task, wt, built.fail);
      }
      const impl = built.impl;
      const outcome = await runDualReviewAndIntegration2(task, worktree, plan, impl, mergeLock2);
      if (outcome.status === "failed" || outcome.status === "halted") {
        return await attachAssessment2(task, wt, outcome);
      }
      return outcome;
    } catch (error) {
      const detail = `unhandled agent error: ${error && error.message || String(error)}`;
      const result = resultFromUnhandledAgentError(tag, detail, { worktree });
      return await attachAssessment2(task, wt, result);
    }
  }
  return { runPlanDesignLoop: runPlanDesignLoop2, runWorkItemBuildLoop: runWorkItemBuildLoop2, runImplementationStage: runImplementationStage2, runDualReviewAndIntegration: runDualReviewAndIntegration2, runTask: runTask2 };
}

// src/workflows/df12-build-odw/main.ts
var CONFIG = makeConfig(args);
var {
  PROJECT_ROOT,
  BASE,
  ROADMAP,
  ONLY_TASK,
  MAX_TASKS,
  MAX_PARALLEL,
  MAX_PLANNING_PARALLEL,
  MAX_BUILD_PARALLEL,
  MAX_DESIGN_ROUNDS,
  MAX_REVIEW_ROUNDS,
  STAGE_ATTEMPTS,
  PER_WORK_ITEM_BUILD,
  MAX_WORK_ITEM_ROUNDS,
  AUTO_MERGE,
  DOCUMENT_AUDIT,
  DRY_RUN,
  AUTH_PREFLIGHT,
  REQUIRE_CODERABBIT_AUTH,
  ASSESS_PARTIAL_BRANCHES,
  RESUME_PARTIAL_BRANCHES,
  RESUME_MODE,
  RESUME_TASK_ID,
  RESUME_MAX_CANDIDATES,
  WORKTREE_WRITE_PREFLIGHT,
  WRITE_PROBE_EFFORT,
  WRITE_PROBE_MODEL_BY_ADAPTER,
  BUDGET_RESERVE,
  BUILD_ADAPTER,
  PLAN_ADAPTER,
  REVIEW_ADAPTER,
  TRIAGE_ADAPTER,
  ASSESSMENT_ADAPTER,
  BUILD_MODEL,
  PLAN_MODEL,
  REVIEW_MODEL,
  TRIAGE_MODEL,
  TRIAGE_ESCALATION_MODEL,
  ASSESSMENT_MODEL,
  ASSESSMENT_ESCALATION_MODEL,
  AUTH_REQUIRED_ADAPTERS,
  CODERABBIT_REVIEW_COMMAND,
  CODERABBIT_HOST_REVIEW,
  CODERABBIT_BETWEEN_WORK_ITEMS,
  CODERABBIT_ATTEMPTS,
  CODERABBIT_BACKOFF_MINUTES,
  CODERABBIT_FINDINGS_FILE,
  HOST_COMMIT_GATES,
  HOST_GATES_BETWEEN_WORK_ITEMS,
  CS_CHECK,
  CS_CHECK_COMMAND,
  COMMIT_GATE_TIMEOUT_SECONDS,
  COMMIT_GATES,
  COMMIT_GATE_TEXT,
  COMMIT_GATE_GUIDANCE,
  CS_CHECK_GUIDANCE
} = CONFIG;
if (PROJECT_ROOT !== process.cwd()) {
  const fs = process.getBuiltinModule("node:fs");
  let projectRootStat;
  try {
    projectRootStat = fs.statSync(PROJECT_ROOT);
  } catch (error) {
    throw new Error(`Configured projectRoot is not accessible: ${PROJECT_ROOT} (${error && error.message || String(error)})`);
  }
  if (!projectRootStat.isDirectory()) {
    throw new Error(`Configured projectRoot is not a directory: ${PROJECT_ROOT}`);
  }
  process.chdir(PROJECT_ROOT);
}
function buildAgentOptions(options = {}) {
  return { adapter: BUILD_ADAPTER, model: BUILD_MODEL, ...options };
}
function planAgentOptions(options = {}) {
  return { adapter: PLAN_ADAPTER, model: PLAN_MODEL, ...options };
}
function reviewAgentOptions(options = {}) {
  return { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL, ...options };
}
function triageAgentOptions(options = {}) {
  return { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL, ...options };
}
function assessmentAgentOptions(options = {}) {
  return { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL, ...options };
}
var withInfraRetry = makeWithInfraRetry(STAGE_ATTEMPTS);
var discoverRecoveryCandidates = makeRecoveryDiscovery({
  base: BASE,
  resumeTaskId: RESUME_TASK_ID,
  resumeMaxCandidates: RESUME_MAX_CANDIDATES
});
var {
  preamble,
  codeSearchGuidance,
  planPrompt,
  designReviewPrompt,
  implementPrompt,
  implementWorkItemPrompt,
  fixPrompt,
  codeReviewPrompt,
  expertReviewPrompt,
  addendumReviewPrompt,
  implementAddendumPrompt,
  integratePrompt,
  auditPrompt
} = makePrompts(CONFIG);
var { runTaskAgentWritePreflight, ensureTaskAgentWriteAccess } = makeWritePreflight({
  enabled: WORKTREE_WRITE_PREFLIGHT,
  targets: writeProbeTargets
});
var {
  assessmentPrompt,
  recoveryAssessmentPrompt,
  assessRecoveryCandidate,
  shouldAssessFailure,
  attachAssessment
} = makeAssessment({
  preamble,
  assessPartialBranches: ASSESS_PARTIAL_BRANCHES,
  assessmentAgentOptions,
  assessmentEscalationModel: ASSESSMENT_ESCALATION_MODEL,
  withInfraRetry
});
var { triagePrompt, runTriage } = makeRemediation({
  preamble,
  base: BASE,
  roadmap: ROADMAP,
  triageAgentOptions,
  triageEscalationModel: TRIAGE_ESCALATION_MODEL
});
var {
  coderabbitBackoffMinutes,
  runCoderabbitHostReview,
  recordCoderabbitReview,
  runHostCommitGates,
  runCodeSceneCheck
} = makeHostReview({
  base: BASE,
  coderabbitAttempts: CODERABBIT_ATTEMPTS,
  coderabbitBackoffMinutes: CODERABBIT_BACKOFF_MINUTES,
  coderabbitFindingsFile: CODERABBIT_FINDINGS_FILE,
  commitGates: COMMIT_GATES,
  commitGateTimeoutSeconds: COMMIT_GATE_TIMEOUT_SECONDS,
  csCheck: CS_CHECK,
  csCheckCommand: CS_CHECK_COMMAND
});
async function runAuthPreflight() {
  if (!AUTH_PREFLIGHT) return [];
  phase("Auth Preflight");
  const failures = [];
  const codex = await execFileStatus("codex", ["login", "status"]);
  const codexOutput = [codex.stdout, codex.stderr, codex.message].filter(Boolean).join("\n");
  if (!codex.ok || authFailureDetail(codexOutput)) {
    failures.push({
      tool: "codex",
      command: "codex login status",
      detail: authFailureDetail(codexOutput) || codexOutput.trim() || "Codex auth status check failed"
    });
  }
  if (AUTH_REQUIRED_ADAPTERS.has("claude")) {
    const claude = await execFileStatus("claude", ["auth", "status"]);
    const claudeOutput = [claude.stdout, claude.stderr, claude.message].filter(Boolean).join("\n");
    if (!claude.ok || authFailureDetail(claudeOutput)) {
      failures.push({
        tool: "claude",
        command: "claude auth status",
        detail: authFailureDetail(claudeOutput) || claudeOutput.trim() || "Claude auth status check failed"
      });
    }
  }
  if (REQUIRE_CODERABBIT_AUTH) {
    const coderabbit = await execFileStatus("coderabbit", ["auth", "status"]);
    const coderabbitOutput = [coderabbit.stdout, coderabbit.stderr, coderabbit.message].filter(Boolean).join("\n");
    if (!coderabbit.ok || authFailureDetail(coderabbitOutput)) {
      failures.push({
        tool: "coderabbit",
        command: "coderabbit auth status",
        detail: authFailureDetail(coderabbitOutput) || coderabbitOutput.trim() || "CodeRabbit auth status check failed"
      });
    }
  }
  if (failures.length) {
    log(`[auth] fatal preflight failure: ${failures.map((failure) => `${failure.tool}: ${failure.detail.split(/\r?\n/)[0]}`).join("; ")}`);
  } else {
    const passed = ["Codex"];
    if (AUTH_REQUIRED_ADAPTERS.has("claude")) passed.push("Claude");
    if (REQUIRE_CODERABBIT_AUTH) passed.push("CodeRabbit");
    log(`[auth] preflight passed for ${passed.join(", ")}`);
  }
  return failures;
}
function slugForTask(task) {
  return `roadmap-${roadmapIdSlug(task.id)}${task.isAddendum ? "-addendum" : ""}`;
}
function worktreeParentPath() {
  const path = process.getBuiltinModule("node:path");
  const cwd = process.cwd();
  return path.join(path.dirname(cwd), `${path.basename(cwd)}.worktrees`);
}
async function createWorktree(task) {
  const fs = process.getBuiltinModule("node:fs/promises");
  const path = process.getBuiltinModule("node:path");
  const branch = slugForTask(task);
  const worktreePath = path.join(worktreeParentPath(), branch);
  const setupCommand = `git worktree add -b ${branch} ${worktreePath} origin/${BASE}`;
  try {
    await execFileText("git", ["fetch", "origin", BASE]);
    const baseSha = (await execFileText("git", ["rev-parse", `origin/${BASE}`])).trim();
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await execFileText("git", ["worktree", "add", "-b", branch, worktreePath, `origin/${BASE}`]);
    const worktreeSha = (await execFileText("git", ["-C", worktreePath, "rev-parse", "HEAD"])).trim();
    if (worktreeSha !== baseSha) {
      return {
        ok: false,
        worktreePath,
        branch,
        baseSha,
        donkeyInvocation: setupCommand,
        notes: `worktree HEAD ${worktreeSha} did not match origin/${BASE} ${baseSha}`
      };
    }
    return {
      ok: true,
      worktreePath,
      branch,
      baseSha,
      donkeyInvocation: setupCommand,
      notes: "created deterministically by the ODW control loop; no setup agent required"
    };
  } catch (error) {
    const failure = error;
    const details = [
      failure && failure.message || String(error),
      failure?.stderr ? `stderr: ${failure.stderr.trim()}` : "",
      failure?.stdout ? `stdout: ${failure.stdout.trim()}` : ""
    ].filter(Boolean).join("; ");
    return {
      ok: false,
      worktreePath,
      branch,
      baseSha: "",
      donkeyInvocation: setupCommand,
      notes: details
    };
  }
}
async function readRoadmapForSelection(root = process.cwd()) {
  const canonicalRef = `origin/${BASE}:${ROADMAP}`;
  try {
    return {
      text: await execFileText("git", ["-C", root, "show", canonicalRef]),
      source: canonicalRef,
      fallbackReason: ""
    };
  } catch (error) {
    const failure = error;
    const details = [
      failure && failure.message || String(error),
      failure?.stderr ? `stderr: ${failure.stderr.trim()}` : "",
      failure?.stdout ? `stdout: ${failure.stdout.trim()}` : ""
    ].filter(Boolean).join("; ");
    throw new Error(`Failed to read canonical roadmap ref ${canonicalRef}: ${details}`);
  }
}
async function executeResume(task, candidate, enriched, evidence, stage, mergeLock2) {
  const worktree = candidate.worktreePath;
  const extra = { kind: "recovery-resume" };
  const writeAccess = await ensureTaskAgentWriteAccess(worktree, candidate.taskId);
  if (!writeAccess.ok) {
    const detail = `task-agent writable-root preflight failed (launch/sandbox fault, not a task defect): ${writeAccess.failures.map((failure) => `${failure.adapter}: ${failure.detail}`).join("; ")}`;
    return { id: candidate.taskId, status: "failed", stage: "worktree-write", detail, worktree, proposals: [], ...extra };
  }
  try {
    let plan;
    let impl;
    if (stage === "plan") {
      const planned = await runPlanDesignLoop(task, worktree, { resume: true, extra });
      if (planned.fail) return planned.fail;
      plan = planned.plan;
    } else if (stage === "implement") {
      plan = {
        execplanPath: enriched.execplanPath,
        workItems: [],
        summary: "Resumed from the committed ExecPlan on the surviving branch."
      };
    }
    if (stage === "plan" || stage === "implement") {
      const built = await runImplementationStage(task, worktree, plan, { resume: stage === "implement", extra });
      if (built.fail) return built.fail;
      impl = built.impl;
    } else {
      const synthetic = await syntheticRecoveryImpl(enriched, evidence);
      impl = synthetic;
      plan = { execplanPath: synthetic.execplanPath, workItems: [], summary: synthetic.summary };
    }
    return await runDualReviewAndIntegration(task, candidate.worktreePath, plan, impl, mergeLock2, { kind: "recovery-resume" });
  } catch (error) {
    const detail = `unhandled agent error: ${error && error.message || String(error)}`;
    return resultFromUnhandledAgentError(candidate.taskId, detail, { worktree, kind: "recovery-resume" });
  }
}
async function runRecovery(root, mergeLock2 = null) {
  const summary = {
    enabled: true,
    mode: RESUME_MODE,
    candidates: 0,
    assessed: 0,
    resumed: 0,
    skipped: [],
    results: [],
    errors: []
  };
  const held = { normal: /* @__PURE__ */ new Set(), addendum: /* @__PURE__ */ new Set() };
  const taskResults = [];
  phase("Recovery");
  const fetched = await execFileStatus("git", ["-C", root, "fetch", "origin", BASE]);
  if (!fetched.ok) {
    summary.errors.push(`fetch origin ${BASE} failed (continuing with local refs): ${(fetched.message || fetched.stderr || "").trim()}`);
  }
  let roadmap;
  try {
    roadmap = await readRoadmapForSelection(root);
  } catch (error) {
    summary.errors.push(error && error.message || String(error));
    log("[recovery] cannot read the canonical roadmap; skipping recovery discovery");
    return { summary, taskResults, held, fatal: null };
  }
  const discovery = await discoverRecoveryCandidates(roadmap.text, root);
  summary.candidates = discovery.candidates.length;
  summary.skipped.push(...discovery.skipped);
  summary.errors.push(...discovery.errors);
  const holdCandidate = (branchName, taskId) => {
    const parsed = branchToRoadmapId(branchName);
    if (!parsed) return;
    (parsed.isAddendum ? held.addendum : held.normal).add(taskId || parsed.id);
  };
  for (const entry of discovery.skipped) {
    if (RECOVERY_HOLD_REASONS.has(entry.reason)) holdCandidate(entry.branchName, entry.id);
  }
  for (const candidate of discovery.candidates) {
    holdCandidate(candidate.branchName, candidate.taskId);
    const task = {
      id: candidate.taskId,
      title: candidate.taskTitle,
      requires: [],
      rationale: `${RESUME_MODE}-mode recovery resume of a surviving task branch`,
      isAddendum: false,
      subtasks: []
    };
    const resumeWt = { branch: candidate.branchName, worktreePath: candidate.worktreePath, baseSha: candidate.baseCommit };
    let decision;
    let evidence;
    let enriched;
    let assessment = null;
    let planState = null;
    if (RESUME_MODE === "continue") {
      log(`[recovery] dispatching ${candidate.branchName} (task ${candidate.taskId}) from its committed ExecPlan`);
      evidence = await collectAssessmentEvidence(task, resumeWt);
      const resolved = await recoveryExecplanPath(candidate);
      enriched = { ...candidate, execplanPath: resolved.execplanPath };
      planState = resolved.error ? { status: "unreadable", ticked: 0, unticked: 0, items: [], error: resolved.error } : await readExecplanState(enriched);
      decision = { classification: "", ...recoveryContinueDecision(enriched, evidence, planState, { dryRun: DRY_RUN }) };
    } else {
      log(`[recovery] assessing ${candidate.branchName} (task ${candidate.taskId})`);
      const assessed = await assessRecoveryCandidate(candidate);
      if (!assessed.assessment) {
        summary.results.push({
          id: candidate.taskId,
          branchName: candidate.branchName,
          classification: "",
          action: "assessment-error",
          assessmentError: assessed.assessmentError
        });
        summary.skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: "assessment-error" });
        if (authFailureDetail(assessed.assessmentError) || providerFailureDetail(assessed.assessmentError)) {
          return { summary, taskResults, held, fatal: resultFromUnhandledAgentError(candidate.taskId, assessed.assessmentError) };
        }
        continue;
      }
      assessment = assessed.assessment;
      summary.assessed += 1;
      evidence = assessment.hostEvidence;
      const resolved = await recoveryExecplanPath(candidate);
      enriched = { ...candidate, execplanPath: resolved.execplanPath };
      decision = resolved.error ? { classification: "", action: "report", stage: null, reason: "execplan-stat-error", skip: true } : { stage: "review", ...recoveryDecision(enriched, evidence, assessment, RESUME_MODE, { dryRun: DRY_RUN }) };
    }
    const resultBase = {
      id: candidate.taskId,
      branchName: candidate.branchName,
      classification: decision.classification,
      ...planState ? { planStatus: planState.status } : {}
    };
    if (decision.action !== "resume") {
      if (decision.skip) {
        summary.skipped.push({ id: candidate.taskId, branchName: candidate.branchName, reason: decision.reason || "" });
      }
      summary.results.push({
        ...resultBase,
        action: "reported",
        ...decision.reason ? { reason: decision.reason } : {},
        ...assessment ? { assessment } : {}
      });
      log(`[recovery] ${candidate.branchName}: ${decision.classification || planState?.status || "reported"} (reported${decision.reason ? `; ${decision.reason}` : ""})`);
      continue;
    }
    const stage = decision.stage || "review";
    log(`[recovery] resuming ${candidate.branchName} at the ${stage} stage through the ordinary pipeline`);
    const outcome = await executeResume(task, candidate, enriched, evidence, stage, mergeLock2);
    if (outcome.status === "fatal-auth" || outcome.status === "provider-fault" || outcome.status === "infra-fault") {
      summary.results.push({ ...resultBase, resumeStage: stage, action: "resume-failed", reason: outcome.detail || outcome.status });
      return { summary, taskResults, held, fatal: outcome };
    }
    taskResults.push({ task, result: outcome.status === "done" ? outcome : await attachAssessment(task, resumeWt, outcome) });
    if (outcome.status === "done") {
      summary.resumed += 1;
      summary.results.push({ ...resultBase, resumeStage: stage, action: "resumed" });
      log(`[recovery] ${candidate.branchName}: resumed and integrated`);
    } else if (outcome.status === "manual-merge-ready") {
      summary.results.push({ ...resultBase, resumeStage: stage, action: "manual-merge-ready" });
    } else {
      summary.results.push({ ...resultBase, resumeStage: stage, action: "resume-failed", reason: outcome.detail || outcome.status });
      log(`[recovery] ${candidate.branchName}: resume ${outcome.status} at ${outcome.stage || "unknown stage"}`);
    }
  }
  return { summary, taskResults, held, fatal: null };
}
function writeProbeTargets() {
  const probeOptions = (realAdapter) => (options) => ({
    adapter: realAdapter,
    ...WRITE_PROBE_MODEL_BY_ADAPTER[String(realAdapter).toLowerCase()] ? { model: WRITE_PROBE_MODEL_BY_ADAPTER[String(realAdapter).toLowerCase()] } : {},
    effort: WRITE_PROBE_EFFORT,
    ...options
  });
  const planAdapter = String(PLAN_ADAPTER).toLowerCase();
  const buildAdapter = String(BUILD_ADAPTER).toLowerCase();
  const targets = [
    { role: "plan", adapter: planAdapter, options: probeOptions(planAdapter) },
    { role: "build", adapter: buildAdapter, options: probeOptions(buildAdapter) }
  ];
  const seen = /* @__PURE__ */ new Set();
  return targets.filter((target) => {
    if (seen.has(target.adapter)) return false;
    seen.add(target.adapter);
    return true;
  });
}
async function runAudit(task) {
  phase("Audit");
  const audit = await agent(auditPrompt(task, null), reviewAgentOptions({ phase: "Audit", label: `audit:after-${task.id}`, schema: AUDIT_SCHEMA }));
  return audit;
}
var processed = [];
var processedNormal = /* @__PURE__ */ new Set();
var processedAddendum = /* @__PURE__ */ new Set();
var manualMergeReadyNormal = /* @__PURE__ */ new Set();
var manualMergeReadyAddendum = /* @__PURE__ */ new Set();
var dryRunNormal = /* @__PURE__ */ new Set();
var dryRunAddendum = /* @__PURE__ */ new Set();
var recoveryHeldNormal = /* @__PURE__ */ new Set();
var recoveryHeldAddendum = /* @__PURE__ */ new Set();
var recovery = {
  enabled: RESUME_PARTIAL_BRANCHES,
  mode: RESUME_MODE,
  candidates: 0,
  assessed: 0,
  resumed: 0,
  skipped: [],
  results: [],
  errors: []
};
var results = [];
var audits = [];
var triages = [];
var pendingByStep = /* @__PURE__ */ new Map();
var inflight = /* @__PURE__ */ new Map();
var inflightNormal = /* @__PURE__ */ new Set();
var inflightAddendum = /* @__PURE__ */ new Set();
var halted = null;
var canFlush = AUTO_MERGE && !DRY_RUN;
function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(() => fn());
    tail = result.then(() => {
    }, () => {
    });
    return result;
  };
}
var mergeLock = mutex();
function semaphore(limit) {
  const max = Math.max(1, limit);
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < max && queue.length) {
      const item = queue.shift();
      if (!item) break;
      active += 1;
      Promise.resolve().then(item.fn).then(item.resolve, item.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}
var planningLock = semaphore(MAX_PLANNING_PARALLEL);
var buildLock = semaphore(MAX_BUILD_PARALLEL);
var hostGateLock = semaphore(1);
var {
  runPlanDesignLoop,
  runWorkItemBuildLoop,
  runImplementationStage,
  runDualReviewAndIntegration,
  runTask
} = makeTaskPipeline({
  CS_CHECK,
  runCodeSceneCheck,
  MAX_DESIGN_ROUNDS,
  MAX_REVIEW_ROUNDS,
  MAX_WORK_ITEM_ROUNDS,
  PER_WORK_ITEM_BUILD,
  HOST_COMMIT_GATES,
  HOST_GATES_BETWEEN_WORK_ITEMS,
  CODERABBIT_HOST_REVIEW,
  CODERABBIT_BETWEEN_WORK_ITEMS,
  DRY_RUN,
  AUTO_MERGE,
  BASE,
  planPrompt,
  designReviewPrompt,
  implementPrompt,
  implementWorkItemPrompt,
  fixPrompt,
  codeReviewPrompt,
  expertReviewPrompt,
  addendumReviewPrompt,
  implementAddendumPrompt,
  integratePrompt,
  planAgentOptions,
  reviewAgentOptions,
  buildAgentOptions,
  planningLock,
  buildLock,
  hostGateLock,
  withInfraRetry,
  attachAssessment,
  ensureTaskAgentWriteAccess,
  createWorktree,
  runHostCommitGates,
  runCoderabbitHostReview,
  recordCoderabbitReview
});
var selectSeq = 0;
async function doSelect(taken) {
  phase("Select");
  const label = `select#${++selectSeq}`;
  const roadmap = await readRoadmapForSelection();
  if (roadmap.fallbackReason) {
    log(`[${label}] using working-tree ${ROADMAP}; origin/${BASE} read failed: ${roadmap.fallbackReason}`);
  }
  const selection = selectRoadmapTask(roadmap.text, taken, ONLY_TASK);
  if (selection?.hasTask && selection.task) {
    log(`[${label}] selected ${selection.task.isAddendum ? "addendum pass" : "normal task"} ${selection.task.id} from ${roadmap.source}`);
  } else {
    log(`[${label}] no unblocked roadmap task found from ${roadmap.source}`);
  }
  return selection;
}
function takenSnapshot() {
  return {
    normal: [...processedNormal, ...manualMergeReadyNormal, ...dryRunNormal, ...inflightNormal, ...recoveryHeldNormal],
    addendum: [...processedAddendum, ...manualMergeReadyAddendum, ...dryRunAddendum, ...inflightAddendum, ...recoveryHeldAddendum]
  };
}
function isAlreadyTaken(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal;
  const manualMergeReadySet = task?.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal;
  const dryRunSet = task?.isAddendum ? dryRunAddendum : dryRunNormal;
  const recoveryHeldSet = task?.isAddendum ? recoveryHeldAddendum : recoveryHeldNormal;
  return processedSet.has(task.id) || manualMergeReadySet.has(task.id) || dryRunSet.has(task.id) || recoveryHeldSet.has(task.id) || inflightNormal.has(task.id) || inflightAddendum.has(task.id);
}
function markInflight(task) {
  const inflightSet = task?.isAddendum ? inflightAddendum : inflightNormal;
  inflightSet.add(task.id);
}
function unmarkInflight(task) {
  const inflightSet = task?.isAddendum ? inflightAddendum : inflightNormal;
  inflightSet.delete(task.id);
}
function markProcessed(task) {
  const processedSet = task?.isAddendum ? processedAddendum : processedNormal;
  processedSet.add(task.id);
  processed.push(task.id);
}
function markManualMergeReady(task) {
  const manualMergeReadySet = task?.isAddendum ? manualMergeReadyAddendum : manualMergeReadyNormal;
  manualMergeReadySet.add(task.id);
}
function markDryRun(task) {
  const dryRunSet = task?.isAddendum ? dryRunAddendum : dryRunNormal;
  dryRunSet.add(task.id);
}
function addPending(step, items) {
  if (!items || !items.length) return;
  if (!pendingByStep.has(step)) pendingByStep.set(step, []);
  pendingByStep.get(step).push(...items);
}
async function flushSettledSteps() {
  if (!canFlush) return;
  const inflightSteps = new Set([...inflight.keys()].map(stepOf));
  for (const [step, items] of [...pendingByStep.entries()]) {
    if (!items.length || inflightSteps.has(step)) continue;
    const tr = await mergeLock(() => runTriage(step, items));
    triages.push({ step, ...tr || {} });
    if (!tr?.ok || !tr.pushed) {
      log(`[step ${step}] triage did not land; keeping ${items.length} proposal(s) pending`);
      continue;
    }
    const lanes = (tr?.decisions || []).reduce((m, d) => (m[d.lane] = (m[d.lane] || 0) + 1, m), {});
    log(`[step ${step}] triaged ${items.length} proposal(s): ${Object.entries(lanes).map(([k, v]) => `${v} ${k}`).join(", ") || "none recorded"}`);
    pendingByStep.delete(step);
  }
}
async function fillPool() {
  while (inflight.size < MAX_PARALLEL && processed.length + inflight.size < MAX_TASKS) {
    if (budget.total && budget.remaining() < BUDGET_RESERVE) {
      if (!halted) halted = `budget reserve reached (${Math.round(budget.remaining() / 1e3)}k remaining)`;
      return;
    }
    let sel;
    try {
      sel = await doSelect(takenSnapshot());
    } catch (err) {
      log(`[pool] select agent failed (${err && err.message || String(err)}); stop opening new work, drain in-flight`);
      if (!halted) halted = `select agent error: ${err && err.message || String(err)}`;
      return;
    }
    if (!sel || !sel.hasTask || !sel.task) {
      if (inflight.size === 0) log(sel?.blockedSummary ? `No unblocked task: ${sel.blockedSummary}` : "No unblocked roadmap tasks remain.");
      return;
    }
    const task = sel.task;
    if (isAlreadyTaken(task)) {
      log(`Selector re-offered already-taken ${task.isAddendum ? "addendum pass" : "normal task"} ${task.id}; not double-spawning.`);
      return;
    }
    log(`[pool] spawning ${task.id} (${inflight.size + 1}/${MAX_PARALLEL} in flight)`);
    markInflight(task);
    inflight.set(
      task.id,
      // A thrown agent error (e.g. a subagent that completes without emitting
      // structured output) must NOT reject through Promise.race and crash the
      // whole run — convert it to a failed result the control loop drains.
      runTask(task, mergeLock).then(
        (result) => ({ id: task.id, task, result }),
        (err) => {
          const detail = `unhandled agent error: ${err && err.message || String(err)}`;
          return {
            id: task.id,
            task,
            result: resultFromUnhandledAgentError(task.id, detail)
          };
        }
      )
    );
  }
}
// --- Worker-pool control loop -----------------------------------------------
async function workflowMain() {
  const authPreflight = await runAuthPreflight();
  if (authPreflight.length) {
    halted = `fatal auth preflight failed: ${authPreflight.map((failure) => `${failure.tool} (${failure.command})`).join(", ")}`;
  }
  let stop = Boolean(halted);
  let providerFaultHalt = false;
  if (RESUME_PARTIAL_BRANCHES && halted) {
    recovery.blocked = "auth-preflight-failed";
  }
  if (RESUME_PARTIAL_BRANCHES && !halted) {
    try {
      const outcome = await runRecovery(process.cwd(), mergeLock);
      recovery = outcome.summary;
      for (const id of outcome.held.normal) recoveryHeldNormal.add(id);
      for (const id of outcome.held.addendum) recoveryHeldAddendum.add(id);
      for (const entry of outcome.taskResults) {
        results.push(entry.result);
        if (entry.result.status === "done" && entry.result.integration?.pushed) {
          markProcessed(entry.task);
        } else if (entry.result.status === "manual-merge-ready") {
          markManualMergeReady(entry.task);
        } else if (["failed", "halted"].includes(entry.result.status) && !halted) {
          halted = `recovery resume of task ${entry.result.id} ${entry.result.status} at ${entry.result.stage}: ${entry.result.detail}`;
          stop = true;
        }
      }
      if (outcome.fatal) {
        results.push(outcome.fatal);
        halted = `recovery ${outcome.fatal.status} at ${outcome.fatal.stage}: ${outcome.fatal.detail}`;
        if (outcome.fatal.status === "provider-fault" || outcome.fatal.status === "infra-fault") providerFaultHalt = true;
        stop = true;
      }
    } catch (error) {
      const detail = error && error.message || String(error);
      recovery.errors.push(`recovery pass failed: ${detail}`);
      log(`[recovery] failed (${detail}); continuing with normal roadmap selection`);
    }
  }
  while (true) {
    if (!stop && !halted) {
      try {
        await flushSettledSteps();
      } catch (err) {
        log(`[triage] failed (${err && err.message || String(err)}); proposals stay pending for a later sweep`);
      }
      await fillPool();
    }
    if (inflight.size === 0) break;
    const done = await Promise.race(inflight.values());
    inflight.delete(done.id);
    unmarkInflight(done.task);
    const result = done.result;
    results.push(result);
    if (result.status === "done" && result.integration?.pushed) {
      markProcessed(done.task);
      if (result.kind !== "addendum") {
        addPending(stepOf(done.id), result.proposals);
        let audit = null;
        try {
          audit = await mergeLock(() => runAudit({ id: done.id }));
        } catch (err) {
          log(`[audit ${done.id}] failed (${err && err.message || String(err)}); skipping (task already merged)`);
        }
        if (audit) {
          audits.push({ afterTask: done.id, ...audit });
          addPending(stepOf(done.id), (audit.proposedRoadmapItems || []).map((p) => ({ ...p, source: `audit:${done.id}` })));
        }
      }
    } else if (result.status === "dry-run") {
      markDryRun(done.task);
    } else if (result.status === "manual-merge-ready") {
      markManualMergeReady(done.task);
    } else if (result.status === "fatal-auth") {
      halted = `task ${done.id} fatal auth failure at ${result.stage}: ${result.detail}`;
      stop = true;
    } else if (result.status === "provider-fault") {
      halted = `task ${done.id} provider fault at ${result.stage}: ${result.detail}`;
      providerFaultHalt = true;
      stop = true;
    } else if (result.status === "infra-fault") {
      halted = `task ${done.id} infrastructure fault at ${result.stage}: ${result.detail}; branch state is durable \u2014 relaunch with resumeMode: "continue" to resume from the committed ExecPlan`;
      providerFaultHalt = true;
      stop = true;
    } else if (!halted) {
      halted = `task ${done.id} ${result.status} at ${result.stage}: ${result.detail}`;
      stop = true;
    }
  }
  if (canFlush && !providerFaultHalt) {
    try {
      await flushSettledSteps();
    } catch (err) {
      log(`[triage:end] failed (${err && err.message || String(err)}); ${[...pendingByStep.values()].flat().length} proposal(s) left pending`);
    }
  }
  const unresolvedRecovery = [
    ...[...recoveryHeldNormal].filter((id) => !processedNormal.has(id) && !manualMergeReadyNormal.has(id)).map((id) => ({ id, isAddendum: false })),
    ...[...recoveryHeldAddendum].filter((id) => !processedAddendum.has(id) && !manualMergeReadyAddendum.has(id)).map((id) => ({ id, isAddendum: true }))
  ].sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }) || Number(left.isAddendum) - Number(right.isAddendum));
  recovery.unresolved = unresolvedRecovery.map((entry) => {
    const reported = (recovery.results || []).filter((result) => result.id === entry.id);
    const last = reported[reported.length - 1];
    return {
      id: entry.id,
      isAddendum: entry.isAddendum,
      branchName: last?.branchName || "",
      classification: last?.classification || "",
      action: last?.action || "held",
      ...last?.reason ? { reason: last.reason } : {}
    };
  });
  if (!halted && unresolvedRecovery.length) {
    halted = `needs-operator-recovery: ${unresolvedRecovery.length} recovery survivor branch(es) still block the roadmap frontier (${unresolvedRecovery.map((entry) => entry.id + (entry.isAddendum ? " (addendum)" : "")).join(", ")}); use recovery.results/recovery.unresolved to close, resume, split, or hoover each branch, then relaunch`;
  }
  const pendingProposals = [...pendingByStep.values()].flat();
  const assessments = results.filter((result) => result.assessment || result.assessmentError).map((result) => ({
    id: result.id,
    stage: result.stage,
    status: result.status,
    classification: result.assessment?.classification || "",
    recommendation: result.assessment?.recommendation || "",
    assessmentError: result.assessmentError || ""
  }));
  return {
    base: BASE,
    modelRouting: {
      worktree: { mode: "deterministic-git-worktree" },
      build: { adapter: BUILD_ADAPTER, model: BUILD_MODEL },
      plan: { adapter: PLAN_ADAPTER, model: PLAN_MODEL },
      review: { adapter: REVIEW_ADAPTER, model: REVIEW_MODEL },
      triage: { adapter: TRIAGE_ADAPTER, model: TRIAGE_MODEL },
      assessment: { adapter: ASSESSMENT_ADAPTER, model: ASSESSMENT_MODEL }
    },
    maxParallel: MAX_PARALLEL,
    maxPlanningParallel: MAX_PLANNING_PARALLEL,
    maxBuildParallel: MAX_BUILD_PARALLEL,
    // The exact deterministic gate set every branch agent was instructed to run
    // (issue #28): operators can audit reported gate greenness against it.
    commitGates: COMMIT_GATES,
    // Host gate verification aggregate: whether the host re-ran the gates
    // itself, the per-gate timeout, and bounded counters. Per-round pass/fail
    // detail lives in each task's reviewRounds[].hostGates.
    hostGates: {
      enabled: HOST_COMMIT_GATES,
      timeoutSeconds: COMMIT_GATE_TIMEOUT_SECONDS,
      ...hostGateMetrics
    },
    stageAttempts: STAGE_ATTEMPTS,
    // Host-driven build loop configuration: one builder turn per unticked
    // ExecPlan Progress item when enabled, with committed progress verified
    // after every turn.
    workItemBuild: { enabled: PER_WORK_ITEM_BUILD, maxRounds: MAX_WORK_ITEM_ROUNDS },
    // Bounded-cardinality fault metrics (fixed keys): stage retries spent on
    // infrastructure faults plus terminal fault counts per class, so operators
    // can read retry pressure straight from the result instead of the logs.
    faultMetrics: { ...faultMetrics },
    // Host-run CodeRabbit review aggregate: effective configuration plus
    // bounded counters (reviews run, findings by severity, rate-limited runs,
    // deferred reviews). Per-finding detail goes to the JSONL sink when
    // coderabbitFindingsFile is configured.
    coderabbit: {
      hostReview: CODERABBIT_HOST_REVIEW,
      attempts: CODERABBIT_ATTEMPTS,
      backoffMinutes: CODERABBIT_BACKOFF_MINUTES,
      findingsFile: CODERABBIT_FINDINGS_FILE,
      ...coderabbitCapture,
      bySeverity: { ...coderabbitCapture.bySeverity }
    },
    processed,
    results,
    assessments,
    audits,
    authPreflight,
    // Fresh-run recovery index (failure-resume design): per-task results[]
    // entries remain the primary record for review/integration outcomes.
    recovery,
    // Remediation GIST-triaged into addendum / step-task / reroute lanes when each
    // step quiesced (see remediationTriage). Anything in pendingProposals was left
    // unwritten because the run halted — triage it manually.
    remediationTriage: triages,
    pendingProposals,
    halted,
    summary: `Processed ${processed.length} roadmap task(s) (pool width ${MAX_PARALLEL}): ` + results.map((r) => `${r.id}=${r.status}`).join(", ") + (recovery.enabled ? ` | recovery(${recovery.mode}): ${recovery.assessed} assessed, ${recovery.resumed} resumed, ${recovery.skipped.length} skipped` : "") + (assessments.length ? ` | assessed ${assessments.length} failed/halted branch(es)` : "") + (triages.length ? ` | triaged ${triages.reduce((n, t) => n + (t.decisions ? t.decisions.length : 0), 0)} proposal(s) across ${triages.length} step(s)` : "") + (halted ? ` | halted: ${halted}` : " | clean stop (no more unblocked tasks).")
  };
}

// --- Entry (generated footer) ------------------------------------------------
return await workflowMain()
