import type { AgentDescriptor } from "./mention-parser"

/**
 * V4.0 §A1 — BUILT-IN production agent descriptors that carry the trigger +
 * capability metadata the autonomous event path needs.
 *
 * WHY THIS EXISTS: the core `AgentListProviderImpl` maps every AgentV2.Info to a
 * descriptor WITHOUT any V3.8.1 metadata (AgentV2.Info has no triggers/capabilities
 * — see agent-list-provider.ts). So `matchByTrigger`/`capableAgents` never matched
 * ANY agent for an autonomous event (git.push / ci.failure / pr.comment /
 * monitor.alert / schedule.scan / ci.repair.requested) → every such event blocked
 * with `no_capable_agent` → the autonomous half never ran. These descriptors give
 * the runtime something real to bind.
 *
 * HOW THEY RUN: each built-in's `name` is a REAL, resolvable agent the runner's
 * `agents.get(descriptor.name)` will find:
 *   - "auto"    — the renamed default primary agent (agent.ts defaultID; the Agent
 *                 service also falls back to the legacy "build" name).
 *   - "general" — the general-purpose agent (agent/agent.ts registers `general`).
 *   - "plan"    — the read-only plan agent (agent/agent.ts registers `plan`).
 * The descriptor is METADATA only — it decides matchability + carries the
 * autonomy/limits ceilings; the actual turn runs as the named agent.
 *
 * MATCHABLE-BUT-HIDDEN: `visible: false` keeps them out of the human @mention UI
 * (agent-orchestrator filters on `visible`) while the pure matchers
 * (matchByTrigger/matchByCapability/capableAgents — which ignore `visible`) still
 * find them. These built-ins ONLY make an agent MATCHABLE; the §D autonomy gate and
 * the §E security gate still apply on top, so autonomy stays conservative
 * (diagnose/review = level_1 read-only; code_edit = level_2 low-risk).
 *
 * Capabilities cover every TaskPartitioner DEFAULT_RULES step so no autonomous
 * event falls through to `no_capable_agent`:
 *   ci.failure          → code_edit (level_2) + test_run (level_2)
 *   ci.repair.requested → code_edit (level_2) + test_run (level_2)
 *   pr.comment          → analyze (level_1) + code_edit (level_2) + review (level_1)
 *   monitor.alert       → diagnose (level_1) + code_edit (level_2)
 *   git.push            → review (level_1)
 *   schedule.scan       → maintain (level_1)
 * Each of those capabilities is declared by at least one built-in below. (The
 * partitioner's rules for git.push/schedule.scan/ci.repair.requested were added
 * alongside these built-ins — an event with no rule falls back to the generic
 * `handle` capability, which no built-in declares, so a matching rule is REQUIRED.)
 */
export const BUILTIN_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  // 1. CodeFixAgent — the autonomous fixer. Triggered by CI failures + explicit
  //    repair requests; covers code_edit AND test_run so a ci.failure DAG's fix
  //    subtask binds here. level_2 (low-risk edits), file-scope + turn-time ceilings.
  {
    id: "builtin:codefix",
    name: "auto",
    displayName: "Code Fix Agent",
    description: "Autonomously fixes failing builds/tests (ci.failure, ci.repair.requested).",
    visible: false,
    triggers: [{ event: "ci.failure" }, { event: "ci.repair.requested" }],
    capabilities: ["code_edit", "test_run"],
    autonomy: "level_2",
    limits: { maxFilesChanged: 8, maxTurnDurationMs: 600_000 },
  },
  // 2. DiagnosisAgent — read-only root-cause locator for monitor alerts. level_1
  //    (post-hoc log only, no edits). Runs as the general-purpose agent.
  {
    id: "builtin:diagnosis",
    name: "general",
    displayName: "Diagnosis Agent",
    description: "Read-only root-cause diagnosis for monitor alerts (monitor.alert).",
    visible: false,
    triggers: [{ event: "monitor.alert" }],
    capabilities: ["diagnose"],
    autonomy: "level_1",
    limits: { maxTurnDurationMs: 300_000 },
  },
  // 3. CodeReviewAgent — read-only reviewer. Triggered by pushes + PR comments;
  //    covers review + analyze (the pr.comment DAG's analyze/review subtasks and
  //    the git.push reviewer). level_1 (read-only).
  {
    id: "builtin:codereview",
    name: "general",
    displayName: "Code Review Agent",
    description: "Read-only review/analysis on pushes and PR comments (git.push, pr.comment).",
    visible: false,
    triggers: [{ event: "git.push" }, { event: "pr.comment" }],
    capabilities: ["review", "analyze"],
    autonomy: "level_1",
    limits: {},
  },
  // 4. ChangeAgent — implements the requested change in a PR-comment pipeline. The
  //    pr.comment DAG's code_edit subtask binds here. level_2, file-scope ceiling.
  {
    id: "builtin:change",
    name: "auto",
    displayName: "Change Agent",
    description: "Implements requested changes from PR comments (pr.comment).",
    visible: false,
    triggers: [{ event: "pr.comment" }],
    capabilities: ["code_edit"],
    autonomy: "level_2",
    limits: { maxFilesChanged: 8 },
  },
  // 5. TestAgent — matched by CAPABILITY (test_run), not by trigger: the ci.failure
  //    DAG's test_run subtask can bind here (CodeFixAgent also covers test_run;
  //    registry order picks the first). No triggers → never trigger-matched.
  {
    id: "builtin:test",
    name: "auto",
    displayName: "Test Agent",
    description: "Runs/adds regression tests for a fix DAG (capability: test_run).",
    visible: false,
    triggers: [],
    capabilities: ["test_run"],
    autonomy: "level_2",
    limits: {},
  },
  // 6. MaintenanceAgent — scheduled maintenance scans. level_1 (read-only analysis).
  {
    id: "builtin:maintenance",
    name: "general",
    displayName: "Maintenance Agent",
    description: "Scheduled maintenance scans (schedule.scan).",
    visible: false,
    triggers: [{ event: "schedule.scan" }],
    capabilities: ["maintain", "analyze"],
    autonomy: "level_1",
    limits: {},
  },
]
