import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Database } from "@deepagent-code/core/database/database"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Use the existing headless mode: unknown routes are local 404s and no web UI
// fallback can forward test bodies outside this scoped test server.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.createRoutes(undefined, RuntimeFlags.layer({ disableEmbeddedWebUi: true })), { disableListenLog: true, disableLogger: true },
)
const http = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal), Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Database.defaultLayer),
)
const instances = InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })))
const workspace = Workspace.defaultLayer.pipe(Layer.provide(InstanceStore.defaultLayer), Layer.provide(InstanceBootstrap.defaultLayer))
const it = testEffect(Layer.mergeAll(http, instances, Project.defaultLayer, Session.defaultLayer, workspace, Database.defaultLayer))
const request = (url: string, body?: unknown) => (body === undefined
  ? Effect.succeed(HttpClientRequest.get(url))
  : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body)))
  .pipe(Effect.map(HttpClientRequest.setHeader("origin", "http://localhost:3000")), Effect.flatMap(HttpClient.execute))
afterEach(async () => { await disposeAllInstances(); await resetDatabase() })

describe("IM personal /dac HTTP contract", () => {
  it.live("legacy execution routes are absent and ordinary messages cannot admit a Session", () => Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const query = `?directory=${encodeURIComponent(tmp)}`
    for (const url of ["/api/v1/im/tasks/targets", "/api/v1/im/tasks/requests", "/api/v1/im/tasks/requests/request/accept", "/api/v1/im/tasks/requests/request/cancel"]) {
      const response = yield* request(url + query, url.includes("targets") ? undefined : {})
      expect(response.status).toBe(404)
    }
    const response = yield* request("/api/v1/im/groups" + query, { type: "project", name: "personal" })
    expect(response.status).toBe(200)
    const group = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
    expect((yield* request(`/api/v1/im/groups/${group.id}/messages${query}`, { senderType: "user", type: "text", content: "@auto /dac this is another person's normal message" })).status).toBe(200)
    const binding = yield* request(`/api/v1/im/groups/${group.id}/dac${query}`)
    expect(binding.status).toBe(200)
    const value = yield* binding.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(IMDacSessionSchema.BindingResponse)))
    expect(value.sessionID).toBeNull()
    expect(value.workspaceID).toBeNull()
    const missing = yield* request(`/api/v1/im/groups/${group.id}/dac/commands${query}`, {
      commandID: "missing-reference", text: "private", delivery: "queue", referenceMessageIDs: ["missing-message"],
    })
    expect(missing.status).toBe(409)
    expect(yield* missing.json).toMatchObject({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "reference_unavailable", admitted: false } })
    const unknown = yield* request(`/api/v1/im/groups/${group.id}/dac/commands/missing-reference${query}`)
    expect(unknown.status).toBe(409)
    expect(yield* unknown.json).toMatchObject({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "command_not_found" } })
    const db = (yield* Database.Service).db
    expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }), 30000)
  it.live("final retry is an explicit local command endpoint, not a new prompt or message send", () => Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const query = `?directory=${encodeURIComponent(tmp)}`
    const response = yield* request("/api/v1/im/groups" + query, { type: "project", name: "reply" })
    const group = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
    const retry = yield* request(`/api/v1/im/groups/${group.id}/dac/commands/missing/reply/retry${query}`, {})
    expect(retry.status).toBe(409)
    expect(yield* retry.json).toMatchObject({ name: "IM_DAC_COMMAND_REJECTED", data: { code: "reply_unavailable" } })
    const foreign = yield* tmpdirScoped()
    expect((yield* request(`/api/v1/im/groups/${group.id}/dac/commands/missing/reply/retry?directory=${encodeURIComponent(foreign)}`, {})).status).toBe(404)
    expect(yield* (yield* Database.Service).db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }), 30000)

})
