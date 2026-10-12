import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"
import { Log } from "@deepagent-code/core/util/log"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { pollWithTimeout } from "../lib/effect"

test("an actual local SQL refusal reports its pass stage without SQL or cause content", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-sync-diagnostic-")
  const native = KernelLiveFirstSeenFixture.make()
  const config = { appkey: `private-sync-diagnostic-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", protectedMedia: false,
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const execute = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "original SDK did not connect")
    yield* db.run(sql`CREATE TRIGGER diagnostic_only BEFORE INSERT ON im_kernel_reader_scope BEGIN SELECT RAISE(ABORT, 'private_sql_body_sentinel'); END`)
    const reader = yield* IMKernelReader.make(config, { workspaceID: directory, requestGate: (effect) => effect,
      inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) })
    yield* reader.syncSlice
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
    expect(native.topics).toContain("qry_delivery_reader")
    yield* Effect.promise(() => Bun.sleep(50))
    const diagnostic = yield* Effect.promise(() => Bun.file(Log.file()).text())
    expect(diagnostic).toContain("stage=ensure_scope")
    expect(diagnostic).toContain("kind=drizzle_query")
    expect(diagnostic).toContain("lastNativeOperation=getDeliveryReader")
    expect(diagnostic).toContain("sqliteCode=SQLITE_CONSTRAINT_TRIGGER")
    expect(diagnostic).not.toContain("private_sql_body_sentinel")
    expect(diagnostic).not.toContain("CREATE TRIGGER")
    expect(yield* db.get(sql`SELECT count(*) n FROM session_v2_provider_turn_receipt`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_dac_command`)).toEqual({ n: 0 })
  })
  try {
    await Log.init({ print: false, dev: false })
    await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "reader.sqlite")),
      IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15000)

test("the diagnostic admits only closed domain codes and rejects arbitrary error fields", () => {
  expect(IMKernelReader.syncFailureDiagnostic(new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_RETIRED", message: "private_cause_sentinel" })))
    .toEqual({ kind: "kernel_delivery", failureCode: "KERNEL_DELIVERY_RETIRED" })
  expect(IMKernelReader.syncFailureDiagnostic({ _tag: "private_tag_sentinel", code: "private_code_sentinel", message: "private_cause_sentinel", cause: { token: "private_token_sentinel" } }))
    .toEqual({ kind: "unclassified" })
})
