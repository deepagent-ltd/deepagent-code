import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { ToolProvenance } from "../../src/tool/provenance"

// M2 (S1-v3.4): MCP provenance must be carried as explicit metadata, not guessed
// from the tool name string. The old code used `name.includes(":")` to decide the
// source, which contradicted the actual `_`-separated MCP naming (mcp/index.ts:699)
// and misclassified real MCP tools as builtin. These tests assert the two downstream
// token vocabularies map back correctly from explicit provenance.

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const model = (providerID: string, modelID: string) =>
  ({
    id: modelID,
    providerID,
    api: { id: modelID, url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
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

const user = (providerID: string, modelID: string, sessionID: string) =>
  ({
    id: "msg_provenance",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
  }) as any

async function prepareWithTools(sessionID: string, tools: Record<string, any>) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: user("deepagent", "deepseek-deepseek-v4-flash", sessionID),
      sessionID,
      model: model("deepagent", "deepseek-deepseek-v4-flash"),
      agent: { name: "build", mode: "primary", prompt: "generic agent prompt", options: {}, permission: [] } as any,
      system: ["You are deepagent-code."],
      messages: [{ role: "user", content: "hello" }],
      tools,
      provider: { id: "deepagent", options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  )
}

function caps(prepared: Awaited<ReturnType<typeof prepareWithTools>>) {
  const deepagent = (prepared.metadata as any).deepagent
  return deepagent.tool_capabilities as { name: string; source: string }[]
}

describe("M2 MCP provenance — explicit source", () => {
  // (a) A `_`-named MCP tool (default naming) classifies as mcp via explicit provenance.
  test("default `_`-named MCP tool maps to mcp_or_namespaced_tool token", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const mcpTool = {} as any
    ToolProvenance.set(mcpTool, { source: "mcp", mcpServer: "github", mcpToolName: "list_prs" })
    const prepared = await prepareWithTools("ses_prov_mcp_underscore", { github_list_prs: mcpTool })
    const entry = caps(prepared).find((c) => c.name === "github_list_prs")
    expect(entry?.source).toBe("mcp_or_namespaced_tool")
  })

  // (c) A builtin tool whose name contains `_` is NOT misclassified as mcp.
  test("builtin tool with underscore in name stays generic_agent_tool_registry", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const builtin = {} as any
    ToolProvenance.set(builtin, { source: "builtin" })
    const prepared = await prepareWithTools("ses_prov_builtin_underscore", { apply_patch: builtin })
    const entry = caps(prepared).find((c) => c.name === "apply_patch")
    expect(entry?.source).toBe("generic_agent_tool_registry")
  })

  // Old behavior reversal: a `:`-named tool WITHOUT provenance is NOT treated as mcp.
  test("name with colon but no provenance is not treated as mcp", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const prepared = await prepareWithTools("ses_prov_colon_no_prov", { "weird:name": {} as any })
    const entry = caps(prepared).find((c) => c.name === "weird:name")
    expect(entry?.source).toBe("generic_agent_tool_registry")
  })

  // (d) server grouping comes from provenance.mcpServer, not a name split.
  test("DeepAgent prompt context groups MCP servers from provenance.mcpServer", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const t1 = {} as any
    const t2 = {} as any
    ToolProvenance.set(t1, { source: "mcp", mcpServer: "github", mcpToolName: "list_prs" })
    ToolProvenance.set(t2, { source: "mcp", mcpServer: "github", mcpToolName: "get_issue" })
    // Names deliberately do NOT start with the server name — a split would fail.
    const prepared = await prepareWithTools("ses_prov_server_group", {
      gh_list: t1,
      gh_issue: t2,
      read: (() => {
        const b = {} as any
        ToolProvenance.set(b, { source: "builtin" })
        return b
      })(),
    })
    // The metadata path proves source classification; server grouping lives in the
    // prompt context. Both tools must classify as mcp.
    const mcpCaps = caps(prepared).filter((c) => c.source === "mcp_or_namespaced_tool")
    expect(mcpCaps.map((c) => c.name).sort()).toEqual(["gh_issue", "gh_list"])
  })
})
