import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { cleanupRunsDir, deepagentRunInput, readJson, runDeepAgentStream, tempRunsDir } from "./_gateway"

describe("DeepAgent max knowledge mode", () => {
  test("uses bounded refs-only retrieval and stages learning candidates", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })
      const runDir = await runDeepAgentStream(dir, undefined, "max", {
        ...deepagentRunInput,
        feature: "optimize sgemm cuda kernel shared memory",
      })

      const knowledge = await readJson(runDir, "KNOWLEDGE_RETRIEVAL_RESULT.json")
      expect(knowledge).toMatchObject({
        agent_mode: "max",
        enabled: true,
        retrieval_mode: "v3_retriever",
        retriever: "packages/core/src/deepagent/knowledge-retriever.ts",
        prompt_injection_policy: {
          inject_synthesis: true,
          inject_full_strategy_body: false,
          inject_full_memory_body: false,
          inject_full_skill_body: false,
        },
      })
      // DAP-11: curated strategies/methodologies are seeded into DocumentStore (slug-derived ids
      // like doc:strategy:...). The default run feature is gpu/kernel-flavored, so domain-pack gpu
      // strategies legitimately fill the bounded top-k. Assert the contract (bounded refs-only,
      // valid kinds, at least one strategy ref present) rather than a specific in-code ref id.
      const refIds = knowledge.selected_refs.map((ref: { ref_id: string }) => ref.ref_id)
      expect(refIds.length).toBeGreaterThan(0)
      expect(refIds.some((id: string) => id.startsWith("doc:strategy:"))).toBe(true)
      expect(knowledge.selected_refs.every((ref: { kind: string }) => ["strategy", "methodology", "knowledge", "skill", "memory"].includes(ref.kind))).toBe(true)
      expect(knowledge.retrieval_policy.topk_by_kind).toEqual({ strategy: 3, methodology: 2, knowledge: 2, skill: 2, memory: 3 })

      const workPackage = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      expect(workPackage).toMatchObject({
        agent_mode: "max",
        knowledge_enabled: true,
      })
      expect(workPackage.knowledge_retrieval.selected_refs).toEqual(
        knowledge.selected_refs.map((ref: { ref_id: string }) => ref.ref_id),
      )
      const learning = await readJson(runDir, "LEARNING_WRITEBACK_MANIFEST.json")
      expect(learning).toMatchObject({
        promotion_decision: "staged",
      })
      expect(learning.skill_candidates).toEqual([])
      expect(learning.strategy_candidates.some((candidate: { source_ref: string; status: string }) =>
        candidate.status === "staged" && candidate.source_ref === "KNOWLEDGE_RETRIEVAL_RESULT.json",
      )).toBe(true)
    } finally {
      await cleanupRunsDir(dir)
    }
  })
})
