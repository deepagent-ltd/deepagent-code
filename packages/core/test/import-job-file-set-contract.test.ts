import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { ImportJob } from "../src/import-job"
import { ImportBatchReceiptTable } from "../src/import-job.sql"
import { ImportJobSchema } from "../src/import-job/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.live("interrupting destination reconciliation retains the actual SQLite writer fence until the native callback settles", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "import-fence-interrupt-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
    const filename = path.join(root, "authority.sqlite")
    yield* Effect.promise(async () => {
      const { Database } = await import("#sqlite-native")
      const observer = new Database(filename)
      observer.run("CREATE TABLE probe(id INTEGER PRIMARY KEY)")
      observer.run("PRAGMA busy_timeout = 0")
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const owner = Effect.runFork(ImportJob.withDestinationFence(filename, async (target) => {
        target.run("INSERT INTO probe VALUES(1)")
        entered.resolve()
        await release.promise
      }))
      try {
        await entered.promise
        const interrupt = Effect.runPromise(Fiber.interrupt(owner))
        expect(await Promise.race([interrupt.then(() => "released"), Bun.sleep(20).then(() => "held")])).toBe("held")
        expect(() => observer.run("BEGIN IMMEDIATE")).toThrow()
        release.resolve()
        await interrupt
        expect(observer.query("SELECT * FROM probe").all()).toEqual([{ id: 1 }])
        observer.run("BEGIN IMMEDIATE")
        observer.run("ROLLBACK")
      } finally {
        release.resolve()
        await Effect.runPromise(Fiber.interrupt(owner))
        observer.close()
      }
    })
  }),
)

it.live("published file receipts remain distinct from session results and unknown stop requires explicit reconciliation", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "import-file-contract-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
    const filename = path.join(root, "authority.sqlite")
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const job = (yield* ImportJob.create({ id: "files", request: { requestID: "files", source: "codex", scopes: ["skill"] },
        digest: "a".repeat(64), targetKey: "copy", migrationDigest: "current", ownerID: "owner" })).row
      const result = {
        kind: "file_set.v1" as const, phase: "published" as const, scope: "skill" as const,
        sourceId: "skill/example", targetId: "skill-example", manifestHash: "b".repeat(64),
        directoryRef: { area: "config" as const, relative: "skills/example" }, bytes: 10, fileCount: 2,
        summary: { written: 1, skipped: 0 },
      }
      yield* db.insert(ImportBatchReceiptTable).values({ job_id: job.job_id, batch_id: "skill-0",
        source_digest: "a".repeat(64), source_id: result.sourceId, target_id: result.targetId,
        result, committed_at: Date.now() }).run()
      expect(yield* ImportJob.receipts({ filename, jobID: job.job_id, includeResults: true })).toEqual({
        count: 1, batchIDs: ["skill-0"], results: [], fileResults: [result],
      })
      expect(Exit.isFailure(yield* ImportJob.receipts({ filename, jobID: job.job_id,
        sourceDigest: "c".repeat(64) }).pipe(Effect.exit))).toBe(true)
      const lost = (yield* ImportJob.update({ id: job.job_id, ownerID: "owner", revision: job.revision,
        patch: { state: "recovery_required", active_batch_id: "skill-0", owner_id: null, owner_lease_expires_at: null } }))!
      expect(ImportJob.info(lost).stopConfirmedAt).toBeUndefined()
      const cancel = yield* ImportJob.requestCancel(job.job_id)
      expect(cancel.state).toBe("cancel_requested")
      expect(cancel.revision).toBe(lost.revision + 1)
      expect(yield* ImportJob.confirmStopped({ id: job.job_id, revision: lost.revision, count: 1, known: true })).toBeUndefined()
      const settled = yield* ImportJob.confirmStopped({ id: job.job_id, revision: cancel.revision, count: 1, known: true })
      expect(settled?.state).toBe("cancelled_partial")
      expect(settled?.committed_batches).toBe(1)
      expect(settled?.stop_confirmed_at).toBeNumber()
      yield* db.run("UPDATE import_batch_receipt SET result = json_set(result, '$.unexpected', 1) WHERE job_id = 'files'")
      // A corrupt receipt must fail even when the caller only asks for its count.
      expect(Exit.isFailure(yield* ImportJob.receipts({ filename, jobID: job.job_id }).pipe(Effect.exit))).toBe(true)
      expect(Schema.is(ImportJobSchema.FileSetResult)({ ...result, bytes: 256 * 1024 * 1024 + 1 })).toBe(false)
      expect(Schema.is(ImportJobSchema.FileSetResult)({ ...result, directoryRef: { area: "config", relative: "skills/../outside" } })).toBe(false)
    }).pipe(Effect.provide(Database.layerFromPath(filename)))
  }),
)
