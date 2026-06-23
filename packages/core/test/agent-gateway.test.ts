import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Model } from "@deepagent-code/llm"
import { AgentGateway } from "../src/agent-gateway"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"

const deepagentRunInput = {
  callKind: "session_turn" as const,
  feature: "session_chat",
  providerID: "deepagent",
  modelID: "deepagent/default",
  sessionID: "ses_test",
  messageID: "msg_test",
  workspaceID: "workspace_test",
  agent: "user:test",
  origin: {
    file: "packages/core/src/session/runner/llm.ts",
    function: "SessionRunner.runTurn",
  },
}

const defaultProviderRunInput = {
  ...deepagentRunInput,
  providerID: "openai",
  modelID: "gpt-test",
}

const tempRunsDir = () => mkdtemp(path.join(tmpdir(), "deepagent-runs-"))

const readOnlyRunDir = async (dir: string) => {
  const runs = await readdir(dir)
  expect(runs).toHaveLength(1)
  return path.join(dir, runs[0]!)
}

const readJson = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, name), "utf8"))

describe("AgentGateway", () => {
  test("global runtime manages upstream providers under high/max", async () => {
    // V3.1 global runtime: DeepAgent is provider-agnostic. A high/max turn on any upstream
    // provider (here openai) is managed and writes run artifacts, and the DeepAgent system
    // prompt is injected regardless of providerID. (Pre-V3.1 this provider was passthrough.)
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          defaultProviderRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" }), LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      expect(await readdir(dir)).toHaveLength(1)
      expect(AgentGateway.systemPrompt("openai").join("\n").length).toBeGreaterThan(0)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("general mode bypasses DeepAgent runtime artifacts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "general", runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" }), LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta", "finish"])
      expect(await readdir(dir)).toHaveLength(0)
      expect(AgentGateway.systemPrompt("deepagent").join("\n")).toBe("")
      expect(AgentGateway.snapshot()).toMatchObject({
        mode: "off",
        agentMode: "general",
        agentManaged: false,
        originalPathAllowed: true,
        knowledgeEnabled: false,
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("disabled high/max mode stays inactive in snapshot and request decoration", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "max", runsDir: undefined })

    expect(AgentGateway.snapshot()).toMatchObject({
      mode: "off",
      agentMode: "max",
      agentManaged: false,
      originalPathAllowed: true,
      knowledgeEnabled: false,
    })
    expect(AgentGateway.systemPrompt("deepagent")).toEqual([])
    expect(AgentGateway.systemPrompt("openai")).toEqual([])

    const request = LLM.request({
      id: "req_disabled_deepagent",
      model: Model.make({ id: "deepagent/default", provider: "deepagent", route: OpenAIChat.route }),
      prompt: "hello",
    })
    const routed = AgentGateway.routeRequest(request)
    expect(routed).toBe(request)

    AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
  })

  test("writes minimal DeepAgent artifacts for managed passthrough streams", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(
            LLMEvent.textDelta({ id: "text-0", text: "hello" }),
            LLMEvent.finish({ reason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } }),
          ),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      const files = await readdir(runDir)
      expect(files).toContain("DEEPAGENT_RUN_STATE.json")
      expect(files).toContain("deepagent_generic_agent_binding.json")
      expect(files).toContain("run_monitor_snapshot.json")
      expect(files).toContain("token_usage_ledger.json")
      expect(files).toContain("run_checkpoint_manifest.json")
      expect(files).toContain("MODEL_WORK_PACKAGE.json")
      expect(files).toContain("DESIGN.md")
      expect(files).toContain("HANDOFF.md")
      expect(files).toContain("TEST.md")
      expect(files).toContain("HISTORY.md")
      expect(await readJson(runDir, "deepagent_generic_agent_binding.json")).toMatchObject({
        schema_version: "deepagent_generic_agent_binding.v1",
        call_kind: "session_turn",
        runtime_feature: "session_chat",
        provider_id: "deepagent",
        model_id: "deepagent/default",
        agent_mode: "high",
        activation_mode: "first_fast_design",
        knowledge_enabled: false,
        agent_managed: true,
        original_path_allowed: false,
        generic_agent_session_id: "ses_test",
        generic_agent_message_id: "msg_test",
      })
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        schema_version: "deepagent_global_run_state.v1",
        provider_id: "deepagent",
        agent_mode: "high",
        activation_mode: "first_fast_design",
        knowledge_enabled: false,
        state: "completed",
        passthrough: true,
        default_agent_preserved: true,
        tool_mcp_preserved: true,
      })
      expect(await readJson(runDir, "MODEL_WORK_PACKAGE.json")).toMatchObject({
        agent_mode: "high",
        activation_mode: "first_fast_design",
        knowledge_enabled: false,
        selected_memory_refs: [],
        selected_strategy_refs: [],
        knowledge_retrieval: { enabled: false, mode: "disabled" },
      })
      expect(await readFile(path.join(runDir, "HISTORY.md"), "utf8")).toContain("\"event_type\": \"finish\"")
      expect(await readJson(runDir, "token_usage_ledger.json")).toMatchObject({
        schema_version: "token_usage_ledger.v1",
        model_provider: "deepagent",
        input_tokens: 3,
        output_tokens: 5,
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes an MCP capability index from generic agent prepared tool metadata", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [
                  { name: "bash", source: "generic_agent_tool_registry" },
                  { name: "github:list_issues", source: "mcp_or_namespaced_tool" },
                ],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "MCP_CAPABILITY_INDEX.json")).toMatchObject({
        execution_owner: "generic_agent_tool_registry_or_mcp",
        capability_summary: { total: 2, enabled: 2 },
        capabilities: [
          { name: "bash", source: "generic_agent_tool_registry", execution_owner: "generic_agent_tool_registry_or_mcp" },
          { name: "github:list_issues", source: "mcp_or_namespaced_tool", execution_owner: "generic_agent_tool_registry_or_mcp" },
        ],
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("routes low complexity to the configured upstream execution and records upstream intent for higher complexity", async () => {
    const lowDir = await tempRunsDir()
    const highDir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        runsDir: lowDir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })
      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )
      expect(await readJson(await readOnlyRunDir(lowDir), "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            execution_provider_id: "deepagent",
            selected_provider_id: "deepagent",
            selected_model_id: "deepagent/default",
            route_scope: "configured_upstream_execution",
          },
        ],
      })

      AgentGateway.configure({
        enabled: true,
        agentMode: "high",
        runsDir: highDir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })
      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [
                  { name: "github:list_issues", source: "mcp_or_namespaced_tool" },
                ],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )
      expect(await readJson(await readOnlyRunDir(highDir), "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            execution_provider_id: "deepagent",
            selected_provider_id: "anthropic",
            selected_model_id: "claude-frontier",
            route_scope: "configured_upstream_intent",
          },
        ],
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(lowDir, { recursive: true, force: true })
      await rm(highDir, { recursive: true, force: true })
    }
  })

  test("max mode records bounded knowledge policy without inlining full knowledge", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readFile(path.join(runDir, "DEEPAGENT_BOOT_MESSAGE.md"), "utf8")).toContain("bounded knowledge retrieval")
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        agent_mode: "max",
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
      })
      expect(await readJson(runDir, "MODEL_WORK_PACKAGE.json")).toMatchObject({
        agent_mode: "max",
        activation_mode: "first_fast_design_bounded_knowledge",
        knowledge_enabled: true,
        knowledge_retrieval: {
          enabled: true,
          mode: "bounded_retrieval_refs_only",
          full_skill_body_allowed: false,
          hidden_evaluator_feedback_allowed: false,
        },
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("max mode synchronizes context-selected knowledge refs into work package", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [{ name: "github:list_issues", source: "mcp_or_namespaced_tool" }],
              },
            },
          },
          Stream.make(LLMEvent.finish({ reason: "stop" })),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      const knowledge = await readJson(runDir, "KNOWLEDGE_RETRIEVAL_RESULT.json")
      const workPackage = await readJson(runDir, "MODEL_WORK_PACKAGE.json")
      const refIDs = knowledge.selected_refs.map((ref: { ref_id: string }) => ref.ref_id)
      expect(knowledge.candidate_refs.map((ref: { ref_id: string }) => ref.ref_id)).toContain("strategy:mcp-tool-coordination")
      expect(refIDs).toContain("strategy:mcp-tool-coordination")
      expect(knowledge).toMatchObject({
        retriever: "packages/core/src/deepagent/knowledge-retriever.ts",
        retrieval_policy: {
          // V3 anti-misleading gates (docs/30 §4): mandatory per-kind top-k + evidence gate
          topk_by_kind: { strategy: 3, methodology: 1, memory: 3 },
          evidence_threshold: 0.6,
          body_policy: "refs_and_short_synthesis_only",
          deterministic_ranking: true,
        },
      })
      expect(knowledge.candidate_refs.length).toBeGreaterThanOrEqual(knowledge.selected_refs.length)
      expect(knowledge.rejected_refs).toEqual(expect.arrayContaining([{ reason: expect.any(String), ref_id: expect.any(String) }]))
      expect(workPackage.knowledge_retrieval.selected_refs).toEqual(refIDs)
      expect(workPackage.knowledge_retrieval.selected_ref_details.map((ref: { ref_id: string }) => ref.ref_id)).toEqual(refIDs)
      expect(workPackage.selected_strategy_refs).toContain("strategy:mcp-tool-coordination")
      expect(knowledge.synthesis).toContain("MCP tools extend capabilities")
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records interrupted streams as cancelled instead of completed", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "high", runsDir: dir, allowProviderExecutedTools: false })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            deepagentRunInput,
            Stream.make(LLMEvent.textDelta({ id: "text-0", text: "partial" })).pipe(
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow()

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "cancelled",
        cancellation_reasons: ["user_or_runtime_interrupt"],
      })
      expect(await readJson(runDir, "run_checkpoint_manifest.json")).toMatchObject({
        state: "cancelled",
        resume_policy: { decision: "review_required" },
      })
      expect(await readFile(path.join(runDir, "FAILURE_DOSSIER.md"), "utf8")).toContain("interrupted or cancelled")
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("freezes run-local config for artifacts after the run opens", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({
        enabled: true,
        agentMode: "max",
        runsDir: dir,
        allowProviderExecutedTools: false,
        modelRouter: {
          upstreamProviderID: "anthropic",
          upstreamModelID: "claude-frontier",
          reason: "frontier route",
          userPreference: "none",
        },
      })

      await Effect.runPromise(
        AgentGateway.manageStream(
          {
            ...deepagentRunInput,
            metadata: {
              deepagent: {
                tool_capabilities: [{ name: "github:list_issues", source: "mcp_or_namespaced_tool" }],
              },
            },
          },
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "hello" })).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                AgentGateway.configure({
                  enabled: true,
                  agentMode: "high",
                  runsDir: dir,
                  modelRouter: {
                    upstreamProviderID: "openai",
                    upstreamModelID: "gpt-cheap",
                    reason: "changed after run opened",
                    userPreference: "hard",
                  },
                })
              }),
            ),
            Stream.concat(Stream.make(LLMEvent.finish({ reason: "stop" }))),
          ),
        ).pipe(Stream.runCollect),
      )

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        agent_mode: "max",
        knowledge_enabled: true,
      })
      expect(await readJson(runDir, "MODEL_ROUTER_AUDIT.json")).toMatchObject({
        decisions: [
          {
            selected_provider_id: "anthropic",
            selected_model_id: "claude-frontier",
            route_scope: "configured_upstream_intent",
          },
        ],
      })
      expect(await readJson(runDir, "release_bundle_manifest.json")).toMatchObject({
        agent_mode: "max",
      })
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("schema report validates cross-artifact contracts", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: dir, allowProviderExecutedTools: false })
      await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )

      const report = await readJson(await readOnlyRunDir(dir), "SCHEMA_VALIDATION_REPORT.json")
      expect(report).toMatchObject({
        status: "pass",
        validator: "structural_and_cross_artifact_contract_validator",
      })
      expect(report.cross_checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ artifact: "artifact_graph:run_id_consistency", status: "pass" }),
          expect.objectContaining({ artifact: "artifact_graph:knowledge_ref_consistency", status: "pass" }),
          expect.objectContaining({ artifact: "artifact_graph:checkpoint_hash_coverage", status: "pass" }),
        ]),
      )
    } finally {
      AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("bypasses DeepAgent artifacts when the global runtime is disabled", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: false, runsDir: dir })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(deepagentRunInput, Stream.make(LLMEvent.finish({ reason: "stop" }))).pipe(
          Stream.runCollect,
        ),
      )
      expect(Array.from(events).map((event) => event.type)).toEqual(["finish"])
      expect(await readdir(dir)).toHaveLength(0)
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails closed on provider-executed tools", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, allowProviderExecutedTools: false })

      await expect(
        Effect.runPromise(
          AgentGateway.manageStream(
            deepagentRunInput,
            Stream.make(
              LLMEvent.toolCall({
                id: "call_1",
                name: "code_interpreter_call",
                input: { query: "docs" },
                providerExecuted: true,
              }),
            ),
          ).pipe(Stream.runCollect),
        ),
      ).rejects.toThrow("provider-executed tool")

      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "deepagent_generic_agent_binding.json")).toMatchObject({
        provider_id: "deepagent",
        provider_executed_tool_observations: [
          {
            provider_executed: true,
            tool_type: "code_interpreter_call",
            policy_decision: "blocked",
            security_impact: "blocking",
            comparability_impact: "must_report",
          },
        ],
      })
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "blocked",
        blocking_reasons: ["provider_executed_tool_blocked"],
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not mark streams without terminal finish as completed", async () => {
    const dir = await tempRunsDir()
    try {
      AgentGateway.configure({ enabled: true, runsDir: dir, allowProviderExecutedTools: false })

      const events = await Effect.runPromise(
        AgentGateway.manageStream(
          deepagentRunInput,
          Stream.make(LLMEvent.textDelta({ id: "text-0", text: "partial" })),
        ).pipe(Stream.runCollect),
      )

      expect(Array.from(events).map((event) => event.type)).toEqual(["text-delta"])
      const runDir = await readOnlyRunDir(dir)
      expect(await readJson(runDir, "DEEPAGENT_RUN_STATE.json")).toMatchObject({
        state: "failed",
        failure_dossier_ref: expect.any(String),
      })
      expect(await readdir(runDir)).toContain("FAILURE_DOSSIER.md")
      expect(await readJson(runDir, "run_checkpoint_manifest.json")).toMatchObject({
        resume_policy: { decision: "review_required" },
      })
    } finally {
      AgentGateway.configure({ enabled: false, runsDir: undefined })
      await rm(dir, { recursive: true, force: true })
    }
  })
})
