import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { cleanupRunsDir, readJson, runDeepAgentStream, sha256Text, tempRunsDir } from "./_gateway"

describe("DeepAgent control-plane artifacts", () => {
  test("writes phase 3 control-plane artifacts without human intervention when no intervention occurred", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      const files = await readdir(runDir)

      expect(files).toContain("TASK_SPEC.json")
      expect(files).toContain("DEEPAGENT_BOOT_MESSAGE.md")
      expect(files).toContain("PROBLEM_PROFILE.json")
      expect(files).toContain("MODEL_WORK_PACKAGE.json")
      expect(files).toContain("DESIGN.md")
      expect(files).toContain("HANDOFF.md")
      expect(files).toContain("TEST.md")
      expect(files).toContain("HISTORY.md")
      expect(files).toContain("ACTIVATION_POLICY.json")
      expect(files).toContain("MCP_CAPABILITY_INDEX.json")
      expect(files).toContain("KNOWLEDGE_RETRIEVAL_RESULT.json")
      expect(files).toContain("DETERMINISTIC_RESULT.json")
      expect(files).toContain("DIAGNOSIS_RESULT.json")
      expect(files).toContain("SCHEMA_VALIDATION_REPORT.json")
      expect(files).toContain("RUN_CONTEXT.md")
      expect(files).toContain("CANDIDATE_LINEAGE.json")
      expect(files).toContain("OUTPUT_CONTRACT.json")
      expect(files).toContain("run_checkpoint_manifest.json")
      expect(files).toContain("resource_usage_record.json")
      expect(files).toContain("TOOL_AUDIT.json")
      expect(files).not.toContain("human_intervention_record.json")

      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        provider_id: "deepagent",
        deepagent_system_active: true,
        boot_message_ref: "DEEPAGENT_BOOT_MESSAGE.md",
        checkpoint_ref: expect.stringContaining("run_checkpoint_manifest:"),
        default_agent_preserved: true,
        tool_mcp_preserved: true,
      })
      const bootMessage = await readFile(path.join(runDir, "DEEPAGENT_BOOT_MESSAGE.md"), "utf8")
      expect(bootMessage).toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
      expect(bootMessage).toContain("当前模式: high")
      const runContext = await readFile(path.join(runDir, "RUN_CONTEXT.md"), "utf8")
      expect(runContext).toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
      expect(await readFile(path.join(runDir, "DESIGN.md"), "utf8")).toContain("# Design")
      expect(await readFile(path.join(runDir, "HANDOFF.md"), "utf8")).toContain("# Handoff")
      expect(await readFile(path.join(runDir, "TEST.md"), "utf8")).toContain("# Test")
      expect(await readFile(path.join(runDir, "HISTORY.md"), "utf8")).toContain("# History")
      const graph = new AgentGateway.DeepAgentDocumentStore.DocumentStore(path.join(runDir, "graph"))
      const graphRunContext = graph.list({ type: "run_context", scope: `run:${path.basename(runDir)}` })[0]
      expect(graphRunContext).toBeDefined()
      expect(graph.get(graphRunContext!.id)?.body).toBe(runContext)
      expect(await readJson(runDir, "run_checkpoint_manifest.json")).toMatchObject({
        group: "production",
        resume_policy: { decision: "resume_allowed" },
      })
      expect(await readJson(runDir, "ACTIVATION_POLICY.json")).toMatchObject({
        agent_mode: "high",
        default_activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        full_skill_body_in_prompt_allowed: false,
      })
      expect(await readJson(runDir, "MCP_CAPABILITY_INDEX.json")).toMatchObject({
        source_runtime: "generic_agent_mcp_registry",
        execution_owner: "generic_agent_tool_registry_or_mcp",
        provider_hosted_mcp_allowed: false,
      })
      expect(await readJson(runDir, "SCHEMA_VALIDATION_REPORT.json")).toMatchObject({ status: "pass" })
      const checkpoint = await readJson(runDir, "run_checkpoint_manifest.json")
      const runStateRef = checkpoint.run_context_refs.find((ref: { kind: string }) => ref.kind === "run_state")
      expect(runStateRef.sha256).toBe(sha256Text(await readFile(path.join(runDir, "DEEPAGENT_RUN_STATE.json"), "utf8")))
      expect(
        checkpoint.run_context_refs.find((ref: { kind: string }) => ref.kind === "deterministic_result"),
      ).toBeTruthy()
      for (const kind of ["design", "handoff", "test", "history_private"]) {
        expect(checkpoint.run_context_refs.find((ref: { kind: string }) => ref.kind === kind)).toBeTruthy()
      }
      const bootMessageRef = checkpoint.run_context_refs.find((ref: { kind: string }) => ref.kind === "boot_message")
      expect(bootMessageRef.sha256).toBe(
        sha256Text(await readFile(path.join(runDir, "DEEPAGENT_BOOT_MESSAGE.md"), "utf8")),
      )
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  // L5 (S1-v3.4): the MODEL_WORK_PACKAGE manifest carries a code_intel evidence artifact ref
  // tagged with the new `evidence_kind` dimension (orthogonal to artifact_type). The type guard
  // accepts the V3.4 value plus the V3.5-reserved values.
  test("model work package registers a code_intel evidence artifact with evidence_kind", async () => {
    const dir = await tempRunsDir()
    try {
      const runDir = await runDeepAgentStream(dir)
      const wp = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      const refs = wp.artifact_refs as { ref_id: string; artifact_type: string; evidence_kind?: string }[]
      const codeIntel = refs.find((r) => r.ref_id === "artifact:code_intel_result")
      expect(codeIntel).toBeDefined()
      expect(codeIntel?.artifact_type).toBe("code_intel_result")
      expect(codeIntel?.evidence_kind).toBe("lsp_query")
    } finally {
      await cleanupRunsDir(dir)
    }
  })

  test("isEvidenceKind accepts lsp_query and the V3.5-reserved values", () => {
    expect(AgentGateway.isEvidenceKind("lsp_query")).toBe(true)
    expect(AgentGateway.isEvidenceKind("debug_session")).toBe(true)
    expect(AgentGateway.isEvidenceKind("profile")).toBe(true)
    expect(AgentGateway.isEvidenceKind("bogus")).toBe(false)
    expect(AgentGateway.EVIDENCE_KINDS).toEqual(["lsp_query", "debug_session", "profile"])
  })
})
