import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Option, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { ImportJob } from "@deepagent-code/core/import-job"
import { tmpdirScoped } from "../fixture/fixture"
import { importServer, importSource } from "../fixture/import-job"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)
const post = (url: string, body?: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body ?? {}), "application/json")),
    HttpClient.execute,
  )
const get = (id: string) =>
  HttpClientRequest.get(`/global/import/jobs/${id}`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as ImportJobSchema.Info),
  )
const wait = (id: string, predicate: (job: ImportJobSchema.Info) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const job = yield* get(id)
      if (predicate(job)) return job
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(`Import ${id} did not reach the expected state`)
  })

for (const source of ["codex", "claude"] as const)
  it.live(
    `${source}: durable HTTP copy, exact retry, zero-write query and reconnect`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        const sourcePath = yield* Effect.promise(() => importSource(root, source, 3))
        yield* Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const request = { requestID: "exact-original", source, sourcePath, scopes: ["session"] }
          const response = yield* post("/global/import/jobs", request)
          expect(response.status).toBe(200)
          const accepted = (yield* response.json) as ImportJobSchema.Info
          const completed = yield* wait(accepted.id, (job) => ImportJobSchema.terminal(job.state))
          expect(completed).toMatchObject({
            state: "completed",
            committedBatches: 3,
            totalSessions: 3,
            failedBatches: 0,
          })
          expect(completed.target?.id).toBe(accepted.id)
          expect(completed.target?.mode).toBe("copy_to_new_db")
          expect(completed.target?.backup?.sha256).toMatch(/^[0-9a-f]{64}$/)
          expect(yield* db.all("SELECT id FROM session").pipe(Effect.orDie)).toEqual([])
          const proof = yield* ImportJob.receipts({
            filename: completed.target!.dbPath,
            jobID: completed.id,
            sourceDigest: completed.sourceDigest,
            includeResults: true,
          })
          expect(proof.count).toBe(3)
          expect(proof.results).toHaveLength(3)
          // The source may change later; exact request retry locates its frozen original job.
          yield* Effect.promise(() => fs.rm(sourcePath, { recursive: true }))
          const retried = yield* post("/global/import/jobs", request)
          expect(retried.status).toBe(200)
          expect(((yield* retried.json) as ImportJobSchema.Info).id).toBe(accepted.id)
          expect((yield* post("/global/import/jobs", { ...request, cwdFilter: "/different" })).status).toBe(409)
          const before = yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)
          expect((yield* get(accepted.id)).sourceDigest).toBe(completed.sourceDigest)
          const listed = yield* HttpClientRequest.get("/global/import/jobs").pipe(
            HttpClient.execute,
            Effect.flatMap((r) => r.json),
          )
          expect(listed).toMatchObject({ items: [{ id: accepted.id }] })
          expect(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)).toEqual(before)
          expect((yield* get(accepted.id)).committedBatches).toBe(3)
        }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
      }),
    30_000,
  )

it.live(
  "HTTP cancel confirms a session boundary and durable partial receipts",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const sourcePath = yield* Effect.promise(() => importSource(root, "codex", 150))
      yield* Effect.gen(function* () {
        const response = yield* post("/global/import/jobs", {
          requestID: "cancel-partial",
          source: "codex",
          sourcePath,
          scopes: ["session"],
        })
        const accepted = (yield* response.json) as ImportJobSchema.Info
        const writing = yield* wait(
          accepted.id,
          (job) => job.committedBatches > 0 || ImportJobSchema.terminal(job.state),
        )
        expect(writing.state).toBe("running")
        const cancelled = yield* post(`/global/import/jobs/${accepted.id}/cancel`)
        expect(cancelled.status).toBe(200)
        const acknowledgement = (yield* cancelled.json) as ImportJobSchema.Info
        expect(["cancel_requested", "cancelled_partial"]).toContain(acknowledgement.state)
        if (acknowledgement.state === "cancel_requested") expect(acknowledgement.stopConfirmedAt).toBeUndefined()
        const stopped = yield* wait(accepted.id, (job) => ImportJobSchema.terminal(job.state))
        expect(stopped.state).toBe("cancelled_partial")
        expect(stopped.stopConfirmedAt).toBeGreaterThan(0)
        expect(stopped.committedBatches).toBeGreaterThan(0)
        expect(stopped.committedBatches).toBeLessThan(150)
        const before = yield* ImportJob.receipts({ filename: stopped.target!.dbPath, jobID: stopped.id })
        yield* Effect.sleep("50 millis")
        expect(yield* ImportJob.receipts({ filename: stopped.target!.dbPath, jobID: stopped.id })).toEqual(before)
        expect((yield* get(stopped.id)).committedBatches).toBe(before.count)
        expect(
          ((yield* (yield* post(`/global/import/jobs/${stopped.id}/cancel`)).json) as ImportJobSchema.Info).revision,
        ).toBe(stopped.revision)
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30_000,
)

it.live("unsupported writes and missing live confirmation are rejected before target writes", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const sourcePath = yield* Effect.promise(() => importSource(root, "codex"))
    yield* Effect.gen(function* () {
      const base = { requestID: "invalid", source: "codex", sourcePath }
      expect(
        (yield* post("/global/import/jobs", {
          ...base,
          scopes: ["memory"],
          mode: "merge_into_live",
          confirmLiveMerge: true,
        })).status,
      ).toBe(400)
      expect(
        (yield* post("/global/import/jobs", { ...base, scopes: ["session"], mode: "merge_into_live" })).status,
      ).toBe(400)
      expect(yield* (yield* Database.Service).db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)).toEqual([])
    }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
  }),
)

it.live(
  "disconnecting the legacy SSE observer does not cancel its durable job",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const sourcePath = yield* Effect.promise(() => importSource(root, "codex", 100))
      yield* Effect.gen(function* () {
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* post("/global/import", { source: "codex", sourcePath, scopes: ["session"] })
            expect(response.status).toBe(200)
            return yield* Stream.runHead(response.stream)
          }),
        )
        expect(Option.isSome(first)).toBe(true)
        const id = new TextDecoder().decode(Option.getOrThrow(first)).match(/"jobID":"([a-zA-Z0-9_-]+)"/)?.[1]
        expect(id).toBeTruthy()
        const completed = yield* wait(id!, (job) => ImportJobSchema.terminal(job.state))
        expect(completed).toMatchObject({ state: "completed", committedBatches: 100 })
        expect(completed.cancelRequestedAt).toBeUndefined()
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30_000,
)

it.live(
  "preflight protects locally owned imported history before either live or copy target preparation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const sourcePath = yield* Effect.promise(() => importSource(root, "codex"))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const request = {
          requestID: "seed-live",
          source: "codex",
          sourcePath,
          scopes: ["session"],
          mode: "merge_into_live",
          confirmLiveMerge: true,
        }
        const admitted = (yield* (yield* post("/global/import/jobs", request)).json) as ImportJobSchema.Info
        expect((yield* wait(admitted.id, (job) => ImportJobSchema.terminal(job.state))).state).toBe("completed")
        // The actual native create/admit caller is covered by writer integration. This
        // fixture persists its durable authority marker after an earlier imported history.
        yield* db.run("UPDATE session SET v2_authority = 1, title = 'retained local work'").pipe(Effect.orDie)
        const history = yield* db.all("SELECT * FROM event ORDER BY seq").pipe(Effect.orDie)
        for (const mode of ["copy_to_new_db", "merge_into_live"] as const) {
          const accepted = (yield* (yield* post("/global/import/jobs", { ...request, requestID: mode, mode }))
            .json) as ImportJobSchema.Info
          const rejected = yield* wait(accepted.id, (job) => ImportJobSchema.terminal(job.state))
          expect(rejected.state).toBe("failed")
          expect(rejected.error?.message).toContain("IMPORT_SESSION_PROTECTED")
          expect(rejected.target).toBeUndefined()
          expect(rejected.committedBatches).toBe(0)
          expect(yield* db.all("SELECT * FROM event ORDER BY seq").pipe(Effect.orDie)).toEqual(history)
          expect(yield* db.get("SELECT title FROM session").pipe(Effect.orDie)).toEqual({
            title: "retained local work",
          })
        }
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30_000,
)

it.live("configured management authentication rejects import access without admitting a job", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      expect((yield* post("/global/import/jobs", { requestID: "unauthorized", source: "codex" })).status).toBe(401)
      expect((yield* HttpClientRequest.get("/global/import/jobs").pipe(HttpClient.execute)).status).toBe(401)
      expect(yield* (yield* Database.Service).db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)).toEqual([])
    }).pipe(Effect.provide(importServer(path.join(root, "live.db"), "fixture-secret")))
  }),
)
