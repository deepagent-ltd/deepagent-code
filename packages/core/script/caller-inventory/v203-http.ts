import { DIMENSIONS } from "./types"
import type { Requirement } from "./types"
import type { RulePack } from "./rules"

// These are reviewed HTTP faces over the original business owners. Mutations
// adapt those owners; they do not claim a second Session runner or model loop.
// Exact operation names keep newly added endpoints unclassified until reviewed.
export const V203_HTTP_RULE_PACKS: readonly RulePack[] = [
  ...reviewed(
    "http.instance.im.",
    {
      dacSubmit: "dac.submit",
      dacReplyRetry: "dac.retryReply",
    },
    "adapter",
    "packages/core/src/im/dac-session.ts",
    "dacScope",
  ),
  ...reviewed(
    "http.instance.im.",
    {
      dacBinding: "dac.binding",
      dacCommand: "dac.command",
    },
    "read_only",
    "packages/core/src/im/dac-session.ts",
    "dacScope",
  ),
  ...reviewed(
    "http.instance.browser.",
    {
      create: "BrowserControl.create",
      cancel: "BrowserControl.cancel",
      filesApprove: "files.approve",
    },
    "adapter",
    "packages/core/src/browser/control.ts",
    "native",
  ),
  ...reviewed(
    "http.instance.browser.",
    {
      get: "BrowserControl.get",
      action: "BrowserControl.getAction",
      filesPreview: "files.preview",
      filesStatus: "files.status",
      filesList: "files.list",
    },
    "read_only",
    "packages/core/src/browser/control.ts",
    "read",
  ),
  ...reviewed(
    "http.instance.imTask.",
    {
      enable: "LocalTaskPolicy.enable",
      propose: "IMTaskAuthority.propose",
      accept: "tasks.accept",
      cancel: "control.cancel",
      refuse: "notices.refuse",
    },
    "adapter",
    "packages/core/src/im/task-authority.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.imTask.",
    {
      targets: "RemoteTaskScope.targets",
      conversation: "LocalTaskPolicy.lookup",
      read: "tasks.read",
      state: "state.read",
      session: "taskSession.read",
    },
    "read_only",
    "packages/core/src/im/task-authority.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.imTask.",
    {
      capability: "LocalTaskAuthority.authenticate",
    },
    "read_only",
    "packages/core/src/im/task-authority.ts",
    "LocalTaskAuthority.authenticate",
  ),
  ...reviewed(
    "http.instance.workRecovery.",
    {
      recoverKnown: "NativeWorkKnownRecovery.recover",
      resumeRecovered: "NativeWorkKnownRecovery.resume",
      cleanupKnown: "NativeWorkStorageCleanup.cleanup",
    },
    "adapter",
    "packages/core/src/session/work-known-recovery.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventWork.",
    {
      candidates: "management.candidates",
      rules: "management.rules",
      roots: "management.roots",
      session: "management.session",
    },
    "read_only",
    "packages/core/src/deepagent/event-work-management.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventWork.",
    {
      ruleControl: "management.ruleControl",
      rootControl: "management.rootControl",
    },
    "adapter",
    "packages/core/src/deepagent/event-work-management.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventInvestigation.",
    {
      candidates: "EventInvestigation.candidates",
      reports: "EventInvestigation.reports",
    },
    "read_only",
    "packages/core/src/deepagent/event-investigation.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventInvestigation.",
    {
      capture: "service.capture",
      control: "service.control",
    },
    "adapter",
    "packages/core/src/deepagent/event-investigation.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventValidation.",
    {
      candidates: "service.candidates",
    },
    "read_only",
    "packages/core/src/deepagent/event-validation.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventValidation.",
    {
      rules: "service.list",
      runs: "service.history",
    },
    "read_only",
    "packages/core/src/deepagent/event-validation.ts",
    "LocalTaskAuthority.authenticate",
  ),
  ...reviewed(
    "http.instance.eventValidation.",
    {
      capture: "service.capture",
      configureCaptured: "service.configureCaptured",
      configure: "service.configure",
      control: "service.control",
    },
    "adapter",
    "packages/core/src/deepagent/event-validation.ts",
    "LocalTaskAuthority.provide",
  ),
  ...reviewed(
    "http.instance.deepagent.",
    {
      goalPlanRebaseBegin: "GoalPlanRebaseHost.begin",
      goalPlanRebaseApply: "GoalPlanRebaseHost.apply",
      goalPlanRebaseCancel: "GoalPlanRebaseHost.cancel",
      goalPlanRebaseReconcile: "GoalPlanRebaseHost.reconcile",
    },
    "adapter",
    "packages/core/src/deepagent/goal-plan-rebase.ts",
    "GoalPlanRebaseAccess.authenticateOperator",
  ),
  ...reviewed(
    "http.instance.deepagent.",
    {
      goalPlanRebaseGet: "GoalPlanRebaseHost.get",
    },
    "read_only",
    "packages/core/src/deepagent/goal-plan-rebase.ts",
    "GoalPlanRebaseAccess.authenticateOperator",
  ),
  ...reviewed(
    "http.server.server.attention.",
    {
      "attention.capability": "checkScope",
      "attention.list": "attention.list",
      "attention.get": "attention.get",
      "attention.seen": "attention.seen",
    },
    "read_only",
    "packages/core/src/attention.ts",
    "checkScope",
  ),
  ...reviewed(
    "http.server.server.attention.",
    {
      "attention.taskControl": "taskControl.value.control",
    },
    "adapter",
    "packages/server/src/attention-control.ts",
    "checkScope",
  ),
]

function reviewed(
  prefix: string,
  methods: Record<string, string>,
  verdict: "adapter" | "read_only",
  reader: string,
  access: string,
): RulePack[] {
  return Object.entries(methods).map(([name, chain]) => {
    const requirements: readonly Requirement[] = [
      { kind: "reach", pathSuffix: reader },
      { kind: "bodyChain", chain },
      { kind: "bodyChain", chain: access },
      { kind: "noBodyChain", chain: "SessionRunner.Service" },
      { kind: "noBodyChain", chain: "SessionRunCoordinator.Service" },
      { kind: "noBodyChain", chain: "SessionPrompt.loop" },
      { kind: "noBodyChain", chain: "promptSvc.promptOrSteer" },
      { kind: "noBodyChain", chain: "llm.stream" },
    ]
    return {
      match: (id) => id === prefix + name,
      rules: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { verdict, requirements }])),
    }
  })
}
