import { afterEach, describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@deepagent-code/core/database/database"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { eq } from "drizzle-orm"
import * as Log from "@deepagent-code/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(SessionNs.defaultLayer, EventV2Bridge.defaultLayer, Database.defaultLayer, httpApiLayer),
)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "keeps V1-only history readable and rejects prompt/update/fork/remove without adoption",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const seed = yield* SessionNs.use.create({ title: "seed" })
        const legacyID = SessionID.descending()
        yield* EventV2Bridge.Service.use((events) =>
          events.publish(SessionV1.Event.Created, {
            sessionID: legacyID,
            info: { ...seed, id: legacyID, title: "historical" },
          }),
        )
        const { db } = yield* Database.Service
        expect(
          (yield* db
            .select({ authority: SessionTable.v2_authority })
            .from(SessionTable)
            .where(eq(SessionTable.id, legacyID))
            .get())?.authority,
        ).toBe(false)
        const get = yield* requestInDirectory(`/session/${legacyID}`, test.directory)
        expect(get.status).toBe(200)
        expect(((yield* get.json) as SessionNs.Info).title).toBe("historical")

        const requests = [
          {
            method: "POST",
            path: `/session/${legacyID}/prompt_async`,
            body: { parts: [{ type: "text", text: "forbidden" }] },
          },
          { method: "PATCH", path: `/session/${legacyID}`, body: { title: "forbidden" } },
          { method: "POST", path: `/session/${legacyID}/fork`, body: { intentID: "legacy-refused" } },
          { method: "DELETE", path: `/session/${legacyID}` },
        ]
        for (const request of requests) {
          const response = yield* requestInDirectory(request.path, test.directory, {
            method: request.method,
            headers: { "Content-Type": "application/json" },
            ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          })
          expect(response.status).toBe(409)
          expect(JSON.stringify(yield* response.json)).toContain("legacy_session_requires_adoption")
        }
        expect(
          (yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, legacyID)).all()).length,
        ).toBe(0)
        expect(
          (yield* db
            .select({ title: SessionTable.title })
            .from(SessionTable)
            .where(eq(SessionTable.id, legacyID))
            .get())?.title,
        ).toBe("historical")
      }),
    { git: true },
  )

  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] },
            permission: [{ permission: "bash", pattern: "*", action: "deny" }],
          }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })
        expect(next.permission).toEqual([{ permission: "bash", pattern: "*", action: "deny" }])

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "session-actions-fork" }),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        // Fork carries the parent's metadata verbatim PLUS an injected `forkedFrom`
        // lineage marker (parentSessionID/parentTitle + a volatile forkedAt timestamp).
        const { forkedFrom, ...forkedMetadata } = (fork.metadata ?? {}) as Record<string, unknown> & {
          forkedFrom?: { parentSessionID?: string; parentTitle?: string; forkedAt?: number }
        }
        expect(forkedMetadata).toEqual((next.metadata ?? {}) as Record<string, unknown>)
        expect(forkedFrom).toMatchObject({ parentSessionID: session.id })
        expect(typeof forkedFrom?.forkedAt).toBe("number")

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
