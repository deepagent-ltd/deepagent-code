import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "../../src/agent-gateway"

const tempRunsDir = () => mkdtemp(path.join(tmpdir(), "deepagent-provider-tool-"))

describe("DeepAgent provider-executed tool gate", () => {
  test("blocks hosted tools unless explicitly allowlisted", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, allowProviderExecutedTools: false })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            {
              callKind: "session_turn",
              feature: "session_chat",
              providerID: "deepagent",
              modelID: "deepagent/default",
              sessionID: "ses_deepagent",
              messageID: "msg_deepagent",
            },
            Stream.make(
              LLMEvent.toolCall({
                id: "tool_1",
                name: "local_shell",
                input: { command: "pwd" },
                providerExecuted: true,
              }),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("provider-executed tool")

      const runs = await readdir(dir)
      const binding = JSON.parse(await readFile(path.join(dir, runs[0]!, "deepagent_generic_agent_binding.json"), "utf8"))
      expect(binding.provider_executed_tool_observations[0]).toMatchObject({
        provider_executed: true,
        tool_type: "local_shell",
        policy_decision: "blocked",
      })
    } finally {
      AgentGateway.configure({
        enabled: false,
        runsDir: undefined,
        allowProviderExecutedTools: false,
        allowProviderExecutedToolNames: [],
      })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not treat the hosted tool switch as a wildcard allowlist", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        runsDir: dir,
        allowProviderExecutedTools: true,
        allowProviderExecutedToolNames: ["web_search"],
      })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            {
              callKind: "session_turn",
              feature: "session_chat",
              providerID: "deepagent",
              modelID: "deepagent/default",
              sessionID: "ses_deepagent",
              messageID: "msg_deepagent",
            },
            Stream.make(
              LLMEvent.toolCall({
                id: "tool_1",
                name: "code_interpreter_call",
                input: { code: "print(1)" },
                providerExecuted: true,
              }),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("provider-executed tool")
    } finally {
      AgentGateway.configure({
        enabled: false,
        runsDir: undefined,
        allowProviderExecutedTools: false,
        allowProviderExecutedToolNames: [],
      })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("allows only named provider-executed tools", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        runsDir: dir,
        allowProviderExecutedTools: true,
        allowProviderExecutedToolNames: ["web_search"],
      })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            callKind: "session_turn",
            feature: "session_chat",
            providerID: "deepagent",
            modelID: "deepagent/default",
            sessionID: "ses_deepagent",
            messageID: "msg_deepagent",
          },
          Stream.make(
            LLMEvent.toolCall({
              id: "tool_1",
              name: "web_search",
              input: { query: "docs" },
              providerExecuted: true,
            }),
            LLMEvent.finish({ reason: "stop" }),
          ),
        ).pipe(Stream.runCollect),
      )

      const runs = await readdir(dir)
      const binding = JSON.parse(await readFile(path.join(dir, runs[0]!, "deepagent_generic_agent_binding.json"), "utf8"))
      expect(binding.provider_executed_tool_observations[0]).toMatchObject({
        provider_executed: true,
        tool_type: "web_search",
        policy_decision: "allowed",
      })
    } finally {
      AgentGateway.configure({
        enabled: false,
        runsDir: undefined,
        allowProviderExecutedTools: false,
        allowProviderExecutedToolNames: [],
      })
      await rm(dir, { recursive: true, force: true })
    }
  })
})
