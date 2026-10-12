import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
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
import { tmpdir } from "node:os"
import path from "node:path"

const control = { mode: "baseline", phase: "seed", online: true, sourceCurrent: true, cutCalls: 0, inspectCalls: 0 }
const traces: { mode: string; kind: string; index: number; started: number; settled: number }[] = []
const summaries: object[] = []
const native = KernelLiveFirstSeenFixture.make({
  fetch(request) {
    if (new URL(request.url).pathname !== "/inspect") return undefined
    return (async () => {
      if (request.headers.get("authorization") !== "Bearer private-first-seen-token") return Response.json({}, { status: 403 })
      const observe = control.phase === "output"
      const index = observe ? ++control.inspectCalls : 0
      const started = performance.now()
      if (observe) await Bun.sleep(1150)
      if (observe) traces.push({ mode: control.mode, kind: "authenticated_http_inspect", index, started, settled: performance.now() })
      return Response.json({ name: "Pending owned group" })
    })()
  },
  queryDelayMs(topic) { return topic === "qry_delivery_read_cut" && control.mode === "refreshed_still_expired" && control.cutCalls === 2 ? 1150 : 0 },
  response(topic, request, response) {
    if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
      version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: request.projectionRevision,
      throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", complete: false, serverNow: Date.now(),
    } }
    return response
  },
})
const config = { appkey: `private-mixed-output-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver",
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
const client = Layer.provideMerge(KernelClient.layer, KernelSdk.liveFromConfig(config))
const state = (db: Database.Interface["db"]) => Effect.gen(function* () {
  return { projections: yield* db.all(sql`SELECT * FROM im_kernel_reader_projection`), groups: yield* db.all(sql`SELECT * FROM im_groups`),
    messages: yield* db.all(sql`SELECT * FROM im_messages`), scope: yield* db.all(sql`SELECT * FROM im_kernel_reader_scope`), meter: yield* db.all(sql`SELECT * FROM im_kernel_reader_meter`) }
})

test("mixed native cut and slow authenticated HTTP inspection reobserve at most two expired proofs once and preserve TTL, identity and revision fences", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "dac-reader-mixed-output-"))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const connection = yield* KernelClient.Service
      const sdk = yield* KernelSdk.Service
      for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(connection.state)) === "connected") break
        if (attempt === 199) return yield* Effect.die(new Error("native connection not ready"))
        yield* Effect.sleep("10 millis")
      }
      for (const mode of ["fresh", "ttl", "current", "source", "revision", "refreshed_still_expired"]) {
        control.mode = mode
        control.phase = "seed"
        control.online = true
        control.sourceCurrent = true
        control.cutCalls = 0
        control.inspectCalls = 0
        const filename = path.join(directory, `${mode}.sqlite`)
        const database = Database.layerFromPath(filename)
        const repository = IMRepositoryLive.pipe(Layer.provide(database))
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const repo = yield* IMRepository
          const source = KernelConfig.deliverySource(config)
          const runtime = KernelReader.attach({ db, workspaceID: "workspace", userID: "server", source,
            current: () => Effect.sync(() => control.online && control.sourceCurrent),
            inspect: () => Effect.tryPromise({ try: async () => {
              const response = await fetch(native.server.url.origin + "/inspect", { headers: { Authorization: "Bearer private-first-seen-token" } })
              if (response.status !== 200) throw new Error("authenticated inspect refused")
              return await response.json() as { name: string }
            }, catch: () => KernelReaderSchema.failure("reader_scope_mismatch", "inspect") }),
            readCut: (request) => Effect.gen(function* () {
              const index = ++control.cutCalls
              const started = performance.now()
              const cut = yield* sdk.getDeliveryReadCut(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryReadCut")))
              traces.push({ mode, kind: "original_sdk_native_cut", index, started, settled: performance.now() })
              if (index === 2 && mode === "current") control.online = false
              if (index === 2 && mode === "source") control.sourceCurrent = false
              if (index === 2 && mode === "revision") yield* KernelReader.applyMessages(runtime, { version: 1, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64),
                projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [] }).pipe(Effect.orDie)
              return cut
            }),
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
          yield* KernelReader.bind(runtime, "a".repeat(64))
          yield* KernelReader.ensureScope(runtime)
          const now = Date.now()
          const expiry = mode === "ttl" ? now + 650 : now + 60000
          yield* KernelReader.applyChanges(runtime, { version: 1, scopeKey: "a".repeat(64), after: "0", upper: "1", scanCursor: "1", scanProjectionKey: "b".repeat(64), pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
            items: [{ visibility: "visible", projectionKey: "b".repeat(64), revision: "1", cursor: "1", conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "private-mixed-visible", latestSequence: "1", latestMessageTime: now, nextExpiryAt: expiry }] })
          yield* KernelReader.applyMessages(runtime, { version: 1, scopeKey: "a".repeat(64), projectionKey: "b".repeat(64), projectionRevision: "1", direction: "newer", nextDeliveryCursor: "1", finished: true, serverNow: now,
            items: [{ effectKey: "d".repeat(64), messageId: "private-mixed-visible", sequence: "1", deliveryCursor: "1", messageTime: now, expiresAt: expiry, senderId: "sender", targetId: "sender", conversationType: 1, content: '{"content":"private protected fixture bytes"}', isSend: false, isRead: false }] })
          const visible = (yield* KernelReader.projection(runtime, "b".repeat(64)))!.local_group_id!
          const pending = yield* KernelReader.pending(runtime, { conversationType: 2, conversationID: "empty-owned", name: "Pending owned group" })
          const before = yield* state(db)
          const returned = { count: 0 }
          control.phase = "output"
          const result = yield* KernelReader.withOutput(runtime, { workspaceID: "workspace", userID: "server", groupIDs: [visible, pending] }, Effect.gen(function* () {
            yield* KernelReader.assertOutput(db)
            const groups = yield* Effect.forEach([visible, pending], (groupID) => repo.getGroup({ groupID, workspaceID: "workspace", userID: "server" }))
            const messages = yield* repo.listMessages({ groupID: visible, limit: 2 })
            const reader = yield* KernelReader.groupPageState(db)
            returned.count++
            return { groups, reader, messages }
          })).pipe(Effect.result)
          const after = yield* state(db)
          const elapsedTraces = traces.filter((item) => item.mode === mode)
          const firstCut = elapsedTraces.find((item) => item.kind === "original_sdk_native_cut" && item.index === 1)!
          const inspection = elapsedTraces.find((item) => item.kind === "authenticated_http_inspect" && item.index === 1)!
          expect(inspection.settled - firstCut.settled).toBeGreaterThan(1000)
          expect(control.inspectCalls).toBe(1)
          expect(control.cutCalls).toBe(2)
          if (mode === "fresh") {
            expect(result._tag).toBe("Success")
            if (result._tag !== "Success") return yield* Effect.die(new Error("fresh candidate was refused"))
            expect(result.success.groups.map((group) => group?.id)).toEqual([visible, pending])
            expect(result.success.reader!.proofWindowMs).toBeGreaterThan(0)
            expect(result.success.reader!.proofWindowMs).toBeLessThanOrEqual(1000)
            expect(result.success.messages.messages.map((message) => message.content)).toEqual(["private protected fixture bytes"])
            expect(returned.count).toBe(1)
          }
          if (mode !== "fresh") {
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") return yield* Effect.die(new Error("stale candidate unexpectedly returned output"))
            const error = result.failure as { code: string; operation: string }
            expect(error.code).toBe(mode === "current" || mode === "source" ? "reader_unavailable" : "reader_stale")
            expect(error.operation).toBe(mode === "current" || mode === "source" ? "current" : mode === "revision" ? "output-revision" : "output-deadline")
            expect(returned.count).toBe(0)
          }
          if (mode !== "revision") expect(after).toEqual(before)
          if (mode === "revision") {
            expect(after.groups).toEqual(before.groups)
            expect(after.messages).toEqual(before.messages)
            expect(after.projections).not.toEqual(before.projections)
          }
          summaries.push({ mode, outcome: result._tag, cutCalls: control.cutCalls, inspectCalls: control.inspectCalls, returned: returned.count,
            originalProofAgeBeforeInspectSettledMs: Math.round(inspection.settled - firstCut.settled), sqlWritesByOutput: 0 })
        }).pipe(Effect.provide(Layer.mergeAll(database, repository)), Effect.scoped)
      }
    }).pipe(Effect.provide(client), Effect.scoped))
    expect(summaries).toHaveLength(6)
  } finally {
    native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20000)
