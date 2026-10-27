import { afterAll, beforeAll, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Option, Schema, Scope, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

const control = { mode: "fresh", phase: "seed", online: true, capability: true, batchCalls: 0, scalarCalls: 0, inspectCalls: 0, sdkFailure: "" }
const cases = ["long-flight", "mixed", "late-consume", "consumed", "consumer", "ttl", "current", "source", "revision", "post-revision", "order", "duplicate", "missing", "extra", "clock", "ordinals", "complete", "foreign", "unsupported"]
const selected = process.env.DEEPAGENT_CODE_TEST_OUTPUT_BATCH_CASES?.split(",") ?? cases
if (!selected.length || selected.some(mode => !cases.includes(mode)) || new Set(selected).size !== selected.length) throw new Error("BATCH_CASE_SELECTION_REJECTED")
const full = selected.length === cases.length && selected.every((mode, index) => mode === cases[index])
if ((process.env.CI || process.env.GITHUB_ACTIONS) && !full) throw new Error("BATCH_CASE_SELECTION_REJECTED")
const summaries: { mode: string; outcome: string; business: number; batch: number; scalar: number; inspect: number }[] = []
const selector = Schema.Union([
  Schema.Struct({ visible: Schema.Struct({ projectionKey: KernelReaderSchema.Hash, projectionRevision: KernelReaderSchema.Positive }) }),
  Schema.Struct({ pending: Schema.Struct({ conversationType: Schema.Literals([1, 2]), targetId: KernelReaderSchema.text(512) }) }),
])
const native = KernelLiveFirstSeenFixture.make({
  fetch(request) {
    if (new URL(request.url).pathname !== "/inspect") return undefined
    if (request.headers.get("authorization") !== "Bearer private-first-seen-token") return Response.json({}, { status: 403 })
    if (control.phase === "output") control.inspectCalls++
    return Response.json({ name: "Authenticated batch fixture group" })
  },
  queryDelayMs(topic) {
    if (topic !== "qry_delivery_output_proof") return 0
    return control.mode === "long-flight" ? 4900 : control.mode === "ttl" ? 200 : 0
  },
  response(topic, request, original) {
    if (topic === "qry_delivery_reader") return { name: "DeliveryReaderInfo", value: { version: 2, scopeKey: "a".repeat(64), currentCursor: "2", serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000, outputProofAvailable: control.capability } }
    if (topic === "qry_delivery_read_cut") {
      control.scalarCalls++
      return { name: "DeliveryReadCutResult", value: cut(String(request.projectionKey), String(request.projectionRevision), Date.now()) }
    }
    if (topic !== "qry_delivery_output_proof") return original
    control.batchCalls++
    const selected = Schema.decodeUnknownSync(Schema.Array(selector))(request.outputRows, { onExcessProperty: "error" })
    const now = Date.now()
    const rows = selected.map((row) => "visible" in row ? { visible: cut(row.visible.projectionKey, row.visible.projectionRevision, now) } : { pending: row.pending })
    const changed = control.mode === "order" ? [...rows].reverse()
      : control.mode === "duplicate" ? [rows[0], rows[0]]
        : control.mode === "missing" ? rows.slice(0, 1)
          : control.mode === "extra" ? [...rows, rows[0]]
            : rows.map((row, index) => "visible" in row && index === 0 ? { visible: { ...row.visible,
              ...(control.mode === "clock" ? { serverNow: now + 1 } : {}),
              ...(control.mode === "ordinals" ? { liveUnread: "2", storedUnread: "1" } : {}),
              ...(control.mode === "complete" ? { complete: true } : {}),
              ...(control.mode === "foreign" ? { projectionKey: "f".repeat(64) } : {}),
            } } : row)
    return { name: "DeliveryOutputProofResult", value: { version: 2, scopeKey: request.scopeKey, serverNow: now, rows: changed } }
  },
})
const config = { appkey: `private-output-batch-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver", protectedMedia: true,
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
const client = Layer.provideMerge(KernelClient.layer, KernelSdk.liveFromConfig(config))
const directory = await fs.mkdtemp(path.join(tmpdir(), "dac-output-batch-proof-"))

const scope = Scope.makeUnsafe()
const shared: { context?: Context.Context<KernelClient.Service | KernelSdk.Service> } = {}

beforeAll(async () => {
  shared.context = await Effect.runPromise(Layer.buildWithScope(client, scope))
  await Effect.runPromise(Effect.gen(function* () {
    const connection = yield* KernelClient.Service
    const sdk = yield* KernelSdk.Service
    if (!sdk.getDeliveryOutputProof) return yield* Effect.die("ACTUAL_BATCH_SDK_METHOD_MISSING")
    for (const round of Array.from({ length: 500 }, (_, index) => index)) {
      if ((yield* SubscriptionRef.get(connection.state)) === "connected") break
      if (round === 499) return yield* Effect.die("ACTUAL_BATCH_SDK_NOT_CONNECTED")
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.provide(shared.context)))
}, 60000)

afterAll(async () => {
  try {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  } finally {
    native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
  expect(summaries).toHaveLength(selected.length)
  expect(summaries.map((summary) => summary.mode)).toEqual(selected)
  expect(new Set(summaries.map((summary) => summary.mode)).size).toBe(selected.length)
  if (full) {
    expect(summaries).toHaveLength(19)
    expect(summaries.map((summary) => summary.mode)).toEqual(cases)
    expect(new Set(summaries.map((summary) => summary.mode)).size).toBe(19)
  }
  console.log(JSON.stringify({ tag: "BATCH_CASE_COUNTS", coverage: full ? "full" : "partial", expected: cases.length,
    verified: summaries.length, unique: new Set(summaries.map((summary) => summary.mode)).size, cases: summaries }))
}, 60000)

function cut(projectionKey: string, projectionRevision: string, serverNow: number) {
  return { version: 2, scopeKey: "a".repeat(64), projectionKey, projectionRevision,
    throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", complete: false, serverNow }
}

// Plain tests stay serial because the original SDK connection is shared.
for (const mode of selected) test(`one authenticated batch preserves two visible or mixed output across long native flight, and rejects stale/current/codec boundaries before effects [${mode}]`, async () => {
  const context = shared.context
  if (!context) throw new Error("ACTUAL_BATCH_SDK_CONTEXT_MISSING")
  await Effect.runPromise(Effect.gen(function* () {
    const sdk = yield* KernelSdk.Service
    const connection = yield* KernelClient.Service
      control.mode = mode
      control.phase = "seed"
      control.online = true
      control.capability = mode !== "unsupported"
      control.batchCalls = 0
      control.scalarCalls = 0
      control.inspectCalls = 0
      control.sdkFailure = ""
      const info = yield* sdk.getDeliveryReader()
      const database = Database.layerFromPath(path.join(directory, `${mode}.sqlite`))
      const repository = IMRepositoryLive.pipe(Layer.provide(database))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const repo = yield* IMRepository
        const source = KernelConfig.deliverySource(config)
        const runtime = KernelReader.attach({ db, workspaceID: "batch-workspace", userID: "server", source,
          current: () => SubscriptionRef.get(connection.state).pipe(Effect.map((state) => state === "connected" && control.online && KernelReader.hash(source) === KernelReader.hash(KernelConfig.deliverySource(config)))),
          inspect: () => Effect.tryPromise({ try: async () => {
            const response = await fetch(native.server.url.origin + "/inspect", { headers: { Authorization: "Bearer private-first-seen-token" } })
            if (response.status !== 200) throw new Error("authenticated inspect refused")
            return await response.json() as { name: string }
          }, catch: () => KernelReaderSchema.failure("reader_scope_mismatch", "inspect") }),
          readCut: (request) => sdk.getDeliveryReadCut(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryReadCut"))),
          ...(info.outputProofAvailable === true ? { outputProof: (request: KernelReaderSchema.OutputProofRequest) => Effect.gen(function* () {
            const result = yield* sdk.getDeliveryOutputProof!(request).pipe(Effect.mapError((error) => {
              const closed = Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.Literal("output_proof"), kind: Schema.Literals(["invalid_response", "invalid_request", "unsupported_capability", "disconnected", "unavailable", "denied", "stale"]) }))(error.cause)
              control.sdkFailure = Option.isSome(closed) ? closed.value.kind : "unclassified"
              return KernelReaderSchema.failure("reader_unavailable", "getDeliveryOutputProof")
            }))
            if (mode === "current") control.online = false
            if (mode === "source") config.token = "private-rotated-token"
            if (mode === "revision") yield* KernelReader.applyMessages(runtime, { version: 2, scopeKey: info.scopeKey, projectionKey: "b".repeat(64), projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [] })
            return result
          }).pipe(Effect.mapError(error => error instanceof KernelReaderSchema.Error ? error : KernelReaderSchema.failure("reader_unavailable", "batch-fixture"))) } : {}),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(runtime); config.token = "private-first-seen-token" }))
        yield* KernelReader.bind(runtime, info.scopeKey, 2)
        yield* KernelReader.ensureScope(runtime)
        const now = Date.now()
        const expiry = mode === "ttl" ? now + 120 : now + 60000
        const keys = mode === "mixed" ? ["b"] : ["b", "c"]
        yield* KernelReader.applyChanges(runtime, { version: 2, scopeKey: info.scopeKey, after: "0", upper: String(keys.length), scanCursor: String(keys.length), scanProjectionKey: keys.at(-1)!.repeat(64), pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
          items: keys.map((key, index) => ({ visibility: "visible" as const, projectionKey: key.repeat(64), revision: "1", cursor: String(index + 1), conversationType: 1 as const, targetId: `sender-${key}`, readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: `batch-message-${key}`, latestSequence: "1", latestMessageTime: now, nextExpiryAt: expiry })) })
        for (const key of keys) yield* KernelReader.applyMessages(runtime, { version: 2, scopeKey: info.scopeKey, projectionKey: key.repeat(64), projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: now,
          items: [{ effectKey: key === "b" ? "d".repeat(64) : "e".repeat(64), messageId: `batch-message-${key}`, sequence: "1", deliveryCursor: "1", messageTime: now, expiresAt: expiry, senderId: `sender-${key}`, targetId: `sender-${key}`, conversationType: 1, content: JSON.stringify({ content: `actual batch bytes ${key}` }), isSend: false, isRead: false, messageType: "jg:text" }] })
        const groups = (yield* KernelReader.projections(runtime)).map((row) => row.local_group_id!)
        if (mode === "mixed") groups.push(yield* KernelReader.pending(runtime, { conversationType: 2, conversationID: "empty-owned", name: "Authenticated batch fixture group" }))
        yield* db.run(sql`CREATE TABLE batch_effect_probe (id INTEGER PRIMARY KEY)`)
        const before = yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)
        control.inspectCalls = 0
        control.phase = "output"
        const elapsed = performance.now()
        const probe = Effect.gen(function* () {
          yield* db.run(sql`INSERT INTO batch_effect_probe DEFAULT VALUES`)
          if (mode === "consumer") yield* Effect.sleep("1100 millis")
          if (mode === "post-revision") yield* KernelReader.applyMessages(runtime, { version: 2, scopeKey: info.scopeKey, projectionKey: "b".repeat(64), projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [] })
          return yield* Effect.forEach(groups, (groupID) => repo.getGroup({ groupID, workspaceID: "batch-workspace", userID: "server" }))
        })
        const result = yield* (mode === "late-consume" || mode === "consumed" ? Effect.gen(function* () {
          const prepared = yield* KernelReader.prepareOutput(runtime, { workspaceID: "batch-workspace", userID: "server", groupIDs: groups }, probe)
          if (mode === "late-consume") yield* Effect.sleep("1100 millis")
          if (mode === "consumed") expect((yield* prepared).map(group => group?.id)).toEqual(groups)
          return yield* prepared
        }) : KernelReader.withOutput(runtime, { workspaceID: "batch-workspace", userID: "server", groupIDs: groups }, probe)).pipe(Effect.result)
        const count = (yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM batch_effect_probe`))!.count
        expect(control.scalarCalls).toBe(0)
        expect(control.inspectCalls).toBe(0)
        expect(control.batchCalls).toBe(mode === "unsupported" ? 0 : 1)
        if (mode === "long-flight" || mode === "mixed") {
          expect(result._tag, result._tag === "Failure" && result.failure instanceof KernelReaderSchema.Error ? JSON.stringify({ mode, code: result.failure.code, operation: result.failure.operation, sdkFailure: control.sdkFailure }) : mode).toBe("Success")
          if (result._tag !== "Success") return yield* Effect.die(result.failure)
          expect(result.success.map((group) => group?.id)).toEqual(groups)
          expect(count).toBe(1)
          if (mode === "long-flight") expect(performance.now() - elapsed).toBeGreaterThanOrEqual(4800)
        }
        if (mode !== "long-flight" && mode !== "mixed") {
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") return yield* Effect.die("BATCH_BOUNDARY_ALLOWED_OUTPUT")
          // Repository read errors cross its existing DTO boundary. Direct
          // preparation/current failures retain the original Core error class.
          if (mode !== "consumer" && mode !== "post-revision") expect(result.failure).toBeInstanceOf(KernelReaderSchema.Error)
          if (mode === "consumer" || mode === "post-revision") expect(Schema.decodeUnknownOption(Schema.Struct({ code: KernelReaderSchema.Code, operation: Schema.String }))(result.failure)._tag).toBe("Some")
          expect(count).toBe(mode === "consumed" || mode === "consumer" || mode === "post-revision" ? 1 : 0)
          if (["late-consume", "consumer", "ttl"].includes(mode)) expect(result.failure).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
          if (mode === "revision" || mode === "post-revision") expect(result.failure).toMatchObject({ code: "reader_stale", operation: "output-revision" })
          if (mode === "consumed") expect(result.failure).toMatchObject({ code: "reader_stale", operation: "output-consumed" })
          if (mode === "current" || mode === "source") expect(result.failure).toMatchObject({ code: "reader_unavailable", operation: "current" })
          if (mode === "unsupported") expect(result.failure).toMatchObject({ code: "reader_upgrade_required", operation: "output-proof" })
        }
        if (mode !== "revision" && mode !== "post-revision") expect(yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)).toEqual(before)
        expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt`))!.count).toBe(0)
        summaries.push({ mode, outcome: result._tag, business: count, batch: control.batchCalls, scalar: control.scalarCalls, inspect: control.inspectCalls })
      }).pipe(Effect.provide(Layer.mergeAll(database, repository)), Effect.scoped)
  }).pipe(Effect.provide(context), Effect.scoped))
}, 60000)

test("Core batch schemas independently reject duplicate selectors, excess fields, count and byte-text bounds, and reusable pending booleans", () => {
  const visible = { kind: "visible", projectionKey: "b".repeat(64), projectionRevision: "1" }
  const pending = { kind: "pending", conversationType: 2, conversationID: "empty-owned" }
  const decode = (value: unknown) => Schema.decodeUnknownOption(KernelReaderSchema.OutputProofRequest, { onExcessProperty: "error" })(value)
  expect(decode({ version: 2, scopeKey: "a".repeat(64), rows: [visible, pending] })._tag).toBe("Some")
  expect(decode({ version: 2, scopeKey: "a".repeat(64), rows: Array.from({ length: 32 }, (_, index) => ({ ...pending, conversationID: `group-${index}` })) })._tag).toBe("Some")
  for (const rows of [[visible], [visible, visible], [pending, pending], Array.from({ length: 33 }, (_, index) => ({ ...pending, conversationID: `group-${index}` })), [visible, { ...pending, conversationID: "中".repeat(171) }], [{ ...visible, index: 1 }, pending]])
    expect(decode({ version: 2, scopeKey: "a".repeat(64), rows })._tag).toBe("None")
  expect(decode({ version: 1, scopeKey: "a".repeat(64), rows: [visible, pending] })._tag).toBe("None")
  const now = Date.now()
  expect(Schema.decodeUnknownOption(KernelReaderSchema.OutputProofResult, { onExcessProperty: "error" })({ version: 2, scopeKey: "a".repeat(64), serverNow: now, rows: [{ kind: "visible", cut: cut("b".repeat(64), "1", now) }, { ...pending, membershipCurrent: true }] })._tag).toBe("None")
})

test("Core batch result validates every scalar cut field and the original unread completion relation independently", () => {
  const now = Date.now()
  const first = cut("b".repeat(64), "1", now)
  const second = { kind: "pending", conversationType: 2, conversationID: "empty-owned" }
  const decode = (value: unknown) => Schema.decodeUnknownOption(KernelReaderSchema.OutputProofResult, { onExcessProperty: "error" })(value)
  const envelope = { version: 2, scopeKey: "a".repeat(64), serverNow: now }
  expect(decode({ ...envelope, rows: [{ kind: "visible", cut: first }, second] })._tag).toBe("Some")
  for (const changed of [{ ...first, complete: true }, { ...first, throughOrdinal: "2" }, { ...first, readOrdinal: "2" },
    { ...first, liveUnread: "2" }, { ...first, storedUnread: "-1" }, { ...first, projectionRevision: "01" },
    { ...first, targetAdmittedOrdinal: "9223372036854775808" }, { ...first, serverNow: now - 1 },
    { ...first, serverNow: Number.MAX_SAFE_INTEGER + 1 }, { ...first, version: 1 }, { ...first, body: "not-output-authority" }])
    expect(decode({ ...envelope, rows: [{ kind: "visible", cut: changed }, second] })._tag).toBe("None")
  expect(decode({ ...envelope, serverNow: 0, rows: [{ kind: "visible", cut: first }, second] })._tag).toBe("None")
  expect(decode({ ...envelope, rows: [{ kind: "visible", cut: first }] })._tag).toBe("None")
  expect(decode({ ...envelope, rows: Array.from({ length: 33 }, () => second) })._tag).toBe("None")
})
