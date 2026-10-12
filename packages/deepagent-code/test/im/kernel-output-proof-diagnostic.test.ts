import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { Log } from "@deepagent-code/core/util/log"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

const control = { mode: "native", nativeOrdinal: 0 }
const native = KernelLiveFirstSeenFixture.make({
  fetch(request) {
    if (new URL(request.url).pathname !== "/inspect") return undefined
    if (request.headers.get("authorization") !== "Bearer private-first-seen-token") return Response.json({}, { status: 403 })
    return Response.json({ name: "Private diagnostic owned group" })
  },
  queryDelayMs(topic) { return topic === "qry_delivery_read_cut" && control.mode === "native" && (control.nativeOrdinal === 2 || control.nativeOrdinal === 3) ? 1150 : 0 },
  response(topic, request, response) {
    if (topic !== "qry_delivery_read_cut") return response
    control.nativeOrdinal++
    return { name: "DeliveryReadCutResult", value: {
      version: 1, scopeKey: request.scopeKey, projectionKey: request.projectionKey, projectionRevision: request.projectionRevision,
      throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", complete: false, serverNow: Date.now(),
    } }
  },
})
const config = { appkey: `private-output-proof-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver",
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
const client = Layer.provideMerge(KernelClient.layer, KernelSdk.liveFromConfig(config))

test("closed output proof diagnostics distinguish real native-flight skew from local consumption without exposing proof identities or changing failure", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "dac-output-proof-diagnostic-"))
  const initialLevel = Log.getLevel()
  try {
    await Log.init({ print: false, level: "DEBUG" })
    await Effect.runPromise(Effect.gen(function* () {
      const connection = yield* KernelClient.Service
      const sdk = yield* KernelSdk.Service
      for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(connection.state)) === "connected") break
        if (attempt === 199) return yield* Effect.die(new Error("actual native connection not ready"))
        yield* Effect.sleep("10 millis")
      }
      for (const mode of ["native", "consumer"]) {
        control.mode = mode
        control.nativeOrdinal = 0
        const database = Database.layerFromPath(path.join(directory, `${mode}.sqlite`))
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const runtime = KernelReader.attach({ db, workspaceID: "private-output-workspace", userID: "server", source: KernelConfig.deliverySource(config),
            current: () => Effect.succeed(true), inspect: () => Effect.tryPromise({ try: async () => {
              const response = await fetch(native.server.url.origin + "/inspect", { headers: { Authorization: "Bearer private-first-seen-token" } })
              if (response.status !== 200) throw new Error("authenticated inspect refused")
              return await response.json() as { name: string }
            }, catch: () => KernelReaderSchema.failure("reader_scope_mismatch", "inspect") }),
            readCut: (request) => sdk.getDeliveryReadCut(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryReadCut"))),
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
          yield* KernelReader.bind(runtime, "a".repeat(64))
          yield* KernelReader.ensureScope(runtime)
          const now = Date.now()
          yield* KernelReader.applyChanges(runtime, { version: 1, scopeKey: "a".repeat(64), after: "0", upper: "2", scanCursor: "2", scanProjectionKey: "c".repeat(64), pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
            items: ["b", "c"].map((key) => ({ visibility: "visible" as const, projectionKey: key.repeat(64), revision: "1", cursor: "1", conversationType: 1 as const, targetId: `private-target-${key}`, readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: `private-protected-${key}`, latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 })) })
          const groups = yield* KernelReader.projections(runtime)
          const before = yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)
          const beforeLog = yield* Effect.promise(() => fs.readFile(Log.file(), "utf8").catch(() => ""))
          const executions = { count: 0 }
          const result = yield* KernelReader.withOutput(runtime, { workspaceID: "private-output-workspace", userID: "server", groupIDs: groups.map(row => row.local_group_id!) }, Effect.gen(function* () {
            executions.count++
            if (mode === "consumer") yield* Effect.sleep("1150 millis")
            yield* KernelReader.assertOutput(db)
            return "should-not-output"
          })).pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") return yield* Effect.die(new Error("expired proof produced output"))
          const failure = result.failure as KernelReaderSchema.Error
          expect(failure instanceof KernelReaderSchema.Error).toBe(true)
          expect(failure.code).toBe("reader_stale")
          expect(failure.operation).toBe("output-deadline")
          expect(executions.count).toBe(mode === "consumer" ? 1 : 0)
          expect(yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)).toEqual(before)
          yield* Effect.sleep("20 millis")
          const afterLog = yield* Effect.promise(() => fs.readFile(Log.file(), "utf8"))
          const added = afterLog.slice(beforeLog.length)
          const lines = added.split("\n").filter(line => line.includes("IM output proof rejected"))
          expect(lines.length).toBeGreaterThan(0)
          expect(lines.length).toBeLessThanOrEqual(4)
          const records = lines.map(line => Object.fromEntries(Array.from(line.matchAll(/\b(index|visibility|phase|flightMs|proofAgeMs|remainingMs|actualRowCount|refreshSelectedCount|activeWindow|expiredAtFailure|consumerMs|outputElapsedMs|failureStage|operation)=([^\s]+)/g), match => [match[1], match[2]])))
          expect(records.every(row => row.actualRowCount === "2" && ["0", "1"].includes(row.index) && row.visibility === "visible" && row.operation === "output-deadline")).toBe(true)
          expect(records.some(row => row.activeWindow === "true" && row.expiredAtFailure === "true" && Number(row.remainingMs) <= 0)).toBe(true)
          expect(added.includes("private-target-")).toBe(false)
          expect(added.includes("private-protected-")).toBe(false)
          expect(added.includes("private-output-workspace")).toBe(false)
          expect(added.includes(config.token)).toBe(false)
          expect(added.includes("a".repeat(64))).toBe(false)
          expect(added.includes("b".repeat(64))).toBe(false)
          expect(added.includes("c".repeat(64))).toBe(false)
          if (mode === "native") {
            expect(control.nativeOrdinal).toBe(3)
            expect(records.every(row => row.refreshSelectedCount === "1")).toBe(true)
            expect(records.some(row => row.phase === "refresh")).toBe(true)
            expect(records.some(row => row.phase === "observe" && Number(row.flightMs) >= 1000)).toBe(true)
            expect(records.every(row => Number(row.consumerMs) < 1000)).toBe(true)
          }
          if (mode === "consumer") {
            expect(control.nativeOrdinal).toBe(2)
            expect(records.every(row => row.phase === "observe" && row.refreshSelectedCount === "0")).toBe(true)
            expect(records.every(row => Number(row.consumerMs) >= 1000)).toBe(true)
          }
        }).pipe(Effect.provide(database), Effect.scoped)
      }
    }).pipe(Effect.provide(client), Effect.scoped))
  } finally {
    native.server.stop(true)
    await Log.init({ print: true, level: initialLevel })
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 10000)
