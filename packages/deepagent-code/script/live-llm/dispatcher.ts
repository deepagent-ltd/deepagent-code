import type { DeterministicCheck, ModelRun } from "./routes"
import { modelRunKey } from "./routes"

export type DispatcherCommand = {
  cwd: string
  args: string[]
}

const checkCommands: Record<DeterministicCheck, DispatcherCommand[]> = {
  "expert-panel": [
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/panel/arbiter.test.ts",
      "test/panel/consult.test.ts",
      "test/panel/orchestrator.test.ts",
      "test/script/live-llm-expert-panel-oracle.test.ts",
      "test/session/goal-loop-wiring.test.ts",
    ),
  ],
  "goal-loop": [
    command("packages/core", "bun", "test", "test/deepagent/goal-loop.test.ts"),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/cli/run/run-process.test.ts",
      "test/script/live-llm-goal-cli-oracle.test.ts",
      "test/session/goal-loop-wiring.test.ts",
      "test/session/goal-steer.test.ts",
    ),
  ],
  "live-llm-routes": [command("packages/deepagent-code", "bun", "run", "test:llm-routes")],
  "llm-adapter": [
    command("packages/llm", "bun", "typecheck"),
    command("packages/llm", "bun", "test", "test/adapter.test.ts", "test/schema.test.ts", "test/executor.test.ts"),
    command("packages/deepagent-code", "bun", "test", "test/provider/compatibility.test.ts"),
  ],
  "session-v2": [
    command("packages/core", "bun", "typecheck"),
    command(
      "packages/core",
      "bun",
      "test",
      "test/session-runner.test.ts",
      "test/session-projector.test.ts",
      "test/session-run-coordinator.test.ts",
    ),
  ],
  "session-continuation": [
    command("packages/core", "bun", "test", "test/session-compaction.test.ts", "test/session-projector.test.ts"),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/session/compaction.test.ts",
      "test/session/context-ledger.test.ts",
      "test/session/steer.test.ts",
    ),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/session/prompt.test.ts",
      "--test-name-pattern",
      "World State",
    ),
  ],
  "tool-files": [
    command(
      "packages/core",
      "bun",
      "test",
      "test/tool-read.test.ts",
      "test/tool-write.test.ts",
      "test/tool-edit.test.ts",
      "test/tool-apply-patch.test.ts",
      "test/tool-glob.test.ts",
      "test/tool-grep.test.ts",
    ),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/tool/read.test.ts",
      "test/tool/write.test.ts",
      "test/tool/edit.test.ts",
    ),
  ],
  "tool-bash-sandbox": [
    command("packages/core", "bun", "run", "test:llm-sandbox"),
    command(
      "packages/core",
      "bun",
      "test",
      "test/tool-bash.test.ts",
      "test/process/process.test.ts",
      "test/effect/cross-spawn-spawner.test.ts",
    ),
    command("packages/deepagent-code", "bun", "test", "test/tool/shell.test.ts"),
  ],
  permission: [
    command("packages/deepagent-code", "bun", "typecheck"),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/permission/next.test.ts",
      "test/question/question.test.ts",
      "test/permission-task.test.ts",
      "test/agent/subagent-plan-permission.test.ts",
    ),
  ],
  mcp: [
    command("packages/deepagent-code", "bun", "typecheck"),
    command("packages/deepagent-code", "bun", "test", "test/mcp", "test/deepagent/mcp-provenance.test.ts"),
  ],
  "desktop-runtime": [
    command("packages/deepagent-code", "bun", "typecheck"),
    command("packages/desktop", "bun", "typecheck"),
    command("packages/desktop", "bun", "test"),
  ],
  "ui-runtime": [command("packages/app", "bun", "typecheck"), command("packages/app", "bun", "run", "test:unit")],
  "worktree-routing": [
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/session/prompt.test.ts",
      "--test-name-pattern",
      "runs a prompt in the persisted session directory",
    ),
    command(
      "packages/deepagent-code",
      "bun",
      "test",
      "test/tool/task.test.ts",
      "--test-name-pattern",
      "persists the canonical worktree directory",
    ),
  ],
}

const modelCommands = new Map<string, DispatcherCommand>([
  ["live:adapter:provider-smoke", command("packages/llm", "bun", "run", "test:llm-live:provider")],
  ["live:adapter:structured-output", command("packages/llm", "bun", "run", "test:llm-live:structured-adapter")],
  ["live:session-v2:v2-provider-loop", command("packages/core", "bun", "run", "test:llm-live:v2-provider-loop")],
  [
    "live:legacy-session:structured-output",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:structured-legacy"),
  ],
  ["live:session-v2:file-read-search", command("packages/core", "bun", "run", "test:llm-live:file-read")],
  ["live:session-v2:file-mutations", command("packages/core", "bun", "run", "test:llm-live:file-mutations")],
  ["live:legacy-session:file-read-search", command("packages/deepagent-code", "bun", "run", "test:llm-live:file-read")],
  [
    "live:legacy-session:file-mutations",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:file-mutations"),
  ],
  ["live:session-v2:bash-repair", command("packages/core", "bun", "run", "test:llm-live:bash-repair")],
  ["live:legacy-session:bash-repair", command("packages/deepagent-code", "bun", "run", "test:llm-live:bash-repair")],
  [
    "live:legacy-session:subagent-foreground",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:subagent-foreground"),
  ],
  [
    "live:legacy-session:shell-exit-contract",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:shell-exit-contract"),
  ],
  [
    "live:legacy-session:stale-validation",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:stale-validation"),
  ],
  ["live:legacy-session:degeneration", command("packages/deepagent-code", "bun", "run", "test:llm-live:degeneration")],
  [
    "ext:legacy-session:subagent-finalizer-isolation",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:finalizer-isolation"),
  ],
  [
    "live:legacy-session:steer-boundary",
    command("packages/deepagent-code", "bun", "run", "test:llm-live:steer-boundary"),
  ],
  [
    "ext:legacy-session:subagent-worktree-routing",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-worktree"),
  ],
  [
    "ext:legacy-session:multi-agent-dag",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:multi-agent-dag"),
  ],
  [
    "ext:legacy-session:multi-agent-parallel-worktrees",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:multi-agent-parallel-worktrees"),
  ],
  [
    "ext:legacy-session:multi-agent-pr-collaboration",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:multi-agent-pr-collaboration"),
  ],
  [
    "ext:v4-event-runtime:v4-multi-agent-runtime",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:v4-multi-agent-runtime"),
  ],
  [
    "ext:legacy-session:subagent-intensity",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-intensity"),
  ],
  [
    "ext:legacy-session:subagent-resume",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-resume"),
  ],
  [
    "ext:legacy-session:subagent-takeover",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-takeover"),
  ],
  [
    "ext:legacy-session:subagent-interrupted",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-interrupted"),
  ],
  [
    "ext:legacy-session:subagent-background",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:subagent-background"),
  ],
  [
    "ext:legacy-session:permissions-deny",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:permissions-deny"),
  ],
  ["ext:legacy-session:mcp-marker", command("packages/deepagent-code", "bun", "run", "test:llm-ext:mcp-marker")],
  ["ext:adapter:provider-abort", command("packages/llm", "bun", "run", "test:llm-ext:provider-abort")],
  ["ext:packaged-sidecar:packaged-sidecar", command("packages/desktop", "bun", "run", "test:llm-ext:sidecar")],
  ["ext:packaged-sidecar:desktop-subagents", command("packages/desktop", "bun", "run", "test:llm-release:subagents")],
  ["ext:renderer-ui:desktop-ui", command("packages/desktop", "bun", "run", "test:llm-release:ui")],
  ["live:cli-subprocess:cli-headless", command("packages/deepagent-code", "bun", "run", "test:llm-live:cli-headless")],
  [
    "ext:cli-subprocess:goal-grader-cli-entry",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:goal-cli"),
  ],
  [
    "ext:legacy-session:compaction-retention",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:compaction-retention"),
  ],
  ["ext:legacy-session:expert-panel", command("packages/deepagent-code", "bun", "run", "test:llm-ext:expert-panel")],
  [
    "ext:legacy-session:intelligence-draft-confirmation",
    command("packages/deepagent-code", "bun", "run", "test:llm-ext:intelligence-draft"),
  ],
])

// Registration is not qualification. A LIVE suite enters this set only after its committed harness,
// fixed model fingerprint, mutation self-test, and 30/30 evidence have been reviewed together.
export const qualifiedLiveRuns = new Set<string>()

export function commandsForChecks(checks: Iterable<DeterministicCheck>) {
  const commands = new Map<string, DispatcherCommand>()
  for (const check of checks) {
    for (const item of checkCommands[check]) commands.set(`${item.cwd}\0${item.args.join("\0")}`, item)
  }
  return [...commands.values()]
}

export function commandForModelRun(run: ModelRun) {
  return modelCommands.get(modelRunKey(run))
}

export function unqualifiedRuns(runs: Iterable<ModelRun>) {
  return [...runs].filter((run) => run.mode === "live" && !qualifiedLiveRuns.has(modelRunKey(run)))
}

function command(cwd: string, ...args: string[]): DispatcherCommand {
  return { cwd, args }
}
