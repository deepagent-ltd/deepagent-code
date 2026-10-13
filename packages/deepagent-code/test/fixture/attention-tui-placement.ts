// Real host graph in a fresh process: private file DB, generated SDK, no runner/provider substitute.
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { createOpencodeClient } from "@deepagent-code/sdk/client"
import { seedActivity, seedSession } from "../../../core/test/fixture/attention"
import { AppRuntime, builtAppRuntimeRoot } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"

const directory = Bun.argv[2]
assert(directory)
const auth = { authorization: `Basic ${btoa("operator:placement-fixture")}` }
const database = await AppRuntime.runPromise(Database.Service)
assert.equal(builtAppRuntimeRoot()?.databasePath, path.join(directory, "attention.db"))
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const locations = { a: path.join(directory, "project A"), b: path.join(directory, "project B") }

try {
  for (const value of Object.values(locations)) {
    await mkdir(value, { recursive: true })
    await Bun.write(
      path.join(value, "deepagent-code.json"),
      JSON.stringify({ formatter: false, lsp: false, enabled_providers: [] }),
    )
  }
  const sessions = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const a = yield* seedSession(database, "tui_a", { project: "attention-a" })
      const b = yield* seedSession(database, "tui_b", { project: "attention-b" })
      for (const [key, session] of [
        ["a", a],
        ["b", b],
      ] as const) {
        yield* database.db
          .update(SessionTable)
          .set({ directory: locations[key] })
          .where(eq(SessionTable.id, session))
          .run()
          .pipe(Effect.orDie)
        yield* seedActivity(database, session, `tui_${key}`)
        const data = { text: `Persisted project ${key} message`, time: { created: 1 } }
        yield* database.db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(`msg_attention_tui_${key}`),
            session_id: session,
            type: "user",
            seq: 1,
            time_created: 1,
            data,
          })
          .run()
          .pipe(Effect.orDie)
      }
      return { a, b }
    }),
  )
  const client = createOpencodeClient({ baseUrl: listener.url.toString(), directory: locations.b, headers: auth })
  // Warm the real locations before the read-only oracle so location bootstrap is separate evidence.
  for (const sessionID of Object.values(sessions)) {
    assert.equal((await client.v2.session.get({ sessionID })).response?.status, 200)
    assert.equal((await client.v2.session.messages({ sessionID })).response?.status, 200)
  }
  const snapshot = () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const rows: Record<string, unknown> = {}
        for (const table of [
          "session",
          "session_input",
          "session_message",
          "session_activity",
          "session_provider_attempt",
          "session_v2_provider_turn_receipt",
          "attention_seen",
        ]) {
          rows[table] = yield* database.db.all(sql`SELECT * FROM ${sql.raw(table)}`).pipe(Effect.orDie)
        }
        rows.events = yield* database.db
          .all(sql`SELECT * FROM event WHERE aggregate_id IN (${sessions.a}, ${sessions.b})`)
          .pipe(Effect.orDie)
        rows.active = [...(yield* (yield* SessionExecution.Service).active)]
        return rows
      }),
    )
  const before = await snapshot()
  assert.deepEqual(before.active, [])
  assert.deepEqual(before.session_provider_attempt, [])
  assert.deepEqual(before.session_v2_provider_turn_receipt, [])
  assert.deepEqual(before.attention_seen, [])

  const listing = await client.v2.attention.list({ view: "all" })
  assert.equal(listing.response?.status, 200)
  assert.deepEqual(new Set(listing.data?.data.map((item) => item.session.id)), new Set(Object.values(sessions)))
  const source = listing.data?.data.find((item) => item.session.id === sessions.a)
  assert(source)
  const detail = await client.v2.attention.get({ itemID: source.id })
  assert.equal(detail.response?.status, 200)
  assert.equal(detail.data?.data.seen, false)
  const found = await client.v2.session.get({ sessionID: source.session.id })
  assert.equal(found.response?.status, 200)
  assert.equal(found.data?.data.location.directory, locations.a)
  assert.equal(found.data?.data.projectID, source.session.projectID)
  assert.equal(found.data?.data.location.workspaceID ?? null, null)
  const target = createOpencodeClient({
    baseUrl: listener.url.toString(),
    directory: found.data?.data.location.directory,
    headers: auth,
  })
  const messages = await target.v2.session.messages({ sessionID: source.session.id, order: "asc", limit: 20 })
  assert.equal(messages.response?.status, 200)
  assert.deepEqual(
    messages.data?.data.map((message) => ("text" in message ? message.text : message.type)),
    ["Persisted project a message"],
  )
  // Even the original B-routed client is resolved from A's persisted placement by middleware.
  assert.deepEqual(
    (await client.v2.session.messages({ sessionID: source.session.id, order: "asc" })).data?.data,
    messages.data?.data,
  )
  assert.equal((await client.v2.session.get({ sessionID: sessions.b })).data?.data.location.directory, locations.b)
  assert.deepEqual(await snapshot(), before)
  assert.equal(await AppRuntime.runPromise(Database.Service), database)
  console.log("ATTENTION_TUI_FILE_DB_PLACEMENT_PASS")
} finally {
  await listener.stop(true)
  await Server.disposeDefault()
  await AppRuntime.dispose()
}
