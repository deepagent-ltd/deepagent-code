import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Database } from "@deepagent-code/core/database/database"
import { IMMentionIntentTable } from "@deepagent-code/core/im/mention-intent.sql"
import { IMReplyOutbox } from "@/im/im-reply-outbox"
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

const originalResponder = process.env.DEEPAGENT_IM_AGENT_RESPONDER
const executionRows = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* db.all<{ sessions: number; inputs: number; receipts: number; outbox: number }>(
    "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) receipts,(SELECT count(*) FROM im_reply_outbox) outbox",
  ).pipe(Effect.orDie)
})
afterEach(() => {
  if (originalResponder === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
  if (originalResponder !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = originalResponder
})

describe("IM ordinary HTTP messages never invoke the owner's DAC", () => {
  it.live("ON, OFF and default ordinary mentions preserve exact message retries without Session admission", () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const query = `?directory=${encodeURIComponent(directory)}`
    const created = yield* request("/api/v1/im/groups" + query, { type: "project", name: "chat only" })
    expect(created.status).toBe(200)
    const group = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
    const before = yield* executionRows
    const messageIDs: string[] = []
    for (const setting of [undefined, "off", "on"]) {
      if (setting === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
      if (setting !== undefined) process.env.DEEPAGENT_IM_AGENT_RESPONDER = setting
      const body = { senderType: "user", type: "text", content: "@auto /dac an ordinary remote message is not a private command", clientRequestID: `ordinary-${setting ?? "default"}` }
      const first = yield* request(`/api/v1/im/groups/${group.id}/messages${query}`, body)
      expect(first.status).toBe(200)
      const message = yield* first.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
      const duplicate = yield* request(`/api/v1/im/groups/${group.id}/messages${query}`, body)
      expect(duplicate.status).toBe(200)
      expect(yield* duplicate.json).toMatchObject({ id: message.id })
      messageIDs.push(message.id)
    }
    const page = yield* request(`/api/v1/im/groups/${group.id}/messages${query}`)
    expect(page.status).toBe(200)
    const messages = yield* page.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ messages: Schema.Array(Schema.Struct({ id: Schema.String })) }))))
    expect(messages.messages.map((message) => message.id).sort()).toEqual(messageIDs.sort())
    expect(yield* executionRows).toEqual(before)
    expect(before).toEqual([{ sessions: 0, inputs: 0, receipts: 0, outbox: 0 }])
    expect(yield* (yield* Database.Service).db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)).toEqual([])
  }), 30000)

  it.live("an old pending mention remains unchanged across the real reconcile interval even with responder ON", () => Effect.gen(function* () {
    process.env.DEEPAGENT_IM_AGENT_RESPONDER = "on"
    const directory = yield* tmpdirScoped()
    const query = `?directory=${encodeURIComponent(directory)}`
    const created = yield* request("/api/v1/im/groups" + query, { type: "project", name: "historical pending" })
    expect(created.status).toBe(200)
    const group = yield* created.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
    const response = yield* request(`/api/v1/im/groups/${group.id}/messages${query}`, { senderType: "user", type: "text", content: "@auto old pending mention" })
    expect(response.status).toBe(200)
    const message = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))))
    const db = (yield* Database.Service).db
    // An immutable historical specimen, not a new automatic admission producer.
    yield* db.insert(IMMentionIntentTable).values({ id: `imi_old_${message.id}`, message_id: message.id, agent_name: "auto", directory, workspace_id: directory, user_id: "server", origin: "local", status: "pending", created_at: 1, updated_at: 1 }).run().pipe(Effect.orDie)
    const intents = yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)
    const before = yield* executionRows
    yield* Effect.sleep(`${IMReplyOutbox.IM_REPLY_RECONCILE_INTERVAL_MS + 250} millis`)
    expect(yield* db.select().from(IMMentionIntentTable).all().pipe(Effect.orDie)).toEqual(intents)
    expect(yield* executionRows).toEqual(before)
    expect(before).toEqual([{ sessions: 0, inputs: 0, receipts: 0, outbox: 0 }])
  }), 30000)
})
