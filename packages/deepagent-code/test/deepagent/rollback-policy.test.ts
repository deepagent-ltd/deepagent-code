import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Stream } from "effect"
import { LLMEvent } from "@deepagent-code/llm"
import { cleanupRunsDir, readJson, runDeepAgentStream, sha256Text, tempRunsDir } from "./_gateway"

describe("DeepAgent rollback policy", () => {
  test("blocked runs keep failure dossier and require review before resume", async () => {
    const dir = await tempRunsDir()
    try {
      await expect(
        runDeepAgentStream(
          dir,
          Stream.make(LLMEvent.toolCall({ id: "tool_1", name: "hosted", input: {}, providerExecuted: true })),
        ),
      ).rejects.toThrow("provider-executed tool")
      const runDir = await import("node:fs/promises").then(async (fs) => {
        const runs = await fs.readdir(dir)
        return `${dir}/${runs[0]!}`
      })
      expect(await import("node:fs/promises").then((fs) => fs.readdir(runDir))).toContain("FAILURE_DOSSIER.md")
      const checkpoint = await readJson(runDir, "run_checkpoint_manifest.json")
      expect(checkpoint).toMatchObject({
        resume_policy: { decision: "review_required" },
      })
      const failureRef = checkpoint.run_context_refs.find((ref: { kind: string }) => ref.kind === "failure_dossier")
      expect(failureRef.sha256).toBe(sha256Text(await readFile(path.join(runDir, "FAILURE_DOSSIER.md"), "utf8")))
      expect(await readJson(runDir, "CANDIDATE_LINEAGE.json")).toMatchObject({
        nodes: [{ status: "runtime_failed", failure_dossier_ref: expect.any(String) }],
      })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
