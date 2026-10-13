import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

if (!process.env.DEEPAGENT_TEST_MCP_INVOKE_CHILD) {
  test("MCP App durable invocation uses an isolated fileDB and original SDK transport", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-mcp-app-invoke-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const child = Bun.spawn({ cmd: [process.execPath, "test", import.meta.path, "--timeout", "45000"], cwd: path.resolve(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_TEST_MCP_INVOKE_CHILD: "1" }, stdout: "pipe", stderr: "pipe" })
    const deadline = setTimeout(() => child.kill(), 55000)
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const output = stdout + stderr
      console.info(output)
      expect({ status, output: status === 0 ? "ok" : output }).toEqual({ status: 0, output: "ok" })
      expect(output).toMatch(/\b0 fail\b/)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}

if (process.env.DEEPAGENT_TEST_MCP_INVOKE_CHILD) {
  const { Effect, Exit, Fiber, Layer, Option, Scope, Cause } = await import("effect")
  const { eq, sql } = await import("drizzle-orm")
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")
  const { MCP } = await import("../../src/mcp/index")
  const { Config } = await import("../../src/config/config")
  const { McpAppResource } = await import("../../src/mcp/app-resource")
  const { McpAppInvocationHost } = await import("../../src/mcp/app-invocation")
  const { InstanceRef } = await import("../../src/effect/instance-ref")
  const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { EventV2 } = await import("@deepagent-code/core/event")
  const { AgentV2 } = await import("@deepagent-code/core/agent")
  const { Location } = await import("@deepagent-code/core/location")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { Project } = await import("@deepagent-code/core/project")
  const { ProjectTable } = await import("@deepagent-code/core/project/sql")
  const { SessionSchema } = await import("@deepagent-code/core/session/schema")
  const { SessionTable } = await import("@deepagent-code/core/session/sql")
  const { SessionStore } = await import("@deepagent-code/core/session/store")
  const { SessionRunCoordinator } = await import("@deepagent-code/core/session/run-coordinator")
  const { PermissionV2 } = await import("@deepagent-code/core/permission")
  const { PermissionSaved } = await import("@deepagent-code/core/permission/saved")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { McpAppInvocation } = await import("@deepagent-code/core/session/mcp-app-invocation")
  const { McpAppInvocationSchema } = await import("@deepagent-code/core/session/mcp-app-invocation.schema")
  const { McpAppRunner } = await import("@deepagent-code/core/session/runner/mcp-app-invocation")
  const { McpAppEffectTable, McpAppInvocationTable } = await import("@deepagent-code/core/session/mcp-app-invocation.sql")
  const { V2ToolEffectAdmissionTable, V2ToolEffectTable } = await import("@deepagent-code/core/session/runner/v2-tool-effect.sql")
  const { StartupInventory } = await import("@deepagent-code/core/session/runner/startup-inventory")
  const { testEffect, pollWithTimeout } = await import("../lib/effect")
  const it = testEffect(Layer.mergeAll(MCP.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer))

  it.instance("exact App RPC, real permission source, original serial boundary, transport unknown and cold facts", () => Effect.gen(function* () {
    const instance = yield* InstanceRef
    if (!instance) return yield* Effect.die("missing original test instance")
    const mcp = yield* MCP.Service
    const config = yield* Config.Service
    const state = { calls: 0, drop: false, generation: 1, concurrent: 0, maxConcurrent: 0 }
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "app-invocation-wire", version: "1" }, { capabilities: { tools: {}, resources: {} } })
      server.setRequestHandler("tools/list", () => ({ tools: [
        { name: "view", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: "ui://invoke/view" } } },
        { name: "app_only", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        { name: "model_only", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
      ] }))
      server.setRequestHandler("resources/list", () => ({ resources: [] }))
      server.setRequestHandler("resources/read", (request) => ({ contents: [{ uri: request.params.uri, mimeType: McpAppResource.MIME_TYPE, text: "<html>real App</html>" }] }))
      server.setRequestHandler("tools/call", async (request) => {
        state.calls++
        state.concurrent++
        state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent)
        await new Promise((resolve) => setTimeout(resolve, 15))
        state.concurrent--
        return { content: [{ type: "text", text: `actual-${request.params.name}` }], structuredContent: { calls: state.calls }, _meta: { privateResult: "App-only metadata" } }
      })
      return server
    }, { legacy: "reject", keepAliveMs: 0 })
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
      const method = request.method === "POST" ? (await request.clone().json() as { method?: string }).method : undefined
      const response = await handler.fetch(request)
      if (method === "tools/call" && state.drop) { await response.arrayBuffer(); return new Response("lost ACK", { status: 503 }) }
      return response
    } })
    yield* Effect.addFinalizer(() => Effect.promise(async () => { await handler.close(); await listener.stop(true) }))
    yield* mcp.add("app_wire", { type: "remote", url: `http://127.0.0.1:${listener.port}/mcp`, oauth: false, protocol: "2026-07-28" })
    yield* Effect.addFinalizer(() => mcp.disconnect("app_wire").pipe(Effect.ignore))
    const client = (yield* mcp.clients()).app_wire
    if (!client) return yield* Effect.die("original MCP client missing")
    const tools = (yield* Effect.promise(() => client.listTools())).tools
    const origin = { tools, active: true }
    const resource = McpAppResource.make(Effect.gen(function* () {
      // This calls InstanceState under the original InstanceRef. Transport Promise fibers must
      // carry the captured context, instead of inventing a default instance.
      const clients = yield* mcp.clients()
      const snapshot = config.mcpSnapshot ? yield* config.mcpSnapshot() : undefined
      return origin.active && clients.app_wire === client ? [{ scope: origin, client, server: "app_wire", tools: origin.tools, version: state.generation,
        source: snapshot?.source ?? "actual-config" }] : []
    }))
    yield* Effect.addFinalizer(() => Effect.sync(() => resource.dispose()))
    const filename = path.join(instance.directory, "app-invocation.sqlite")
    const database = Database.layerFromPath(filename)
    const events = EventV2.layer.pipe(Layer.provide(database))
    const location = Location.Service.of({ directory: AbsolutePath.make(instance.directory), project: { id: Project.ID.global, directory: AbsolutePath.make(instance.directory) } })
    const current = Layer.succeed(Location.Service, location)
    const agents = AgentV2.layer
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const saved = PermissionSaved.layer.pipe(Layer.provide(database))
    const permissions = PermissionV2.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(current), Layer.provide(agents), Layer.provide(store), Layer.provide(saved))
    const identities = LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))
    const layer = Layer.mergeAll(database, events, current, agents, store, saved, permissions, identities)
    const sessionID = SessionSchema.ID.make(`ses_app_${crypto.randomUUID()}`)
    const ids: string[] = []
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const actors = yield* AgentV2.Service
      const permission = yield* PermissionV2.Service
      const sessions = yield* SessionStore.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(instance.directory), sandboxes: [] }).onConflictDoNothing().run()
      yield* (yield* LocationIdentity.Service).resolve({ directory: AbsolutePath.make(instance.directory), boundary: { kind: "implicit_local" }, project: { kind: "registered_root", observedProjectId: "global" } })
      yield* actors.update((editor) => editor.update(AgentV2.defaultID, (agent) => { agent.mode = "primary"; agent.permissions = [{ action: "mcp", resource: "*", effect: "ask" }] }))
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "app", title: "App invocation", directory: instance.directory, version: "test", v2_authority: true }).run()
      const descriptor = (yield* resource.list()).find((item) => item.tool === "view")!
      const view = yield* resource.read({ server: descriptor.server, tool: descriptor.tool, generation: descriptor.generation, resourceUri: descriptor.resourceUri, consent: true, sessionID })
      const inventory = yield* resource.viewTools({ viewID: view.viewID, sessionID })
      expect(inventory.tools.map((tool) => tool.name)).toEqual(["view", "app_only"])
      expect(Object.keys(yield* mcp.tools()).some((name) => name.includes("app_only"))).toBe(false)
      yield* McpAppInvocation.registerHost(location, { capture: (input) => resource.capture(input).pipe(Effect.mapError(() => McpAppInvocation.failure("changed")), Effect.flatMap(McpAppInvocationHost.native)) })
      const service = yield* McpAppInvocation.make()
      const input = { sessionID, viewID: view.viewID, rpcID: 1, name: "app_only", arguments: {} }
      const admitted = yield* service.invoke(input)
      ids.push(admitted.invocationID)
      expect(admitted.state).toBe("queued")
      expect((yield* service.invoke(input)).invocationID).toBe(admitted.invocationID)
      expect(state.calls).toBe(0)
      const conflict = yield* service.invoke({ ...input, arguments: { changed: true } }).pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
      const coordinator = yield* SessionRunCoordinator.make({ started: (id: typeof sessionID) => sessions.claim(id).pipe(Effect.asVoid),
        drain: (id: typeof sessionID) => McpAppRunner.drain({ db, events, location, permissions: permission, sessionID: id }).pipe(Effect.asVoid),
        settled: (id: typeof sessionID) => db.select({ token: SessionTable.execution_claim_token }).from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(
          Effect.flatMap((row) => row?.token ? sessions.release(id, row.token).pipe(Effect.asVoid) : Effect.void), Effect.orDie) })
      yield* coordinator.wake(sessionID, admitted.admittedSeq)
      const requests = yield* pollWithTimeout(permission.forSession(sessionID).pipe(Effect.map((rows) => rows.length === 1 ? rows : undefined)), "actual App permission missing")
      expect(requests[0]?.source?.type).toBe("mcp_app")
      expect(requests[0]?.source && "messageID" in requests[0].source).toBe(false)
      yield* permission.reply({ requestID: requests[0]!.id, reply: "once" })
      yield* coordinator.awaitIdle(sessionID)
      const settled = yield* service.status({ sessionID, invocationID: admitted.invocationID })
      expect(settled.state).toBe("settled")
      expect(state.calls).toBe(1)
      expect(state.maxConcurrent).toBe(1)
      expect((yield* service.result({ sessionID, invocationID: admitted.invocationID, viewID: view.viewID })).result._meta).toMatchObject({ privateResult: "App-only metadata", "io.modelcontextprotocol/serverInfo": { name: "app-invocation-wire", version: "1" } })
      expect((yield* service.invoke(input)).state).toBe("settled")
      expect(state.calls).toBe(1)
      // An abort while the original transport is preparing cannot cross its physical send marker.
      const aborted = yield* Effect.promise(async () => {
        const controller = new AbortController()
        return MCP.callAppTool(client, tools.find((tool) => tool.name === "app_only")!, {}, {
          current: () => origin.active, signal: controller.signal,
          beforeSend: async () => { controller.abort(); await Promise.resolve() },
        }).then(() => "unexpected", () => "refused")
      })
      expect(aborted).toBe("refused")
      expect(state.calls).toBe(1)
      // A restored rule body cannot revive a permission receipt from an older agent generation.
      yield* actors.update((editor) => editor.update(AgentV2.defaultID, (agent) => { agent.permissions = [{ action: "mcp", resource: "*", effect: "deny" }] }))
      yield* actors.update((editor) => editor.update(AgentV2.defaultID, (agent) => { agent.permissions = [{ action: "mcp", resource: "*", effect: "ask" }] }))
      const revoked = yield* service.result({ sessionID, invocationID: admitted.invocationID, viewID: view.viewID }).pipe(Effect.exit)
      expect(Exit.isFailure(revoked) && Option.getOrUndefined(Cause.findErrorOption(revoked.cause))).toMatchObject({ code: "permission_denied" })
      expect(state.calls).toBe(1)
      expect(yield* db.get(sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_provider_attempt) attempts,(SELECT count(*) FROM session_activity) activities,(SELECT count(*) FROM session_v2_tool_effect_admission) effects`)).toEqual({ inputs: 0, attempts: 0, activities: 0, effects: 0 })
      const unknown = yield* service.invoke({ ...input, rpcID: 2 })
      ids.push(unknown.invocationID)
      state.drop = true
      yield* coordinator.wake(sessionID, unknown.admittedSeq)
      const request2 = yield* pollWithTimeout(permission.forSession(sessionID).pipe(Effect.map((rows) => rows.length === 1 ? rows : undefined)), "actual App permission missing")
      yield* permission.reply({ requestID: request2[0]!.id, reply: "once" })
      yield* coordinator.awaitIdle(sessionID).pipe(Effect.exit)
      expect((yield* service.status({ sessionID, invocationID: unknown.invocationID })).state).toBe("unknown")
      expect(state.calls).toBe(2)
      expect((yield* service.invoke({ ...input, rpcID: 2 })).state).toBe("unknown")
      expect(state.calls).toBe(2)
      const debt = yield* db.select().from(McpAppEffectTable).where(eq(McpAppEffectTable.invocation_id, unknown.invocationID)).get()
      expect(debt?.reserved_bytes).toBe(McpAppInvocationSchema.LIMITS.resultBytes)
      expect(Exit.isFailure(yield* McpAppInvocation.requireAppResolved(db, sessionID).pipe(Effect.exit))).toBe(true)
      const inventory2 = yield* StartupInventory.classifyStartup(db)
      expect(inventory2.byCategory.mcp_app).toEqual({ safe_before_dispatch: 0, recovery: 1, resolved: 1, unclassified: 0 })
      // Legal aged ledger history issues no view/grant and performs no physical call. A new
      // admission reaches the production metadata-only collector; retired rows do not starve it.
      const original = (yield* McpAppInvocation.get(db, { sessionID, invocationID: admitted.invocationID }))!
      const aged = Date.now() - McpAppInvocationSchema.LIMITS.resultLifetimeMs - 1000
      yield* Effect.forEach(["aged-a", "aged-b"], (rpcID) => Effect.gen(function* () {
        const id = `mcpapp_${McpAppInvocation.hash({ viewID: view.viewID, rpcID })}`
        yield* db.insert(McpAppInvocationTable).values({ ...original.invocation, invocation_id: id, rpc_id: JSON.stringify(rpcID), admitted_seq: 0, created_at: aged, expires_at: aged + 60000 }).run()
        yield* db.insert(McpAppEffectTable).values({ invocation_id: id, state: "queued", revision: 1 }).run()
        yield* db.update(McpAppEffectTable).set({ state: "cancelled_before_dispatch", revision: 2, terminal_at: aged + 1 }).where(eq(McpAppEffectTable.invocation_id, id)).run()
      }), { discard: true })
      const fresh = yield* service.invoke({ ...input, rpcID: 3 })
      expect(fresh.state).toBe("queued")
      expect(yield* db.get(sql`SELECT count(*) count FROM session_mcp_app_invocation WHERE arguments_retired_at IS NOT NULL`)).toEqual({ count: 2 })
      expect(yield* McpAppInvocation.retire(db)).toBe(0)
      expect((yield* service.list({ sessionID, limit: 1 })).map((row) => row.invocationID)).toEqual([fresh.invocationID])
      expect((yield* service.list({ sessionID, after: unknown.admittedSeq })).map((row) => row.invocationID)).toEqual([fresh.invocationID])
      yield* McpAppInvocation.cancel(db, events, (yield* McpAppInvocation.get(db, { sessionID, invocationID: fresh.invocationID }))!, "interrupted")
      expect(state.calls).toBe(2)
    }).pipe(Effect.provide(layer))
    // A fresh DB layer reopens original facts; it cannot reconstruct original view authority.
    origin.active = false
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const known = yield* McpAppInvocation.get(db, { sessionID, invocationID: ids[0]! })
      const unknown = yield* McpAppInvocation.get(db, { sessionID, invocationID: ids[1]! })
      expect(known?.effect.state).toBe("settled")
      expect(unknown?.effect.state).toBe("unknown")
      expect(unknown?.effect.reserved_bytes).toBe(8 * 1024 * 1024)
      expect(McpAppInvocation.native(ids[1]!)).toBeUndefined()
      expect(state.calls).toBe(2)
    }).pipe(Effect.provide(Database.layerFromPath(filename)))
  }), 45000)
}
