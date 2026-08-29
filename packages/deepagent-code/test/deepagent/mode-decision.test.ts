import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Model } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { cleanupRunsDir, deepagentRunInput, tempRunsDir } from "./_gateway"

// V3.1 global runtime: activation and fail-closed behavior are decided by agent STRENGTH,
// not by providerID. These are behavior tests (the production entrypoints manageStream /
// routeRequest / snapshot), not source-string assertions.
describe("DeepAgent mode decision (global runtime)", () => {
  test("kill switch fails closed for every provider", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, killSwitch: true })
      const exit = await Effect.runPromise(
        AgentGateway.manageStream(
          { ...deepagentRunInput, providerID: "openai", modelID: "gpt-test" },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect, Effect.exit),
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("general strength is pure passthrough; high activates the runtime", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: dir })
      expect(AgentGateway.snapshot()).toMatchObject({ mode: "off", agentMode: "general", agentManaged: false })

      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir })
      expect(AgentGateway.snapshot()).toMatchObject({ mode: "enabled", agentMode: "high", agentManaged: true })
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("routeRequest decorates only when the runtime is active (strength-gated)", async () => {
    const dir = await tempRunsDir()
    try {
      const request = LLMRequestFixture()
      AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: dir })
      const general = AgentGateway.routeRequest(request)
      expect(isRecord(general.metadata?.deepagent) && "router" in (general.metadata!.deepagent as object)).toBe(false)

      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir })
      const high = AgentGateway.routeRequest(request)
      expect(isRecord(high.metadata?.deepagent) && "router" in (high.metadata!.deepagent as object)).toBe(true)
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const LLMRequestFixture = () =>
  LLM.request({
    id: "req_mode",
    model: Model.make({ id: "gpt-test", provider: "openai", route: OpenAIChat.route }),
    prompt: "hello",
  })
