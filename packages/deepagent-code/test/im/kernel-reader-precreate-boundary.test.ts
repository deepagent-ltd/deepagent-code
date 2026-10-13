import { afterAll, expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { makeNativeV2Peer } from "./fixture/kernel-native-v2-peer"

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kernel-precreate-boundary-")))
const selected = process.env.DEEPAGENT_CODE_TEST_NATIVE_PRECREATE_CASE
const cases = [
  "get-no-sync", "prepare-once", "second-refusal", "effect-no-replay",
  "postframe-no-replay", "delayed-prepared", "consumed-prepared", "changed-identity",
]

afterAll(() => fs.rm(root, { recursive: true, force: true }))

// The published SDK owns one process-global connection. Each scenario needs a
// normal fresh process, rather than swapping its active connection in one test.
if (!selected) {
  for (const scenario of cases) test(`isolated native V2 precreate boundary: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, DEEPAGENT_CODE_TEST_NATIVE_PRECREATE_CASE: scenario },
      stdout: "pipe", stderr: "pipe",
    })
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(result[0], `${result[1]}\n${result[2]}`).toBe(0)
    expect(result[2]).toContain("1 pass")
    expect(result[2]).toContain("0 fail")
  }, 30000)
}

const boundary = (name: string, title: string, effect: () => Promise<unknown>) => {
  if (selected === name) test(title, effect, 15000)
}
async function run(name: string, options: Parameters<typeof makeNativeV2Peer>[0], scenario: (input: {
  native: ReturnType<typeof makeNativeV2Peer>
  reader: IMKernelReader.Interface
  client: KernelClient.Interface
  db: Database.Interface["db"]
  request: { workspaceID: string; userID: string; groupIDs: string[] }
  probe: Effect.Effect<string, unknown>
}) => Effect.Effect<void, unknown>) {
  const directory = await fs.mkdtemp(path.join(root, "case-"))
  const native = makeNativeV2Peer(options)
  native.addMessage(`baseline-${name}`)
  const execute = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    for (const round of Array.from({ length: 500 }, (_, index) => index)) {
      if ((yield* SubscriptionRef.get(client.state)) === "connected") break
      if (round === 499) return yield* Effect.die("ACTUAL_NATIVE_SDK_DID_NOT_CONNECT")
      yield* Effect.sleep("10 millis")
    }
    const reader = yield* IMKernelReader.make(native.config, { workspaceID: directory,
      inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: "sender", member_uuids: [native.config.userID, input.conversationID] }) })
    yield* reader.sync
    const projection = yield* KernelReader.projection(reader.runtime, native.projectionKey)
    if (!projection?.local_group_id || projection.visibility !== "visible") return yield* Effect.die("ACTUAL_PROJECTION_NOT_VISIBLE")
    expect(KernelReader.readerVersion(reader.runtime)).toBe(2)
    yield* db.run(sql`CREATE TABLE boundary_effect_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`)
    const request = { workspaceID: directory, userID: "server", groupIDs: [projection.local_group_id] }
    const probe = Effect.gen(function* () {
      yield* KernelReader.gateGroup(db, projection.local_group_id!)
      yield* db.run(sql`INSERT INTO boundary_effect_probe(label) VALUES (${name})`)
      return "ONE_ACTUAL_SQL_EFFECT"
    })
    native.requests.length = 0
    yield* scenario({ native, reader, client, db, request, probe })
    expect(native.errors).toEqual([])
    expect(native.requests.every((request) => request.requestVersion === 2)).toBe(true)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt`))?.count).toBe(0)
  })
  try {
    await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "case.sqlite")),
      IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(native.config))))), Effect.scoped))
  } finally {
    await native.stop()
  }
}

boundary("get-no-sync", "protected GET stale never runs synchronization or writes a projection", async () => run("get-no-sync", undefined, ({ native, reader, db, request, probe }) => Effect.gen(function* () {
  const before = yield* db.get(sql`SELECT local_revision,server_revision FROM im_kernel_reader_projection LIMIT 1`)
  native.advanceRevision()
  const rejected = yield* reader.withOutput(request, probe).pipe(Effect.flip)
  expect(rejected).toMatchObject({ code: "reader_stale", operation: "getDeliveryReadCut", wireCode: 12203 })
  expect(native.requests.map((request) => request.topic)).toEqual(["qry_delivery_read_cut"])
  expect(yield* db.get(sql`SELECT local_revision,server_revision FROM im_kernel_reader_projection LIMIT 1`)).toEqual(before)
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 0 })
})))

boundary("prepare-once", "opt-in prepare native 12203 performs one bounded current sync before exactly one effect", async () => run("prepare-once", undefined, ({ native, reader, db, request, probe }) => Effect.gen(function* () {
  native.advanceRevision()
  expect(yield* reader.withOutput(request, probe, { refreshBeforeEffect: true })).toBe("ONE_ACTUAL_SQL_EFFECT")
  const cuts = native.requests.filter((request) => request.topic === "qry_delivery_read_cut")
  expect(cuts.map((request) => request.ackCode)).toEqual([12203, 0])
  expect(cuts[0]?.requestRevision).not.toBe(cuts[1]?.requestRevision)
  const sync = native.requests.filter((request) => request.topic !== "qry_delivery_read_cut")
  expect(sync.length).toBeLessThanOrEqual(4)
  expect(sync.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(1)
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 1 })
})))

boundary("second-refusal", "a second natural native 12203 remains refused without another sync or effect", async () => {
  const control: { native?: ReturnType<typeof makeNativeV2Peer> } = {}
  return run("second-refusal", { beforeQuery: (topic) => { if (topic === "qry_delivery_read_cut") control.native?.advanceRevision() } }, ({ native, reader, db, request, probe }) => Effect.gen(function* () {
    control.native = native
    const rejected = yield* reader.withOutput(request, probe, { refreshBeforeEffect: true }).pipe(Effect.flip)
    expect(rejected).toMatchObject({ code: "reader_stale", operation: "getDeliveryReadCut", wireCode: 12203 })
    expect(native.requests.filter((request) => request.topic === "qry_delivery_read_cut")).toHaveLength(2)
    expect(native.requests.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(1)
    expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 0 })
  }))
})

boundary("effect-no-replay", "native 12203 after the business effect starts cannot replay that effect", async () => run("effect-no-replay", undefined, ({ native, reader, db, request, probe }) => Effect.gen(function* () {
  const actual = Effect.gen(function* () {
    yield* probe
    native.advanceRevision()
    return yield* KernelReader.withOutput(reader.runtime, request, Effect.succeed("INNER_CURRENT_CUT"))
  })
  const rejected = yield* reader.withOutput(request, actual, { refreshBeforeEffect: true }).pipe(Effect.flip)
  expect(rejected).toMatchObject({ code: "reader_stale", operation: "getDeliveryReadCut", wireCode: 12203 })
  expect(native.requests.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(0)
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 1 })
})))

boundary("postframe-no-replay", "actual postframe projection change rejects without synchronization or effect replay", async () => run("postframe-no-replay", undefined, ({ native, reader, client, db, request, probe }) => Effect.gen(function* () {
  const actual = Effect.gen(function* () {
    yield* probe
    native.advanceRevision()
    const scope = (yield* KernelReader.scope(reader.runtime))!
    const page = yield* client.getDeliveryChanges({ version: 2, scopeKey: native.scopeKey, after: scope.completed_after, limit: 32 })
    yield* KernelReader.applyChanges(reader.runtime, page)
    return "BUSINESS_ALREADY_COMMITTED"
  })
  const rejected = yield* reader.withOutput(request, actual, { refreshBeforeEffect: true }).pipe(Effect.flip)
  expect(rejected).toMatchObject({ code: "reader_stale", operation: "output-revision" })
  expect(native.requests.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(0)
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 1 })
})))

boundary("delayed-prepared", "delayed prepared output keeps the original deadline and starts no business effect", async () => run("delayed-prepared", undefined, ({ reader, db, request, probe }) => Effect.gen(function* () {
  const prepared = yield* KernelReader.prepareOutput(reader.runtime, request, probe)
  yield* Effect.sleep("1100 millis")
  const rejected = yield* prepared.pipe(Effect.flip)
  expect(rejected).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 0 })
})))

boundary("consumed-prepared", "a consumed prepared output rejects a second run using the same proof", async () => run("consumed-prepared", undefined, ({ reader, db, request, probe }) => Effect.gen(function* () {
  const prepared = yield* KernelReader.prepareOutput(reader.runtime, request, probe)
  expect(yield* prepared).toBe("ONE_ACTUAL_SQL_EFFECT")
  const rejected = yield* prepared.pipe(Effect.flip)
  expect(rejected).toMatchObject({ code: "reader_stale", operation: "output-consumed" })
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 1 })
})))

boundary("changed-identity", "current source identity change between preparation and consumption rejects before effect", async () => run("changed-identity", undefined, ({ native, reader, db, request, probe }) => Effect.gen(function* () {
  const prepared = yield* KernelReader.prepareOutput(reader.runtime, request, probe)
  native.config.userID = "changed-identity"
  const rejected = yield* prepared.pipe(Effect.flip)
  expect(rejected).toBeInstanceOf(KernelReaderSchema.Error)
  expect(rejected).toMatchObject({ code: "reader_unavailable", operation: "current" })
  expect(yield* db.get(sql`SELECT count(*) count FROM boundary_effect_probe`)).toEqual({ count: 0 })
})))
