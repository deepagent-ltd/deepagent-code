import { minimatch } from "minimatch"

export const executionStacks = [
  "adapter",
  "session-v2",
  "legacy-session",
  "v4-event-runtime",
  "cli-subprocess",
  "packaged-sidecar",
  "renderer-ui",
] as const

export const modelSuites = [
  "provider-smoke",
  "cli-headless",
  "v2-provider-loop",
  "structured-output",
  "file-read-search",
  "file-mutations",
  "bash-repair",
  "subagent-foreground",
  "subagent-interrupted",
  "subagent-background",
  "permissions-deny",
  "mcp-marker",
  "provider-abort",
  "packaged-sidecar",
  "desktop-ui",
  "desktop-subagents",
  "shell-exit-contract",
  "stale-validation",
  "degeneration",
  "subagent-finalizer-isolation",
  "steer-boundary",
  "subagent-worktree-routing",
  "multi-agent-dag",
  "multi-agent-parallel-worktrees",
  "multi-agent-pr-collaboration",
  "v4-multi-agent-runtime",
  "subagent-intensity",
  "subagent-resume",
  "subagent-takeover",
  "compaction-retention",
  "expert-panel",
  "goal-grader-cli-entry",
  "intelligence-draft-confirmation",
] as const

export type ExecutionStack = (typeof executionStacks)[number]
export type ModelSuite = (typeof modelSuites)[number]
export type ModelMode = "live" | "ext"
export type ModelRun = {
  mode: ModelMode
  stack: ExecutionStack
  suite: ModelSuite
}

export type DeterministicCheck =
  | "desktop-runtime"
  | "expert-panel"
  | "goal-loop"
  | "live-llm-routes"
  | "llm-adapter"
  | "mcp"
  | "permission"
  | "session-continuation"
  | "session-v2"
  | "tool-bash-sandbox"
  | "tool-files"
  | "ui-runtime"
  | "worktree-routing"

type Route = {
  id: string
  paths: string[]
  checks?: DeterministicCheck[]
  runs?: ModelRun[]
}

const adapterProvider = modelRun("live", "adapter", "provider-smoke")
const cliHeadless = modelRun("live", "cli-subprocess", "cli-headless")
const adapterStructured = modelRun("live", "adapter", "structured-output")
const v2Provider = modelRun("live", "session-v2", "v2-provider-loop")
const legacyStructured = modelRun("live", "legacy-session", "structured-output")
const legacyFileRead = modelRun("live", "legacy-session", "file-read-search")
const legacyFileMutations = modelRun("live", "legacy-session", "file-mutations")
const legacyBashRepair = modelRun("live", "legacy-session", "bash-repair")
const legacySubagent = modelRun("live", "legacy-session", "subagent-foreground")
const v2FileRead = modelRun("live", "session-v2", "file-read-search")
const v2FileMutations = modelRun("live", "session-v2", "file-mutations")
const v2BashRepair = modelRun("live", "session-v2", "bash-repair")
const permissionsDeny = modelRun("ext", "legacy-session", "permissions-deny")
const mcpMarker = modelRun("ext", "legacy-session", "mcp-marker")
const providerAbort = modelRun("ext", "adapter", "provider-abort")
const packagedSidecar = modelRun("ext", "packaged-sidecar", "packaged-sidecar")
const interruptedSubagent = modelRun("ext", "legacy-session", "subagent-interrupted")
const backgroundSubagent = modelRun("ext", "legacy-session", "subagent-background")
const shellExitContract = modelRun("live", "legacy-session", "shell-exit-contract")
const staleValidation = modelRun("live", "legacy-session", "stale-validation")
const degeneration = modelRun("live", "legacy-session", "degeneration")
const finalizerIsolation = modelRun("ext", "legacy-session", "subagent-finalizer-isolation")
const steerBoundary = modelRun("live", "legacy-session", "steer-boundary")
const worktreeRouting = modelRun("ext", "legacy-session", "subagent-worktree-routing")
const multiAgentDag = modelRun("ext", "legacy-session", "multi-agent-dag")
const multiAgentParallelWorktrees = modelRun("ext", "legacy-session", "multi-agent-parallel-worktrees")
const multiAgentPRCollaboration = modelRun("ext", "legacy-session", "multi-agent-pr-collaboration")
const v4MultiAgentRuntime = modelRun("ext", "v4-event-runtime", "v4-multi-agent-runtime")
const subagentIntensity = modelRun("ext", "legacy-session", "subagent-intensity")
const subagentResume = modelRun("ext", "legacy-session", "subagent-resume")
const subagentTakeover = modelRun("ext", "legacy-session", "subagent-takeover")
const compactionRetention = modelRun("ext", "legacy-session", "compaction-retention")
const expertPanel = modelRun("ext", "legacy-session", "expert-panel")
const goalGraderCliEntry = modelRun("ext", "cli-subprocess", "goal-grader-cli-entry")
const intelligenceDraft = modelRun("ext", "legacy-session", "intelligence-draft-confirmation")
const allHarnessRuns = [
  adapterProvider,
  cliHeadless,
  adapterStructured,
  v2Provider,
  legacyStructured,
  legacyFileRead,
  legacyFileMutations,
  legacyBashRepair,
  legacySubagent,
  v2FileRead,
  v2FileMutations,
  v2BashRepair,
  shellExitContract,
  staleValidation,
  degeneration,
  finalizerIsolation,
  steerBoundary,
  worktreeRouting,
  multiAgentDag,
  multiAgentParallelWorktrees,
  multiAgentPRCollaboration,
  v4MultiAgentRuntime,
  subagentIntensity,
  subagentResume,
  subagentTakeover,
  interruptedSubagent,
  backgroundSubagent,
  permissionsDeny,
  mcpMarker,
  compactionRetention,
  expertPanel,
  goalGraderCliEntry,
  intelligenceDraft,
]

export const routeManifest = [
  {
    id: "live-llm-common-harness",
    paths: [
      "packages/llm/script/live-llm/config.ts",
      "packages/core/script/live-llm/runtime.ts",
      "packages/core/script/live-llm/sandbox*.ts",
      "packages/deepagent-code/script/live-llm/lifecycle.ts",
      "packages/deepagent-code/script/live-llm/runtime.ts",
    ],
    checks: ["live-llm-routes", "tool-bash-sandbox"],
    runs: allHarnessRuns,
  },
  {
    id: "live-llm-adapter-harness",
    paths: ["packages/llm/script/live-llm/provider-smoke.ts", "packages/llm/script/live-llm/assertions.ts"],
    checks: ["llm-adapter"],
    runs: [adapterProvider],
  },
  {
    id: "live-llm-adapter-structured-harness",
    paths: ["packages/llm/script/live-llm/structured-output-adapter.ts"],
    checks: ["llm-adapter"],
    runs: [adapterStructured],
  },
  {
    id: "live-llm-v2-harness",
    paths: ["packages/core/script/live-llm/v2-provider-loop.ts"],
    checks: ["session-v2"],
    runs: [v2Provider],
  },
  {
    id: "live-llm-v2-file-harness",
    paths: ["packages/core/script/live-llm/file-tools.ts"],
    checks: ["tool-files"],
    runs: [v2FileRead, v2FileMutations],
  },
  {
    id: "live-llm-v2-bash-harness",
    paths: ["packages/core/script/live-llm/bash-repair.ts", "packages/core/script/live-llm/sandbox-conformance.ts"],
    checks: ["tool-bash-sandbox"],
    runs: [v2BashRepair],
  },
  {
    id: "live-llm-legacy-harness",
    paths: ["packages/deepagent-code/script/live-llm/structured-output-legacy.ts"],
    checks: ["llm-adapter"],
    runs: [legacyStructured],
  },
  {
    id: "live-llm-legacy-file-harness",
    paths: ["packages/deepagent-code/script/live-llm/file-tools.ts"],
    checks: ["tool-files"],
    runs: [legacyFileRead, legacyFileMutations],
  },
  {
    id: "live-llm-legacy-bash-harness",
    paths: ["packages/deepagent-code/script/live-llm/bash-repair.ts"],
    checks: ["tool-bash-sandbox"],
    runs: [legacyBashRepair],
  },
  {
    id: "live-llm-subagent-harness",
    paths: ["packages/deepagent-code/script/live-llm/subagents.ts"],
    checks: ["permission"],
    runs: [legacySubagent],
  },
  {
    id: "live-llm-subagent-extension-harness",
    paths: [
      "packages/deepagent-code/script/live-llm/subagent-worktree.ts",
      "packages/deepagent-code/script/live-llm/subagent-interrupted.ts",
      "packages/deepagent-code/script/live-llm/subagent-background.ts",
      "packages/deepagent-code/script/live-llm/subagent-takeover.ts",
    ],
    checks: ["permission", "worktree-routing"],
    runs: [worktreeRouting, interruptedSubagent, backgroundSubagent, subagentTakeover],
  },
  {
    id: "live-llm-extension-harness",
    paths: ["packages/deepagent-code/script/live-llm/permissions-deny.ts"],
    checks: ["permission"],
    runs: [permissionsDeny],
  },
  {
    id: "live-llm-mcp-harness",
    paths: [
      "packages/deepagent-code/script/live-llm/mcp-marker.ts",
      "packages/deepagent-code/script/live-llm/mcp-server.ts",
    ],
    checks: ["mcp"],
    runs: [mcpMarker],
  },
  {
    id: "live-llm-shell-exit-contract-harness",
    paths: ["packages/deepagent-code/script/live-llm/shell-exit-contract.ts"],
    checks: ["tool-bash-sandbox"],
    runs: [shellExitContract],
  },
  {
    id: "live-llm-stale-validation-harness",
    paths: ["packages/deepagent-code/script/live-llm/stale-validation.ts"],
    checks: ["session-continuation", "tool-bash-sandbox"],
    runs: [staleValidation],
  },
  {
    id: "live-llm-degeneration-harness",
    paths: ["packages/deepagent-code/script/live-llm/degeneration.ts"],
    checks: ["tool-bash-sandbox"],
    runs: [degeneration],
  },
  {
    id: "live-llm-finalizer-isolation-harness",
    paths: ["packages/deepagent-code/script/live-llm/finalizer-isolation.ts"],
    checks: ["permission"],
    runs: [finalizerIsolation],
  },
  {
    id: "live-llm-steer-boundary-harness",
    paths: ["packages/deepagent-code/script/live-llm/steer-boundary.ts"],
    checks: ["session-continuation"],
    runs: [steerBoundary],
  },
  {
    id: "live-llm-worktree-routing-harness",
    paths: ["packages/deepagent-code/script/live-llm/subagent-worktree.ts"],
    checks: ["permission", "worktree-routing"],
    runs: [worktreeRouting],
  },
  {
    id: "live-llm-multi-agent-dag-harness",
    paths: ["packages/deepagent-code/script/live-llm/multi-agent-dag.ts"],
    checks: ["permission", "tool-bash-sandbox"],
    runs: [multiAgentDag],
  },
  {
    id: "live-llm-multi-agent-parallel-worktrees-harness",
    paths: ["packages/deepagent-code/script/live-llm/multi-agent-parallel-worktrees.ts"],
    checks: ["permission", "worktree-routing", "tool-bash-sandbox"],
    runs: [multiAgentParallelWorktrees],
  },
  {
    id: "live-llm-multi-agent-pr-collaboration-harness",
    paths: ["packages/deepagent-code/script/live-llm/multi-agent-pr-collaboration.ts"],
    checks: ["permission", "worktree-routing", "tool-bash-sandbox"],
    runs: [multiAgentPRCollaboration],
  },
  {
    id: "live-llm-v4-multi-agent-runtime-harness",
    paths: ["packages/deepagent-code/script/live-llm/v4-multi-agent-runtime.ts"],
    checks: ["permission", "session-continuation", "tool-bash-sandbox", "worktree-routing"],
    runs: [v4MultiAgentRuntime],
  },
  {
    id: "v4-multi-agent-runtime-production",
    paths: [
      "packages/core/src/database/migration/*agent_execution.ts",
      "packages/core/src/deepagent/agent-execution*.ts",
      "packages/core/src/deepagent/deepagent-event.ts",
      "packages/core/src/deepagent/event-router.ts",
      "packages/core/src/deepagent/lmn-events.ts",
      "packages/core/src/deepagent/task-partitioner.ts",
      "packages/deepagent-code/src/session/agent-handoff-consumer.ts",
      "packages/deepagent-code/src/session/agent-worktree.ts",
      "packages/deepagent-code/src/session/multi-agent-runtime.ts",
      "packages/deepagent-code/src/session/v4-event-runtime.ts",
      "packages/deepagent-code/src/session/v4-pr-collaboration.ts",
    ],
    checks: ["permission", "session-continuation", "worktree-routing"],
    runs: [v4MultiAgentRuntime],
  },
  {
    id: "live-llm-subagent-intensity-harness",
    paths: ["packages/deepagent-code/script/live-llm/subagent-intensity.ts"],
    checks: ["live-llm-routes"],
    runs: [subagentIntensity],
  },
  {
    id: "live-llm-subagent-resume-harness",
    paths: ["packages/deepagent-code/script/live-llm/subagent-resume.ts"],
    checks: ["permission", "session-continuation"],
    runs: [subagentResume],
  },
  {
    id: "live-llm-subagent-takeover-harness",
    paths: ["packages/deepagent-code/script/live-llm/subagent-takeover.ts"],
    checks: ["permission", "session-continuation"],
    runs: [subagentTakeover],
  },
  {
    id: "live-llm-provider-abort-harness",
    paths: ["packages/llm/script/live-llm/provider-abort.ts"],
    checks: ["llm-adapter"],
    runs: [providerAbort],
  },
  {
    id: "live-llm-packaged-sidecar-harness",
    paths: ["packages/desktop/scripts/live-llm/packaged-sidecar.ts"],
    checks: ["desktop-runtime"],
    runs: [packagedSidecar],
  },
  {
    id: "live-llm-desktop-runtime-harness",
    paths: ["packages/desktop/scripts/live-llm/runtime.ts"],
    checks: ["desktop-runtime"],
  },
  {
    id: "live-llm-desktop-subagent-harness",
    paths: ["packages/desktop/scripts/live-llm/desktop-subagents.ts", "packages/desktop/scripts/subagents-live.ts"],
    checks: ["desktop-runtime"],
  },
  {
    id: "live-llm-desktop-ui-harness",
    paths: ["packages/desktop/scripts/live-llm/desktop-ui.ts"],
    checks: ["desktop-runtime"],
  },
  {
    id: "live-llm-autonomous-eval-harness",
    paths: ["packages/deepagent-code/script/live-llm/autonomous-eval.ts"],
    checks: ["live-llm-routes", "tool-bash-sandbox"],
  },
  {
    id: "live-llm-eval-report-harness",
    paths: ["packages/llm/script/live-llm/eval-report.ts"],
    checks: ["live-llm-routes"],
  },
  {
    id: "live-llm-long-session-harness",
    paths: ["packages/desktop/scripts/live-llm/long-session.ts"],
    checks: ["desktop-runtime"],
  },
  {
    id: "live-llm-headless-long-session-harness",
    paths: ["packages/deepagent-code/script/live-llm/long-session.ts"],
    checks: ["session-continuation", "permission"],
  },
  {
    id: "llm-openai-compatible",
    paths: [
      "packages/llm/src/providers/openai-compatible*.ts",
      "packages/llm/src/protocols/openai*.ts",
      "packages/llm/src/route/**",
      "packages/llm/src/schema/**",
      "packages/llm/src/tool*.ts",
    ],
    checks: ["llm-adapter"],
    runs: [adapterProvider, adapterStructured, v2Provider, legacyStructured],
  },
  {
    id: "llm-package",
    paths: ["packages/llm/package.json", "bun.lock"],
    checks: ["llm-adapter"],
    runs: [adapterProvider, adapterStructured, v2Provider],
  },
  {
    id: "llm-other",
    paths: [
      "packages/llm/src/cache-policy.ts",
      "packages/llm/src/index.ts",
      "packages/llm/src/llm.ts",
      "packages/llm/src/provider-error.ts",
      "packages/llm/src/provider.ts",
      "packages/llm/src/providers/**",
      "packages/llm/src/protocols/**",
      "packages/llm/src/utils/**",
    ],
    checks: ["llm-adapter"],
  },
  {
    id: "core-session-runner",
    paths: ["packages/core/src/session/runner/**"],
    checks: ["session-v2"],
    runs: [v2Provider],
  },
  {
    id: "core-session-runtime",
    paths: [
      "packages/core/src/session.ts",
      "packages/core/src/session/input.ts",
      "packages/core/src/session/execution.ts",
      "packages/core/src/session/execution/**",
      "packages/core/src/session/run-coordinator.ts",
      "packages/core/src/session/store.ts",
      "packages/core/src/session/history.ts",
      "packages/core/src/session/context-epoch.ts",
      "packages/core/src/location-layer.ts",
    ],
    checks: ["session-v2"],
  },
  {
    id: "core-session-compaction",
    paths: ["packages/core/src/session/compaction.ts"],
    checks: ["session-v2", "session-continuation"],
  },
  {
    id: "core-session-support",
    paths: [
      "packages/core/src/session/error.ts",
      "packages/core/src/session/event.ts",
      "packages/core/src/session/info.ts",
      "packages/core/src/session/logging.ts",
      "packages/core/src/session/message-id.ts",
      "packages/core/src/session/message-updater.ts",
      "packages/core/src/session/message.ts",
      "packages/core/src/session/projector.ts",
      "packages/core/src/session/prompt.ts",
      "packages/core/src/session/schema.ts",
      "packages/core/src/session/sql.ts",
      "packages/core/src/session/todo.ts",
    ],
    checks: ["session-v2"],
  },
  {
    id: "core-tool-registry",
    paths: [
      "packages/core/src/tool/registry.ts",
      "packages/core/src/tool/tools.ts",
      "packages/core/src/tool/tool.ts",
      "packages/core/src/tool/builtins.ts",
      "packages/core/src/tool/application-tools.ts",
    ],
    checks: ["session-v2", "tool-files", "tool-bash-sandbox"],
    runs: [v2Provider, v2FileRead, v2FileMutations, v2BashRepair],
  },
  {
    id: "core-tool-read-search",
    paths: ["packages/core/src/tool/read.ts", "packages/core/src/tool/glob.ts", "packages/core/src/tool/grep.ts"],
    checks: ["tool-files"],
    runs: [v2FileRead],
  },
  {
    id: "core-tool-mutations",
    paths: [
      "packages/core/src/tool/write.ts",
      "packages/core/src/tool/edit.ts",
      "packages/core/src/tool/apply-patch.ts",
    ],
    checks: ["tool-files"],
    runs: [v2FileMutations],
  },
  {
    id: "core-tool-bash",
    paths: ["packages/core/src/tool/bash.ts"],
    checks: ["tool-bash-sandbox"],
    runs: [v2BashRepair],
  },
  {
    id: "core-tool-support",
    paths: [
      "packages/core/src/tool/question.ts",
      "packages/core/src/tool/skill.ts",
      "packages/core/src/tool/todowrite.ts",
      "packages/core/src/tool/webfetch.ts",
      "packages/core/src/tool/websearch.ts",
    ],
    checks: ["session-v2"],
  },
  {
    id: "legacy-provider",
    paths: ["packages/deepagent-code/src/provider/**"],
    checks: ["llm-adapter", "desktop-runtime"],
    runs: [adapterProvider],
  },
  {
    id: "legacy-config",
    paths: ["packages/deepagent-code/src/config/**"],
    checks: ["llm-adapter", "permission"],
    runs: [
      adapterProvider,
      legacyStructured,
      legacyFileMutations,
      legacyBashRepair,
      legacySubagent,
      worktreeRouting,
      multiAgentParallelWorktrees,
      subagentIntensity,
      subagentResume,
      expertPanel,
    ],
  },
  {
    id: "legacy-session-llm",
    paths: ["packages/deepagent-code/src/session/llm.ts", "packages/deepagent-code/src/session/llm/**/*.ts"],
    checks: ["llm-adapter", "tool-files", "tool-bash-sandbox"],
    runs: [
      adapterProvider,
      legacyStructured,
      legacyFileMutations,
      legacyBashRepair,
      legacySubagent,
      worktreeRouting,
      multiAgentParallelWorktrees,
      subagentIntensity,
      expertPanel,
    ],
  },
  {
    id: "legacy-session-prompt",
    paths: [
      "packages/deepagent-code/src/session/prompt.ts",
      "packages/deepagent-code/src/session/processor.ts",
      "packages/deepagent-code/src/session/tools.ts",
    ],
    checks: ["llm-adapter", "session-continuation", "tool-files", "tool-bash-sandbox", "worktree-routing"],
    runs: [
      adapterProvider,
      legacyStructured,
      legacyFileMutations,
      legacyBashRepair,
      legacySubagent,
      worktreeRouting,
      multiAgentParallelWorktrees,
      subagentResume,
      compactionRetention,
      expertPanel,
      goalGraderCliEntry,
    ],
  },
  {
    id: "legacy-session-continuation",
    paths: [
      "packages/deepagent-code/src/session/steer.ts",
      "packages/deepagent-code/src/session/compaction.ts",
      "packages/deepagent-code/src/session/context-ledger.ts",
      "packages/deepagent-code/src/session/system.ts",
      "packages/core/src/system-context/**",
    ],
    checks: ["session-continuation"],
  },
  {
    id: "legacy-session-instructions",
    paths: [
      "packages/deepagent-code/src/agent/**",
      "packages/deepagent-code/src/session/prompt/**",
      "packages/deepagent-code/src/session/instruction.ts",
      "AGENTS.md",
      "packages/deepagent-code/AGENTS.md",
    ],
    checks: ["llm-adapter"],
    runs: [legacyStructured, legacySubagent, multiAgentPRCollaboration, expertPanel, goalGraderCliEntry],
  },
  {
    id: "legacy-session-support",
    paths: [
      "packages/deepagent-code/src/session/agent-*.ts",
      "packages/deepagent-code/src/session/conversation-log-writer.ts",
      "packages/deepagent-code/src/session/deepagent-multiround.ts",
      "packages/deepagent-code/src/session/digest-builder.ts",
      "packages/deepagent-code/src/session/event-dispatcher.ts",
      "packages/deepagent-code/src/session/goal-*.ts",
      "packages/deepagent-code/src/session/message*.ts",
      "packages/deepagent-code/src/session/multi-agent-runtime.ts",
      "packages/deepagent-code/src/session/overflow.ts",
      "packages/deepagent-code/src/session/reminders.ts",
      "packages/deepagent-code/src/session/retry.ts",
      "packages/deepagent-code/src/session/revert.ts",
      "packages/deepagent-code/src/session/run-state.ts",
      "packages/deepagent-code/src/session/schema.ts",
      "packages/deepagent-code/src/session/session*.ts",
      "packages/deepagent-code/src/session/status.ts",
      "packages/deepagent-code/src/session/summary.ts",
      "packages/deepagent-code/src/session/supervisor-notifier.ts",
      "packages/deepagent-code/src/session/todo.ts",
      "packages/deepagent-code/src/session/v4-event-runtime.ts",
    ],
    checks: ["session-continuation"],
    runs: [subagentResume],
  },
  {
    id: "legacy-tool-registry",
    paths: [
      "packages/deepagent-code/src/tool/registry.ts",
      "packages/deepagent-code/src/tool/tool.ts",
      "packages/deepagent-code/src/tool/schema.ts",
      "packages/deepagent-code/src/tool/define.ts",
    ],
    checks: ["llm-adapter", "tool-files", "tool-bash-sandbox"],
    runs: [
      adapterProvider,
      legacyStructured,
      legacyFileRead,
      legacyFileMutations,
      legacyBashRepair,
      legacySubagent,
      expertPanel,
    ],
  },
  {
    id: "legacy-tool-read-search",
    paths: [
      "packages/deepagent-code/src/tool/read.{ts,txt}",
      "packages/deepagent-code/src/tool/glob.{ts,txt}",
      "packages/deepagent-code/src/tool/grep.{ts,txt}",
    ],
    checks: ["tool-files"],
    runs: [legacyFileRead, expertPanel],
  },
  {
    id: "legacy-tool-mutations",
    paths: [
      "packages/deepagent-code/src/tool/write.{ts,txt}",
      "packages/deepagent-code/src/tool/edit.{ts,txt}",
      "packages/deepagent-code/src/tool/apply_patch*.{ts,txt}",
      "packages/deepagent-code/src/tool/apply-patch-grammar.ts",
    ],
    checks: ["tool-files"],
    runs: [legacyFileMutations],
  },
  {
    id: "legacy-tool-bash",
    paths: [
      "packages/deepagent-code/src/tool/shell.ts",
      "packages/deepagent-code/src/tool/shell/**",
      "packages/deepagent-code/src/tool/validation-result.ts",
      "packages/deepagent-code/src/tool/runtime.ts",
    ],
    checks: ["tool-bash-sandbox"],
    runs: [legacyBashRepair],
  },
  {
    id: "legacy-tool-task",
    paths: [
      "packages/deepagent-code/src/tool/task*.{ts,txt}",
      "packages/deepagent-code/src/tool/task-run.ts",
      "packages/deepagent-code/src/background/**",
    ],
    checks: ["permission", "worktree-routing"],
    runs: [
      legacySubagent,
      worktreeRouting,
      multiAgentParallelWorktrees,
      multiAgentPRCollaboration,
      subagentIntensity,
      subagentResume,
      subagentTakeover,
      interruptedSubagent,
      backgroundSubagent,
      expertPanel,
      goalGraderCliEntry,
    ],
  },
  {
    id: "legacy-subagent-worktree-runtime",
    paths: ["packages/deepagent-code/src/project/instance-*.ts", "packages/deepagent-code/src/worktree/**"],
    checks: ["permission", "worktree-routing"],
    runs: [worktreeRouting, multiAgentParallelWorktrees, multiAgentPRCollaboration],
  },
  {
    id: "legacy-subagent-intensity",
    paths: ["packages/deepagent-code/src/settings/store.ts", "packages/core/src/agent-gateway.ts"],
    checks: ["live-llm-routes"],
    runs: [subagentIntensity],
  },
  {
    id: "legacy-pr-collaboration",
    paths: [
      "packages/deepagent-code/src/agent/pr-*.ts",
      "packages/deepagent-code/src/agent/collaboration-identity.ts",
      "packages/deepagent-code/src/collaboration/review-contract.ts",
      "packages/deepagent-code/src/tool/pr_finalize.ts",
    ],
    checks: ["permission", "worktree-routing", "tool-bash-sandbox"],
    runs: [multiAgentPRCollaboration],
  },
  {
    id: "legacy-tool-read-support",
    paths: [
      "packages/deepagent-code/src/tool/code_intel*.{ts,txt}",
      "packages/deepagent-code/src/tool/context_query.{ts,txt}",
      "packages/deepagent-code/src/tool/cross-file-diagnostics.ts",
      "packages/deepagent-code/src/tool/debug.{ts,txt}",
      "packages/deepagent-code/src/tool/diagnostics-latch.ts",
      "packages/deepagent-code/src/tool/lsp.{ts,txt}",
      "packages/deepagent-code/src/tool/query_log.{ts,txt}",
      "packages/deepagent-code/src/tool/semantic-fingerprint.ts",
    ],
    checks: ["tool-files"],
    runs: [legacyFileRead],
  },
  {
    id: "legacy-tool-support",
    paths: [
      "packages/deepagent-code/src/tool/dismiss_validation.ts",
      "packages/deepagent-code/src/tool/external-directory.ts",
      "packages/deepagent-code/src/tool/internal.ts",
      "packages/deepagent-code/src/tool/invalid.ts",
      "packages/deepagent-code/src/tool/json-schema.ts",
      "packages/deepagent-code/src/tool/mcp-websearch.ts",
      "packages/deepagent-code/src/tool/plan*.{ts,txt}",
      "packages/deepagent-code/src/tool/profile.{ts,txt}",
      "packages/deepagent-code/src/tool/provenance.ts",
      "packages/deepagent-code/src/tool/question.{ts,txt}",
      "packages/deepagent-code/src/tool/skill.{ts,txt}",
      "packages/deepagent-code/src/tool/truncate.ts",
      "packages/deepagent-code/src/tool/truncation-dir.ts",
      "packages/deepagent-code/src/tool/webfetch.{ts,txt}",
      "packages/deepagent-code/src/tool/websearch.{ts,txt}",
    ],
    checks: ["llm-adapter"],
  },
  {
    id: "goal-plan-tool-production",
    paths: [
      "packages/deepagent-code/src/tool/plan*.{ts,txt}",
      "packages/deepagent-code/src/deepagent/validation-exec.ts",
    ],
    checks: ["goal-loop", "permission", "tool-bash-sandbox"],
    runs: [goalGraderCliEntry],
  },
  {
    id: "owning-instructions",
    paths: ["packages/core/src/tool/AGENTS.md", "packages/deepagent-code/src/session/llm/AGENTS.md"],
  },
  {
    id: "legacy-permission",
    paths: ["packages/deepagent-code/src/permission/**"],
    checks: ["permission"],
    runs: [permissionsDeny, multiAgentParallelWorktrees, multiAgentPRCollaboration],
  },
  {
    id: "legacy-subagent-supervision",
    paths: [
      "packages/deepagent-code/src/effect/bridge.ts",
      "packages/deepagent-code/src/effect/instance-ref.ts",
      "packages/deepagent-code/src/effect/run-service.ts",
      "packages/deepagent-code/src/effect/runtime-flags.ts",
      "packages/deepagent-code/src/event-v2-bridge.ts",
      "packages/deepagent-code/src/question/**",
    ],
    checks: ["permission", "worktree-routing"],
    runs: [
      multiAgentParallelWorktrees,
      multiAgentPRCollaboration,
      subagentResume,
      subagentTakeover,
      interruptedSubagent,
      backgroundSubagent,
    ],
  },
  {
    id: "legacy-mcp",
    paths: ["packages/deepagent-code/src/mcp/**"],
    checks: ["mcp"],
    runs: [mcpMarker],
  },
  {
    id: "desktop-runtime",
    paths: [
      "packages/deepagent-code/src/server/routes/**",
      "packages/desktop/src/main/**",
      "packages/desktop/src/preload/**",
      "packages/desktop/electron-builder.*",
      "packages/desktop/package.json",
    ],
    checks: ["desktop-runtime"],
    runs: [packagedSidecar],
  },
  {
    id: "desktop-renderer-runtime",
    paths: [
      "packages/app/src/**/sdk*.ts",
      "packages/app/src/**/event*.ts",
      "packages/app/src/**/prompt*.ts*",
      "packages/app/src/**/timeline*.ts*",
      "packages/app/src/**/tool*.ts*",
      "packages/app/src/**/permission*.ts*",
      "packages/desktop/src/renderer/index.tsx",
      "packages/desktop/src/renderer/initialization.ts",
    ],
    checks: ["ui-runtime"],
  },
  {
    id: "live-llm-routing",
    paths: [
      "packages/deepagent-code/script/live-llm/routes.ts",
      "packages/deepagent-code/script/live-llm/git.ts",
      "packages/deepagent-code/script/live-llm/cache.ts",
      "packages/deepagent-code/script/live-llm/dispatcher.ts",
      "packages/deepagent-code/test/script/live-llm-routes.test.ts",
      "script/pre-push-live-llm.ts",
      "script/hooks",
    ],
    checks: ["live-llm-routes"],
  },
  {
    id: "cli-production",
    paths: [
      "packages/deepagent-code/src/cli/cmd/run.ts",
      "packages/deepagent-code/src/cli/cmd/run/**",
      "packages/deepagent-code/test/cli/run/run-process.test.ts",
      "packages/deepagent-code/script/live-llm/cli-headless.ts",
      "packages/deepagent-code/script/live-llm/cli-goal-loop.ts",
      "packages/deepagent-code/script/live-llm/goal-cli-oracle.ts",
      "packages/deepagent-code/test/script/live-llm-goal-cli-oracle.test.ts",
    ],
    checks: ["goal-loop", "llm-adapter", "permission"],
    runs: [cliHeadless, goalGraderCliEntry],
  },
  {
    id: "expert-panel-production",
    paths: [
      "packages/deepagent-code/src/panel/**",
      "packages/deepagent-code/src/agent/schema/panel.ts",
      "packages/deepagent-code/src/agent/prompt/panel/**",
      "packages/deepagent-code/src/session/goal-loop-wiring.ts",
      "packages/deepagent-code/script/live-llm/expert-panel.ts",
      "packages/deepagent-code/script/live-llm/expert-panel-oracle.ts",
      "packages/deepagent-code/test/script/live-llm-expert-panel-oracle.test.ts",
    ],
    checks: ["expert-panel", "permission"],
    runs: [expertPanel],
  },
  {
    id: "compaction-retention-suite",
    paths: [
      "packages/deepagent-code/script/live-llm/compaction-retention.ts",
      "packages/deepagent-code/src/session/compaction.ts",
      "packages/deepagent-code/src/session/overflow.ts",
    ],
    checks: ["session-continuation"],
    runs: [compactionRetention],
  },
  {
    id: "goal-loop-production",
    paths: [
      "packages/core/src/deepagent/goal-*.ts",
      "packages/core/src/deepagent/plan-controller.ts",
      "packages/deepagent-code/src/agent/agent.ts",
      "packages/deepagent-code/src/agent/subagent-permissions.ts",
      "packages/deepagent-code/src/server/routes/instance/httpapi/groups/deepagent.ts",
      "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/deepagent.ts",
      "packages/deepagent-code/src/session/goal-event.ts",
      "packages/deepagent-code/src/session/goal-status-publisher.ts",
      "packages/deepagent-code/src/session/goal-loop-wiring.ts",
      "packages/deepagent-code/src/session/goal-manager.ts",
      "packages/deepagent-code/src/session/goal-driver.ts",
    ],
    checks: ["goal-loop", "permission"],
    runs: [goalGraderCliEntry],
  },
  {
    id: "intelligence-draft-suite",
    paths: [
      "packages/deepagent-code/script/live-llm/cli-intelligence.ts",
      "packages/deepagent-code/src/session/prompt.ts",
    ],
    checks: ["llm-adapter"],
    runs: [intelligenceDraft],
  },
] satisfies Route[]

export const owningPaths = [
  "packages/llm/src/**",
  "packages/core/src/session/**",
  "packages/core/src/session.ts",
  "packages/core/src/agent-gateway.ts",
  "packages/core/src/tool/**",
  "packages/core/src/deepagent/goal-*.ts",
  "packages/core/src/deepagent/plan-controller.ts",
  "packages/deepagent-code/src/agent/**",
  "packages/deepagent-code/src/cli/cmd/run.ts",
  "packages/deepagent-code/src/cli/cmd/run/**",
  "packages/deepagent-code/src/config/**",
  "packages/deepagent-code/src/effect/bridge.ts",
  "packages/deepagent-code/src/effect/instance-ref.ts",
  "packages/deepagent-code/src/effect/run-service.ts",
  "packages/deepagent-code/src/event-v2-bridge.ts",
  "packages/deepagent-code/src/panel/**",
  "packages/deepagent-code/src/permission/**",
  "packages/deepagent-code/src/project/instance-*.ts",
  "packages/deepagent-code/src/server/routes/instance/httpapi/groups/deepagent.ts",
  "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/deepagent.ts",
  "packages/deepagent-code/src/session/**",
  "packages/deepagent-code/src/settings/**",
  "packages/deepagent-code/src/tool/**",
  "packages/deepagent-code/src/provider/**",
  "packages/deepagent-code/src/question/**",
  "packages/deepagent-code/src/mcp/**",
  "packages/deepagent-code/src/worktree/**",
  "packages/desktop/src/main/**",
  "packages/desktop/src/preload/**",
]

export function selectRoutes(paths: Iterable<string>) {
  const normalized = new Set<string>()
  const invalid = new Set<string>()

  for (const path of paths) {
    const value = normalizePath(path)
    if (!value) {
      invalid.add(path)
      continue
    }
    normalized.add(value)
  }

  const matched = new Set<string>()
  const checks = new Set<DeterministicCheck>()
  const runs = new Map<string, ModelRun>()
  const classified = new Set<string>()

  for (const route of routeManifest) {
    const matching = [...normalized].filter((path) => route.paths.some((pattern) => minimatch(path, pattern)))
    if (!matching.length) continue
    matched.add(route.id)
    matching.forEach((path) => classified.add(path))
    route.checks?.forEach((check) => checks.add(check))
    route.runs?.forEach((run) => runs.set(modelRunKey(run), run))
  }

  const unclassified = [...normalized].filter(
    (path) => !classified.has(path) && owningPaths.some((pattern) => minimatch(path, pattern)),
  )

  return {
    paths: [...normalized].sort(),
    matchedRoutes: [...matched].sort(),
    checks: [...checks].sort(),
    runs: [...runs.values()].sort((a, b) => modelRunKey(a).localeCompare(modelRunKey(b))),
    unclassified: unclassified.sort(),
    invalid: [...invalid].sort(),
  }
}

export function modelRunKey(run: ModelRun) {
  return `${run.mode}:${run.stack}:${run.suite}`
}

function modelRun(mode: ModelMode, stack: ExecutionStack, suite: ModelSuite): ModelRun {
  return { mode, stack, suite }
}

function normalizePath(path: string) {
  const value = path.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!value || value.includes("\0") || value.startsWith("/") || value.split("/").includes("..")) return
  return value
}
