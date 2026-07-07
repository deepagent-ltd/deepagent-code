// V3.8.1 §C — ServerAgentListProvider (the PRODUCTION registry path, reads the
// deepagent-code `Agent.Info`). Verifies the new metadata is mapped onto the
// descriptor, that autonomy/approval defaults are applied, that a legacy agent
// definition (no new fields) still lists & @mentions exactly as in V3.8, and
// that findByTrigger/findByCapability match over the mapped descriptors.

import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentListProvider } from "@deepagent-code/core/im/agent-list-provider"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { Agent } from "@/agent/agent"
import { ServerAgentListProviderLive } from "@/im/agent-executor-server"

// Minimal Agent.Info records (only fields the provider reads). Cast through
// unknown so tests don't have to build a full permission ruleset etc.
function agentInfo(partial: Record<string, unknown>): Agent.Info {
  return { options: {}, permission: [], mode: "all", ...partial } as unknown as Agent.Info
}

function makeLayer(agents: Agent.Info[]) {
  const mock = {
    list: () => Effect.succeed(agents),
  } as unknown as Agent.Interface
  return ServerAgentListProviderLive.pipe(Layer.provide(Layer.succeed(Agent.Service, mock)))
}

const scope = { workspaceID: "wrk_1", userID: "u1" }

const run = (
  layer: Layer.Layer<AgentListProviderService>,
  f: (p: AgentListProvider) => Effect.Effect<AgentDescriptor[], Error, never>,
): Promise<AgentDescriptor[]> =>
  Effect.gen(function* () {
    const provider = yield* AgentListProviderService
    return yield* f(provider)
  }).pipe(Effect.provide(layer), Effect.runPromise)

describe("ServerAgentListProvider — metadata mapping & defaults", () => {
  it("maps declared metadata onto the descriptor", async () => {
    const layer = makeLayer([
      agentInfo({
        name: "reviewer",
        description: "reviews code",
        mode: "all",
        triggers: [{ event: "code.changed" }],
        capabilities: ["review"],
        autonomy: "level_2",
        context_sources: ["code_graph"],
        approval_required: false,
        limits: { maxConcurrency: 4 },
      }),
    ])
    const [d] = await run(layer, (p) => p.listAgents(scope))
    expect(d.name).toBe("reviewer")
    expect(d.triggers).toEqual([{ event: "code.changed" }])
    expect(d.capabilities).toEqual(["review"])
    expect(d.autonomy).toBe("level_2")
    expect(d.context_sources).toEqual(["code_graph"])
    expect(d.approval_required).toBe(false)
    expect(d.limits).toEqual({ maxConcurrency: 4 })
  })

  it("defaults autonomy to level_0 and derives approval_required=true for an agent with NO metadata (backward-compat)", async () => {
    // A legacy agent definition — exactly the V3.8 shape, no new fields.
    const layer = makeLayer([agentInfo({ name: "build", description: "default agent", mode: "primary" })])
    const [d] = await run(layer, (p) => p.listAgents(scope))
    // list()/@mention identity preserved.
    expect(d.id).toBe("build")
    expect(d.name).toBe("build")
    expect(d.displayName).toBe("default agent")
    expect(d.visible).toBe(true)
    // autonomy defaults to the conservative level_0; approval derived from it.
    expect(d.autonomy).toBe("level_0")
    expect(d.approval_required).toBe(true)
    // declarative metadata stays absent (no empty arrays injected).
    expect(d.triggers).toBeUndefined()
    expect(d.capabilities).toBeUndefined()
    expect(d.context_sources).toBeUndefined()
    expect(d.limits).toBeUndefined()
  })

  it("derives approval_required=false when a higher autonomy is declared without explicit approval", async () => {
    const layer = makeLayer([agentInfo({ name: "auto", mode: "all", autonomy: "level_3" })])
    const [d] = await run(layer, (p) => p.listAgents(scope))
    expect(d.autonomy).toBe("level_3")
    expect(d.approval_required).toBe(false)
  })

  it("an explicit approval_required always wins over the autonomy-derived default", async () => {
    const layer = makeLayer([agentInfo({ name: "auto", mode: "all", autonomy: "level_3", approval_required: true })])
    const [d] = await run(layer, (p) => p.listAgents(scope))
    expect(d.approval_required).toBe(true)
  })

  it("still filters hidden / subagent agents from the list (V3.8 behavior unchanged)", async () => {
    const layer = makeLayer([
      agentInfo({ name: "visible", mode: "all" }),
      agentInfo({ name: "hidden", mode: "all", hidden: true }),
      agentInfo({ name: "sub", mode: "subagent" }),
    ])
    const listed = await run(layer, (p) => p.listAgents(scope))
    expect(listed.map((d) => d.name)).toEqual(["visible"])
  })
})

describe("ServerAgentListProvider — findByTrigger / findByCapability", () => {
  const layer = makeLayer([
    agentInfo({ name: "alpha", mode: "all", triggers: [{ event: "code.changed" }], capabilities: ["code.edit"] }),
    agentInfo({ name: "beta", mode: "all", triggers: [{ event: "im.mention" }], capabilities: ["review"] }),
    agentInfo({ name: "legacy", mode: "all" }),
  ])

  it("findByTrigger returns only matching agents", async () => {
    const r = await run(layer, (p) => p.findByTrigger({ ...scope, event: "code.changed" }))
    expect(r.map((d) => d.name)).toEqual(["alpha"])
  })

  it("findByCapability returns only matching agents", async () => {
    const r = await run(layer, (p) => p.findByCapability({ ...scope, capability: "review" }))
    expect(r.map((d) => d.name)).toEqual(["beta"])
  })

  it("no-match returns empty; legacy agent never matches", async () => {
    expect(await run(layer, (p) => p.findByTrigger({ ...scope, event: "ci.failure" }))).toEqual([])
    expect(await run(layer, (p) => p.findByCapability({ ...scope, capability: "doc.write" }))).toEqual([])
  })
})
