import assert from "node:assert/strict"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { ImportJob } from "@deepagent-code/core/import-job"
import { ImportJobSchema } from "@deepagent-code/core/import-job/schema"
import { importServer, importSource } from "./import-job"

const root = process.argv[2]!
const mode = process.argv[3]!
const post = (url: string, body?: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body ?? {}), "application/json")),
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as ImportJobSchema.Info),
  )
const get = (id: string) =>
  HttpClientRequest.get(`/global/import/jobs/${id}`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as ImportJobSchema.Info),
  )
const request = {
  requestID: "process-kill",
  source: "codex" as const,
  sourcePath: path.join(root, "codex"),
  scopes: ["session" as const],
}
console.log("IMPORT_PROCESS_START", mode, root)
if (mode === "crash") await importSource(root, "codex", 500)
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      console.log("IMPORT_PROCESS_SERVER_READY", mode)
      const db = (yield* Database.Service).db
      if (mode === "crash") {
        const accepted = yield* post("/global/import/jobs", request)
        for (let attempt = 0; attempt < 5_000; attempt++) {
          const job = yield* get(accepted.id)
          if (job.committedBatches > 0 && job.activeBatchID && job.activeBatchID !== "prepare") {
            yield* Effect.promise(() => Bun.write(path.join(root, "crash.json"), JSON.stringify(job)))
            process.kill(process.pid, "SIGKILL")
          }
          assert.equal(ImportJobSchema.terminal(job.state), false, JSON.stringify(job))
          yield* Effect.sleep("1 millis")
        }
        throw new Error("Did not observe a real admitted import batch before kill")
      }
      const killed = (yield* Effect.promise(() =>
        Bun.file(path.join(root, "crash.json")).json(),
      )) as ImportJobSchema.Info
      const proof = yield* ImportJob.receipts({ filename: killed.target!.dbPath, jobID: killed.id })
      assert.ok(proof.count > 0 && proof.count < 500)
      const before = yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)
      console.log("IMPORT_PROCESS_RECEIPTS", proof.count)
      for (;;) {
        const observed = yield* get(killed.id)
        if (observed.state === "recovery_required") {
          assert.equal(observed.stopConfirmedAt, undefined)
          break
        }
        yield* Effect.sleep("250 millis")
      }
      console.log("IMPORT_PROCESS_OWNER_LOST")
      assert.deepEqual(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie), before)
      assert.deepEqual(yield* ImportJob.receipts({ filename: killed.target!.dbPath, jobID: killed.id }), proof)
      assert.equal((yield* post("/global/import/jobs", request)).id, killed.id)
      for (let attempt = 0; attempt < 300; attempt++) {
        const stopped = yield* post(`/global/import/jobs/${killed.id}/cancel`)
        if (attempt % 20 === 0) console.log("IMPORT_PROCESS_CANCEL", attempt, JSON.stringify(stopped))
        if (stopped.stopConfirmedAt) {
          assert.equal(stopped.state, "cancelled_partial")
          assert.equal(stopped.committedBatches, proof.count)
          assert.deepEqual(yield* ImportJob.receipts({ filename: killed.target!.dbPath, jobID: killed.id }), proof)
          yield* Effect.promise(() =>
            Bun.write(
              path.join(root, "recovered.json"),
              JSON.stringify({ killed, stopped, proof, queryChanges: before, recoveredPID: process.pid }),
            ),
          )
          console.log("IMPORT_PROCESS_RESTART_PASS", JSON.stringify({ committed: proof.count, jobID: killed.id }))
          return
        }
        assert.equal(stopped.state, "recovery_required")
        yield* Effect.sleep("250 millis")
      }
      throw new Error("Explicit cold cancellation did not confirm stopped")
    }).pipe(Effect.provide(importServer(path.join(root, "live.db"))), Effect.provide(NodeServices.layer)),
  ),
)
