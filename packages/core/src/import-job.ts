export * as ImportJob from "./import-job"

import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "./database/database"
import { DatabaseMode } from "./database/mode"
import { ImportJobTable } from "./import-job.sql"
import { ImportJobSchema } from "./import-job/schema"

export type Row = typeof ImportJobTable.$inferSelect
const active = ["preflight", "ready", "running", "cancel_requested"] as const
export const OWNER_LEASE_MS = 30_000

export const get = Effect.fn("ImportJob.get")(function* (id: string) {
  const database = yield* Database.Service
  return yield* database.db
    .select()
    .from(ImportJobTable)
    .where(and(eq(ImportJobTable.job_id, id), eq(ImportJobTable.operator_id, "server")))
    .get()
    .pipe(Effect.orDie)
})

export function info(row: Row, now = Date.now()): ImportJobSchema.Info {
  const lost =
    !ImportJobSchema.terminal(row.state) && row.owner_lease_expires_at !== null && row.owner_lease_expires_at <= now
  return {
    id: row.job_id,
    requestID: row.request_id,
    source: row.request.source,
    state: lost ? "recovery_required" : row.state,
    revision: row.revision,
    dryRun: row.request.dryRun ?? false,
    scopes: row.request.scopes ?? ["session"],
    ...(row.target ? { target: row.target } : {}),
    ...(row.source_digest ? { sourceDigest: row.source_digest } : {}),
    totalSessions: row.total_sessions,
    committedBatches: row.committed_batches,
    failedBatches: row.failed_batches,
    ...(row.active_batch_id ? { activeBatchID: row.active_batch_id } : {}),
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }),
    ...(row.stop_confirmed_at === null ? {} : { stopConfirmedAt: row.stop_confirmed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(lost
      ? {
          error: {
            code: "IMPORT_OWNER_UNAVAILABLE",
            message: "The import owner stopped reporting progress. Querying does not resume or retry this job.",
          },
        }
      : row.error_code
        ? { error: { code: row.error_code, message: row.error_detail ?? row.error_code } }
        : {}),
  }
}

export const list = Effect.fn("ImportJob.list")(function* (input: { cursor?: string; limit?: number } = {}) {
  const database = yield* Database.Service
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))
    return yield* new ImportJobSchema.Error({
      code: "invalid_request",
      message: "Import job limit must be an integer from 1 to 100",
    })
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))
  const cursor = input.cursor?.split(":")
  if (cursor && (cursor.length !== 2 || !/^\d+$/.test(cursor[0]!) || !/^[a-zA-Z0-9_-]+$/.test(cursor[1]!)))
    return yield* new ImportJobSchema.Error({ code: "invalid_request", message: "Invalid import job cursor" })
  const rows = yield* database.db
    .select()
    .from(ImportJobTable)
    .where(
      and(
        eq(ImportJobTable.operator_id, "server"),
        cursor
          ? or(
              lt(ImportJobTable.created_at, Number(cursor[0])),
              and(eq(ImportJobTable.created_at, Number(cursor[0])), lt(ImportJobTable.job_id, cursor[1]!)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(ImportJobTable.created_at), desc(ImportJobTable.job_id))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items: items.map((row) => info(row)),
    ...(rows.length > limit && last ? { cursor: `${last.created_at}:${last.job_id}` } : {}),
  }
})

export const create = Effect.fn("ImportJob.create")(function* (input: {
  id: string
  request: ImportJobSchema.Request
  digest: string
  targetKey: string
  migrationDigest: string
  ownerID: string
}) {
  const database = yield* Database.Service
  if (database.mode) DatabaseMode.ensureReady(database.mode)
  return yield* database.db.transaction(
    () =>
      Effect.gen(function* () {
        const prior = yield* database.db
          .select()
          .from(ImportJobTable)
          .where(and(eq(ImportJobTable.operator_id, "server"), eq(ImportJobTable.request_id, input.request.requestID)))
          .get()
        if (prior) {
          if (prior.request_digest !== input.digest)
            return yield* new ImportJobSchema.Error({
              code: "conflict",
              message:
                "IMPORT_REQUEST_CONFLICT: requestID already belongs to different source, target, confirmation, configuration or migration content",
            })
          return { row: prior, created: false }
        }
        const conflict = yield* database.db
          .select({ id: ImportJobTable.job_id })
          .from(ImportJobTable)
          .where(
            and(
              eq(ImportJobTable.target_key, input.targetKey),
              inArray(ImportJobTable.state, [...active, "recovery_required"]),
            ),
          )
          .get()
        if (conflict)
          return yield* new ImportJobSchema.Error({
            code: "conflict",
            message: `IMPORT_TARGET_BUSY: target belongs to import ${conflict.id}`,
          })
        const now = Date.now()
        const row = yield* database.db
          .insert(ImportJobTable)
          .values({
            job_id: input.id,
            operator_id: "server",
            request_id: input.request.requestID,
            request_digest: input.digest,
            request: input.request,
            target_key: input.targetKey,
            state: "preflight",
            revision: 0,
            source_format_revision: 1,
            total_sessions: 0,
            migration_digest: input.migrationDigest,
            owner_id: input.ownerID,
            owner_lease_expires_at: now + OWNER_LEASE_MS,
            committed_batches: 0,
            failed_batches: 0,
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get()
        if (!row) return yield* Effect.die("Import job insert returned no row")
        return { row, created: true }
      }),
    { behavior: "immediate" },
  )
})

export const update = Effect.fn("ImportJob.update")(function* (input: {
  id: string
  ownerID: string
  revision: number
  states?: readonly ImportJobSchema.State[]
  patch: Partial<
    Omit<typeof ImportJobTable.$inferInsert, "job_id" | "operator_id" | "request_id" | "request_digest" | "request">
  >
}) {
  const database = yield* Database.Service
  if (database.mode) DatabaseMode.ensureReady(database.mode)
  return yield* database.db
    .update(ImportJobTable)
    .set({ ...input.patch, revision: sql`${ImportJobTable.revision} + 1`, updated_at: Date.now() })
    .where(
      and(
        eq(ImportJobTable.job_id, input.id),
        eq(ImportJobTable.operator_id, "server"),
        eq(ImportJobTable.owner_id, input.ownerID),
        eq(ImportJobTable.revision, input.revision),
        gt(ImportJobTable.owner_lease_expires_at, Date.now()),
        inArray(ImportJobTable.state, [...(input.states ?? active)]),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
})

export const beginBatch = Effect.fn("ImportJob.beginBatch")(function* (input: {
  id: string
  ownerID: string
  revision: number
  batchID: string
}) {
  const database = yield* Database.Service
  if (database.mode) DatabaseMode.ensureReady(database.mode)
  return yield* database.db
    .update(ImportJobTable)
    .set({
      active_batch_id: input.batchID,
      revision: sql`${ImportJobTable.revision} + 1`,
      updated_at: Date.now(),
    })
    .where(
      and(
        eq(ImportJobTable.job_id, input.id),
        eq(ImportJobTable.owner_id, input.ownerID),
        eq(ImportJobTable.revision, input.revision),
        gt(ImportJobTable.owner_lease_expires_at, Date.now()),
        eq(ImportJobTable.state, "running"),
        isNull(ImportJobTable.cancel_requested_at),
        isNull(ImportJobTable.active_batch_id),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
})

export const requestCancel = Effect.fn("ImportJob.requestCancel")(function* (id: string) {
  const database = yield* Database.Service
  if (database.mode) DatabaseMode.ensureReady(database.mode)
  return yield* database.db.transaction(
    () =>
      Effect.gen(function* () {
        const row = yield* get(id)
        if (!row) return yield* new ImportJobSchema.Error({ code: "not_found", message: "Import job does not exist" })
        if ((ImportJobSchema.terminal(row.state) && row.state !== "recovery_required") ||
          (row.cancel_requested_at !== null && row.state !== "recovery_required")) return row
        const now = Date.now()
        return (yield* database.db
          .update(ImportJobTable)
          .set({ state: "cancel_requested", cancel_requested_at: now, updated_at: now, revision: row.revision + 1 })
          .where(and(eq(ImportJobTable.job_id, id), eq(ImportJobTable.revision, row.revision)))
          .returning()
          .get())!
      }),
    { behavior: "immediate" },
  )
})

/** Read-only destination evidence. Never opens a migration or business writer. */
export const receipts = Effect.fn("ImportJob.receipts")(function* (input: {
  filename: string
  jobID: string
  sourceDigest?: string
  includeResults?: boolean
}) {
  return yield* Effect.tryPromise(async () => {
    const { Database } = await import("#sqlite-native")
    const db = new Database(input.filename, { create: false, readonly: true })
    try {
      db.run("PRAGMA query_only = ON")
      const rows = db
        .query(
          "SELECT batch_id, source_digest, result FROM import_batch_receipt WHERE job_id = ? ORDER BY committed_at, batch_id",
        )
        .all(input.jobID) as { batch_id: string; source_digest: string; result: string }[]
      if (input.sourceDigest && rows.some((row) => row.source_digest !== input.sourceDigest))
        throw new Error("IMPORT_RECEIPT_CONFLICT: source digest differs from the frozen job snapshot")
      const results = rows.map((row) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(ImportJobSchema.BatchResult), { onExcessProperty: "error" })(row.result))
      return {
        count: rows.length,
        batchIDs: rows.map((row) => row.batch_id),
        results: input.includeResults
          ? results.filter((result): result is ImportJobSchema.SessionResult => !("kind" in result))
          : [],
        fileResults: input.includeResults
          ? results.filter((result): result is ImportJobSchema.FileSetResult => "kind" in result)
          : [],
      }
    } finally {
      db.close()
    }
  })
})

/** Explicit control caller must hold the target flock before reconciling a dead owner.
 * This can settle existing receipt evidence; it cannot renew an owner or admit work.
 */
export const confirmStopped = Effect.fn("ImportJob.confirmStopped")(function* (input: {
  id: string
  revision: number
  count: number
  known: boolean
  preparation?: boolean
}) {
  const database = yield* Database.Service
  if (database.mode) DatabaseMode.ensureReady(database.mode)
  const now = Date.now()
  return yield* database.db
    .update(ImportJobTable)
    .set({
      state: input.known ? (input.count > 0 ? "cancelled_partial" : "cancelled") : "recovery_required",
      committed_batches: input.count,
      settled_at: now,
      updated_at: now,
      revision: input.revision + 1,
      owner_lease_expires_at: null,
      ...(input.known
        ? { stop_confirmed_at: now, active_batch_id: null }
        : {
            error_code: input.preparation ? "IMPORT_TARGET_PREPARATION_UNKNOWN" : "IMPORT_RECEIPT_UNAVAILABLE",
            error_detail: input.preparation
              ? "Owner disappeared while preparing the destination; no stop was confirmed or import replayed"
              : "Stopped owner has unverifiable destination receipts",
          }),
    })
    .where(
      and(
        eq(ImportJobTable.job_id, input.id),
        eq(ImportJobTable.operator_id, "server"),
        eq(ImportJobTable.revision, input.revision),
        eq(ImportJobTable.state, "cancel_requested"),
        or(isNull(ImportJobTable.owner_lease_expires_at), lt(ImportJobTable.owner_lease_expires_at, now + 1)),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
})

/** Serialize cold-stop confirmation with any physical destination batch. This opens
 * an existing DB only, without running migrations or admitting replacement work.
 */
export const withDestinationFence = <A>(filename: string,
  settle: (target: InstanceType<typeof import("#sqlite-native").Database>) => Promise<A>) =>
  Effect.tryPromise(async () => {
    const { Database } = await import("#sqlite-native")
    const target = new Database(filename, { create: false, readwrite: true })
    try {
      target.run("BEGIN IMMEDIATE")
      const result = await settle(target)
      target.run("COMMIT")
      return result
    } finally {
      target.close()
    }
  // SQLite and native filesystem promises cannot be cancelled. Keep the owner's
  // physical fence and outer flock until COMMIT/close, even if its caller times out.
  }).pipe(Effect.uninterruptible)

/** Must run inside the destination batch transaction, after its writer lock is held. */
export const assertBatchAuthority = Effect.fn("ImportJob.assertBatchAuthority")(function* (input: {
  id: string
  ownerID: string
  batchID: string
}) {
  const current = yield* get(input.id)
  if (
    !current ||
    current.owner_id !== input.ownerID ||
    (current.owner_lease_expires_at ?? 0) <= Date.now() ||
    current.cancel_requested_at !== null ||
    current.state !== "running" ||
    current.active_batch_id !== input.batchID
  )
    return yield* Effect.fail(new Error("IMPORT_BATCH_AUTHORITY_LOST: late, expired or cancelled batch cannot write"))
})
