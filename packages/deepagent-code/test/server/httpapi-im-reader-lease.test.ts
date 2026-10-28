import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import { join } from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { IMKernelDeliveryTable } from "@deepagent-code/core/im/kernel-delivery.sql"
import { IMKernelReaderProjectionTable, IMKernelReaderReadIntentTable, IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMDacSessionSchema } from "@deepagent-code/core/im/dac-session.schema"
import { GroupID, MessageID } from "@deepagent-code/core/im/id"
import { GroupTable, MemberTable, MessageTable } from "@deepagent-code/core/im/sql"
import { init } from "@deepagent-code/core/util/log"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Project } from "@/project/project"
import { Workspace } from "@/control-plane/workspace"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { deliverReply, authorizeReply, authorizeRegisteredReply, appendReply, replyOutboxID } from "@/im/im-reply-outbox"
import { ReplyBodyFixture } from "../../../core/test/fixture/im-reply-body-retirement"
import { IMDacBindingTable } from "@deepagent-code/core/im/dac-session.sql"
import { IMFacade } from "@/im/facade"
import { createHash } from "node:crypto"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { GroupDetailResponse, IMGroupResponse, IMPaths, MarkReadResponse, MessagePageResponse } from "@/server/routes/instance/httpapi/groups/im"
import { IMWebSocketPaths } from "@/server/routes/instance/httpapi/groups/im-websocket"
import { IMReaderSDKFixture } from "./im-reader-sdk.fixture"
import { IMDeviceRuntimeFixture } from "./im-device-runtime.fixture"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withTimeout } from "@/util/timeout"

void init({ print: false })
const it = testEffect(NodeServices.layer)
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const request = (directory: string, path: string, input?: RequestInit) => {
  const url = new URL(path, "http://localhost")
  url.searchParams.set("directory", directory)
  return HttpClientRequest.fromWeb(new Request(url, input)).pipe(HttpClientRequest.setUrl(url.pathname), HttpClient.execute, Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))))
}
const group = (directory: string, name: string) => request(directory, IMPaths.facadeDirect, post({ name })).pipe(Effect.map((response) => { expect(response).toMatchObject({ status: 200 }); return Schema.decodeUnknownSync(IMGroupResponse)(response.body) }))
const head = (directory: string, groupID: string) => request(directory, IMPaths.messages.replace(":groupId", groupID))
const waitBody = (directory: string, groupID: string, text: string) => pollWithTimeout(head(directory, groupID).pipe(Effect.map((response) => {
  if (response.status !== 200) return undefined
  const page = Schema.decodeUnknownSync(MessagePageResponse)(response.body)
  return page.messages.some((message) => message.content === text) ? page : undefined
})), `protected HTTP head did not expose ${text}`, "8 seconds")
const openSocket = (base: URL, directory: string, groupID: string) => {
  const url = new URL(IMWebSocketPaths.group.replace(":groupId", groupID), base)
  url.protocol = "ws:"
  url.searchParams.set("directory", directory)
  const socket = new WebSocket(url)
  const frames: string[] = []
  socket.addEventListener("message", (event) => frames.push(String(event.data)))
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }))
  const opened = new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("protected socket failed to open")), { once: true }) })
  return withTimeout(opened, 5000, "protected socket open timed out").then(() => ({ socket, frames, closed }))
}

const run = <A, E, R>(sdk: IMReaderSDKFixture.Interface, effect: (base: URL) => Effect.Effect<A, E, R>, metadata?: { name: string; allowed: boolean; inspections: number; delayMs?: number; token?: string }) => Effect.gen(function* () {
  const directory = yield* tmpdirScoped({ git: false })
  const original = Flag.DEEPAGENT_CODE_DB
  Flag.DEEPAGENT_CODE_DB = join(directory, "reader-file.sqlite")
  yield* Effect.addFinalizer(() => Effect.sync(() => { Flag.DEEPAGENT_CODE_DB = original }))
  const platform = yield* IMDeviceRuntimeFixture.make({ directory: join(directory, "platform"), uuid: "uuid-alice", async fetch(request, identity) {
    const url = new URL(request.url)
    const input = request.method === "POST" ? Schema.decodeUnknownSync(Schema.Struct({
      conversation_type: Schema.optional(Schema.Literals([1, 2])), conversation_id: Schema.optional(Schema.String), name: Schema.optional(Schema.String),
    }))(await request.json()) : undefined
    if (url.pathname.endsWith("/inspect") && metadata) metadata.inspections++
    const payload = url.pathname.endsWith("/login") ? {
      profile: "dac-im-device-v1", entitlementID: "e".repeat(32), deviceJkt: identity.jkt, bindingVersion: 1,
      identity: { uuid: "uuid-alice", name: "alice", org_id: 7, org_all_group_id: "org7" },
      kernel: { token: `daim2.${metadata?.token ?? "controlled-token"}`, navigator: "https://127.0.0.1:9", appkey: "appkey_1",
        user_id: "uuid-alice", socket_audience: "wss://127.0.0.1:9/im", credential_expires_at: Math.floor(Date.now() / 1000) + 3600,
        credential_generation: 1, device_profile: "dac-im-device-v1" },
    } : url.pathname.endsWith("/rename") ? {
      kernel_token: metadata?.token ?? "controlled-token", navigator_url: "https://127.0.0.1:9", appkey: "appkey_1",
      identity: { uuid: "uuid-alice", name: "alice", org_id: 7, org_all_group_id: "org7" }, ttl: { msg_life_time_ms: 259200000 },
      device: { profile: "dac-im-device-v1", entitlementID: "e".repeat(32), deviceJkt: identity.jkt, bindingVersion: 1, credentialGeneration: 1, socketAudience: "owned-reader" },
    } : url.pathname.endsWith("/resolve") ? { uuid: `uuid-${url.searchParams.get("name")}`, name: url.searchParams.get("name") }
      : url.pathname.endsWith("/inspect") && input?.conversation_type && input.conversation_id ? { conversation_type: input.conversation_type, conversation_id: input.conversation_id, org_id: 7, member_uuids: sdk.conversation(input.conversation_type, input.conversation_id).allowed && metadata?.allowed !== false ? ["uuid-alice", input.conversation_id] : [input.conversation_id], name: metadata?.name ?? input.conversation_id }
      : url.pathname.endsWith("/groups") ? { group_id: "kg-lease", name: input?.name, member_uuids: ["uuid-alice", "uuid-boba"] } : {}
    if (url.pathname.endsWith("/groups") || url.pathname.endsWith("/invite")) sdk.observed.platformMutations++
    if (url.pathname.endsWith("/inspect") && metadata?.delayMs) await Bun.sleep(metadata.delayMs)
    return Response.json({ success: true, message: "", data: payload })
  } })
  yield* IMDeviceRuntimeFixture.profile(platform.url)
  const node = createServer()
  const upgraded = new Set<Duplex>()
  node.on("upgrade", (_request, socket) => { upgraded.add(socket); socket.once("close", () => upgraded.delete(socket)) })
  const instanceStore = InstanceStore.defaultLayer.pipe(Layer.provide(Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })))
  const workspace = Workspace.defaultLayer.pipe(Layer.provide(InstanceStore.defaultLayer), Layer.provide(InstanceBootstrap.defaultLayer))
  const imRuntime = HttpApiApp.createIMRuntimeLayer({ buildEngine: sdk.buildEngine, env: {} }, platform.deviceLayer).pipe(Layer.provide(platform.httpLayer))
  const serving = HttpRouter.serve(HttpApiApp.createRoutes(undefined, RuntimeFlags.defaultLayer, { imRuntime }), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provideMerge(HttpServer.layerTestClient.pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(NodeHttpServer.layer(() => node, { port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "1 second" })))),
    Layer.provideMerge(NodeServices.layer),
  )
  const context = yield* Layer.build(Layer.mergeAll(instanceStore, Project.defaultLayer, Session.defaultLayer, workspace, Database.defaultLayer, serving).pipe(Layer.provide(Layer.suspend(() => ConfigProvider.layer(ConfigProvider.fromEnv())))))
  yield* Effect.addFinalizer(() => Effect.sync(() => { node.closeAllConnections(); upgraded.forEach((socket) => socket.destroy()); upgraded.clear() }))
  const server = node.address()
  if (!server || typeof server === "string") return yield* Effect.die("controlled DAC did not listen")
  return yield* effect(new URL(`http://127.0.0.1:${server.port}`)).pipe(
    Effect.tapCause(() => Effect.sync(() => console.error("IM_READER_FIXTURE_STAGE", {
      proofs: platform.observations, factories: sdk.observed.factories,
      calls: sdk.observed.calls, errors: sdk.observed.errors,
    }))),
    Effect.provide(context),
  )
})

it.live("personal DAC binding accepts owner-created pending conversations before any mirrored message", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const direct = yield* group(directory, "newpeer")
    const created = yield* request(directory, IMPaths.facadeGroups, post({ name: "emptygroup", memberNames: ["newpeer"] }))
    expect(created.status).toBe(200)
    const project = Schema.decodeUnknownSync(IMGroupResponse)(created.body)
    for (const conversation of [direct, project]) {
      expect(conversation.reader?.state).toBe("pending")
      const response = yield* request(directory, IMPaths.dacBinding.replace(":groupId", conversation.id))
      expect(response.status).toBe(200)
      expect(Schema.decodeUnknownSync(IMDacSessionSchema.BindingResponse)(response.body)).toMatchObject({ groupID: conversation.id, directory, bindingID: null, sessionID: null, workspaceID: null })
    }
    const db = sdk.observed.database!.db
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_kernel_reader_message`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_input`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_dac_binding`))?.count).toBe(0)
    expect(sdk.observed.sends).toBe(0)
    expect(sdk.observed.marks).toBe(0)
    sdk.publish(1, "uuid-newpeer", "VERIFIED_VISIBLE_BODY")
    yield* waitBody(directory, direct.id, "VERIFIED_VISIBLE_BODY")
    expect((yield* request(directory, IMPaths.dacBinding.replace(":groupId", direct.id))).status).toBe(200)
  }))
}), 30000)

it.live("personal DAC pending admission rejects tampered mapping, foreign owner, revoked membership and unverified message references", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const direct = yield* group(directory, "newpeer")
    const db = sdk.observed.database!.db
    const row = yield* db.select().from(IMKernelReaderProjectionTable).where(eq(IMKernelReaderProjectionTable.local_group_id, direct.id)).get()
    if (!row) return yield* Effect.die("actual pending producer did not persist its mapping")
    const mapping = KernelReaderSchema.decode(KernelReaderSchema.Pending, row.metadata, 4096)
    const url = IMPaths.dacBinding.replace(":groupId", direct.id)
    const rejected = () => request(directory, url).pipe(Effect.tap((response) => Effect.sync(() => expect(response).toMatchObject({ status: 409, body: { name: "IM_DAC_COMMAND_REJECTED", data: { code: "binding_unavailable" } } }))))
    const where = eq(IMKernelReaderProjectionTable.local_group_id, direct.id)
    const metadata = KernelReaderSchema.encode(KernelReaderSchema.Pending, { ...mapping, targetId: "uuid-forged" }, 4096)
    yield* db.update(IMKernelReaderProjectionTable).set({ metadata, metadata_hash: KernelReader.hash(metadata) }).where(where).run()
    yield* rejected()
    yield* db.update(IMKernelReaderProjectionTable).set(row).where(where).run()
    yield* db.update(IMKernelReaderProjectionTable).set({ binding_key: "b".repeat(64) }).where(where).run()
    yield* rejected()
    yield* db.update(IMKernelReaderProjectionTable).set(row).where(where).run()
    yield* db.update(GroupTable).set({ created_by: "other-owner" }).where(eq(GroupTable.id, GroupID.make(direct.id))).run()
    yield* rejected()
    yield* db.update(GroupTable).set({ created_by: direct.createdBy }).where(eq(GroupTable.id, GroupID.make(direct.id))).run()
    yield* db.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.group_id, GroupID.make(direct.id))).run()
    yield* rejected()
    yield* db.update(MemberTable).set({ role: "owner" }).where(eq(MemberTable.group_id, GroupID.make(direct.id))).run()
    yield* db.update(MemberTable).set({ member_type: "agent" }).where(eq(MemberTable.group_id, GroupID.make(direct.id))).run()
    yield* rejected()
    yield* db.update(MemberTable).set({ member_type: "user" }).where(eq(MemberTable.group_id, GroupID.make(direct.id))).run()
    const foreign = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    expect((yield* request(foreign, url)).status).not.toBe(200)
    const wrongSource = KernelReaderSchema.encode(KernelReaderSchema.Pending, { ...mapping, sourceHash: "b".repeat(64) }, 4096)
    yield* db.update(IMKernelReaderProjectionTable).set({ metadata: wrongSource, metadata_hash: KernelReader.hash(wrongSource) }).where(where).run()
    expect(yield* request(directory, url)).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_scope_mismatch" } } })
    yield* db.update(IMKernelReaderProjectionTable).set(row).where(where).run()
    const forged = MessageID.make("imsg_pending_forged")
    yield* db.insert(MessageTable).values({ id: forged, group_id: GroupID.make(direct.id), sender_id: "uuid-newpeer", sender_type: "user", type: "text", content: "UNVERIFIED_PENDING_BODY", created_at: Date.now(), updated_at: Date.now(), deleted_at: null }).run()
    expect(yield* request(directory, IMPaths.dacSubmit.replace(":groupId", direct.id), post({ commandID: "unverified-pending-ref", text: "private command", delivery: "queue", referenceMessageIDs: [forged] })))
      .toMatchObject({ status: 409, body: { name: "IM_DAC_COMMAND_REJECTED", data: { code: "reference_unavailable", admitted: false } } })
    sdk.conversation(1, "uuid-newpeer").allowed = false
    expect(yield* request(directory, url)).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_scope_mismatch" } } })
    sdk.conversation(1, "uuid-newpeer").allowed = true
    sdk.publish(1, "uuid-newpeer", "REVOKED_VISIBLE_BODY")
    yield* waitBody(directory, direct.id, "REVOKED_VISIBLE_BODY")
    const reader = sdk.observed.lease.get(directory)!.reader
    const previous = sdk.stallChanges()
    const syncing = yield* Effect.forkChild(reader.sync)
    yield* Effect.addFinalizer(() => Effect.sync(previous.release))
    yield* Effect.promise(() => withTimeout(previous.started, 5000, "Original reader changes response did not reach its barrier"))
    sdk.revoke(1, "uuid-newpeer")
    const revoked = sdk.stallChanges()
    yield* Effect.addFinalizer(() => Effect.sync(revoked.release))
    const joining = yield* Effect.forkChild(reader.sync)
    yield* Effect.yieldNow
    previous.release()
    yield* Fiber.join(syncing)
    yield* Fiber.join(joining)
    // A joined pass may have captured its changes before revoke. Only the
    // original durable projection acknowledges the later revision.
    revoked.release()
    yield* pollWithTimeout(reader.sync.pipe(
      Effect.andThen(db.select().from(IMKernelReaderProjectionTable).where(where).get()),
      Effect.map((projection) => projection?.visibility === "revoked" ? true : undefined),
    ), "Original reader did not publish the revoked projection", "8 seconds")
    expect((yield* db.select().from(IMKernelReaderProjectionTable).where(where).get())?.visibility).toBe("revoked")
    expect((yield* request(directory, url)).status).not.toBe(200)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_input`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_dac_binding`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_dac_command`))?.count).toBe(0)
    expect(sdk.observed.sends).toBe(0)
    expect(sdk.observed.marks).toBe(0)
  }))
}), 30000)

it.live("explicit selected group refresh uses the original authenticated inspector and fileSQLite without new changes or sends", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  const metadata = { name: "uuid-boba", allowed: true, inspections: 0 }
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const original = yield* group(directory, "boba")
    sdk.publish(1, "uuid-boba", "UNCHANGED_ORIGINAL_BODY")
    yield* waitBody(directory, original.id, "UNCHANGED_ORIGINAL_BODY")
    const db = sdk.observed.database!.db
    const before = yield* db.all(sql`SELECT reader_key,scope_key,completed_after,window_after,window_upper FROM im_kernel_reader_scope`)
    const messages = yield* db.all(sql`SELECT * FROM im_messages`)
    const memberRows = yield* db.all(sql`SELECT * FROM im_members`)
    const intentions = yield* db.all(sql`SELECT * FROM im_kernel_reader_read_intent`)
    const unchanged = yield* request(directory, IMPaths.group.replace(":groupId", original.id))
    expect(Schema.decodeUnknownSync(GroupDetailResponse)(unchanged.body).group.name).toBe("uuid-boba")
    metadata.name = "当前认证中文群名"
    const inspected = metadata.inspections
    const staleGET = yield* request(directory, IMPaths.group.replace(":groupId", original.id))
    expect(Schema.decodeUnknownSync(GroupDetailResponse)(staleGET.body).group.name).toBe("uuid-boba")
    expect(metadata.inspections).toBe(inspected)
    const refreshed = yield* request(directory, IMPaths.groupRefresh.replace(":groupId", original.id), { method: "POST" })
    expect(refreshed.status).toBe(200)
    expect(Schema.decodeUnknownSync(GroupDetailResponse)(refreshed.body).group.name).toBe(metadata.name)
    expect(metadata.inspections).toBe(inspected + 1)
    expect(yield* db.all(sql`SELECT reader_key,scope_key,completed_after,window_after,window_upper FROM im_kernel_reader_scope`)).toEqual(before)
    expect(yield* db.all(sql`SELECT * FROM im_messages`)).toEqual(messages)
    expect(yield* db.all(sql`SELECT * FROM im_members`)).toEqual(memberRows)
    expect(yield* db.all(sql`SELECT * FROM im_kernel_reader_read_intent`)).toEqual(intentions)
    const lateGET = yield* request(directory, IMPaths.group.replace(":groupId", original.id))
    expect(Schema.decodeUnknownSync(GroupDetailResponse)(lateGET.body).group.name).toBe(metadata.name)
    const meter = yield* db.all(sql`SELECT * FROM im_kernel_reader_meter`)
    metadata.allowed = false
    metadata.name = "拒绝的名称不得写入"
    const rejected = yield* request(directory, IMPaths.groupRefresh.replace(":groupId", original.id), { method: "POST" })
    expect(rejected).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_scope_mismatch" } } })
    expect(yield* db.all(sql`SELECT * FROM im_kernel_reader_meter`)).toEqual(meter)
    expect((yield* db.get<{ name: string }>(sql`SELECT name FROM im_groups WHERE id=${original.id}`))?.name).toBe("当前认证中文群名")
    const missing = yield* request(directory, IMPaths.groupRefresh.replace(":groupId", "img_missing"), { method: "POST" })
    expect(missing).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_required" } } })
    expect(sdk.observed.sends).toBe(0)
    expect(sdk.observed.marks).toBe(0)
    expect(sdk.observed.platformMutations).toBe(0)
  }), metadata)
}))

it.live("normal facade retry restores cold pending conversation selection without a known group ID and rejects revoked membership", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  const metadata = { name: "unchanged conversation", allowed: true, inspections: 0, token: "original-test-token" }
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const direct = yield* group(directory, "boba")
    const created = yield* request(directory, IMPaths.facadeGroups, post({ name: "emptygroup", memberNames: ["boba"] }))
    expect(created.status).toBe(200)
    const project = Schema.decodeUnknownSync(IMGroupResponse)(created.body)
    const db = sdk.observed.database!.db
    const before = yield* db.all(sql`SELECT reader_key,scope_key,completed_after,window_after,window_upper FROM im_kernel_reader_scope`)
    const members = yield* db.all(sql`SELECT * FROM im_members`)
    const groups = yield* db.all(sql`SELECT * FROM im_groups`)
    const oldPending = yield* db.all<{ metadata: string }>(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)
    expect(oldPending.length).toBe(2)
    // The real identity endpoint retires the original connection and activates
    // a fresh credential while the durable account and reader scope stay fixed.
    metadata.token = "cold-test-token"
    expect((yield* request(directory, IMPaths.facadeRename, post({ name: "alice" }))).status).toBe(200)
    const pageURL = "/api/v1/im/groups/page?lane=protected&limit=2"
    expect(yield* request(directory, pageURL)).toMatchObject({ status: 503, body: { name: "IM_READER_UNAVAILABLE", data: { code: "reader_scope_mismatch", operation: "pending-output" } } })
    expect(yield* db.all(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)).toEqual(oldPending)
    const inspected = metadata.inspections
    const delayed = sdk.delayConnection()
    const restoring = yield* Effect.forkChild(request(directory, IMPaths.facadeRetry, { method: "POST" }))
    yield* Effect.promise(() => delayed.subscribed)
    expect(metadata.inspections).toBe(inspected)
    delayed.release(0)
    const restored = yield* Fiber.join(restoring)
    expect({ inspections: metadata.inspections - inspected, acquireErrors: sdk.observed.errors }).toEqual({ inspections: 2, acquireErrors: [] })
    expect(restored).toMatchObject({ status: 200, body: { uuid: "uuid-alice", name: "alice", orgID: 7 } })
    expect(metadata.inspections).toBe(inspected + 2)
    const page = yield* request(directory, pageURL)
    expect(page.status).toBe(200)
    expect(Schema.decodeUnknownSync(Schema.Struct({ groups: Schema.Array(IMGroupResponse) }))(page.body).groups.map((item) => item.id).toSorted()).toEqual([direct.id, project.id].toSorted())
    expect(yield* db.all(sql`SELECT reader_key,scope_key,completed_after,window_after,window_upper FROM im_kernel_reader_scope`)).toEqual(before)
    expect(yield* db.all(sql`SELECT * FROM im_members`)).toEqual(members)
    expect(yield* db.all(sql`SELECT * FROM im_groups`)).toEqual(groups)
    const recovered = yield* db.all<{ metadata: string }>(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)
    expect(recovered).not.toEqual(oldPending)
    metadata.token = "revoked-test-token"
    metadata.allowed = false
    expect((yield* request(directory, IMPaths.facadeRename, post({ name: "alice" }))).status).toBe(200)
    const denied = yield* request(directory, IMPaths.facadeRetry, { method: "POST" })
    expect(denied).toEqual({ status: 502, body: { name: "IM_FACADE_UNAVAILABLE", data: { code: "im_unavailable", message: "IM conversation recovery is currently unavailable" } } })
    expect(JSON.stringify(denied)).not.toContain(metadata.token)
    expect(yield* db.all(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)).toEqual(recovered)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_messages`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_kernel_reader_message`))?.count).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_input`))?.count).toBe(0)
    expect(sdk.observed.sends).toBe(0)
    expect(sdk.observed.marks).toBe(0)
    expect(sdk.observed.platformMutations).toBe(1)
  }), metadata)
}), 30000)

it.live("normal facade retry rejects failed, disconnected and retired connections before pending metadata recovery", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  const metadata = { name: "unchanged conversation", allowed: true, inspections: 0, token: "original-test-token" }
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    yield* group(directory, "boba")
    const db = sdk.observed.database!.db
    const pending = yield* db.all(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)
    const inspected = metadata.inspections
    for (const state of [3, 2]) {
      const delayed = sdk.delayConnection()
      const restoring = yield* Effect.forkChild(request(directory, IMPaths.facadeRetry, { method: "POST" }))
      yield* Effect.promise(() => delayed.subscribed)
      delayed.release(state)
      expect(yield* Fiber.join(restoring)).toEqual({ status: 502, body: { name: "IM_FACADE_UNAVAILABLE", data: { code: "im_unavailable", message: "IM conversation recovery is currently unavailable" } } })
      expect(metadata.inspections).toBe(inspected)
      expect(yield* db.all(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)).toEqual(pending)
    }
    const delayed = sdk.delayConnection()
    const restoring = yield* Effect.forkChild(request(directory, IMPaths.facadeRetry, { method: "POST" }))
    yield* Effect.promise(() => delayed.subscribed)
    expect((yield* request(directory, IMPaths.facadeRename, post({ name: "alice" }))).status).toBe(200)
    expect(yield* Fiber.join(restoring)).toEqual({ status: 502, body: { name: "IM_FACADE_UNAVAILABLE", data: { code: "im_unavailable", message: "IM conversation recovery is currently unavailable" } } })
    delayed.release(0)
    expect(metadata.inspections).toBe(inspected)
    expect(yield* db.all(sql`SELECT metadata FROM im_kernel_reader_projection WHERE visibility='pending' ORDER BY binding_key`)).toEqual(pending)
    expect(sdk.observed.sends).toBe(0)
    expect(sdk.observed.marks).toBe(0)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM im_kernel_reader_message`))?.count).toBe(0)
  }), metadata)
}), 30000)

it.live("complete App HTTP and sockets retain the actual workspace lease through stalled A, first B, disposal, recreation, membership and background ACK", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  yield* run(sdk, (base) => Effect.gen(function* () {
    const directoryA = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const directoryB = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const store = yield* InstanceStore.Service
    const groupA = yield* group(directoryA, "boba")
    expect(groupA.kernelConvID?.startsWith("kr1:")).toBe(true)
    expect(groupA.projectID).toBeNull()
    expect(groupA.reader).toMatchObject({ mode: "protected", state: "pending", liveUnread: null })
    const database = sdk.observed.database!.db
    expect((yield* database.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM im_kernel_reader_message`))?.count).toBe(0)
    expect(sdk.observed.marks).toBe(0)
    const socketA = yield* Effect.promise(() => openSocket(base, directoryA, groupA.id))
    yield* Effect.addFinalizer(() => Effect.sync(() => socketA.socket.close()))
    sdk.publish(1, "uuid-boba", "CONTROLLED_BODY_A")
    const first = yield* waitBody(directoryA, groupA.id, "CONTROLLED_BODY_A")
    expect(first.reader?.displayEpoch).toBe(sdk.observed.lease.get(directoryA)?.reader.runtime.displayEpoch)
    expect(sdk.observed.context.get(directoryA)).toBe(yield* store.peek(directoryA))
    expect(yield* request(directoryA, IMPaths.status)).toMatchObject({ status: 200, body: { facade: "active", identity: { name: "alice" }, kernel: "connected" } })
    const created = yield* request(directoryA, IMPaths.facadeGroups, post({ name: "读者群", memberNames: ["boba"] }))
    expect(created).toMatchObject({ status: 200 })
    const protectedGroup = Schema.decodeUnknownSync(IMGroupResponse)(created.body)
    expect(protectedGroup.reader).toMatchObject({ mode: "protected", state: "pending", liveUnread: null })
    expect(protectedGroup.projectID).toBeNull()
    expect(protectedGroup.kernelConvID?.startsWith("kr1:")).toBe(true)
    expect(yield* request(directoryA, IMPaths.facadeInvite.replace(":groupId", protectedGroup.id), post({ name: "boba" }))).toMatchObject({ status: 200, body: { ok: true } })
    sdk.publish(2, "kg-lease", "CONTROLLED_GROUP_BODY")
    expect((yield* waitBody(directoryA, protectedGroup.id, "CONTROLLED_GROUP_BODY")).messages).toHaveLength(1)
    expect(sdk.observed.platformMutations).toBe(2)
    socketA.socket.send(JSON.stringify({ type: "read_receipt", data: { groupID: groupA.id, memberID: "server", readAt: Date.now() } }))
    yield* pollWithTimeout(Effect.sync(() => socketA.frames.some((frame) => frame.includes("reader_required")) ? true : undefined), "legacy protected receipt was not rejected")
    expect(sdk.observed.marks).toBe(0)
    sdk.publish(1, "uuid-bobb", "CONTROLLED_BODY_B")
    const pending = sdk.stall(sdk.conversation(1, "uuid-boba").projectionKey)
    yield* Effect.addFinalizer(() => Effect.sync(pending.release))
    const oldGet = yield* Effect.forkChild(head(directoryA, groupA.id))
    yield* Effect.promise(() => pending.started)
    expect(sdk.observed.context.has(directoryB)).toBe(false)
    const groupB = yield* group(directoryB, "bobb")
    const pageB = yield* waitBody(directoryB, groupB.id, "CONTROLLED_BODY_B")
    expect(pageB.reader).toBeDefined()
    expect(sdk.observed.maximum).toBe(2)
    expect(sdk.observed.active).toBe(1)
    expect(sdk.observed.context.get(directoryB)).toBe(yield* store.peek(directoryB))
    const actualA = sdk.observed.context.get(directoryA)!
    const epochA = sdk.observed.lease.get(directoryA)!.reader.runtime.displayEpoch
    const scopeA = yield* database.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.workspace_id, actualA.directory)).get()
    const disposing = yield* Effect.forkChild(store.dispose(actualA))
    yield* pollWithTimeout(store.peek(directoryA).pipe(Effect.map((value) => value === undefined ? true : undefined)), "disposing A remained current")
    expect((yield* request(directoryA, IMPaths.facadeDirect, post({ name: "boba" }))).status).toBe(502)
    expect((yield* Effect.promise(() => withTimeout(socketA.closed, 5000, "retired socket did not close"))).code).toBe(1008)
    expect(socketA.frames.some((frame) => frame.includes("reader_invalidated"))).toBe(true)
    expect(socketA.frames.some((frame) => frame.includes("CONTROLLED_BODY_A"))).toBe(false)
    expect(sdk.observed.marks).toBe(0)
    pending.release()
    const late = yield* Fiber.join(oldGet)
    expect(late.status).toBe(503)
    expect(JSON.stringify(late.body)).not.toContain("CONTROLLED_BODY_A")
    yield* Fiber.join(disposing)
    expect(yield* database.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, scopeA!.reader_key)).get()).toEqual(scopeA)
    expect((yield* waitBody(directoryB, groupB.id, "CONTROLLED_BODY_B")).messages).toHaveLength(1)
    const reopened = yield* group(directoryA, "boba")
    expect(reopened.id).toBe(groupA.id)
    const currentA = yield* waitBody(directoryA, reopened.id, "CONTROLLED_BODY_A")
    expect(currentA.reader?.displayEpoch).not.toBe(epochA)
    expect(sdk.observed.context.get(directoryA)).not.toBe(actualA)
    yield* store.dispose(actualA)
    expect((yield* waitBody(directoryA, reopened.id, "CONTROLLED_BODY_A")).reader?.displayEpoch).toBe(currentA.reader?.displayEpoch)
    const currentSocket = yield* Effect.promise(() => openSocket(base, directoryA, reopened.id))
    yield* Effect.addFinalizer(() => Effect.sync(() => currentSocket.socket.close()))
    sdk.revoke(1, "uuid-boba")
    currentSocket.socket.send(JSON.stringify({ type: "typing", data: { groupID: reopened.id, memberID: "server", typing: true } }))
    expect((yield* Effect.promise(() => withTimeout(currentSocket.closed, 5000, "membership loss did not close current socket"))).code).toBe(1008)
    const denied = yield* head(directoryA, reopened.id)
    expect([404, 503]).toContain(denied.status)
    expect(JSON.stringify(denied.body)).not.toContain("CONTROLLED_BODY_A")
    expect(sdk.observed.marks).toBe(0)
    const leaseB = sdk.observed.lease.get(directoryB)!
    const accountB = KernelReaderSchema.decode(KernelReaderSchema.Binding, (yield* KernelReader.scope(leaseB.reader.runtime))!.binding, 8192)
    const command = yield* ReplyBodyFixture.settledCommand(groupB.id, { directory: directoryB, scope: {
      accountKey: createHash("sha256").update(JSON.stringify([accountB.realm, accountB.appkey, accountB.orgID, accountB.userID])).digest("hex"),
      executorID: accountB.instanceID, conversationKey: JSON.stringify([1, "uuid-bobb"]),
    } })
    const id = replyOutboxID(command.sessionID, "msg_reply_final")
    yield* appendReply(database, { id, sessionID: command.sessionID, groupID: groupB.id, agentID: "build", triggerMessageID: command.inputID, replyMessageID: "msg_reply_final", replyText: ReplyBodyFixture.reply, now: Date.now() })
    const engine = sdk.observed.engine!
    const withReader: IMFacade.Interface["withReader"] = (context, use) => Effect.scoped(Effect.gen(function* () {
      const instance = yield* store.peek(context.directory ?? context.workspaceID)
      if (!instance || !engine.acquireReader) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
      return yield* use(yield* engine.acquireReader({ ...context, instance, instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) }))
    }))
    const background = yield* deliverReply({ db: database, repo: sdk.observed.repository!, broadcaster: sdk.observed.broadcaster!, kernelSync: sdk.observed.engine!,
      authorize: (binding, use) => authorizeRegisteredReply({ db: database, repo: sdk.observed.repository!, facade: { withReader }, kernelSync: engine, instanceStore: store }, binding, use),
    }, { id, sessionID: command.sessionID, groupID: groupB.id, agentID: "build", triggerMessageID: command.inputID, replyMessageID: "msg_reply_final", replyText: ReplyBodyFixture.reply, attempts: 1 })
    const receipt = yield* pollWithTimeout(database.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, background.id)).get().pipe(Effect.map((row) => row?.state === "acknowledged" ? row : undefined)), "background send did not persist SDK ACK")
    expect(receipt.binding?.workspaceID).toBe(directoryB)
    expect(receipt.kernel_message_id).toBe(sdk.observed.sent[0]?.messageID)
    expect(sdk.observed.sent[0]?.text).toBe(`[Agent·build] ${ReplyBodyFixture.reply}`)
    expect(sdk.observed.sends).toBe(1)
    expect(sdk.observed.factories).toBe(1)
    expect(sdk.observed.maximum).toBeLessThanOrEqual(2)
    expect((yield* database.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_input`))?.count).toBe(1)
    expect((yield* database.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_provider_attempt`))?.count).toBe(0)
    expect((yield* database.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_v2_tool_effect_admission`))?.count).toBe(0)
  }))
}), 30000)

it.live("a pending actual mark is retired to unknown before native settlement; a fresh higher action preserves that original fact", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const store = yield* InstanceStore.Service
    const direct = yield* group(directory, "pendingmark")
    sdk.publish(1, "uuid-pendingmark", "CONTROLLED_PENDING_MARK")
    yield* waitBody(directory, direct.id, "CONTROLLED_PENDING_MARK")
    const lease = sdk.observed.lease.get(directory)
    if (!lease) return yield* Effect.die("successful protected head did not capture its actual lease")
    const database = sdk.observed.database!.db
    const actionID = "whole-pending-original"
    const pending = sdk.stallMark(sdk.conversation(1, "uuid-pendingmark").projectionKey)
    yield* Effect.addFinalizer(() => Effect.sync(pending.release))
    const mark = yield* Effect.forkChild(request(directory, IMPaths.markRead.replace(":groupId", direct.id), post({ actionID })))
    yield* Effect.promise(() => pending.started)
    const before = yield* database.select().from(IMKernelReaderReadIntentTable).where(eq(IMKernelReaderReadIntentTable.action_id, actionID)).get()
    if (!before) { pending.release(); return yield* Effect.die("actual mark dispatched without a persisted intent") }
    expect(before).toMatchObject({ phase: "dispatched", original_action_id: actionID, original_target_admitted: "1", result: null, settled_at: null })
    expect(before.runtime_incarnation).toBe(lease.reader.runtime.incarnation)
    expect(sdk.observed.marks).toBe(1)
    const actual = sdk.observed.context.get(directory)!
    const epoch = lease.reader.runtime.displayEpoch
    const disposing = yield* Effect.forkChild(store.dispose(actual))
    const unknown = yield* pollWithTimeout(database.select().from(IMKernelReaderReadIntentTable).where(eq(IMKernelReaderReadIntentTable.action_id, actionID)).get().pipe(Effect.map((row) => row?.phase === "unknown" ? row : undefined)), "retired dispatch stayed an in-flight barrier")
    expect(yield* store.peek(directory)).toBeUndefined()
    expect(sdk.observed.active).toBe(1)
    expect(unknown).toEqual({ ...before, phase: "unknown", local_revision: before!.local_revision + 1, updated_at: unknown.updated_at })
    expect(unknown.updated_at).toBeGreaterThanOrEqual(before!.updated_at)
    const denied = yield* request(directory, IMPaths.markRead.replace(":groupId", direct.id), post({ actionID: "whole-retired-forbidden" }))
    expect(denied.status).toBe(503)
    expect(sdk.observed.marks).toBe(1)
    pending.release()
    expect((yield* Fiber.join(mark)).status).toBe(503)
    yield* Fiber.join(disposing)
    expect(yield* database.select().from(IMKernelReaderReadIntentTable).where(eq(IMKernelReaderReadIntentTable.action_id, actionID)).get()).toEqual(unknown)
    expect((yield* group(directory, "pendingmark")).id).toBe(direct.id)
    sdk.publish(1, "uuid-pendingmark", "CONTROLLED_NEW_TARGET")
    const current = yield* waitBody(directory, direct.id, "CONTROLLED_NEW_TARGET")
    expect(current.reader?.displayEpoch).not.toBe(epoch)
    const newAction = yield* request(directory, IMPaths.markRead.replace(":groupId", direct.id), post({ actionID: "whole-fresh-action", newAction: true }))
    expect(newAction.status).toBe(200)
    expect(Schema.decodeUnknownSync(MarkReadResponse)(newAction.body)).toMatchObject({ ok: true, reader: { actionID: "whole-fresh-action", state: "confirmed", targetAdmitted: "2", readOrdinal: "2", liveUnread: "0" } })
    expect(sdk.observed.marks).toBe(2)
    expect(yield* database.select().from(IMKernelReaderReadIntentTable).where(eq(IMKernelReaderReadIntentTable.action_id, actionID)).get()).toEqual(unknown)
    expect((yield* database.get<{ count: number }>(sql`SELECT count(*) AS count FROM im_kernel_reader_read_intent`))?.count).toBe(2)
    const detail = yield* pollWithTimeout(request(directory, IMPaths.group.replace(":groupId", direct.id)).pipe(Effect.map((response) => response.status === 200 ? Schema.decodeUnknownSync(GroupDetailResponse)(response.body) : undefined)), "cold action detail stayed stale")
    expect(detail.group.reader?.readAction).toMatchObject({ actionID: "whole-fresh-action", phase: "confirmed", targetReached: true })
    expect(detail.group.reader?.unresolvedReadActions).toMatchObject([{ actionID, phase: "unknown", targetReached: true }])
    expect(sdk.observed.factories).toBe(1)
    expect(sdk.observed.maximum).toBeLessThanOrEqual(2)
  }))
}), 30000)


it.live("reply delivery enters the current protected frame before metadata and keeps slow sending outside that frame", () => Effect.gen(function* () {
  const sdk = IMReaderSDKFixture.make({ version: 2 })
  const metadata = { name: "replypeer", allowed: true, inspections: 0, delayMs: 0 }
  yield* run(sdk, () => Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: false, config: { formatter: false, lsp: false } })
    const direct = yield* group(directory, "replypeer")
    const lease = sdk.observed.lease.get(directory)!
    const db = sdk.observed.database!.db
    const repo = sdk.observed.repository!
    const scope = (yield* KernelReader.scope(lease.reader.runtime))!
    const account = KernelReaderSchema.decode(KernelReaderSchema.Binding, scope.binding, 8192)
    const binding = { id: "reply-binding", identity_key: "reply-identity", owner_id: "server",
      account_key: createHash("sha256").update(JSON.stringify([account.realm, account.appkey, account.orgID, account.userID])).digest("hex"),
      executor_id: account.instanceID, conversation_key: JSON.stringify([1, "uuid-replypeer"]), group_id: direct.id,
      project_id: "reply-project", directory, workspace_id: null, current_session_id: "ses_im_reply", generation: 1,
      created_at: Date.now(), updated_at: Date.now() } satisfies typeof IMDacBindingTable.$inferSelect
    expect(yield* repo.getGroup({ groupID: direct.id, workspaceID: directory, userID: "server" }).pipe(Effect.flip))
      .toMatchObject({ message: "Remote conversation is currently unavailable" })
    const withReader: IMFacade.Interface["withReader"] = (_context, use) => Effect.scoped(use(lease))
    const deps = { db, repo, kernelSync: lease.engine, facade: { withReader } }
    const create = (id: string) => lease.engine.createMessage({ id, groupID: direct.id, senderID: "server", senderType: "user", type: "text", content: "collected final", mentions: [] })
    metadata.delayMs = 1100
    const before = performance.now()
    const sent = yield* authorizeReply(deps, binding, create("imsg_transport_slow_exact"))
    expect(performance.now() - before).toBeGreaterThan(1100)
    expect(sent.id).toBe("imsg_transport_slow_exact")
    expect((yield* db.select().from(IMKernelDeliveryTable).where(eq(IMKernelDeliveryTable.message_id, sent.id)).get())?.state).toBe("prepared")
    metadata.delayMs = 0
    const membership = and(eq(MemberTable.group_id, GroupID.make(direct.id)), eq(MemberTable.member_id, "server"), eq(MemberTable.member_type, "user"))
    const member = yield* db.select().from(MemberTable).where(membership).get()
    if (!member) return yield* Effect.die("The actual current membership is absent")
    metadata.allowed = false
    sdk.revoke(1, "uuid-replypeer")
    // The protected metadata admission observes an already persisted revocation.
    // Changing a future platform response after that admission is not an event receipt.
    yield* db.delete(MemberTable).where(membership).run()
    const changedMember = authorizeReply(deps, binding, create("imsg_transport_member_revoked"))
    expect((yield* changedMember.pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make("imsg_transport_member_revoked"))).get()).toBeUndefined()
    metadata.allowed = true
    sdk.conversation(1, "uuid-replypeer").allowed = true
    yield* repo.addMember({ groupID: direct.id, memberID: member.member_id, memberType: member.member_type, role: member.role })
    const changedSource = authorizeReply(deps, binding, Effect.sync(() => KernelReader.close(lease.reader.runtime)).pipe(Effect.andThen(create("imsg_transport_source_revoked"))))
    expect((yield* changedSource.pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* db.select().from(MessageTable).where(eq(MessageTable.id, MessageID.make("imsg_transport_source_revoked"))).get()).toBeUndefined()
    expect(sdk.observed.sends).toBe(0)
  }), metadata)
}), 30000)
