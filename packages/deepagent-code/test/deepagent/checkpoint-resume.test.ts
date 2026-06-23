import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, onlyRunDir, deepagentRunInput, runDeepAgentStream, sha256Text, tempRunsDir } from "./_gateway"

describe("DeepAgent checkpoint resume", () => {
  test("requires a matching checkpoint hash before resume", async () => {
    const dir = await tempRunsDir()
    try {
      const firstRun = await runDeepAgentStream(dir)
      const checkpointPath = path.join(firstRun, "run_checkpoint_manifest.json")
      const checkpointHash = sha256Text(await readFile(checkpointPath, "utf8"))

      AgentGateway.configure({ enabled: true, runsDir: dir, resumeFrom: { checkpointPath, expectedCheckpointHash: checkpointHash } })
      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(Stream.runCollect),
      )

      const runs = await import("node:fs/promises").then((fs) => fs.readdir(dir))
      expect(runs).toHaveLength(2)
      const secondRun = path.join(dir, runs.find((name) => path.join(dir, name) !== firstRun)!)
      expect(await import("node:fs/promises").then((fs) => fs.readdir(secondRun))).toContain("human_intervention_record.json")

      AgentGateway.configure({
        enabled: true,
        runsDir: dir,
        resumeFrom: { checkpointPath, expectedCheckpointHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      })
      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("checkpoint hash mismatch")
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})

