import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, deepagentRunInput, tempRunsDir } from "./_gateway"

// V3.1 global runtime: DeepAgent is the runtime for EVERY upstream provider, gated by
// agent strength (not by providerID). These behavior tests replace the old source-string
// guard that asserted the provider-scoped boundary, which V3.1 reverses.
const upstreamRunInput = { ...deepagentRunInput, providerID: "openai", modelID: "gpt-test" }

const stream = () =>
  Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" }), LLMEvent.finish({ reason: "stop" }))

describe("DeepAgent global runtime boundary (V3.1)", () => {
  test("high mode manages an upstream (non-deepagent) provider and writes artifacts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })
      const events = await Effect.runPromise(
        AgentGateway.manageStream(upstreamRunInput, stream()).pipe(Stream.runCollect),
      )
      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      // The upstream provider is now managed: a run directory is produced.
      expect(await readdir(dir)).toHaveLength(1)
      // The DeepAgent system prompt is injected for every provider under an active strength.
      expect(AgentGateway.systemPrompt("openai").join("\n")).not.toBe("")
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("general mode is pure passthrough for an upstream provider (protects the baseline)", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: dir, allowProviderExecutedTools: false })
      const events = await Effect.runPromise(
        AgentGateway.manageStream(upstreamRunInput, stream()).pipe(Stream.runCollect),
      )
      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      // general = zero artifacts, no DeepAgent system prompt: the inherited path is untouched.
      expect(await readdir(dir)).toHaveLength(0)
      expect(AgentGateway.systemPrompt("openai")).toEqual([])
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
