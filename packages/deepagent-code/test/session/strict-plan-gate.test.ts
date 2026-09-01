import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionTools } from "../../src/session/tools"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { TaskPromptOps } from "@/tool/task"

// W6-1 / P3-1 behavior tests for the strict plan-gate escalation in session/tools.ts (evaluatePlanGate):
// drives the REAL SessionTools.resolve chokepoint with a minimal harness (one registry tool, all other
// services mocked) so the assertions cover the actual wiring — block directives returned as tool
// results without execution, warn-only passes with execution, the grace release, the stale-only
// scope, and the subagent downgrade — not a re-implementation of the decision.

const sessionID = SessionID.make("ses_strict_gate")

const session = (overrides: Partial<Session.Info> = {}): Session.Info =>
  ({
    id: sessionID,
    projectID: "proj_strict_gate",
    directory: "/tmp",
    agent: "auto",
    title: "strict gate",
    ...overrides,
  }) as Session.Info

const agent = { name: "auto", mode: "primary", permission: [], options: {} } as unknown as Agent.Info

const model = { providerID: "test", api: { id: "test" } } as unknown as Provider.Model

const processor = {
  message: { id: MessageID.make("msg_strict_gate") } as never,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
}

const promptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: () => Effect.die("unused"),
} as TaskPromptOps

const makeHarness = (
  toolId: string,
  flags: Partial<RuntimeFlags.Info>,
  onExecute: () => void,
  sessionInfo?: Session.Info,
) => {
  const registry = Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed([toolId]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: toolId,
            description: `${toolId} test tool`,
            parameters: Schema.Unknown,
            provenance: { source: "custom" as const },
            execute: () =>
              Effect.sync(() => {
                onExecute()
                return { title: `${toolId} done`, metadata: {}, output: `${toolId} executed` }
              }),
          },
        ]),
    }),
  )
  const mcp = Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unused"),
      authenticate: () => Effect.die("unused"),
      finishAuth: () => Effect.die("unused"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
      catalog: () => Effect.succeed([]),
      enableCatalogEntry: () => Effect.die("unused"),
    }),
  )
  const plugin = Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      trigger: (_name, _input, output) => Effect.succeed(output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
  )
  const permission = Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.void,
      list: () => Effect.succeed([]),
    }),
  )
  const truncate = Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      write: (text: string) => Effect.succeed(text),
      cleanup: () => Effect.void,
      limits: () => Effect.succeed({ maxLines: 100, maxBytes: 1_000 }),
    }),
  )
  return Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: sessionInfo ?? session(),
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps,
    })
    return tools
  }).pipe(
    Effect.provide(registry),
    Effect.provide(mcp),
    Effect.provide(plugin),
    Effect.provide(permission),
    Effect.provide(truncate),
    Effect.provide(RuntimeFlags.layer(flags)),
  )
}

describe("W6 strictPlanGate escalation (session/tools.ts)", () => {
  beforeEach(() => {
    AgentGateway.DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "strict-gate-")))
  })

  test("stale latch + mutating tool → blocked and the tool is NOT executed (P1-1b / P3-1)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ title: "Plan update required" })
    // P2-1: the block message must NOT carry the warn-path "still proceeds" phrasing.
    expect(String(result.output)).not.toContain("this action still proceeds")
    expect(String(result.output)).toContain("blocked until the plan is re-synced")
    expect(String(result.output)).toContain("`plan`")
    expect(executed).toBe(0)
    // the block increments the runtime grace counter (P1-1a counting path)
    expect(AgentGateway.DeepAgentSessionState.planLatch(String(sessionID))!.consecutive_blocks).toBe(1)
  })

  test("stale + non-mutating (read) passes while the plan is stale", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("read", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.read!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ output: "read executed" })
    expect(executed).toBe(1)
  })

  test("no active step (U9 binding) is NOT escalated: warn-only + execution (P1-1b)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.setPlan(
      String(sessionID),
      AgentGateway.DeepAgentPlanController.buildPlanFromInput(String(sessionID), {
        goal: "g",
        steps: [{ title: "t", status: "pending" }],
      }),
    )

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ output: "edit executed" })
    expect(executed).toBe(1)
  })

  test("strictPlanGate=false → warn-only + execution (P3-1)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", { strictPlanGate: false }, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ output: "edit executed" })
    expect(executed).toBe(1)
  })

  test("grace release: DEFAULT_GRACE_BLOCK_LIMIT consecutive blocks then ONE release with a reminder (P1-1a)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "no_progress")
    const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT

    const results = []
    for (let i = 0; i <= limit; i++) {
      results.push(await tools.edit!.execute!({}, { toolCallId: `call-${i}`, messages: [] }))
    }
    // exactly `limit` blocks first, then one release
    expect(results.slice(0, limit).map((r) => r.title)).toEqual(Array(limit).fill("Plan update required"))
    // ONLY the released call reached the real tool
    expect(executed).toBe(1)
    const released = results[limit]!
    expect(released.title).not.toBe("Plan update required")
    expect(String(released.output)).toContain("edit executed")
    // the release carries the strong reminder; the real tool output follows verbatim
    expect(String(released.output)).toContain("released ONCE")
    expect(String(released.output)).toContain("plan gate already blocked")
    expect(executed).toBe(1)
    // the executing call reset the counter → the next stale call is blocked again (released once)
    const next = await tools.edit!.execute!({}, { toolCallId: "call-after", messages: [] })
    expect(next.title).toBe("Plan update required")
  })

  test("subagent session without plan-write → stale is warn-only, NOT blocked (P1-1c)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(
      makeHarness("edit", {}, () => executed++, session({ parentID: sessionID })),
    )
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ output: "edit executed" })
    expect(executed).toBe(1)
  })

  test("goal-worker subagent session (plan: allow capability grant) → stale still blocks (P1-1c)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(
      makeHarness(
        "edit",
        {},
        () => executed++,
        session({ parentID: sessionID, permission: [{ permission: "plan", pattern: "*", action: "allow" }] }),
      ),
    )
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ title: "Plan update required" })
    expect(executed).toBe(0)
  })

  test("lightweight mode (general) never strict-blocks even with stale plan", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "general")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] })
    expect(result).toMatchObject({ output: "edit executed" })
    expect(executed).toBe(1)
  })
})
