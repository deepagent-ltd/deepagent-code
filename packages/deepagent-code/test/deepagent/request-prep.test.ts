import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { ToolProvenance } from "../../src/tool/provenance"

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const user = (providerID: string, modelID: string, sessionID: string, metadata?: Record<string, unknown>) =>
  ({
    id: "msg_deepagent_request_prep",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
    metadata,
  }) as any

const model = (providerID: string, modelID: string) =>
  ({
    id: modelID,
    providerID,
    api: {
      id: modelID,
      url: "https://example.invalid",
      npm: "@ai-sdk/openai-compatible",
    },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, input: 128_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
  }) as any

async function prepare(
  providerID: string,
  modelID: string,
  sessionID = `ses_deepagent_request_prep_${providerID}_${modelID}`,
  options: { messages?: any[]; metadata?: Record<string, unknown> } = {},
) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: user(providerID, modelID, sessionID, options.metadata),
      sessionID,
      model: model(providerID, modelID),
      agent: {
        name: "build",
        mode: "primary",
        prompt: "generic agent prompt",
        options: {},
        permission: [],
      } as any,
      system: ["You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."],
      messages: options.messages ?? [{ role: "user", content: "hello" }],
      tools: {},
      provider: { id: providerID, options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  )
}

describe("DeepAgent request prep", () => {
  // V3.1 global runtime: in high/max the DeepAgent system prompt is injected for EVERY provider
  // (DeepAgent is a global agent system, not a provider). The distinguishing axis is strength
  // (general vs high/max), not providerID. See deepagent-production-contract.md "Runtime Boundary".
  test("injects the DeepAgent system prompt for every provider in high mode", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const deepagent = await prepare("deepagent", "deepseek-deepseek-v4-flash")
    expect(deepagent.system[0]).toContain("DeepAgent Code")
    expect(deepagent.system[0]).not.toContain("DeepCode")
    expect(deepagent.system[0]).toContain("High")
    expect(deepagent.system[0]).toContain("first_fast_design")
    expect(deepagent.system[0]).not.toContain("generic agent prompt")
    expect(deepagent.system[0]).not.toContain("You are deepagent-code")
    expect(deepagent.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("DeepAgent Code"),
    })

    // An ordinary upstream provider now also runs under the DeepAgent runtime in high mode.
    const ordinary = await prepare("deepseek", "deepseek-v4-flash")
    expect(ordinary.system[0]).toContain("DeepAgent Code")
    expect(ordinary.system[0]).toContain("High")
    expect(ordinary.system[0]).not.toContain("generic agent prompt")
    expect(ordinary.system[0]).not.toContain("You are deepagent-code")
    expect(ordinary.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("DeepAgent Code"),
    })
    expect(ordinary.messages[1]).toMatchObject({ role: "user", content: "hello" })
  })

  test("general mode keeps the DeepAgent provider on the default agent path", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })

    const prepared = await prepare("deepagent", "deepseek-deepseek-v4-flash", "ses_deepagent_request_prep_general")
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).toContain("You are deepagent-code")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("generic agent prompt"),
    })
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.not.stringContaining(AgentGateway.DEEPAGENT_BOOT_MESSAGE),
    })
    expect(prepared.messages[1]).toMatchObject({ role: "user", content: "hello" })

    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  // L2 (v3.8.0 §L2): the orchestration guidance section is injected on BOTH assembly paths.
  test("injects the orchestration section on the DeepAgent path (high mode)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_deepagent_high")
    expect(prepared.system[0]).toContain("多-Agent 编排")
    expect(prepared.system[0]).toContain("扇出判据")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("injects the tier-0 orchestration section on the non-DeepAgent path (general)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_general")
    // non-DeepAgent path keeps the inherited prompt AND appends the tier-0 (off-by-default) guidance
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).toContain("多-Agent 编排")
    expect(prepared.system[0]).toContain("默认不自动编排")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  // §5b: on the non-DeepAgent path at a fan-out-capable mode, the runtime decision (from the user
  // request's ComplexitySignals) is injected as CONCRETE, task-specific numbers — not just generic
  // guidance. DeepAgent is DISABLED here but agentMode is high, so the else-branch fires.
  test("§5b injects a concrete fan-out decision for a complex request (non-DeepAgent, high)", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "high" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_decision_complex", {
      messages: [
        {
          role: "user",
          content: "migrate the auth interface across subsystems and review it thoroughly",
        },
      ],
    })
    expect(prepared.system[0]).toContain("本轮调度判定")
    expect(prepared.system[0]).toContain("researcher")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("§5b a trivial single-file typo request is advised NOT to fan out (non-DeepAgent, high)", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "high" })
    const prepared = await prepare("deepseek", "deepseek-v4-flash", "ses_orch_decision_trivial", {
      messages: [{ role: "user", content: "fix the typo in utils.ts" }],
    })
    expect(prepared.system[0]).toContain("不建议扇出")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("wish-routed general turns use the inherited prompt and bypass DeepAgent metadata", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_wish_general",
      {
        metadata: { deepagent: { agent_mode_override: "general" } },
      },
    )
    expect(prepared.system[0]).toContain("generic agent prompt")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.metadata.deepagent).toMatchObject({ agent_mode_override: "general" })
  })

  test("SECURITY: a client-supplied agent_mode_override cannot escalate above the process-global mode", async () => {
    // The override rides on the client-writable user-message metadata. When the process-global mode
    // is "high", an "ultra" override (an ESCALATION) must be clamped away — the prepared metadata must
    // NOT re-emit `agent_mode_override: "ultra"`, so a subagent/HTTP client cannot self-promote into
    // autonomous ultra mode. A downgrade ("general") on the same global is still honored.
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const escalated = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_escalate",
      { metadata: { deepagent: { agent_mode_override: "ultra" } } },
    )
    // Clamped: the escalation is dropped, so no override is re-emitted (falls back to global "high").
    expect((escalated.metadata.deepagent as Record<string, unknown> | undefined)?.agent_mode_override).toBeUndefined()

    const downgraded = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      "ses_deepagent_request_prep_downgrade",
      { metadata: { deepagent: { agent_mode_override: "general" } } },
    )
    expect((downgraded.metadata.deepagent as Record<string, unknown>).agent_mode_override).toBe("general")
  })

  test("plain later user messages do not advance DeepAgent rounds", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      `ses_deepagent_request_prep_no_count_round_${crypto.randomUUID()}`,
      {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
    )
    expect(prepared.system[0]).toContain("第 1 轮")
  })

  test("explicit round control advances DeepAgent rounds", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const prepared = await prepare(
      "deepagent",
      "deepseek-deepseek-v4-flash",
      `ses_deepagent_request_prep_explicit_round_${crypto.randomUUID()}`,
      {
        metadata: { deepagent: { round_control: { action: "continue" } } },
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "continue" },
        ],
      },
    )
    expect(prepared.system[0]).toContain("第 2 轮")
  })

  // T3 (S1-v3.4): the advance-trigger set {continue, revise, narrow} advances the round; the terminal
  // markers {stop, escalate} inject no turn and must NOT advance (else a non-existent round is counted).
  for (const action of ["revise", "narrow"]) {
    test(`round control "${action}" advances DeepAgent rounds`, async () => {
      AgentGateway.configure({ enabled: true, agentMode: "high" })
      const prepared = await prepare(
        "deepagent",
        "deepseek-deepseek-v4-flash",
        `ses_rc_adv_${action}_${crypto.randomUUID()}`,
        {
          metadata: { deepagent: { round_control: { action } } },
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "next" },
          ],
        },
      )
      expect(prepared.system[0]).toContain("第 2 轮")
    })
  }

  for (const action of ["stop", "escalate"]) {
    test(`terminal round control "${action}" does NOT advance rounds`, async () => {
      AgentGateway.configure({ enabled: true, agentMode: "high" })
      const prepared = await prepare(
        "deepagent",
        "deepseek-deepseek-v4-flash",
        `ses_rc_term_${action}_${crypto.randomUUID()}`,
        {
          metadata: { deepagent: { round_control: { action } } },
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "next" },
          ],
        },
      )
      expect(prepared.system[0]).toContain("第 1 轮")
    })
  }

  test("does not inject DeepAgent identity when gateway is disabled", async () => {
    AgentGateway.configure({ enabled: false, agentMode: "max" })

    const prepared = await prepare("deepagent", "deepseek-deepseek-v4-flash", "ses_deepagent_request_prep_disabled")
    expect(prepared.system[0]).not.toContain(AgentGateway.DEEPAGENT_BOOT_MESSAGE)
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      content: expect.not.stringContaining(AgentGateway.DEEPAGENT_BOOT_MESSAGE),
    })

    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("returns run metadata with tool capabilities", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })

    const sessionID = "ses_deepagent_request_prep_metadata"
    // M2 (S1-v3.4): source is now read from explicit provenance, not the tool name.
    // A `_`-named MCP tool (default naming) must classify as mcp; a `:`-named tool
    // WITHOUT provenance must NOT be misread as mcp anymore.
    const bashTool = {} as any
    const mcpTool = {} as any
    ToolProvenance.set(mcpTool, { source: "mcp", mcpServer: "lookup", mcpToolName: "search" })
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: user("deepagent", "deepseek-deepseek-v4-flash", sessionID),
        sessionID,
        parentSessionID: "ses_parent",
        model: model("deepagent", "deepseek-deepseek-v4-flash"),
        agent: {
          name: "build",
          mode: "primary",
          prompt: "generic agent prompt",
          options: {},
          permission: [],
        } as any,
        system: ["You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."],
        messages: [{ role: "user", content: "hello" }],
        tools: {
          bash: bashTool,
          invalid: {} as any,
          lookup_search: mcpTool,
        },
        provider: { id: "deepagent", options: {} } as any,
        auth: undefined,
        plugin,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )

    expect(prepared.metadata).toMatchObject({
      "deepagent-code": {
        callKind: "session_turn",
        feature: "session_chat",
        sessionID,
        messageID: "msg_deepagent_request_prep",
        parentSessionID: "ses_parent",
        agent: "build",
      },
      deepagent: {
        tool_capabilities: [
          {
            name: "bash",
            source: "generic_agent_tool_registry",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
          {
            name: "lookup_search",
            source: "mcp_or_namespaced_tool",
            execution_owner: "generic_agent_tool_registry_or_mcp",
          },
        ],
      },
    })
  })
})
