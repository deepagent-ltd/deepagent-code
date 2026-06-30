import { describe, expect, test } from "bun:test"
import { Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent tool audit preserves generic agent execution", () => {
  test("audits local tool hashes without taking over execution", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(
        dir,
        Stream.make(
          LLMEvent.toolCall({ id: "tool_1", name: "local_shell", input: { command: "pwd" } }),
          LLMEvent.toolResult({ id: "tool_1", name: "local_shell", result: { type: "text", value: "/repo" } }),
          LLMEvent.finish({ reason: "stop" }),
        ),
      )
      expect(await readJson(runDir, "TOOL_AUDIT.json")).toMatchObject({
        execution_boundary: "generic_agent_tool_registry_and_mcp_preserved",
        events: [
          {
            event_type: "tool-call",
            provider_executed: false,
            execution_owner: "generic_agent_tool_registry_or_mcp",
            policy_decision: "observed_after_execution",
          },
          {
            event_type: "tool-result",
            provider_executed: false,
            execution_owner: "generic_agent_tool_registry_or_mcp",
            policy_decision: "observed_after_execution",
          },
        ],
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
