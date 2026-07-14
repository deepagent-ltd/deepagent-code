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
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { ProjectV2 } from "@deepagent-code/core/project"

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
    // config agents (excluding the appended built-ins) still filter hidden/subagent exactly as V3.8.
    expect(listed.filter((d) => !d.id.startsWith("builtin:")).map((d) => d.name)).toEqual(["visible"])
  })
})

describe("ServerAgentListProvider — findByTrigger / findByCapability", () => {
  const layer = makeLayer([
    agentInfo({ name: "alpha", mode: "all", triggers: [{ event: "code.changed" }], capabilities: ["code.edit"] }),
    agentInfo({ name: "beta", mode: "all", triggers: [{ event: "im.mention" }], capabilities: ["review"] }),
    agentInfo({ name: "legacy", mode: "all" }),
  ])

  // These assert on the CONFIG agents only; the appended built-ins are filtered out (they're covered by
  // the dedicated built-ins suite below). "code.changed" is a config-only trigger no built-in declares.
  it("findByTrigger returns only matching agents", async () => {
    const r = await run(layer, (p) => p.findByTrigger({ ...scope, event: "code.changed" }))
    expect(r.filter((d) => !d.id.startsWith("builtin:")).map((d) => d.name)).toEqual(["alpha"])
  })

  it("findByCapability returns only matching agents", async () => {
    const r = await run(layer, (p) => p.findByCapability({ ...scope, capability: "review" }))
    // "beta" is the only CONFIG agent with `review`; the built-in CodeReviewAgent also declares it.
    expect(r.filter((d) => !d.id.startsWith("builtin:")).map((d) => d.name)).toEqual(["beta"])
  })

  it("no-match returns empty for a capability no agent (built-in or config) declares; legacy agent never matches", async () => {
    // NOTE: "ci.failure" now DOES match — the built-in CodeFixAgent carries that trigger (see the
    // built-ins suite below). A capability no built-in declares (doc.write) still returns empty.
    expect(await run(layer, (p) => p.findByCapability({ ...scope, capability: "doc.write" }))).toEqual([])
    // the config agents ("alpha"/"beta"/"legacy") alone never match ci.failure — only the built-in does.
    const ciMatches = await run(layer, (p) => p.findByTrigger({ ...scope, event: "ci.failure" }))
    expect(ciMatches.map((d) => d.name)).not.toContain("alpha")
    expect(ciMatches.map((d) => d.name)).not.toContain("legacy")
  })
})

// V4.0 §A1 CRITICAL — the PRODUCTION provider (ServerAgentListProviderLive, wired into
// v4EventRuntimeLayer via server.ts) must carry the built-in autonomous descriptors. The real
// deepagent-code agents (auto/general/plan) declare NO trigger/capability metadata, so without the
// built-in append every autonomous event would still block with `no_capable_agent` in production. These
// tests drive the REAL ServerAgentListProvider (not a fake registry) to prove the built-ins are present.
describe("ServerAgentListProvider — built-in autonomous descriptors (production path)", () => {
  // a registry of ONLY config agents that carry no autonomous metadata — mirrors production, where
  // auto/general/plan have no triggers/capabilities. Any match therefore comes from the built-ins.
  const layer = makeLayer([
    agentInfo({ name: "auto", mode: "primary", description: "default" }),
    agentInfo({ name: "general", mode: "all" }),
    agentInfo({ name: "plan", mode: "primary" }),
  ])

  it("findByTrigger('ci.failure') returns the built-in CodeFixAgent (metadata now present in production)", async () => {
    const r = await run(layer, (p) => p.findByTrigger({ ...scope, event: "ci.failure" }))
    expect(r.some((d) => d.id === "builtin:codefix")).toBe(true)
  })

  it("findByCapability('code_edit') returns a built-in (CodeFixAgent/ChangeAgent) in production", async () => {
    const r = await run(layer, (p) => p.findByCapability({ ...scope, capability: "code_edit" }))
    expect(r.some((d) => d.id === "builtin:codefix" || d.id === "builtin:change")).toBe(true)
  })

  it("every autonomous trigger resolves to >=1 capable agent via the production provider", async () => {
    for (const evt of ["ci.failure", "ci.repair.requested", "pr.comment", "monitor.alert", "git.push", "schedule.scan"]) {
      const r = await run(layer, (p) => p.findByTrigger({ ...scope, event: evt }))
      expect(r.length).toBeGreaterThan(0)
    }
  })

  it("built-ins are visible:false so they don't leak into the human @mention list, but ARE listed for matching", async () => {
    const listed = await run(layer, (p) => p.listAgents(scope))
    const builtins = listed.filter((d) => d.id.startsWith("builtin:"))
    expect(builtins.length).toBeGreaterThan(0)
    expect(builtins.every((d) => d.visible === false)).toBe(true)
    // the config agents remain visible.
    expect(listed.some((d) => d.name === "auto" && d.visible === true)).toBe(true)
  })
})

// V4.x defense-in-depth — listAgents must respect the requesting actor's workspace scope. The provider
// is bound to a single routed instance (deepagent-code is single-user, one workspace/directory per
// instance): its CONFIG agents belong to that instance's scope, while the appended built-ins are
// workspace-independent GLOBALS. A query for a workspace this instance was NOT routed to must therefore
// see only the globals — never this instance's config agents. When the instance's own scope is
// unresolvable (a bare fiber, no InstanceRef/WorkspaceRef) the provider DEFERS (includes config agents)
// rather than over-filter, since Layer-1 trusted-source already fails closed on untrusted events.
describe("ServerAgentListProvider — workspace scope gating", () => {
  // Build an InstanceContext for a routed instance located at `directory`.
  const instanceCtx = (directory: string) => ({
    directory,
    worktree: directory,
    project: {
      id: ProjectV2.ID.global,
      worktree: directory,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
  })

  // Run listAgents for `queryScope` while the provider believes it is bound to the given instance scope.
  // `routedWorkspaceID` (WorkspaceRef) and/or `directory` (InstanceRef) set the instance's own identity;
  // omit both to simulate a bare fiber with no resolvable scope.
  const runScoped = (
    agents: Agent.Info[],
    queryScope: { workspaceID: string; userID: string },
    own: { routedWorkspaceID?: string; directory?: string },
  ): Promise<AgentDescriptor[]> => {
    let eff = Effect.gen(function* () {
      const provider = yield* AgentListProviderService
      return yield* provider.listAgents(queryScope)
    }).pipe(Effect.provide(makeLayer(agents)))
    if (own.directory !== undefined) {
      eff = eff.pipe(Effect.provideService(InstanceRef, instanceCtx(own.directory)))
    }
    if (own.routedWorkspaceID !== undefined) {
      eff = eff.pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make(own.routedWorkspaceID)))
    }
    return Effect.runPromise(eff)
  }

  const configAgents = [
    agentInfo({ name: "reviewer", mode: "all" }),
    agentInfo({ name: "auto", mode: "primary" }),
  ]
  const configNames = (list: AgentDescriptor[]) => list.filter((d) => !d.id.startsWith("builtin:")).map((d) => d.name)
  const builtinCount = (list: AgentDescriptor[]) => list.filter((d) => d.id.startsWith("builtin:")).length

  it("returns this instance's config agents when the requested workspaceID matches the routed workspace", async () => {
    const listed = await runScoped(configAgents, { workspaceID: "wrk_alpha", userID: "u1" }, {
      routedWorkspaceID: "wrk_alpha",
    })
    expect(configNames(listed)).toEqual(["reviewer", "auto"])
    expect(builtinCount(listed)).toBeGreaterThan(0)
  })

  it("withholds config agents (globals only) when the requested workspaceID is NOT the routed workspace", async () => {
    const listed = await runScoped(configAgents, { workspaceID: "wrk_other", userID: "u1" }, {
      routedWorkspaceID: "wrk_alpha",
    })
    // out-of-scope query sees NO config agents, but the workspace-independent built-ins remain.
    expect(configNames(listed)).toEqual([])
    expect(builtinCount(listed)).toBeGreaterThan(0)
  })

  it("matches on the directory fallback when the instance has no routed workspace id", async () => {
    const dir = "/tmp/project-x"
    // in-scope: the query addresses the instance by its directory grouping key.
    const inScope = await runScoped(configAgents, { workspaceID: dir, userID: "u1" }, { directory: dir })
    expect(configNames(inScope)).toEqual(["reviewer", "auto"])
    // out-of-scope: a different directory sees globals only.
    const outScope = await runScoped(configAgents, { workspaceID: "/tmp/project-y", userID: "u1" }, { directory: dir })
    expect(configNames(outScope)).toEqual([])
    expect(builtinCount(outScope)).toBeGreaterThan(0)
  })

  it("defers (includes config agents) when the instance's own scope is unresolvable", async () => {
    // no InstanceRef and no WorkspaceRef ⇒ own scope undefined ⇒ do not over-filter.
    const listed = await runScoped(configAgents, { workspaceID: "wrk_whatever", userID: "u1" }, {})
    expect(configNames(listed)).toEqual(["reviewer", "auto"])
    expect(builtinCount(listed)).toBeGreaterThan(0)
  })
})
