import { NodeHttpServer } from "@effect/platform-node"
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { eq, sql } from "drizzle-orm"
import { Attention } from "@deepagent-code/core/attention"
import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { AttentionSeenTable } from "@deepagent-code/core/attention/sql"
import { Database } from "@deepagent-code/core/database/database"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { MessageID } from "@deepagent-code/core/v1/session"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { ServerAuth } from "@deepagent-code/server/auth"
import { AttentionGroup } from "@deepagent-code/server/groups/attention"
import { createAttentionHandler } from "@deepagent-code/server/handlers/attention"
import { Authorization, authorizationLayer } from "@deepagent-code/server/middleware/authorization"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@deepagent-code/server/middleware/schema-error"
import {
  seedActivity,
  seedRecovery,
  seedSession,
  services,
  temporary,
  capability,
} from "../../../core/test/fixture/attention"
import { testEffect } from "../lib/effect"
import { withTimeout } from "../../src/util/timeout"
import { challenge } from "../../../core/test/fixture/attention-permission"

const Api = HttpApi.make("server").add(AttentionGroup).middleware(Authorization).middleware(SchemaErrorMiddleware)
const authorization = ServerAuth.header({ username: "operator", password: "test-secret" })!
const auth = ServerAuth.Config.layer({ password: Option.some("test-secret"), username: "operator" })

const api = (authentication = auth) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(createAttentionHandler()),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      Layer.provide(authentication),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const layer = (access = capability, authentication = auth) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = yield* temporary
      return api(authentication).pipe(
        Layer.provideMerge(services(path.join(directory, "attention.db"), undefined, access)),
      )
    }),
  )
const it = testEffect(layer())
const disabled = testEffect(layer(Attention.localCapability({ gateway: false })))
const unauthenticated = testEffect(
  layer(
    Attention.localCapability({ gateway: false }),
    ServerAuth.Config.layer({ password: Option.none(), username: "operator" }),
  ),
)
const get = (url: string, headers: Record<string, string> = { authorization }) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers), HttpClient.execute)
const seen = (item: AttentionSchema.Item, revision = item.revision) =>
  HttpClientRequest.put(`/api/attention/${encodeURIComponent(item.id)}/seen`).pipe(
    HttpClientRequest.setHeaders({ authorization }),
    HttpClientRequest.bodyJson({ revision }),
    Effect.flatMap(HttpClient.execute),
  )
const list = (url = "/api/attention") =>
  get(url).pipe(
    Effect.flatMap((response) => {
      expect(response.status).toBe(200)
      return response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AttentionSchema.List)))
    }),
  )
const changes = (database: Database.Interface) =>
  database.db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)

it.live("authenticates the operator and rejects every explicit workspace selector before global reads", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const a = yield* seedSession(database, "http-a", { project: "project-a" })
    const b = yield* seedSession(database, "http-b", { project: "project-b" })
    const remote = yield* seedSession(database, "http-private", { workspace: "wrk_secret" })
    yield* seedActivity(database, a, "http-a")
    yield* seedActivity(database, b, "http-b")
    yield* seedActivity(database, remote, "http-private")
    expect((yield* get("/api/attention", {})).status).toBe(401)
    expect((yield* get("/api/attention/capability", {})).status).toBe(401)
    expect((yield* get("/api/attention", { authorization: "Basic invalid" })).status).toBe(401)
    const before = yield* changes(database)
    const supported = yield* get("/api/attention/capability")
    expect(yield* supported.json).toEqual(capability)
    expect((yield* list()).data).toHaveLength(2)
    expect((yield* list("/api/attention?directory=%2Ftmp%2Fproject-a")).data).toHaveLength(2)
    for (const route of [
      "/api/attention?workspace=wrk_secret",
      "/api/attention?workspace=",
      "/api/attention?location%5Bworkspace%5D=wrk_secret",
      "/api/attention/capability?workspace=wrk_secret",
      "/api/attention/activity%3Aactivity_http-a?workspace=wrk_secret",
    ]) {
      const response = yield* get(route)
      expect(response.status).toBe(400)
      expect(JSON.stringify(yield* response.json)).not.toContain("wrk_secret")
    }
    expect((yield* get("/api/attention", { authorization, "x-deepagent-code-workspace": "wrk_secret" })).status).toBe(
      400,
    )
    expect((yield* get("/api/attention/activity%3Aactivity_http-private")).status).toBe(404)
    expect(yield* changes(database)).toEqual(before)
  }),
)

it.live("GETs never write; concurrent seen requests commit one receipt and stale revisions return 409", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const session = yield* seedRecovery(database, "http-recovery", "claim_only")
    const failed = yield* seedSession(database, "http-failed", { project: "project-b" })
    yield* seedActivity(database, failed, "http-failed")
    const before = yield* changes(database)
    const first = yield* list("/api/attention?limit=1")
    expect(first.unseenCount).toBe(2)
    const item = first.data[0]!
    expect(item.kind).toBe("execution_recovery")
    const detail = yield* get(`/api/attention/${encodeURIComponent(item.id)}`)
    expect(detail.status).toBe(200)
    expect((yield* list(`/api/attention?limit=1&cursor=${first.nextCursor}`)).data[0]!.kind).toBe("activity_failed")
    expect(yield* changes(database)).toEqual(before)
    const requests = yield* Effect.all([seen(item), seen(item)], { concurrency: "unbounded" })
    expect(requests.map((response) => response.status)).toEqual([200, 200])
    expect((yield* changes(database))!.value - before!.value).toBe(1)
    const rows = yield* database.db.select().from(AttentionSeenTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect((yield* list("/api/attention?view=unseen&limit=1")).unseenCount).toBe(1)
    expect((yield* seen(item, "stale")).status).toBe(409)
    const mutation = database.db
      .transaction(
        (tx) =>
          tx
            .insert(TaskRunTable)
            .values({
              run_id: "task_http_race",
              request_hash: "a".repeat(64),
              parent_session_id: session,
              parent_message_id: MessageID.make("msg_http_race"),
              tool_call_id: "call_http_race",
              child_session_id: SessionSchema.ID.make("ses_http_child"),
              generation: 1,
              delivery_mode: "background",
              phase: "research",
              state: "running",
              time_created: 1,
              time_updated: 1,
            })
            .run(),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    // Both HTTP clients race a real authority transition on the same file database.
    // A receipt before the transition can cover only the old revision.
    const raced = yield* Effect.all([seen(item), mutation, seen(item)], { concurrency: "unbounded" })
    expect([200, 409]).toContain(raced[0].status)
    expect([200, 409]).toContain(raced[2].status)
    const fresh = (yield* list("/api/attention?kind=execution_recovery")).data[0]!
    expect(fresh).toMatchObject({ id: item.id, seen: false, reasonCode: "recovery_required" })
    expect(fresh.revision).not.toBe(item.revision)
    expect((yield* seen(item)).status).toBe(409)
    expect(
      yield* database.db
        .select()
        .from(AttentionSeenTable)
        .where(eq(AttentionSeenTable.source_revision, fresh.revision))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(0)
    expect((yield* get(`/api/attention?project=project-b&cursor=${first.nextCursor}`)).status).toBe(400)
    expect((yield* get("/api/attention?limit=0")).status).toBe(400)
    expect((yield* get("/api/attention?kind=permission_pending")).status).toBe(400)
  }),
)

disabled.live("returns an explicit disabled capability and denies list/detail/seen", () =>
  Effect.gen(function* () {
    expect(yield* (yield* get("/api/attention/capability")).json).toEqual({
      ...capability,
      enabled: false,
      reason: "profile_disabled",
    })
    expect((yield* get("/api/attention")).status).toBe(503)
    expect((yield* get("/api/attention/activity%3Aprivate")).status).toBe(503)
    const response = yield* HttpClientRequest.put("/api/attention/activity%3Aprivate/seen").pipe(
      HttpClientRequest.setHeaders({ authorization }),
      HttpClientRequest.bodyJson({ revision: "private" }),
      Effect.flatMap(HttpClient.execute),
    )
    expect(response.status).toBe(503)
  }),
)

unauthenticated.live("the default password-free host stays disabled regardless of client profile input", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const session = yield* seedSession(database, "default-private")
    yield* seedActivity(database, session, "default-private")
    const before = yield* changes(database)
    const response = yield* get("/api/attention/capability?profile=implicit-local", {})
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ ...capability, enabled: false, reason: "profile_disabled" })
    expect((yield* get("/api/attention?profile=implicit-local", {})).status).toBe(503)
    expect((yield* get("/api/attention/activity%3Aactivity_default-private", {})).status).toBe(503)
    const receipt = yield* HttpClientRequest.put("/api/attention/activity%3Aactivity_default-private/seen").pipe(
      HttpClientRequest.bodyJson({ revision: "client-provided" }),
      Effect.flatMap(HttpClient.execute),
    )
    expect(receipt.status).toBe(503)
    expect(yield* changes(database)).toEqual(before)
  }),
)

it.live("the generated SDK preserves real nullable values and changes only the viewed receipt", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* seedRecovery(database, "sdk-recovery", "claim_only")
    const client = createDeepAgentCodeClient({
      baseUrl: HttpServer.formatAddress((yield* HttpServer.HttpServer).address),
      headers: { authorization },
      directory: "/tmp/unrelated-project",
    })
    const before = yield* changes(database)
    const page = yield* Effect.promise(() => client.v2.attention.list({ limit: "1" }, { throwOnError: true }))
    expect(page.data.unseenCount).toBe(1)
    const item = page.data.data[0]!
    expect(item).toMatchObject({ kind: "execution_recovery", occurredAt: null, seenAt: null, seen: false })
    expect(Number.isFinite(item.observedAt)).toBe(true)
    const detail = yield* Effect.promise(() => client.v2.attention.get({ itemID: item.id }, { throwOnError: true }))
    expect(detail.data.data).toMatchObject({ id: item.id, occurredAt: null, seenAt: null })
    expect(yield* changes(database)).toEqual(before)
    const receipt = yield* Effect.promise(() =>
      client.v2.attention.seen({ itemID: item.id, revision: item.revision }, { throwOnError: true }),
    )
    expect(receipt.data.data).toMatchObject({ id: item.id, revision: item.revision, occurredAt: null, seen: true })
    expect(Number.isFinite(receipt.data.data.seenAt)).toBe(true)
    expect((yield* changes(database))!.value - before!.value).toBe(1)
    const fresh = yield* Effect.promise(() => client.v2.attention.list({ view: "unseen" }, { throwOnError: true }))
    expect(fresh.data).toMatchObject({ data: [], unseenCount: 0 })
  }),
)

it.live("serves current no-progress action references through the real HTTP handler and generated SDK", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const source = yield* challenge(database, "http-approval", { project: "project-b", leaseMs: 2000 })
    const client = createDeepAgentCodeClient({
      baseUrl: HttpServer.formatAddress((yield* HttpServer.HttpServer).address),
      headers: { authorization },
      directory: "/tmp/unrelated-project",
    })
    const before = yield* changes(database)
    const page = yield* Effect.promise(() => client.v2.attention.list({ kind: "no_progress" }, { throwOnError: true }))
    expect(page.data.unseenCount).toBe(1)
    const item = page.data.data[0]!
    expect(item).toMatchObject({
      id: `approval:${source.requestID}`,
      state: "needs_human",
      allowedActions: ["continue_once", "terminate"],
      source: { activityID: source.activityID, permissionRequestID: source.requestID },
      session: { projectID: "project-b", workspaceID: null },
      seenAt: null,
    })
    expect(item.source.expiresAt).toBeGreaterThan(page.data.asOf)
    const detail = yield* Effect.promise(() => client.v2.attention.get({ itemID: item.id }, { throwOnError: true }))
    expect(detail.data.data).toMatchObject({
      id: item.id,
      revision: item.revision,
      source: item.source,
      allowedActions: item.allowedActions,
      seenAt: null,
    })
    expect(yield* changes(database)).toEqual(before)
    expect((yield* get(`/api/attention/${encodeURIComponent(item.id)}?workspace=wrk_wrong`)).status).toBe(400)
    const receipt = yield* Effect.promise(() =>
      client.v2.attention.seen({ itemID: item.id, revision: item.revision }, { throwOnError: true }),
    )
    expect(receipt.data.data).toMatchObject({
      seen: true,
      revision: item.revision,
      allowedActions: item.allowedActions,
    })
    expect((yield* changes(database))!.value - before!.value).toBe(1)
    yield* Effect.sleep("2100 millis")
    expect((yield* get(`/api/attention/${encodeURIComponent(item.id)}`)).status).toBe(404)
    expect((yield* list("/api/attention?kind=no_progress")).data).toEqual([])
    expect((yield* changes(database))!.value - before!.value).toBe(1)
  }),
)

test("warm host keeps explicit local profiles listener-local and starts disabled without a profile", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const directory = await mkdtemp("/tmp/attention-host-")
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/attention-host.ts")], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      TMPDIR: "/tmp",
      DEEPAGENT_CODE_TEST_HOME: directory,
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      DEEPAGENT_CODE_DB: path.join(directory, "attention.db"),
      DEEPAGENT_CODE_ATTENTION_PROFILE: "",
      DEEPAGENT_CODE_WORKSPACE_ID: "",
      DEEPAGENT_CODE_GATEWAY: "false",
      DEEPAGENT_CODE_SERVER_PASSWORD: "test-secret",
      DEEPAGENT_CODE_SERVER_USERNAME: "operator",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_IM_FACADE_URL: "",
      DEEPAGENT_IM_FACADE_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const result = await withTimeout(
      Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      25000,
      "attention host startup timed out",
    )
    if (result[0] !== 0) throw new Error(`attention host failed: ${result[1]}\n${result[2]}`)
    expect(result[1]).toContain("ATTENTION_HOST_PROFILE_PASS")
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
