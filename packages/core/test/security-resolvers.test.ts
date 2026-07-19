import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { IMRepository, IMRepositoryError, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// §E1 resolvers. resolveTrustedSources + runtimeAllowsOperation are covered both purely and through the
// service; actorHasWorkspacePermission needs the real IM DB (membership) + a fake agent registry.

// ─── PURE helper unit (no IO) ────────────────────────────────────────────────────────────────────────
describe("SecurityResolvers.capabilityWithinDeclaredTools (pure)", () => {
  const withTools = (toolWhitelist?: string[]): Pick<AgentDescriptor, "limits"> =>
    toolWhitelist == null ? { limits: {} } : { limits: { toolWhitelist } }

  test("no declared whitelist ⇒ allowed (defense-in-depth only)", () => {
    expect(SecurityResolvers.capabilityWithinDeclaredTools(withTools(), "deploy")).toBe(true)
    expect(SecurityResolvers.capabilityWithinDeclaredTools({}, "deploy")).toBe(true)
  })

  test("declared whitelist gates the capability", () => {
    expect(SecurityResolvers.capabilityWithinDeclaredTools(withTools(["code.fix"]), "code.fix")).toBe(true)
    expect(SecurityResolvers.capabilityWithinDeclaredTools(withTools(["code.fix"]), "deploy")).toBe(false)
  })

  test("omitted capability is a no-op ⇒ allowed even with a whitelist", () => {
    expect(SecurityResolvers.capabilityWithinDeclaredTools(withTools(["code.fix"]), undefined)).toBe(true)
  })
})

// ─── Fake AgentListProvider (registry) — configurable per test ───────────────────────────────────────
const agentLayer = (agents: AgentDescriptor[]) =>
  Layer.succeed(
    AgentListProviderService,
    AgentListProviderService.of({
      listAgents: () => Effect.succeed(agents),
      findByTrigger: () => Effect.succeed([]),
      findByCapability: () => Effect.succeed([]),
    }),
  )

const descriptor = (id: string): AgentDescriptor => ({ id, name: id, displayName: id, visible: true })

const database = Database.layerFromPath(":memory:")

// A workspace member fixture: seed the IM tables so `listGroups` returns a group for `member_user`.
const seedMembership = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const now = Date.now()
  yield* db.run(`
    INSERT OR IGNORE INTO im_groups (id, workspace_id, project_id, type, name, created_by, created_at, updated_at)
    VALUES ('img_seed', 'ws_1', NULL, 'system', 'Seed', 'member_user', ${now}, ${now})
  `)
  yield* db.run(`
    INSERT OR IGNORE INTO im_members (group_id, member_id, member_type, role, joined_at)
    VALUES ('img_seed', 'member_user', 'user', 'owner', ${now})
  `)
})

describe("SecurityResolvers.resolveTrustedSources", () => {
  const it = testEffect(
    SecurityResolvers.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(WorkspaceConfig.layer, IMRepositoryLive, agentLayer([]))),
      Layer.provideMerge(database),
    ),
  )

  it.effect("absent config ⇒ WorkspaceConfig defaults", () =>
    Effect.gen(function* () {
      const sec = yield* SecurityResolvers.Service
      const sources = yield* sec.resolveTrustedSources("ws_unset")
      expect(sources).toEqual(WorkspaceConfig.DEFAULT_TRUSTED_SOURCES)
    }),
  )

  it.effect("reads an explicit trustedSources list from config", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("ws_cfg", { trustedSources: ["im", "system"] })
      const sec = yield* SecurityResolvers.Service
      const sources = yield* sec.resolveTrustedSources("ws_cfg")
      expect(sources).toEqual(["im", "system"])
    }),
  )
})

describe("SecurityResolvers.actorHasWorkspacePermission", () => {
  const it = testEffect(
    SecurityResolvers.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(WorkspaceConfig.layer, IMRepositoryLive, agentLayer([descriptor("agent_registered")])),
      ),
      Layer.provideMerge(database),
    ),
  )

  it.effect("member of a workspace IM group ⇒ permitted", () =>
    Effect.gen(function* () {
      yield* seedMembership
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({ workspaceID: "ws_1", actorID: "member_user" })
      expect(ok).toBe(true)
    }),
  )

  it.effect("non-member with NO registered agent ⇒ denied (fail-closed)", () =>
    Effect.gen(function* () {
      yield* seedMembership
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({ workspaceID: "ws_1", actorID: "stranger" })
      expect(ok).toBe(false)
    }),
  )

  it.effect("non-member but acting agent is registered for the workspace ⇒ permitted", () =>
    Effect.gen(function* () {
      yield* seedMembership
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({
        workspaceID: "ws_1",
        actorID: "stranger",
        agentID: "agent_registered",
      })
      expect(ok).toBe(true)
    }),
  )

  it.effect("non-member with an UNregistered agent id ⇒ denied", () =>
    Effect.gen(function* () {
      yield* seedMembership
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({
        workspaceID: "ws_1",
        actorID: "stranger",
        agentID: "agent_unknown",
      })
      expect(ok).toBe(false)
    }),
  )

  it.effect("no-actor (system) event ⇒ permitted here (gating deferred to layer 1)", () =>
    Effect.gen(function* () {
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({ workspaceID: "ws_1" })
      expect(ok).toBe(true)
    }),
  )
})

describe("SecurityResolvers.actorHasWorkspacePermission — lookup error fails closed", () => {
  // an IMRepository whose listGroups always fails simulates a DB/lookup error; the resolver must deny.
  const err = () => Effect.fail(new IMRepositoryError({ message: "lookup failed" }))
  const failingIM = Layer.succeed(
    IMRepository,
    IMRepository.of({
      listGroups: err,
      createGroup: err,
      getGroup: err,
      addMember: err,
      listMessages: err,
      createMessage: err,
      getMessage: err,
      markRead: err,
    }),
  )

  const it = testEffect(
    SecurityResolvers.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(WorkspaceConfig.layer, failingIM, agentLayer([]))),
      Layer.provideMerge(database),
    ),
  )

  it.effect("membership lookup error ⇒ denied (fail-closed, no agent fallback)", () =>
    Effect.gen(function* () {
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.actorHasWorkspacePermission({ workspaceID: "ws_1", actorID: "member_user" })
      expect(ok).toBe(false)
    }),
  )
})

describe("SecurityResolvers.runtimeAllowsOperation", () => {
  const it = testEffect(
    SecurityResolvers.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(WorkspaceConfig.layer, IMRepositoryLive, agentLayer([]))),
      Layer.provideMerge(database),
    ),
  )

  it.effect("no declared whitelist ⇒ allowed", () =>
    Effect.gen(function* () {
      const sec = yield* SecurityResolvers.Service
      const ok = yield* sec.runtimeAllowsOperation({ workspaceID: "ws_1", agent: { limits: {} }, capability: "deploy" })
      expect(ok).toBe(true)
    }),
  )

  it.effect("capability inside declared whitelist ⇒ allowed; outside ⇒ denied", () =>
    Effect.gen(function* () {
      const sec = yield* SecurityResolvers.Service
      const agent = { limits: { toolWhitelist: ["code.fix"] } }
      expect(yield* sec.runtimeAllowsOperation({ workspaceID: "ws_1", agent, capability: "code.fix" })).toBe(true)
      expect(yield* sec.runtimeAllowsOperation({ workspaceID: "ws_1", agent, capability: "deploy" })).toBe(false)
    }),
  )
})
