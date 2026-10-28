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

const control = { mode: "prepared", nativeOrdinal: 0 }
const native = KernelLiveFirstSeenFixture.make({
  fetch(request) {
    if (new URL(request.url).pathname !== "/inspect") return undefined
    if (request.headers.get("authorization") !== "Bearer private-first-seen-token") return Response.json({}, { status: 403 })
    return Response.json({ name: "Private diagnostic owned group" })
  },
  response(topic, request, response) {
    if (topic === "qry_delivery_reader") return { name: "DeliveryReaderInfo", value: { version: 2, scopeKey: "a".repeat(64), currentCursor: "2", serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000, outputProofAvailable: true } }
    if (topic !== "qry_delivery_output_proof") return response
    control.nativeOrdinal++
    const now = Date.now()
    return { name: "DeliveryOutputProofResult", value: { version: 2, scopeKey: request.scopeKey, serverNow: now,
      rows: (request.outputRows as { visible: { projectionKey: string; projectionRevision: string } }[]).map(row => ({ visible: {
        version: 2, scopeKey: request.scopeKey, projectionKey: row.visible.projectionKey, projectionRevision: row.visible.projectionRevision,
        throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", complete: false, serverNow: now,
      } })),
    } }
  },
})
const config = { appkey: `private-output-proof-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver", protectedMedia: true,
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
const client = Layer.provideMerge(KernelClient.layer, KernelSdk.liveFromConfig(config))

test("closed output proof diagnostics distinguish delayed prepared consumption from local business consumption without exposing proof identities or changing failure", async () => {
  const started = performance.now()
  const phase = (name: string, consumer?: boolean) => console.error(JSON.stringify({
    stage: "owned-output-proof-diagnostic", phase: name, elapsedMs: Math.round(performance.now() - started), consumer,
  }))
  phase("case-enter")
  const directory = await fs.mkdtemp(path.join(tmpdir(), "dac-output-proof-diagnostic-"))
  phase("directory-ready")
  const initialLevel = Log.getLevel()
  try {
    await Log.init({ print: false, level: "DEBUG" })
    phase("client-acquire")
    await Effect.runPromise(Effect.gen(function* () {
      phase("client-layer-ready")
      const connection = yield* KernelClient.Service
      const sdk = yield* KernelSdk.Service
      for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(connection.state)) === "connected") break
        if (attempt === 199) return yield* Effect.die(new Error("actual native connection not ready"))
        yield* Effect.sleep("10 millis")
      }
      if (!sdk.getDeliveryOutputProof) return yield* Effect.die("actual SDK batch method unavailable")
      phase("connection-ready")
      const info = yield* sdk.getDeliveryReader()
      phase("reader-ready")
      expect(info.outputProofAvailable).toBe(true)
      for (const mode of ["prepared", "consumer"]) {
        control.mode = mode
        control.nativeOrdinal = 0
        const database = Database.layerFromPath(path.join(directory, `${mode}.sqlite`))
        phase("database-acquire", mode === "consumer")
        yield* Effect.gen(function* () {
          phase("database-ready", mode === "consumer")
          const db = (yield* Database.Service).db
          const runtime = KernelReader.attach({ db, workspaceID: "private-output-workspace", userID: "server", source: KernelConfig.deliverySource(config),
            current: () => Effect.succeed(true), inspect: () => Effect.tryPromise({ try: async () => {
              const response = await fetch(native.server.url.origin + "/inspect", { headers: { Authorization: "Bearer private-first-seen-token" } })
              if (response.status !== 200) throw new Error("authenticated inspect refused")
              return await response.json() as { name: string }
            }, catch: () => KernelReaderSchema.failure("reader_scope_mismatch", "inspect") }),
            readCut: (request) => sdk.getDeliveryReadCut(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryReadCut"))),
            outputProof: (request) => sdk.getDeliveryOutputProof!(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryOutputProof"))),
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
          yield* KernelReader.bind(runtime, "a".repeat(64), 2)
          yield* KernelReader.ensureScope(runtime)
          const now = Date.now()
          yield* KernelReader.applyChanges(runtime, { version: 2, scopeKey: "a".repeat(64), after: "0", upper: "2", scanCursor: "2", scanProjectionKey: "c".repeat(64), pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
            items: ["b", "c"].map((key, index) => ({ visibility: "visible" as const, projectionKey: key.repeat(64), revision: "1", cursor: String(index + 1), conversationType: 1 as const, targetId: `private-target-${key}`, readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: `private-protected-${key}`, latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 })) })
          const groups = yield* KernelReader.projections(runtime)
          const before = yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)
          const beforeLog = yield* Effect.promise(() => fs.readFile(Log.file(), "utf8").catch(() => ""))
          const executions = { count: 0 }
          const probe = Effect.gen(function* () {
            executions.count++
            if (mode === "consumer") yield* Effect.sleep("1150 millis")
            yield* KernelReader.assertOutput(db)
            return "should-not-output"
          })
          const prepared = yield* KernelReader.prepareOutput(runtime, { workspaceID: "private-output-workspace", userID: "server", groupIDs: groups.map(row => row.local_group_id!) }, probe)
          phase("proof-ready", mode === "consumer")
          if (mode === "prepared") yield* Effect.sleep("1150 millis")
          const result = yield* prepared.pipe(Effect.result)
          phase("proof-consumed", mode === "consumer")
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
          expect(control.nativeOrdinal).toBe(1)
          expect(records.every(row => row.phase === "observe" && row.refreshSelectedCount === "0")).toBe(true)
          if (mode === "prepared") {
            expect(records.every(row => row.failureStage === "consume_check")).toBe(true)
            expect(records.every(row => Number(row.consumerMs) === 0)).toBe(true)
          }
          if (mode === "consumer") {
            expect(records.every(row => row.failureStage === "consume")).toBe(true)
            expect(records.every(row => Number(row.consumerMs) >= 1000)).toBe(true)
          }
          phase("body-done", mode === "consumer")
        }).pipe(Effect.provide(database), Effect.scoped)
        phase("database-closed", mode === "consumer")
      }
    }).pipe(Effect.provide(client), Effect.scoped))
    phase("client-closed")
  } finally {
    phase("cleanup-enter")
    native.server.stop(true)
    await Log.init({ print: true, level: initialLevel })
    await fs.rm(directory, { recursive: true, force: true })
    phase("cleanup-complete")
  }
}, 10000)
