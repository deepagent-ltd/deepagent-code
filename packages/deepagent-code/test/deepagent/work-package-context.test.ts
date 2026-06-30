import { describe, expect, test } from "bun:test"
import { cleanupRunsDir, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent work package context", () => {
  test("high mode carries bounded knowledge but never strategy refs (docs/39)", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      const workPackage = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      expect(workPackage.artifact_refs.map((ref: { ref_id: string }) => ref.ref_id)).toEqual(
        expect.arrayContaining([
          "artifact:run_state",
          "artifact:candidate_lineage",
          "artifact:output_contract",
          "artifact:design",
          "artifact:handoff",
          "artifact:test",
          "artifact:history",
        ]),
      )
      expect(workPackage.document_refs.map((ref: { ref_id: string }) => ref.ref_id)).toEqual(
        expect.arrayContaining(["doc:design", "doc:handoff", "doc:test", "doc:history"]),
      )
      expect(workPackage.required_outputs).toEqual(
        expect.arrayContaining(["DESIGN.md", "HANDOFF.md", "TEST.md", "HISTORY.md"]),
      )
      expect(workPackage.agent_mode).toBe("high")
      // docs/39 §3.1: high has durable retrieval enabled, but strategies/methodologies stay off.
      expect(workPackage.knowledge_enabled).toBe(true)
      expect(workPackage.selected_strategy_refs).toEqual([])
      expect(workPackage.knowledge_retrieval).toMatchObject({ enabled: true })
      expect(workPackage.mcp_capability_summary).toMatchObject({
        ref: "MCP_CAPABILITY_INDEX.json",
        execution_owner: "generic_agent_tool_registry_or_mcp",
        deepagent_executes_mcp_directly: false,
      })
      expect(workPackage.task_summary).toContain("global runtime")
      expect(JSON.stringify(workPackage)).not.toContain("official_hidden")
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
