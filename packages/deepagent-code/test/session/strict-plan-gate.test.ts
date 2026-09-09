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
  agentInfo?: Agent.Info,
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
      agent: agentInfo ?? agent,
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

  // F-20 contract: a plan-gate block is a typed LLM.ToolFailure REJECTION (the UI part renders
  // status "error" with the template as the error text, and effect-evidence classifies tool_error),
  // not a fake success result whose output carries the template. Returns the failure message for
  // content assertions.
  const expectPlanGateBlock = async (execute: Promise<unknown>): Promise<string> => {
    const rejection = await execute.then(
      () => {
        throw new Error("expected the plan gate to reject the mutating call")
      },
      (error: unknown) => error,
    )
    expect(rejection).toMatchObject({
      _tag: "LLM.ToolFailure",
      metadata: { planGateBlocked: true, title: "Plan update required" },
    })
    return String((rejection as Error).message)
  }

  test("stale latch + mutating tool → blocked and the tool is NOT executed (P1-1b / P3-1)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    const message = await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] }))
    // P2-1: the block message must NOT carry the warn-path "still proceeds" phrasing.
    expect(message).not.toContain("this action still proceeds")
    expect(message).toContain("blocked until the plan is re-synced")
    expect(message).toContain("`plan`")
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

  test("W2: no plan + mutating tool → blocked once with the copyable minimal plan template", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")

    const message = await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-w2a", messages: [] }))
    expect(message).toContain("create a plan first via the `plan` tool")
    // the trivial escape is stated AND machine-copyable (schema-valid create payload;
    // expected_version is Schema.optional — "Use null (or omit) for create", plan.ts)
    expect(message).toContain("one step is fine")
    expect(message).toContain('"operation":"create"')
    expect(message).toContain('"status":"active"')
    expect(executed).toBe(0)
    expect(AgentGateway.DeepAgentSessionState.planLatch(String(sessionID))!.consecutive_blocks).toBe(1)
  })

  test("W2: no plan + reads are never held — understanding stays ungated", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("read", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")

    const result = await tools.read!.execute!({}, { toolCallId: "call-w2b", messages: [] })
    expect(result).toMatchObject({ output: "read executed" })
    expect(executed).toBe(1)
  })

  test("W2: no-plan blocks hit the SAME grace release — limit consecutive blocks, then ONE release with reminder", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT

    for (let i = 0; i < limit; i++) {
      await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: `call-w2c-${i}`, messages: [] }))
    }
    const released = await tools.edit!.execute!({}, { toolCallId: `call-w2c-${limit}`, messages: [] })
    expect(executed).toBe(1)
    expect(String(released.output)).toContain("Plan gate released this call after")
    expect(String(released.output)).toContain("the next mutating call blocks again")
    // released call reset the counter → next mutating call is held again
    await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-w2c-after", messages: [] }))
  })

  test("W2: lightweight mode (general) never no-plan-blocks", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "general")

    const result = await tools.edit!.execute!({}, { toolCallId: "call-w2d", messages: [] })
    expect(String(result.output)).toContain("edit executed")
    expect(executed).toBe(1)
  })

  test("grace release: DEFAULT_GRACE_BLOCK_LIMIT consecutive blocks then ONE release with a reminder (P1-1a)", async () => {
    let executed = 0
    const tools = await Effect.runPromise(makeHarness("edit", {}, () => executed++))
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "no_progress")
    const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT

    // exactly `limit` blocks first (each a typed ToolFailure rejection), then one release
    for (let i = 0; i < limit; i++) {
      await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: `call-${i}`, messages: [] }))
    }
    const released = await tools.edit!.execute!({}, { toolCallId: `call-${limit}`, messages: [] })
    // ONLY the released call reached the real tool
    expect(executed).toBe(1)
    expect(released.title).not.toBe("Plan update required")
    expect(String(released.output)).toContain("edit executed")
    // the release carries the strong reminder; the real tool output follows verbatim
    expect(String(released.output)).toContain("released ONCE")
    expect(String(released.output)).toContain("plan gate already blocked")
    expect(executed).toBe(1)
    // the executing call reset the counter → the next stale call is blocked again (released once)
    await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-after", messages: [] }))
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

    await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] }))
    expect(executed).toBe(0)
  })

  test("W15 P3: custom agent ruleset plan:allow + session without plan → stale still blocks (merge is the effective ruleset)", async () => {
    // The subagent has NO session-level plan rule, but its AGENT ruleset carries `plan: allow`
    // (e.g. a custom agent with PLAN_WRITE_OWN_GOAL). The escape check must judge the MERGED
    // effective ruleset (`Permission.merge(agent, session)` — the same merge the permission ask
    // path uses), so this subagent CAN repair its plan and the strict block stays active.
    let executed = 0
    const tools = await Effect.runPromise(
      makeHarness(
        "edit",
        {},
        () => executed++,
        session({ parentID: sessionID, permission: [] }),
        { name: "custom", mode: "primary", permission: [{ permission: "plan", pattern: "*", action: "allow" }], options: {} } as unknown as Agent.Info,
      ),
    )
    AgentGateway.DeepAgentSessionState.getOrCreate(String(sessionID), "high")
    AgentGateway.DeepAgentSessionState.markPlanStale(String(sessionID), "user_appended")

    await expectPlanGateBlock(tools.edit!.execute!({}, { toolCallId: "call-1", messages: [] }))
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
