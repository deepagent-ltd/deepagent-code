import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { MAX_ACTIVE_JOBS } from "@/import/job"
import { tmpdirScoped } from "../fixture/fixture"
import { importServer, importSource } from "../fixture/import-job"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)
const post = (requestID: string, sourcePath: string, cwdFilter?: string) =>
  HttpClientRequest.post("/global/import/jobs").pipe(
    HttpClientRequest.setBody(
      HttpBody.text(
        JSON.stringify({
          requestID,
          source: "codex",
          sourcePath,
          scopes: ["session"],
          ...(cwdFilter ? { cwdFilter } : {}),
        }),
        "application/json",
      ),
    ),
    HttpClient.execute,
    Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))),
  )

it.live(
  "original HTTP import owner reserves capacity before admission and preserves exact retries",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const source = yield* Effect.promise(() => importSource(root, "codex", 200))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const results = yield* Effect.all(
          Array.from({ length: MAX_ACTIVE_JOBS + 1 }, (_, index) => post(`capacity-${index}`, source)),
          { concurrency: "unbounded" },
        )
        const accepted = results.filter((result) => result.status === 200)
        const refused = results.filter((result) => result.status !== 200)
        expect(accepted).toHaveLength(MAX_ACTIVE_JOBS)
        expect(refused).toHaveLength(1)
        expect(refused[0]!.status).toBe(400)
        expect(refused[0]!.body).toMatchObject({
          error: expect.stringContaining("IMPORT_JOB_CAPACITY"),
        })
        expect(yield* db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)).toHaveLength(MAX_ACTIVE_JOBS)
        const original = accepted[0]!.body as ImportJobSchema.Info
        const retry = yield* post(original.requestID, source)
        expect(retry.status).toBe(200)
        expect((retry.body as ImportJobSchema.Info).id).toBe(original.id)
        expect((yield* post(original.requestID, source, "/conflicting")).status).toBe(409)
        // Cancellation joins the original uninterruptible driver at its safe boundary.
        yield* Effect.forEach(
          accepted,
          (result) =>
            HttpClientRequest.post(`/global/import/jobs/${(result.body as ImportJobSchema.Info).id}/cancel`).pipe(
              HttpClient.execute,
              Effect.flatMap((response) => response.json),
            ),
          { concurrency: "unbounded", discard: true },
        )
        for (let attempt = 0; attempt < 1000; attempt++) {
          const states = yield* db
            .all<{ state: ImportJobSchema.State }>("SELECT state FROM import_job")
            .pipe(Effect.orDie)
          if (states.every((row) => ImportJobSchema.terminal(row.state))) break
          yield* Effect.sleep("10 millis")
        }
        const next = yield* post("capacity-released", source)
        expect(next.status).toBe(200)
        expect((next.body as ImportJobSchema.Info).requestID).toBe("capacity-released")
        expect(yield* db.all("SELECT job_id FROM import_job").pipe(Effect.orDie)).toHaveLength(MAX_ACTIVE_JOBS + 1)
      }).pipe(Effect.provide(importServer(path.join(root, "live.db"))))
    }),
  30000,
)
