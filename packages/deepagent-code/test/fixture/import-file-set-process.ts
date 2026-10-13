import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
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
const sourcePath = path.join(root, "claude")
if (mode === "crash") {
  await importSource(root, "claude")
  await Bun.write(
    path.join(sourcePath, "skills/durable-fixture/SKILL.md"),
    "# Durable fixture\nRetain the immutable assets.\n",
  )
  await Bun.write(path.join(sourcePath, "skills/durable-fixture/assets/raw.bin"), new Uint8Array([0, 255, 128]))
}
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      if (mode === "crash") {
        yield* db
          .run(
            "CREATE TRIGGER import_file_crash_receipt BEFORE INSERT ON import_batch_receipt WHEN json_extract(NEW.result,'$.kind') = 'file_set.v1' BEGIN SELECT RAISE(ABORT, 'published tree without receipt'); END",
          )
          .pipe(Effect.orDie)
        const accepted = yield* post("/global/import/jobs", {
          requestID: "file-process-kill",
          source: "claude",
          sourcePath,
          scopes: ["skill"],
        })
        for (let attempt = 0; attempt < 1_000; attempt++) {
          const job = yield* get(accepted.id)
          if (ImportJobSchema.terminal(job.state)) {
            assert.equal(job.state, "recovery_required")
            assert.equal(job.committedBatches, 0)
            assert.match(job.activeBatchID!, /^file_[a-f0-9]{64}:[a-f0-9]{64}$/)
            const identity = yield* Effect.promise(() =>
              fs.stat(path.join(job.target!.configDir, "skills/durable-fixture")),
            )
            yield* Effect.promise(() =>
              Bun.write(
                path.join(root, "file-crash.json"),
                JSON.stringify({ job, inode: identity.ino, device: identity.dev, pid: process.pid }),
              ),
            )
            process.kill(process.pid, "SIGKILL")
          }
          yield* Effect.sleep("10 millis")
        }
        throw new Error("File publisher did not expose its unknown window")
      }
      const killed = (yield* Effect.promise(() => Bun.file(path.join(root, "file-crash.json")).json())) as {
        job: ImportJobSchema.Info
        inode: number
        device: number
        pid: number
      }
      assert.notEqual(killed.pid, process.pid)
      const before = yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie)
      assert.equal((yield* get(killed.job.id)).state, "recovery_required")
      assert.equal((yield* ImportJob.receipts({ filename: killed.job.target!.dbPath, jobID: killed.job.id })).count, 0)
      assert.deepEqual(yield* db.get("SELECT total_changes() AS changes").pipe(Effect.orDie), before)
      yield* ImportJob.withDestinationFence(killed.job.target!.dbPath, async (database) => {
        database.exec("DROP TRIGGER import_file_crash_receipt")
      })
      const stopped = yield* post(`/global/import/jobs/${killed.job.id}/cancel`)
      assert.equal(stopped.state, "cancelled_partial")
      assert.equal(stopped.committedBatches, 1)
      assert.ok(stopped.stopConfirmedAt)
      const actual = yield* Effect.promise(() =>
        fs.stat(path.join(stopped.target!.configDir, "skills/durable-fixture")),
      )
      assert.deepEqual([actual.dev, actual.ino], [killed.device, killed.inode])
      const bytes = yield* Effect.promise(() =>
        Bun.file(path.join(stopped.target!.configDir, "skills/durable-fixture/assets/raw.bin")).bytes(),
      )
      assert.deepEqual([...bytes], [0, 255, 128])
      yield* Effect.promise(() =>
        Bun.write(
          path.join(root, "file-recovered.json"),
          JSON.stringify({ stopped, observerChanges: before, pid: process.pid }),
        ),
      )
      console.log("IMPORT_FILE_PROCESS_PASS", stopped.id)
    }).pipe(Effect.provide(importServer(path.join(root, "live.db"))), Effect.provide(NodeServices.layer)),
  ),
)
