import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLMEvent, type LLMEvent as LLMEventType } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

export const deepagentRunInput = {
  callKind: "session_turn" as const,
  feature: "session_chat",
  providerID: "deepagent",
  modelID: "deepagent/default",
  sessionID: "ses_deepagent",
  messageID: "msg_deepagent",
  workspaceID: "workspace_deepagent",
  agent: "test",
  origin: {
    file: "packages/core/src/session/runner/llm.ts",
    function: "SessionRunner.runTurn",
  },
}

export const tempRunsDir = () => mkdtemp(path.join(tmpdir(), "deepagent-code-"))

export const cleanupRunsDir = async (dir: string) => {
  AgentGateway.configure({
    enabled: false,
    agentMode: "high",
    runsDir: undefined,
    resumeFrom: undefined,
    killSwitch: false,
    allowProviderExecutedTools: false,
    allowProviderExecutedToolNames: [],
    modelRouter: {
      upstreamProviderID: "deepagent-upstream",
      upstreamModelID: "deepagent/default-upstream",
      reason: "DeepAgent provider default router policy",
      userPreference: "none",
    },
  })
  await rm(dir, { recursive: true, force: true })
}

export const onlyRunDir = async (dir: string) => {
  const runs = await readdir(dir)
  expect(runs).toHaveLength(1)
  return path.join(dir, runs[0]!)
}

export const readJson = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), "utf8"))

export const sha256Text = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`

export const runDeepAgentStream = async (
  dir: string,
  events: Stream.Stream<LLMEventType, never, never> = Stream.make(
    LLMEvent.textDelta({ id: "text-0", text: "ok" }),
    LLMEvent.finish({ reason: "stop", usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 2, totalTokens: 20 } }),
  ),
  mode: "high" | "max" = "high",
  input = deepagentRunInput,
) => {
  AgentGateway.configure({ enabled: true, agentMode: mode, runsDir: dir, allowProviderExecutedTools: false })
  await Effect.runPromise(AgentGateway.manageStream(input, events).pipe(Stream.runCollect))
  // E1: background learning is now queued off the main thread; flush it so tests observe a
  // deterministic post-finalization state (project memory / inbox written).
  await AgentGateway.flushLearning()
  return onlyRunDir(dir)
}
