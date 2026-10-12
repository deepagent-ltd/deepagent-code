import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { AppRuntime } from "@/effect/app-runtime"
import { Server } from "@/server/server"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Execution } from "@deepagent-code/core/session/event"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { IMTaskResultFixture } from "../../im/fixture/task-result"

const root = process.argv[2]!
const identity = `local_${process.argv[3]!.repeat(32)}`
const directory = path.join(root, "project")
await fs.mkdir(path.dirname(LocalTaskAuthority.installationPath()), { recursive: true, mode: 0o700 })
await fs.writeFile(LocalTaskAuthority.installationPath(), JSON.stringify({
  version: 1, instanceID: identity, secret: "3".repeat(64),
}), { mode: 0o600 })
const original = await AppRuntime.runPromise(IMTaskResultFixture.prepare({ directory, instanceID: identity }))
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
await Bun.write(path.join(root, "ready.json"), JSON.stringify({
  url: listener.url.href, messageID: original.messageID, directory, instanceID: identity,
}))
const headers = { authorization: `Basic ${Buffer.from("result-reader:private-result-password").toString("base64")}` }
const get = async (queryDirectory: string, messageID = original.messageID, authenticated = true) => {
  const url = new URL(`/api/v1/im/messages/${encodeURIComponent(messageID)}/task-result`, listener.url)
  url.searchParams.set("directory", queryDirectory)
  const response = await fetch(url, { headers: authenticated ? headers : undefined })
  return { status: response.status, body: await response.json() }
}
const protectedTables = ["im_messages", "im_members", "im_task_source", "im_task_request", "im_task_grant",
  "im_reply_outbox", "work_execution", "session", "session_input", "session_activity", "session_provider_attempt",
  "session_v2_provider_turn_receipt", "session_v2_tool_effect_admission", "session_v2_tool_effect"]
const snapshot = () => AppRuntime.runPromise(Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* Effect.forEach(protectedTables, (table) => db.all<Record<string, unknown>>(`SELECT * FROM "${table}"`).pipe(
    Effect.map((rows) => ({ table, hashes: rows.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort() })),
  ))
}))
const frame = Schema.Struct({
  type: Schema.String,
  properties: Schema.Unknown,
})
const statusFrame = Schema.Struct({
  sessionID: Schema.String,
  status: Schema.Struct({ type: Schema.String }),
})
const observe = async (pathname: string) => {
  const controller = new AbortController()
  const url = new URL(pathname, listener.url)
  if (pathname === "/event") url.searchParams.set("directory", directory)
  const response = await fetch(url, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const next = async () => {
    while (true) {
      const end = buffer.text.indexOf("\n\n")
      if (end >= 0) {
        const value = buffer.text.slice(0, end)
        buffer.text = buffer.text.slice(end + 2)
        const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!data) continue
        const decoded: unknown = JSON.parse(data)
        return Schema.decodeUnknownSync(frame)(pathname === "/global/event" && decoded && typeof decoded === "object" && "payload" in decoded ? decoded.payload : decoded)
      }
      const chunk = await reader.read()
      assert(!chunk.done, "SSE closed before the expected status")
      buffer.text += decoder.decode(chunk.value, { stream: true })
    }
  }
  assert.equal((await next()).type, "server.connected")
  return { next, close: () => controller.abort() }
}
try {
  // Instance bootstrap may initialize project infrastructure. Freeze execution/chat rows
  // before the subsequent reads; the seed is a controlled store oracle, not a Native run.
  const first = await get(directory)
  assert.equal(first.status, 200, JSON.stringify(first))
  assert.equal(first.body.state, "available", JSON.stringify(first))
  const before = await snapshot()
  const denied = await get(directory, original.messageID, false)
  assert.equal(denied.status, 401)
  const exact = await get(directory)
  assert.equal(exact.status, 200)
  assert.equal(exact.body.placement.instanceID, identity)
  assert.equal(exact.body.placement.directory, directory)
  assert.equal(exact.body.placement.sessionID, original.sessionID)
  assert.equal(exact.body.attempt.workID, original.workID)
  const crossProject = await get(path.join(root, "other", "project"))
  assert.equal(crossProject.status, 404)
  const missing = await get(directory, "imsg_unverified")
  assert.equal(missing.status, 404)
  const peerFile = path.join(path.dirname(root), process.argv[3] === "1" ? "2" : "1", "ready.json")
  const peerDeadline = performance.now() + 10_000
  while (!(await Bun.file(peerFile).exists())) {
    assert(performance.now() < peerDeadline, "Other test HTTP instance did not become ready")
    await Bun.sleep(20)
  }
  const peer = await Bun.file(peerFile).json()
  // Both listeners are alive here. A bare message/session identity cannot select another instance.
  const foreignMessage = await get(directory, peer.messageID)
  assert.equal(foreignMessage.status, 404)
  const peerURL = new URL(`/api/v1/im/messages/${encodeURIComponent(original.messageID)}/task-result`, peer.url)
  peerURL.searchParams.set("directory", peer.directory)
  const foreignInstance = await fetch(peerURL, { headers })
  assert.equal(foreignInstance.status, 404)
  const observers = await Promise.all([observe("/event"), observe("/global/event")])
  const observationDeadline = setTimeout(() => observers.forEach((observer) => observer.close()), 5000)
  try {
    // This private probe publishes a terminal fact for an already settled store fixture.
    // It verifies both production SSE paths, not a new runner interruption or provider run.
    await AppRuntime.runPromise(Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make(original.sessionID)
      const session = yield* (yield* SessionStore.Service).get(sessionID)
      assert(session)
      yield* (yield* EventV2Bridge.Service).publish(Execution.Interrupted, {
        sessionID, timestamp: yield* DateTime.now, reason: "user",
      }, { location: session.location })
    }))
    await Promise.all(observers.map(async (observer) => {
      while (true) {
        const event = await observer.next()
        if (event.type !== "session.status") continue
        const status = Schema.decodeUnknownSync(statusFrame)(event.properties)
        if (status.sessionID !== original.sessionID) continue
        assert.equal(status.status.type, "idle")
        return
      }
    }))
  } finally {
    clearTimeout(observationDeadline)
    observers.forEach((observer) => observer.close())
  }
  const current = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.all<{ count: number }>("SELECT count(*) count FROM session_provider_attempt")
  }))
  assert.deepEqual(current, [{ count: 0 }])
  assert.deepEqual(await snapshot(), before)
  assert(!JSON.stringify(exact.body).includes(IMTaskResultFixture.reply))
  await Bun.write(path.join(root, "result.json"), JSON.stringify({
    closed: false, identity, exact: exact.body, statuses: { denied: denied.status, crossProject: crossProject.status, missing: missing.status,
      foreignMessage: foreignMessage.status, foreignInstance: foreignInstance.status },
    protectedTableCount: protectedTables.length, protectedDrift: 0, providerAttempts: 0, ssePaths: ["/event", "/global/event"],
    evidenceClass: "actual production HTTP over controlled terminal business stores",
  }, null, 2))
  await Bun.write(path.join(root, "reads-complete.json"), "true")
  const peerComplete = path.join(path.dirname(peerFile), "reads-complete.json")
  while (!(await Bun.file(peerComplete).exists())) {
    assert(performance.now() < peerDeadline, "Other HTTP instance did not finish its reads")
    await Bun.sleep(20)
  }
} finally {
  await listener.stop(true)
}
const result = await Bun.file(path.join(root, "result.json")).json()
await Bun.write(path.join(root, "result.json"), JSON.stringify({ ...result, closed: true }, null, 2))
process.exit(0)
