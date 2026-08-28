import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, deepagentRunInput, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent production release gate", () => {
  test("kill switch blocks global runtime without writing artifacts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, killSwitch: true })
      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
            Stream.runCollect,
          ),
        ),
      ).rejects.toThrow("kill switch")
      expect(await readdir(dir)).toHaveLength(0)
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("release bundle records rollback guarantees", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      expect(await readJson(runDir, "release_bundle_manifest.json")).toMatchObject({
        runtime_scope: "global",
        gateway_version: "deepagent-global-runtime.v1",
        agent_mode: "high",
        rollback: {
          disable_deepagent_runtime_preserves_upstream_providers: true,
          artifacts_retained_for_audit: true,
          memory_promotion_revocable: true,
        },
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
