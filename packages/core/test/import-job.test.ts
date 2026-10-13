import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "../src/database/database"
import { ImportJob } from "../src/import-job"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.live("import admission is exact, target-exclusive and observations never write", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "import-job-authority-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
    yield* Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const input = {
        id: "job-one",
        request: { requestID: "request-one", source: "codex" as const },
        digest: "a".repeat(64),
        targetKey: "target-one",
        migrationDigest: "migration-one",
        ownerID: "owner-one",
      }
      const first = yield* ImportJob.create(input)
      expect(first.created).toBe(true)
      expect((yield* ImportJob.create({ ...input, id: "ignored-retry-id" })).row.job_id).toBe("job-one")
      expect(Exit.isFailure(yield* ImportJob.create({ ...input, digest: "b".repeat(64) }).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* ImportJob.create({
            ...input,
            id: "job-two",
            request: { requestID: "request-two", source: "codex" },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* ImportJob.update({
        id: "job-one",
        ownerID: "owner-one",
        revision: (yield* ImportJob.get("job-one"))!.revision,
        patch: { state: "running" },
      })
      yield* ImportJob.requestCancel("job-one")
      expect(
        yield* ImportJob.beginBatch({
          id: "job-one",
          ownerID: "owner-one",
          revision: (yield* ImportJob.get("job-one"))!.revision,
          batchID: "0",
        }),
      ).toBeUndefined()
      expect(
        yield* ImportJob.update({
          id: "job-one",
          ownerID: "other",
          revision: (yield* ImportJob.get("job-one"))!.revision,
          patch: { state: "completed" },
        }),
      ).toBeUndefined()
      const current = (yield* ImportJob.get("job-one"))!
      expect(
        yield* ImportJob.update({
          id: "job-one",
          ownerID: "owner-one",
          revision: current.revision - 1,
          patch: { committed_batches: 9 },
        }),
      ).toBeUndefined()
      yield* db.run("UPDATE import_job SET owner_lease_expires_at = 1 WHERE job_id = 'job-one'").pipe(Effect.orDie)
      const expired = (yield* ImportJob.get("job-one"))!
      expect(
        yield* ImportJob.update({
          id: "job-one",
          ownerID: "owner-one",
          revision: expired.revision,
          patch: { owner_lease_expires_at: Date.now() + 30_000 },
        }),
      ).toBeUndefined()
      expect(
        yield* ImportJob.beginBatch({
          id: "job-one",
          ownerID: "owner-one",
          revision: expired.revision,
          batchID: "expired",
        }),
      ).toBeUndefined()
      const second = yield* ImportJob.create({
        ...input,
        id: "expired-running",
        request: { ...input.request, requestID: "expired-running" },
        targetKey: "different-target",
      })
      const running = (yield* ImportJob.update({
        id: second.row.job_id,
        ownerID: "owner-one",
        revision: second.row.revision,
        patch: { state: "running" },
      }))!
      yield* db
        .run("UPDATE import_job SET owner_lease_expires_at = 1 WHERE job_id = 'expired-running'")
        .pipe(Effect.orDie)
      expect(
        yield* ImportJob.beginBatch({
          id: running.job_id,
          ownerID: "owner-one",
          revision: running.revision,
          batchID: "0",
        }),
      ).toBeUndefined()
      const cancelled = yield* ImportJob.requestCancel(running.job_id)
      const unknown = yield* ImportJob.confirmStopped({
        id: running.job_id,
        revision: cancelled.revision,
        count: 0,
        known: false,
        preparation: true,
      })
      expect(unknown?.state).toBe("recovery_required")
      expect(unknown?.error_code).toBe("IMPORT_TARGET_PREPARATION_UNKNOWN")
      expect(unknown?.stop_confirmed_at).toBeNull()
      const before = yield* db.get<{ count: number }>("SELECT total_changes() AS count").pipe(Effect.orDie)
      const row = (yield* ImportJob.get("job-one"))!
      expect(ImportJob.info(row, row.owner_lease_expires_at! + 1)).toMatchObject({ state: "recovery_required" })
      expect(ImportJob.info(row, row.owner_lease_expires_at! + 1).stopConfirmedAt).toBeUndefined()
      expect((yield* ImportJob.list()).items).toHaveLength(2)
      expect(yield* db.get<{ count: number }>("SELECT total_changes() AS count").pipe(Effect.orDie)).toEqual(before)
    }).pipe(Effect.provide(Database.layerFromPath(path.join(root, "authority.db"))))
  }),
)
