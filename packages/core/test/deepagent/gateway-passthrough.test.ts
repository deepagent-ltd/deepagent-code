import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "../../src/agent-gateway"

const tempRunsDir = () => mkdtemp(path.join(tmpdir(), "deepagent-passthrough-"))

const readJson = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), "utf8"))

describe("DeepAgent gateway runtime", () => {
  test("writes managed artifacts for every upstream provider", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            callKind: "session_turn",
            feature: "session_chat",
            providerID: "openai",
            modelID: "gpt-test",
            sessionID: "ses_default",
            messageID: "msg_default",
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      const openaiRuns = await readdir(dir)
      expect(openaiRuns).toHaveLength(1)

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
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "ok" }), LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      const runs = await readdir(dir)
      expect(runs).toHaveLength(2)
      const runDir = path.join(dir, runs.find((name) => name !== openaiRuns[0])!)
      expect(await readJson(runDir, "deepagent_generic_agent_binding.json")).toMatchObject({
        provider_id: "deepagent",
        agent_managed: true,
        original_path_allowed: false,
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })
})
