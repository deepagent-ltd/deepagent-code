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
    "http.instance.browser.",
    {
      sharedCreate: "SharedBrowserControl.create",
      sharedTakeover: "SharedBrowserControl.recordBarrier",
      sharedApproveOrigin: "SharedBrowserControl.approveOrigin",
      sharedClose: "SharedBrowserControl.prepareClose",
    },
    "adapter",
    "packages/core/src/browser/shared-control.ts",
    "native",
  ),
  ...reviewed(
    "http.instance.browser.",
    { sharedList: "SharedBrowserControl.list" },
    "read_only",
    "packages/core/src/browser/shared-control.ts",
    "native",
  ),
  ...reviewed(
    "http.instance.browser.",
    { sharedGet: "readShared" },
    "read_only",
    "packages/core/src/browser/shared-control.ts",
    "authenticate",
  ),
  ...reviewed(
    "http.instance.browser.",
    { sharedFilesApprove: "files.shared.approve" },
    "adapter",
    "packages/core/src/browser/shared-file-exchange.ts",
    "readShared",
  ),
  ...reviewed(
    "http.instance.browser.",
    {
      sharedFilesPreview: "files.shared.preview",
      sharedFilesStatus: "files.shared.status",
      sharedFilesList: "files.shared.list",
    },
    "read_only",
    "packages/core/src/browser/shared-file-exchange.ts",
    "readShared",
  ),
  // browserTui captures the original native()/scopeFor guards. Each HTTP face
  // forwards to its exact Host method; it never acquires a Session/model loop.
  ...Object.entries({
    tuiPair: "pair",
    tuiOwner: "owner",
    tuiReserve: "reserve",
    tuiSeal: "seal",
    tuiDetach: "detach",
  }).flatMap(([name, method]) =>
    reviewed(
      "http.instance.browser.",
      { [name]: `tui.${method}` },
      "adapter",
      "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/browser-tui.ts",
      [
        { kind: "callChain", chain: `host.tui.${method}`, fileSuffix: "handlers/browser-tui.ts" },
        { kind: "callChain", chain: "native", fileSuffix: "handlers/browser-tui.ts" },
      ],
    ),
  ),
  ...reviewed(
    "http.instance.session.",
    { taskSummary: "TaskSummary.read" },
    "read_only",
    "packages/core/src/session/task-summary.ts",
    "requireSession",
  ),
  ...reviewed(
    "http.instance.session.",
    { contextUsage: "SessionContextUsage.read" },
    "read_only",
    "packages/core/src/session/context-usage.ts",
    "requireSession",
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
    "LocalAuthority.provide",
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
    "LocalAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventWork.",
    {
      ruleControl: "management.ruleControl",
      rootControl: "management.rootControl",
    },
    "adapter",
    "packages/core/src/deepagent/event-work-management.ts",
    "LocalAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventInvestigation.",
    {
      candidates: "EventInvestigation.candidates",
      reports: "EventInvestigation.reports",
    },
    "read_only",
    "packages/core/src/deepagent/event-investigation.ts",
    "LocalAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventInvestigation.",
    {
      capture: "service.capture",
      control: "service.control",
    },
    "adapter",
    "packages/core/src/deepagent/event-investigation.ts",
    "LocalAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventValidation.",
    {
      candidates: "service.candidates",
    },
    "read_only",
    "packages/core/src/deepagent/event-validation.ts",
    "LocalAuthority.provide",
  ),
  ...reviewed(
    "http.instance.eventValidation.",
    {
      rules: "service.list",
      runs: "service.history",
    },
    "read_only",
    "packages/core/src/deepagent/event-validation.ts",
    "LocalAuthority.authenticate",
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
    "LocalAuthority.provide",
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
  access: string | readonly Requirement[],
): RulePack[] {
  return Object.entries(methods).map(([name, chain]) => {
    const requirements: readonly Requirement[] = [
      { kind: "reach", pathSuffix: reader },
      { kind: "bodyChain", chain },
      ...(typeof access === "string" ? [{ kind: "bodyChain" as const, chain: access }] : access),
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
