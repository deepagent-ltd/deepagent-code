import { afterEach, describe, expect, test } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Database } from "@deepagent-code/core/database/database"
import { ErrorContract } from "@deepagent-code/core/contract/error-code"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import path from "node:path"
import { Server } from "../../src/server/server"
import { CapabilityPaths } from "../../src/server/routes/instance/httpapi/groups/capability"
import { ContextPaths } from "../../src/server/routes/instance/httpapi/groups/context"
import { SystemContextPaths } from "../../src/server/routes/instance/httpapi/groups/system-context"
import { ApiTypedErrors, apiErrorStatus, makeApiError } from "../../src/server/routes/instance/httpapi/typed-error"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// RI-57: DYNAMIC wire-status oracle for the C0-03 typed-error surface. The static
// registry→status mapping (httpapi-typed-error.test.ts) and the maintenance shell's
// dynamic 423/503 (httpapi-maintenance-boot.test.ts) already exist; this file closes
// the gap for the capability / system-context / context groups: a real listener is
// booted, each dynamically reachable typed error is triggered per endpoint, and the
// ACTUAL HTTP status must equal the registry declaration (`apiErrorStatus`), never a
// hardcoded expectation. A probe group drives the remaining ErrorClasses the
// ready-runtime production endpoints cannot reach, so every registered code has a
// real wire oracle.

const originalDatabase = Flag.DEEPAGENT_CODE_DB
const originalPassword = process.env.DEEPAGENT_CODE_SERVER_PASSWORD

const password = "typed-error-secret"
const auth = () => ({ authorization: `Basic ${btoa(`deepagent-code:${password}`)}` })

afterEach(async () => {
  Flag.DEEPAGENT_CODE_DB = originalDatabase
  if (originalPassword === undefined) delete process.env.DEEPAGENT_CODE_SERVER_PASSWORD
  else process.env.DEEPAGENT_CODE_SERVER_PASSWORD = originalPassword
  await disposeAllInstances()
})

const ERROR_CLASS_NAME: Record<number, string> = {
  400: "ApiBadRequest",
  403: "ApiForbidden",
  404: "ApiNotFound",
  409: "ApiConflict",
  410: "ApiGone",
  423: "ApiLocked",
  503: "ApiUnavailable",
}

async function startReadyListener(dbFile: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
    }).pipe(Effect.provide(Database.layerFromPath(dbFile)), Effect.scoped),
  )
  Flag.DEEPAGENT_CODE_DB = dbFile
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = password
  expect(await Database.bootstrap(dbFile)).toMatchObject({ mode: "ready", ready: true })
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

async function createSession(listener: Awaited<ReturnType<typeof Server.listen>>, directory: string) {
  const response = await fetch(new URL("/session", listener.url), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json", "x-deepagent-code-directory": directory },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

// Direct durable-store setup (no runtime path snapshots a fresh session): plant the
// snapshot-checkpoint authority the trigger demands, then pin the retention floor. A
// raw bun:sqlite writer (not layerFromPath) because the listener already owns the
// file — a second Database layer build would fence itself out as "another process".
function seedRetentionFloor(dbFile: string, sessionId: string, input: { seq: number; floor: number }) {
  const db = new BunDatabase(dbFile)
  try {
    db.run("PRAGMA busy_timeout = 5000")
    db.query("INSERT OR IGNORE INTO event_sequence (aggregate_id, seq) VALUES (?, ?)").run(sessionId, input.seq)
    db.query("UPDATE event_sequence SET seq = MAX(seq, ?) WHERE aggregate_id = ?").run(input.seq, sessionId)
    db.query(
      `INSERT INTO event_snapshot (snapshot_id, aggregate_id, through_seq, sync_seq, codec, schema_version, snapshot_hash, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`snap_typed_error_${sessionId}`, sessionId, input.floor, Date.now(), "test", 1, "a".repeat(64), "{}", Date.now())
    db.query("UPDATE event_sequence SET retention_floor_seq = ?, snapshot_id = ? WHERE aggregate_id = ?").run(
      input.floor,
      `snap_typed_error_${sessionId}`,
      sessionId,
    )
  } finally {
    db.close()
  }
}

describe("C0-03 dynamic typed-error matrix (real ready-runtime listener)", () => {
  test("context group: every reachable typed error matches the registry status on the wire", async () => {
    await using root = await tmpdir()
    await using project = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const dbFile = path.join(root.path, "typed-context.db")
    const listener = await startReadyListener(dbFile)
    try {
      const sessionId = await createSession(listener, project.path)
      await seedRetentionFloor(dbFile, sessionId, { seq: 10, floor: 5 })

      const directoryQuery = `directory=${encodeURIComponent(project.path)}`
      const rows = [
        {
          endpoint: `GET ${ContextPaths.readiness}`,
          url: `${ContextPaths.readiness}?session_id=ses_missing&${directoryQuery}`,
          code: "resource_not_found",
        },
        {
          endpoint: `GET ${ContextPaths.eventsCursor}`,
          url: `${ContextPaths.eventsCursor}?session_id=ses_missing&${directoryQuery}`,
          code: "resource_not_found",
        },
        {
          endpoint: `GET ${ContextPaths.events}`,
          url: `${ContextPaths.events}?session_id=ses_missing&${directoryQuery}`,
          code: "resource_not_found",
        },
        {
          endpoint: `GET ${ContextPaths.events} (limit below range)`,
          url: `${ContextPaths.events}?session_id=${sessionId}&limit=0&${directoryQuery}`,
          code: "validation_failed",
        },
        {
          endpoint: `GET ${ContextPaths.events} (limit above range)`,
          url: `${ContextPaths.events}?session_id=${sessionId}&limit=501&${directoryQuery}`,
          code: "validation_failed",
        },
        {
          endpoint: `GET ${ContextPaths.events} (cursor behind floor)`,
          url: `${ContextPaths.events}?session_id=${sessionId}&after=1&${directoryQuery}`,
          code: "cursor_gap_exceeded",
        },
      ] as const

      for (const row of rows) {
        const response = await fetch(new URL(row.url, listener.url), { headers: auth() })
        const body = await response.json()
        // The registered code is the single authority for the HTTP status: the wire
        // status must equal the registry declaration, and the envelope must carry the
        // same code/status/retryability triple a client decides on.
        expect({ row: row.endpoint, status: response.status, body }).toMatchObject({
          row: row.endpoint,
          status: apiErrorStatus(row.code),
          body: {
            name: ERROR_CLASS_NAME[apiErrorStatus(row.code)],
            data: {
              code: row.code,
              httpStatus: apiErrorStatus(row.code),
              retryability: ErrorContract.codeMeta(row.code)!.retryability,
            },
          },
        })
      }

      // Boundary contrast: a cursor exactly AT the floor is not a gap, and the cursor
      // endpoint reports the seeded authority verbatim.
      const atFloor = await fetch(
        new URL(`${ContextPaths.events}?session_id=${sessionId}&after=5&${directoryQuery}`, listener.url),
        { headers: auth() },
      )
      expect(atFloor.status).toBe(200)
      expect(await atFloor.json()).toMatchObject({ events: [], floor: 5 })
      const cursor = await fetch(
        new URL(`${ContextPaths.eventsCursor}?session_id=${sessionId}&${directoryQuery}`, listener.url),
        { headers: auth() },
      )
      expect(cursor.status).toBe(200)
      expect(await cursor.json()).toEqual({ watermark: 10, cursor: 10, floor: 5 })
    } finally {
      await listener.stop(true)
    }
  }, 60_000)

  test("capability/system-context groups: 200 success and no typed envelope on schema rejection", async () => {
    await using root = await tmpdir()
    await using project = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const dbFile = path.join(root.path, "typed-capability.db")
    const listener = await startReadyListener(dbFile)
    try {
      const directoryQuery = `directory=${encodeURIComponent(project.path)}`

      const catalog = await fetch(new URL(`${CapabilityPaths.catalog}?${directoryQuery}`, listener.url), {
        headers: auth(),
      })
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toMatchObject({ id: expect.any(String), digest: expect.any(String) })

      const receipts = await fetch(new URL(`${CapabilityPaths.loadReceipts}?${directoryQuery}`, listener.url), {
        headers: auth(),
      })
      expect(receipts.status).toBe(200)
      expect(await receipts.json()).toMatchObject({ receipts: [], count: 0 })

      const snapshot = await fetch(new URL(`${SystemContextPaths.snapshot}?${directoryQuery}`, listener.url), {
        headers: auth(),
      })
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({ catalogDigestConsistent: true, loadedCapabilityCount: 0 })

      const search = await fetch(new URL(`${CapabilityPaths.search}?${directoryQuery}`, listener.url), {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ query: "nonexistent capability" }),
      })
      expect(search.status).toBe(200)

      // Boundary row: a payload schema rejection is a 400 but must NOT wear the C0-03
      // typed envelope — the typed surface only serializes registry-backed errors, so
      // a client deciding on `code` never sees a forged one.
      const rejected = await fetch(new URL(`${CapabilityPaths.search}?${directoryQuery}`, listener.url), {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ query: 123 }),
      })
      expect(rejected.status).toBe(400)
      const rejectedBody = await rejected.json()
      expect(rejectedBody).toMatchObject({ name: "BadRequest" })
      expect(rejectedBody.data.code).toBeUndefined()
    } finally {
      await listener.stop(true)
    }
  }, 60_000)
})

// Every registered code through the SAME ApiTypedErrors union the groups declare,
// served by a probe group on a real in-test listener: the dynamic counterpart of the
// static registry test, covering the ErrorClasses the ready-runtime endpoints never
// emit (403/409/423/503 live on the maintenance shell or not at all).
const ProbeApi = HttpApi.make("typed-error-probe").add(
  HttpApiGroup.make("probe").add(
    HttpApiEndpoint.get("fail", "/probe/fail", {
      query: Schema.Struct({ code: Schema.String }),
      success: Schema.String,
      error: ApiTypedErrors,
    }),
  ),
)

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  Effect.succeed(handlers.handle("fail", ({ query }) => Effect.fail(makeApiError(query.code, { resource: "probe" })))),
)

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

describe("C0-03 probe group: every registered code serializes to its registry status on the wire", () => {
  it.live("registry x wire matrix", () =>
    Effect.gen(function* () {
      yield* HttpApiBuilder.layer(ProbeApi).pipe(Layer.provide(probeHandlers), HttpRouter.serve, Layer.build)

      for (const entry of ErrorContract.ERROR_CODE_REGISTRY) {
        const response = yield* HttpClientRequest.get(`/probe/fail?code=${entry.code}`).pipe(HttpClient.execute)
        const body = yield* response.json
        expect({ code: entry.code, status: response.status, body }).toMatchObject({
          code: entry.code,
          status: entry.httpStatus,
          body: {
            name: ERROR_CLASS_NAME[entry.httpStatus],
            data: {
              code: entry.code,
              httpStatus: entry.httpStatus,
              retryability: entry.retryability,
              category: entry.category,
              resource: "probe",
            },
          },
        })
      }
    }),
  )
})
