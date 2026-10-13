import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
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
import { IMKernelExchange } from "@/im/kernel/exchange"
import { makeNativeV2Peer } from "./fixture/kernel-native-v2-peer"

const selected = process.env.DEEPAGENT_CODE_TEST_CURRENT_RECEIVER_COMBINATION
if (selected !== undefined && !["R-A", "R-B", "R-C", "R-B-valid"].includes(selected)) throw new Error("ONLY_APPROVED_NEW_COMBINATION_REQUIRED")
// The original SDK connection is process-global. Normal suite collection
// registers isolated workers; precise worker selection never spawns another case.
if (selected === undefined) {
  for (const combination of ["R-A", "R-B", "R-C", "R-B-valid"]) test(`isolated current Native receiver combination: ${combination}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, DEEPAGENT_CODE_TEST_CURRENT_RECEIVER_COMBINATION: combination },
      stdout: "pipe", stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000)
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(async () => {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    })
    expect(result[0], `${result[1]}\n${result[2]}`).toBe(0)
    expect(result[2]).toContain("1 pass")
    expect(result[2]).toContain("0 fail")
  }, 30_000)
}

const details: Record<string, unknown> = { combination: selected, phases: [] }
const record = (phase: string, value: unknown) => (details.phases as unknown[]).push({ phase, value })
const error = (value: unknown) => value instanceof KernelReaderSchema.Error
  ? { category: "kernel_reader", code: value.code, operation: value.operation, ...(value.wireCode !== undefined ? { wireCode: value.wireCode } : {}) }
  : value instanceof KernelSdk.KernelError ? { category: "native_sdk", operation: value.operation }
    : { category: value instanceof Error ? value.name : "other" }
const count = (db: Database.Interface["db"]) => Effect.gen(function* () {
  return {
    groups: yield* db.get(sql`SELECT count(*) n FROM im_groups`),
    members: yield* db.get(sql`SELECT count(*) n FROM im_members`),
    messages: yield* db.get(sql`SELECT count(*) n FROM im_messages`),
    mirrors: yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`),
    meter: yield* db.get(sql`SELECT instance_id,used_records,used_bytes,revision FROM im_kernel_reader_meter WHERE id=1`),
    scopes: yield* db.all(sql`SELECT reader_key,phase,completed_after,window_after,window_upper,scan_cursor,page_token,continuation,local_revision FROM im_kernel_reader_scope ORDER BY reader_key`),
  }
})
const zeroExecution = (db: Database.Interface["db"]) => Effect.gen(function* () {
  expect(yield* db.get(sql`SELECT count(*) n FROM session`)).toEqual({ n: 0 })
  expect(yield* db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
  expect(yield* db.get(sql`SELECT count(*) n FROM session_v2_provider_turn_receipt`)).toEqual({ n: 0 })
  expect(yield* db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
})
const inspect = (native: ReturnType<typeof makeNativeV2Peer>, input: IMKernelExchange.InspectConversationInput) =>
  IMKernelExchange.inspectConversation({ ...input, facadeURL: native.server.url.origin, key: "private-new-combinations-key" }).pipe(Effect.provide(FetchHttpClient.layer))
const inspector = async (request: Request, mode = "healthy") => {
  if (request.headers.get("authorization") !== "Bearer private-new-combinations-key") return Response.json({ success: false, code: "im_key_invalid" }, { status: 403 })
  const input = await request.json() as { conversation_type: 1 | 2; conversation_id: string }
  return Response.json({ success: true, data: { conversation_type: input.conversation_type, conversation_id: mode === "tuple" ? "wrong-tuple" : input.conversation_id,
    org_id: mode === "org" ? 2 : 1, name: "Fixed private receiver combination", member_uuids: ["receiver", input.conversation_id] } })
}
async function run(options: Parameters<typeof makeNativeV2Peer>[0], scenario: (input: { native: ReturnType<typeof makeNativeV2Peer>; db: Database.Interface["db"]; client: KernelClient.Interface; directory: string }) => Effect.Effect<void, unknown, Effect.Services<ReturnType<typeof IMKernelReader.make>>>) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-r11-receiver-new-")))
  const native = makeNativeV2Peer(options)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const client = yield* KernelClient.Service
      for (const round of Array.from({ length: 500 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(client.state)) === "connected") break
        if (round === 499) return yield* Effect.die("ORIGINAL_SDK_CONNECTION_BOUND_REACHED")
        yield* Effect.sleep("10 millis")
      }
      expect(yield* SubscriptionRef.get(client.state)).toBe("connected")
      yield* scenario({ native, db, client, directory })
      yield* zeroExecution(db)
      expect(native.errors).toEqual([])
      expect(native.requests.every(request => request.requestVersion === 2)).toBe(true)
      const file = yield* Effect.promise(() => fs.stat(path.join(directory, "case.sqlite")))
      record("file-db", { device: file.dev, inode: file.ino })
      record("native", { connections: native.state.connections, requests: native.requests })
    }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "case.sqlite")), IMBroadcasterLive,
      KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(native.config))))), Effect.scoped))
  } finally {
    await native.stop()
    expect(native.state.disconnected).toBe(native.state.connections)
    record("normal-close", { disconnected: native.state.disconnected, connections: native.state.connections })
    await fs.rm(directory, { recursive: true, force: true })
    if (process.env.DEEPAGENT_CODE_TEST_CURRENT_RECEIVER_RECEIPT) await Bun.write(process.env.DEEPAGENT_CODE_TEST_CURRENT_RECEIVER_RECEIPT!, JSON.stringify(details, null, 2) + "\n")
  }
}

if (selected === "R-A") test("current Native wrong org/tuple/foreign proof refuses before mapping and preserves the initialized scope baseline", async () => {
  const control = { mode: "healthy" }
  return run({ fetch: request => new URL(request.url).pathname === "/api/im/conversations/inspect" ? inspector(request, control.mode) : undefined,
    response: (topic, _request, original) => topic === "qry_delivery_changes" && control.mode === "foreign" ? { name: original.name, value: { ...original.value, scopeKey: "f".repeat(64) } } : original,
  }, ({ native, db, client, directory }) => Effect.gen(function* () {
    native.addMessage("wrong-authority-message")
    const reader = yield* IMKernelReader.make(native.config, { workspaceID: directory, inspectConversation: input => inspect(native, input) })
    const header = yield* client.getDeliveryReader()
    yield* KernelReader.bind(reader.runtime, header.scopeKey, 2)
    yield* KernelReader.ensureScope(reader.runtime)
    const before = yield* count(db)
    expect(before.groups).toEqual({ n: 0 })
    expect(before.members).toEqual({ n: 0 })
    expect(before.messages).toEqual({ n: 0 })
    expect(before.mirrors).toEqual({ n: 0 })
    for (const mode of ["org", "tuple", "foreign"]) {
      control.mode = mode
      const result = yield* client.getDeliveryChanges({ version: 2, scopeKey: header.scopeKey, after: "0", limit: 32 }).pipe(
        Effect.mapError(IMKernelReader.readerError), Effect.flatMap(page => KernelReader.applyChanges(reader.runtime, page)), Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) return yield* Effect.die("UNAUTHORIZED_MAPPING_WAS_ADMITTED")
      const rejected = error(Cause.squash(result.cause))
      record(mode, rejected)
      if (mode !== "foreign") expect(rejected).toMatchObject({ category: "kernel_reader", code: "reader_scope_mismatch", operation: "inspect" })
      if (mode === "foreign") expect(rejected).toMatchObject({ category: "kernel_reader", operation: "getDeliveryChanges" })
      expect(yield* count(db)).toEqual(before)
    }
    record("zero-delta-after-legitimate-scope-initialization", before)
  }))
}, 15_000)

if (selected === "R-B") test("actual native stale and SDK nonprogress refusals never fake checkpoint completion, then the same DB resumes both conversations", async () => {
  const control = { mode: "stale", changed: false, sibling: false }
  const siblingKey = createHash("sha256").update("fixed-private-sibling-projection").digest("hex")
  const failures: unknown[] = []
  const reference: { native?: ReturnType<typeof makeNativeV2Peer>; sibling?: Record<string, unknown> } = {}
  return run({
    fetch: request => new URL(request.url).pathname === "/api/im/conversations/inspect" ? inspector(request) : undefined,
    projectionKeys: () => control.sibling ? [siblingKey] : [],
    beforeQuery: topic => { if (topic === "qry_delivery_messages" && control.mode === "stale" && !control.changed) { control.changed = true; reference.native!.advanceRevision() } },
    response: (topic, request, original) => {
      if (topic === "qry_delivery_messages" && control.mode === "nonprogress") return { name: original.name, value: { ...original.value, items: [], finished: false, nextDeliveryCursor: "" } }
      if (!control.sibling) return original
      const sibling = reference.sibling!
      if (topic === "qry_delivery_changes") {
        const list = [...original.value.items as Record<string, unknown>[]]
        if (BigInt(String(request.after || "0")) < BigInt(reference.native!.state.cursor)) list.push({ projectionKey: siblingKey, revision: reference.native!.state.revision, cursor: reference.native!.state.cursor,
          visibility: "visible", liveUnread: "1", storedUnread: "1", admittedOrdinal: "1", readOrdinal: "0", nextExpiryAt: sibling.expiresAt, latestMessageId: sibling.messageId, latestSequence: "1", latestMessageTime: sibling.messageTime, conversationType: 1, targetId: "sibling" })
        list.sort((a,b) => String(a.projectionKey).localeCompare(String(b.projectionKey)))
        return { name: original.name, value: { ...original.value, items: list, scanProjectionKey: list.at(-1)?.projectionKey ?? "" } }
      }
      if (topic === "qry_delivery_messages" && request.projectionKey === siblingKey) {
        const anchor = String(request.anchorDeliveryCursor || "")
        const present = !anchor || (request.direction === "older" ? BigInt(anchor) > 1n : BigInt(anchor) < 1n)
        return { name: original.name, value: { ...original.value, projectionKey: siblingKey, items: present ? [sibling] : [], nextDeliveryCursor: present ? "1" : "", finished: true } }
      }
      return original
    },
  }, ({ native, db, client, directory }) => Effect.gen(function* () {
    reference.native = native
    native.addMessage("unfinished-original-history")
    const reader = yield* IMKernelReader.make(native.config, { workspaceID: directory, inspectConversation: input => inspect(native, input),
      requestGate: effect => effect.pipe(Effect.tapError(cause => Effect.sync(() => failures.push(error(cause))))) })
    yield* reader.sync
    const stale = (yield* KernelReader.scope(reader.runtime))!
    expect(stale.completed_after).toBe("0")
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT history_complete FROM im_kernel_reader_projection LIMIT 1`)).toEqual({ history_complete: 0 })
    expect(failures).toContainEqual({ category: "kernel_reader", code: "reader_stale", operation: "getDeliveryMessages", wireCode: 12203 })
    record("stale-real-12203", { state: yield* SubscriptionRef.get(reader.state), completed: stale.completed_after, failures: [...failures] })
    control.mode = "nonprogress"
    yield* reader.sync
    const stalled = (yield* KernelReader.scope(reader.runtime))!
    expect(stalled.completed_after).toBe("0")
    expect(stalled.phase).toBe("partial")
    expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, stalled.continuation, 8192).projections).toHaveLength(1)
    expect(yield* db.get(sql`SELECT history_complete FROM im_kernel_reader_projection LIMIT 1`)).toEqual({ history_complete: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 0 })
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
    expect(failures).toHaveLength(2)
    record("sdk-empty-nonterminal-refusal", { state: yield* SubscriptionRef.get(reader.state), completed: stalled.completed_after, phase: stalled.phase, failures: [...failures] })
    control.mode = "healthy"
    for (const round of Array.from({ length: 5 }, (_, index) => index)) {
      yield* reader.sync
      if ((yield* KernelReader.scope(reader.runtime))?.phase === "idle") break
      if (round === 4) return yield* Effect.die("HEALTHY_ORIGINAL_CHECKPOINT_DID_NOT_CONVERGE")
    }
    expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe(native.state.cursor)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='unfinished-original-history'`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT history_complete FROM im_kernel_reader_projection LIMIT 1`)).toEqual({ history_complete: 1 })
    const message = native.addMessage("reference-for-private-sibling")
    reference.sibling = { ...message, messageId: "healthy-sibling", effectKey: createHash("sha256").update("healthy-sibling").digest("hex"), sequence: "1", deliveryCursor: "1", senderId: "sibling", targetId: "sibling" }
    control.sibling = true
    for (const round of Array.from({ length: 5 }, (_, index) => index)) {
      yield* reader.sync
      if ((yield* KernelReader.scope(reader.runtime))?.completed_after === native.state.cursor) break
      if (round === 4) return yield* Effect.die("HEALTHY_SIBLING_DID_NOT_CONVERGE")
    }
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='healthy-sibling'`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_projection WHERE history_complete=1`)).toEqual({ n: 2 })
    expect((yield* KernelReader.scope(reader.runtime))?.phase).toBe("idle")
    expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe(native.state.cursor)
    record("same-db-original-history-then-independent-sibling", { completed: native.state.cursor, projectionCount: 2, failures: [...failures], bound: 5 })
  }))
}, 20_000)

if (selected === "R-C") test("two current original consumers overlap one protobuf page, converge through CAS and retain one mirror/member/meter charge", async () => {
  return run({ fetch: request => new URL(request.url).pathname === "/api/im/conversations/inspect" ? inspector(request) : undefined }, ({ native, db, client, directory }) => Effect.gen(function* () {
    const held = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const control = { enabled: false, received: 0 }
    const failures = [[], []] as unknown[][]
    const gate = (index: number) => <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.tapError(cause => Effect.sync(() => failures[index].push(error(cause)))), Effect.flatMap(value => Effect.gen(function* () {
      if (control.enabled && typeof value === "object" && value !== null && "direction" in value && value.direction === "newer" && "items" in value && Array.isArray(value.items) && value.items.length) {
        control.received++
        if (control.received === 2) yield* Deferred.succeed(held, undefined)
        yield* Deferred.await(release)
      }
      return value
    })))
    const readers = yield* Effect.all([0,1].map(index => IMKernelReader.make(native.config, { workspaceID: directory, inspectConversation: input => inspect(native,input), requestGate: gate(index) })))
    const header = yield* client.getDeliveryReader()
    for (const reader of readers) { yield* KernelReader.bind(reader.runtime, header.scopeKey, 2); yield* KernelReader.ensureScope(reader.runtime); yield* KernelReader.current(reader.runtime) }
    const baseline = yield* count(db)
    native.addMessage("one-current-mirror")
    const page = yield* client.getDeliveryChanges({ version: 2, scopeKey: header.scopeKey, after: "0", limit: 32 })
    yield* KernelReader.applyChanges(readers[0].runtime, page)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_messages`)).toEqual({ n: 0 })
    control.enabled = true
    const one = yield* readers[0].sync.pipe(Effect.forkScoped)
    const two = yield* readers[1].sync.pipe(Effect.forkScoped)
    yield* Deferred.await(held).pipe(Effect.timeout("3 seconds"))
    expect(control.received).toBe(2)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 0 })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(one)
    yield* Fiber.join(two)
    control.enabled = false
    const states = yield* Effect.all(readers.map(reader => SubscriptionRef.get(reader.state)))
    record("actual-two-page-consumers-released", { states, failures, heldNativePageCount: control.received })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='one-current-mirror'`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_groups`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_members`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_messages`)).toEqual({ n: 1 })
    for (const round of Array.from({ length: 6 }, (_, index) => index)) {
      yield* readers[0].sync
      if ((yield* KernelReader.scope(readers[0].runtime))?.completed_after === native.state.cursor) break
      if (round === 5) return yield* Effect.die("CURRENT_CONSUMERS_DID_NOT_CONVERGE")
    }
    const unique = yield* db.get(sql`SELECT count(*) n,count(DISTINCT effect_key) effects,count(DISTINCT local_message_id) bodies FROM im_kernel_reader_message`)
    expect(unique).toEqual({ n: 1, effects: 1, bodies: 1 })
    const ledger = yield* db.get<{ used_records: number; used_bytes: number; instance_id: string }>(sql`SELECT used_records,used_bytes,instance_id FROM im_kernel_reader_meter WHERE id=1`)
    const obligations = yield* db.get<{ records: number; bytes: number }>(sql`SELECT 1+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_scope)+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_projection)+(SELECT coalesce(sum(accounted_records),0) FROM im_kernel_reader_message) records,1024+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_scope)+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_projection)+(SELECT coalesce(sum(accounted_bytes),0) FROM im_kernel_reader_message) bytes`)
    expect(ledger!.used_records).toBe(7)
    expect(ledger!.used_records).toBe(obligations!.records)
    expect(ledger!.used_bytes).toBe(obligations!.bytes)
    expect(ledger!.instance_id).toBe((baseline.meter as { instance_id: string }).instance_id)
    const stable = { records: ledger!.used_records, bytes: ledger!.used_bytes }
    yield* readers[0].sync
    yield* readers[1].sync
    expect(yield* db.get(sql`SELECT used_records records,used_bytes bytes FROM im_kernel_reader_meter WHERE id=1`)).toEqual(stable)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 1 })
    expect((yield* KernelReader.scope(readers[0].runtime))?.phase).toBe("idle")
    expect((yield* KernelReader.scope(readers[0].runtime))?.completed_after).toBe(native.state.cursor)
    record("unique-converged-ledger", { unique, obligations, stable, completed: native.state.cursor })
  }))
}, 15_000)

if (selected === "R-B-valid") test("SDK-valid repeated partial change boundary remains incomplete inside each real four-query slice and resumes the same checkpoint", async () => {
  const control = { partial: true, acceptedOlderFinished: 0 }
  return run({
    fetch: request => new URL(request.url).pathname === "/api/im/conversations/inspect" ? inspector(request) : undefined,
    response: (topic, request, original) => {
      if (topic === "qry_delivery_messages" && request.direction === "older" && original.value.finished === true) control.acceptedOlderFinished++
      if (topic !== "qry_delivery_changes" || !control.partial) return original
      return { name: original.name, value: { ...original.value, pageToken: "opaque-private-partial-boundary-token", windowComplete: false, caughtUp: false } }
    },
  }, ({ native, db, directory }) => Effect.gen(function* () {
    native.addMessage("partial-current-history")
    const reader = yield* IMKernelReader.make(native.config, { workspaceID: directory, inspectConversation: input => inspect(native,input), requestGate: effect => effect })
    const start = native.requests.length
    yield* reader.sync
    const partial = (yield* KernelReader.scope(reader.runtime))!
    expect(native.requests.length-start).toBeLessThanOrEqual(4)
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("partial")
    expect(partial.phase).toBe("partial")
    expect(partial.completed_after).toBe("0")
    expect(partial.window_after).toBe("0")
    expect(partial.window_upper).toBe(native.state.cursor)
    expect(partial.page_token).toBe("opaque-private-partial-boundary-token")
    // History may finish independently only because the original SDK accepted
    // an actual finished older message page; the discovery window remains partial.
    expect(control.acceptedOlderFinished).toBe(1)
    expect(yield* db.get(sql`SELECT history_complete FROM im_kernel_reader_projection LIMIT 1`)).toEqual({ history_complete: 1 })
    const meter = yield* db.get(sql`SELECT used_records,used_bytes FROM im_kernel_reader_meter WHERE id=1`)
    const again = native.requests.length
    yield* reader.sync
    const repeated = (yield* KernelReader.scope(reader.runtime))!
    expect(native.requests.length-again).toBeLessThanOrEqual(4)
    expect(native.requests.slice(again).filter(request=>request.topic==="qry_delivery_changes")).toHaveLength(3)
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("partial")
    expect(repeated.completed_after).toBe("0")
    expect(repeated.phase).toBe("partial")
    expect(repeated.window_after).toBe(partial.window_after)
    expect(repeated.window_upper).toBe(partial.window_upper)
    expect(repeated.scan_cursor).toBe(partial.scan_cursor)
    expect(repeated.page_token).toBe(partial.page_token)
    expect(repeated.reader_key).toBe(partial.reader_key)
    expect(yield* db.get(sql`SELECT used_records,used_bytes FROM im_kernel_reader_meter WHERE id=1`)).toEqual(meter)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 1 })
    expect(native.requests.every(request=>request.ackCode===0)).toBe(true)
    record("valid-partial-boundary-repeated-under-four-query-limit", { completed: repeated.completed_after, phase: repeated.phase,
      windowAfter: repeated.window_after, windowUpper: repeated.window_upper, scanCursor: repeated.scan_cursor, pageTokenSHA256: createHash("sha256").update(repeated.page_token!).digest("hex"), acceptedOlderFinished: control.acceptedOlderFinished,
      sameBinding: repeated.reader_key===partial.reader_key, secondSliceQueries: native.requests.length-again, producerQualification: "not asserted; authenticated SDK-valid fault defense only" })
    control.partial=false
    yield* reader.sync
    const complete=(yield* KernelReader.scope(reader.runtime))!
    expect(complete.reader_key).toBe(partial.reader_key)
    expect(complete.phase).toBe("idle")
    expect(complete.completed_after).toBe(native.state.cursor)
    expect(complete.page_token).toBeNull()
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
    native.addMessage("healthy-after-partial-window")
    yield* reader.sync
    expect((yield* KernelReader.scope(reader.runtime))?.phase).toBe("idle")
    expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe(native.state.cursor)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message`)).toEqual({ n: 2 })
    record("same-db-original-checkpoint-terminal-then-fresh-progress", { sameBinding: complete.reader_key===partial.reader_key, completed: native.state.cursor, mirrorCount: 2 })
  }))
}, 15_000)
