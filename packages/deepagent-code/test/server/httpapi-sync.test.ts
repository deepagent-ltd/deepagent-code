import { afterEach, describe, expect, mock, spyOn } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Flag } from "@deepagent-code/core/flag/flag"
import { SyncPaths, SyncReplayLimits } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { SyncHistoryLimits } from "@/server/routes/instance/httpapi/handlers/sync"
import { Database } from "@deepagent-code/core/database/database"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import { EventV2 } from "@deepagent-code/core/event"
import { eq } from "drizzle-orm"
import { HttpServer } from "effect/unstable/http"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { encodeReplayRequestPrefix } from "@/sync/replay-protocol"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  mock.restore()
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const info = spyOn(Log.create({ service: "server.sync" }), "info")
        const session = yield* Session.use.create({ title: "sync" })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
        expect(info.mock.calls.some(([message]) => message === "sync replay requested")).toBe(true)
        expect(info.mock.calls.some(([message]) => message === "sync replay complete")).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "bounds legacy message.updated rows in sync history",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-legacy-diff" })
        yield* Session.use.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: Array.from({ length: MessageV2.ClientDiffLimits.files + 5 }, (_, index) => ({
              file: `legacy-${index}.ts`,
              patch: "x",
              additions: 1,
              deletions: 0,
              status: "modified" as const,
            })),
          },
        })

        const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const rows = (yield* response.json) as Array<{ type: string; data: Record<string, unknown> }>
        const event = rows.find((row) => row.type === "message.updated.1")
        const info = event?.data.info as { summary?: { diffs?: Array<{ patch?: string }> } } | undefined
        expect(info?.summary?.diffs).toHaveLength(MessageV2.ClientDiffLimits.files)
        expect(info?.summary?.diffs?.every((item) => item.patch === undefined)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "pages bounded sync history until the aggregate cursor catches up",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-pages" })
        const extra = SyncHistoryLimits.events + 5
        yield* Effect.forEach(
          Array.from({ length: extra }, (_, index) => index),
          (index) =>
            Session.use.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() + index },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
            }),
          { discard: true },
        )

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const firstRows = (yield* first.json) as Array<{ id: string; aggregate_id: string; seq: number }>
        expect(firstRows).toHaveLength(SyncHistoryLimits.events)
        const state = Object.fromEntries(firstRows.map((row) => [row.aggregate_id, row.seq]))
        const second = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(state),
        })
        const secondRows = (yield* second.json) as Array<{ id: string; aggregate_id: string; seq: number }>
        expect(secondRows.length).toBeGreaterThan(0)
        expect(secondRows.length).toBeLessThanOrEqual(SyncHistoryLimits.events)
        expect(new Set([...firstRows, ...secondRows].map((row) => row.id)).size).toBe(
          firstRows.length + secondRows.length,
        )
        secondRows.forEach((row) => (state[row.aggregate_id] = row.seq))
        const done = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(state),
        })
        expect(yield* done.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "fails closed before decoding an oversized legacy sync event",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-legacy-oversized" })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_sync_legacy_oversized"),
            aggregate_id: session.id,
            seq: sequence!.seq + 1,
            type: "sync.legacy.1",
            data: { value: "x".repeat(SyncHistoryLimits.bytes + 1) },
          })
          .run()
          .pipe(Effect.orDie)

        const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: sequence!.seq }),
        })
        const body = yield* response.text
        expect(response.status, body).toBe(503)
        expect(body).toContain("requires artifact migration")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "returns a contiguous prefix before an oversized legacy sync event",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-prefix" })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_sync_legacy_oversized_after_prefix"),
            aggregate_id: session.id,
            seq: sequence!.seq + 1,
            type: "sync.legacy.1",
            data: { value: "x".repeat(SyncHistoryLimits.bytes + 1) },
          })
          .run()
          .pipe(Effect.orDie)

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const rows = (yield* first.json) as Array<{ aggregate_id: string; seq: number }>
        expect(first.status).toBe(200)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.aggregate_id).toBe(session.id)

        const blocked = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: rows[0]!.seq }),
        })
        const body = yield* blocked.text
        expect(blocked.status, body).toBe(503)
        expect(body).toContain("requires artifact migration")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "never crosses a UTF-8 event that exceeds the serialized page budget",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-wire-prefix" })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        expect(sequence).toBeDefined()
        const target = SyncHistoryLimits.bytes - 100
        const overhead = Buffer.byteLength(JSON.stringify({ value: "" }))
        const available = target - overhead
        const unicode = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3)
        const middle = { value: unicode }
        expect(Buffer.byteLength(JSON.stringify(middle))).toBe(target)
        yield* db
          .insert(EventTable)
          .values([
            {
              id: EventV2.ID.make("evt_sync_wire_small_before"),
              aggregate_id: session.id,
              seq: sequence!.seq + 1,
              type: "sync.test.1",
              data: { value: "before" },
            },
            {
              id: EventV2.ID.make("evt_sync_wire_middle"),
              aggregate_id: session.id,
              seq: sequence!.seq + 2,
              type: "sync.test.1",
              data: middle,
            },
            {
              id: EventV2.ID.make("evt_sync_wire_small_after"),
              aggregate_id: session.id,
              seq: sequence!.seq + 3,
              type: "sync.test.1",
              data: { value: "after" },
            },
          ])
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(EventSequenceTable)
          .set({ seq: sequence!.seq + 3 })
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .run()
          .pipe(Effect.orDie)

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: sequence!.seq }),
        })
        const rows = (yield* first.json) as Array<{ id: string; seq: number }>
        expect(first.status).toBe(200)
        expect(rows.map((row) => row.id)).toEqual(["evt_sync_wire_small_before"])

        const blocked = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: sequence!.seq + 1 }),
        })
        const body = yield* blocked.text
        expect(blocked.status, body).toBe(503)
        expect(body).toContain("Projected sync event evt_sync_wire_middle exceeds")
        expect(body).not.toContain("evt_sync_wire_small_after")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "rejects replay batches above the event and byte budgets before replay",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const event = (index: number, data: Record<string, unknown> = {}) => ({
          id: EventV2.ID.make(`evt_sync_replay_limit_${index}`),
          aggregateID: "aggregate-sync-replay-limit",
          seq: index,
          type: "sync.replay.limit.1",
          data,
        })

        const tooMany = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: Array.from({ length: SyncReplayLimits.events + 1 }, (_, index) => event(index)),
          }),
        })
        expect(tooMany.status).toBe(400)

        const oversized = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: [event(0, { value: "x".repeat(SyncReplayLimits.requestBytes) })],
          }),
        })
        expect(oversized.status).toBe(413)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "replays a maximum admitted event through Web and the real Node listener",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "sync-max-replay" })
        const event = (aggregateID: string, id: EventV2.ID, seq: number) => {
          const base = {
            sessionID: aggregateID,
            info: {
              id: MessageID.ascending(),
              sessionID: aggregateID,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
              system: "",
            },
          }
          const remaining = EventV2.MAX_ENCODED_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(base))
          const data = { ...base, info: { ...base.info, system: "x".repeat(remaining) } }
          expect(Buffer.byteLength(JSON.stringify(data))).toBe(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
          return {
            id,
            aggregateID,
            seq,
            type: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
            data,
          }
        }
        const { db } = yield* Database.Service
        const webSequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const webEvent = event(session.id, EventV2.ID.make("evt_sync_max_web"), webSequence!.seq + 1)
        const webBody = encodeReplayRequestPrefix(tmp.directory, [webEvent])
        expect(webBody.complete).toBe(true)
        expect(webBody.dataBytes).toBe(SyncReplayLimits.eventDataBytes)
        expect(webBody.requestBytes).toBeGreaterThan(SyncReplayLimits.eventDataBytes)
        expect(webBody.requestBytes).toBeLessThanOrEqual(SyncReplayLimits.requestBytes)
        const web = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: webBody.json,
        })
        expect(web.status, yield* web.text).toBe(200)

        const nodeSession = yield* Session.use.create({ title: "sync-max-node" })
        const nodeSequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, nodeSession.id))
          .get()
          .pipe(Effect.orDie)
        const nodeEvent = event(nodeSession.id, EventV2.ID.make("evt_sync_max_node"), nodeSequence!.seq + 1)
        const nodeBody = encodeReplayRequestPrefix(tmp.directory, [nodeEvent])
        const server = yield* HttpServer.HttpServer
        const node = yield* Effect.promise(() =>
          fetch(`${HttpServer.formatAddress(server.address)}${SyncPaths.replay}`, {
            method: "POST",
            headers: {
              "x-deepagent-code-directory": tmp.directory,
              "content-type": "application/json",
            },
            body: nodeBody.json,
          }),
        )
        expect(node.status, yield* Effect.promise(() => node.text())).toBe(200)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "rejects an unbounded replay stream before reading or decoding the full body",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { db } = yield* Database.Service
        const before = yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)
        const chunk = new TextEncoder().encode("x".repeat(256 * 1024))
        let pulls = 0
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++
            if (pulls > 1024) return controller.close()
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        })
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.replay}`, {
              method: "POST",
              headers: {
                "x-deepagent-code-directory": tmp.directory,
                "content-type": "application/json",
              },
              body,
              duplex: "half",
            } as RequestInit),
            context,
          ),
        )

        expect(response.status).toBe(413)
        expect(pulls).toBeLessThan(64)
        expect(cancelled).toBe(true)
        expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "enforces the replay stream budget on the real Node listener without content-length",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { db } = yield* Database.Service
        const before = yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)
        const chunk = new TextEncoder().encode("x".repeat(256 * 1024))
        let pulls = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++
            if (pulls > 1024) return controller.close()
            controller.enqueue(chunk)
          },
        })
        const server = yield* HttpServer.HttpServer
        const response = yield* Effect.promise(() =>
          fetch(`${HttpServer.formatAddress(server.address)}${SyncPaths.replay}`, {
            method: "POST",
            headers: {
              "x-deepagent-code-directory": tmp.directory,
              "content-type": "application/json",
            },
            body,
            duplex: "half",
          } as RequestInit),
        )

        expect(response.status).toBe(400)
        expect(pulls).toBeLessThan(64)
        expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
