import { describe, expect, test } from "bun:test"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent monitor snapshot", () => {
  test("shows status and refs without raw reasoning", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      const monitor = await readJson(runDir, "run_monitor_snapshot.json")
      expect(monitor.reasoning).toMatchObject({ visible: false, raw_hidden: true, summary: null })
      expect(monitor.artifact_refs.map((ref: { kind: string }) => ref.kind)).toContain("tool_audit")
      expect(monitor.checkpoint_refs[0]).toMatchObject({ kind: "checkpoint", ref: "run_checkpoint_manifest.json" })
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})

