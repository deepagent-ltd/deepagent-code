import assert from "node:assert/strict"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Execution } from "@deepagent-code/core/session/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"

const root = process.argv[2]!
const protectedBefore = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ table: Schema.String, hashes: Schema.Array(Schema.String) })))(
  await Bun.file(path.join(root, "protected-before.json")).json(),
)
const tables = protectedBefore.map((entry) => entry.table).filter((table) => table !== "session_provider_owner_lease")
const ownerRows = () => AppRuntime.runPromise(Effect.gen(function* () {
  return yield* (yield* Database.Service).db.all<Record<string, unknown>>("SELECT * FROM session_provider_owner_lease")
}))
const snapshot = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* Effect.forEach(tables, (table) => db.all<Record<string, unknown>>(`SELECT * FROM "${table}"`).pipe(
    Effect.map((rows) => ({ table, hashes: rows.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort() })),
  ))
}))
const facts = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const session = yield* db.get<{ id: string; directory: string; execution_claim_token: number | null }>("SELECT id,directory,execution_claim_token FROM session")
  assert(session && session.execution_claim_token === null)
  const counts = yield* db.get<{ claims: number; queued: number; admissions: number; terminals: number; providers: number; counts: number }>(`SELECT
    (SELECT count(*) FROM session WHERE execution_claim_token IS NOT NULL) claims,
    (SELECT count(*) FROM session_input WHERE promoted_seq IS NULL) queued,
    (SELECT count(*) FROM session_v2_tool_effect_admission WHERE tool_name='read' AND effect_kind='read_only') admissions,
    (SELECT count(*) FROM session_v2_tool_effect) terminals,
    (SELECT count(*) FROM session_provider_attempt) providers,
    (SELECT count(*) FROM work_count_acquisition) counts`)
  assert(counts)
  assert.equal(counts.claims, 0)
  assert.equal(counts.queued, 0)
  assert.equal(counts.admissions, 1)
  assert.equal(counts.terminals, 0)
  assert.equal(counts.providers, 1)
  assert.equal(counts.counts, 1)
  assert.deepEqual(yield* db.all("SELECT state FROM session_v2_provider_turn_receipt"), [{ state: "settled" }])
  assert.deepEqual(yield* db.all("SELECT control_state,admission_state FROM work_execution"), [{ control_state: "revoked", admission_state: "ready" }])
  const tool = yield* db.get<{ status: string }>("SELECT json_extract(data,'$.content[0].state.status') status FROM session_message WHERE type='assistant'")
  assert.equal(tool?.status, "running")
  return { sessionID: session.id, directory: session.directory, ...counts, toolStatus: tool.status }
}))
const original = await facts()
const before = await snapshot()
assert.deepEqual(before, protectedBefore.filter((entry) => entry.table !== "session_provider_owner_lease"),
  "Cold database bootstrap changed original protected execution rows")
const originalOwners = await ownerRows()
assert.deepEqual(originalOwners.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort(),
  protectedBefore.find((entry) => entry.table === "session_provider_owner_lease")!.hashes)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const administrative = async () => {
  const current = await ownerRows()
  originalOwners.forEach((row) => assert.deepEqual(current.find((entry) => entry.owner_token === row.owner_token), row,
    "An original owner lease changed"))
  const fresh = current.filter((row) => !originalOwners.some((entry) => entry.owner_token === row.owner_token))
  assert.equal(fresh.length, 1, "Exactly one new Root administrative owner is allowed")
  return fresh[0]!
}
const openedOwner = await administrative()
const headers = { authorization: `Basic ${Buffer.from(`${process.env.DEEPAGENT_CODE_SERVER_USERNAME}:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`).toString("base64")}` }
const status = Schema.Struct({ type: Schema.Literal("recovery_required"), message: Schema.String, blockedReason: Schema.Literal("recovery_required") })
const statusFrame = Schema.Struct({ sessionID: Schema.String, status })
const eventFrame = Schema.Struct({ type: Schema.String, properties: Schema.Unknown })
const observers: { next: () => Promise<typeof eventFrame.Type>; close: () => void }[] = []
const observe = async (pathname: string) => {
  const controller = new AbortController()
  const url = new URL(pathname, listener.url)
  if (pathname === "/event") url.searchParams.set("directory", original.directory)
  const response = await fetch(url, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const next = async () => {
    while (true) {
      const end = buffer.text.indexOf("\n\n")
      if (end >= 0) {
        const frame = buffer.text.slice(0, end)
        buffer.text = buffer.text.slice(end + 2)
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!data) continue
        const decoded: unknown = JSON.parse(data)
        return Schema.decodeUnknownSync(eventFrame)(pathname === "/global/event" && decoded && typeof decoded === "object" && "payload" in decoded ? decoded.payload : decoded)
      }
      const chunk = await reader.read()
      assert(!chunk.done, "SSE closed before recovery status")
      buffer.text += decoder.decode(chunk.value, { stream: true })
    }
  }
  const observer = { next, close: () => controller.abort() }
  observers.push(observer)
  assert.equal((await next()).type, "server.connected")
  return observer
}
const deadline = setTimeout(() => observers.forEach((observer) => observer.close()), 20_000)
try {
  // These original cold facts have no eligible startup claim/input. A changed execution
  // row fails before any notification probe; this fixture never resumes the Session.
  assert.deepEqual(await snapshot(), before)
  await administrative()
  const url = new URL("/session/status", listener.url)
  url.searchParams.set("directory", original.directory)
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  assert.equal(response.status, 200)
  const values = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await response.json())
  assert.equal(Schema.decodeUnknownSync(status)(values[original.sessionID]).type, "recovery_required")
  assert.deepEqual(await facts(), original)
  assert.deepEqual(await snapshot(), before)
  await administrative()
  const streams = await Promise.all([observe("/event"), observe("/global/event")])
  // Notification probe on the private snapshot only. The running read was produced by
  // the old real signed Native case; publishing this event is not a new runner result.
  await AppRuntime.runPromise(Effect.gen(function* () {
    const sessionID = SessionSchema.ID.make(original.sessionID)
    const session = yield* (yield* SessionStore.Service).get(sessionID)
    assert(session)
    yield* (yield* EventV2Bridge.Service).publish(Execution.Interrupted, {
      sessionID, timestamp: yield* DateTime.now, reason: "user",
    }, { location: session.location })
  }))
  const sse = await Promise.all(streams.map(async (stream) => {
    while (true) {
      const frame = await stream.next()
      if (frame.type !== "session.status") continue
      const current = Schema.decodeUnknownSync(statusFrame)(frame.properties)
      if (current.sessionID !== original.sessionID) continue
      return current.status.type
    }
  }))
  assert.deepEqual(sse, ["recovery_required", "recovery_required"])
  assert.deepEqual(await facts(), original)
  assert.deepEqual(await snapshot(), before)
  const readOwner = await administrative()
  await Bun.write(path.join(root, "result.json"), JSON.stringify({
    closed: false, statusGet: "recovery_required", sse, originalToolStatus: original.toolStatus,
    readAdmissions: original.admissions, toolTerminals: original.terminals, protectedDrift: 0,
    providerAttempts: original.providers, newProviderAttempts: 0, countAcquisitions: original.counts, newCountAcquisitions: 0,
    sessionID: original.sessionID, directory: original.directory, protectedTables: tables.length,
    administrativeOwner: { newOwners: 1, originalOwnersUnchanged: true,
      ownerHash: Hash.sha256(String(openedOwner.owner_token)), registeredAt: openedOwner.registered_at,
      openedHeartbeatAt: openedOwner.heartbeat_at, readHeartbeatAt: readOwner.heartbeat_at,
      releasedAt: readOwner.released_at },
    evidenceClass: "actual production HTTP over original signed Native read history; terminal notification probe only",
  }, null, 2))
} finally {
  clearTimeout(deadline)
  observers.forEach((observer) => observer.close())
  await listener.stop(true)
  await AppRuntime.dispose()
}
const result = await Bun.file(path.join(root, "result.json")).json()
const finalOwners = Bun.spawnSync(["/usr/bin/sqlite3", `file:${path.join(root, "authority.sqlite")}?immutable=1`, "-json",
  "SELECT * FROM session_provider_owner_lease"])
assert.equal(finalOwners.exitCode, 0)
const ended = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
  JSON.parse(finalOwners.stdout.toString()),
)
originalOwners.forEach((row) => assert.deepEqual(ended.find((entry) => entry.owner_token === row.owner_token), row))
const released = ended.filter((row) => !originalOwners.some((entry) => entry.owner_token === row.owner_token))
assert.equal(released.length, 1)
assert.equal(released[0]!.owner_token, openedOwner.owner_token)
assert.equal(typeof released[0]!.released_at, "number")
await Bun.write(path.join(root, "result.json"), JSON.stringify({ ...result, closed: true,
  administrativeOwner: { ...result.administrativeOwner, releasedAt: released[0]!.released_at,
    closedHeartbeatAt: released[0]!.heartbeat_at },
}, null, 2))
process.exit(0)
