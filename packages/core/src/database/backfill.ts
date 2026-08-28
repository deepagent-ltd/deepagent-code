export * as Backfill from "./backfill"

import { sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { statfs } from "fs/promises"

// C1A-09 batched backfill. A large backfill runs in BOUNDED batches, each in its own small
// transaction, so a batch never holds a large schema/write lock for an unbounded time (design §10.6
// "backfill 有明确上界或分批 receipt；大型 backfill 不能长时间占用一个无进度事务"). Each completed
// batch is durably recorded in `database_backfill_progress` (a separate, idempotently-created table),
// so a crash or cancel at a batch boundary resumes from the NEXT batch without re-applying completed
// batches or duplicating work.
//
// Schema decision: per-batch progress lives in a NEW `database_backfill_progress` table created via
// ensureTables (CREATE TABLE IF NOT EXISTS, so an existing production DB gets it on next startup) and
// NOT in the content-addressed `database_migration_receipt` table. Reusing that table's
// result='backfilled' would collide with the migration's own registry-ordinal 'applied' receipt under
// UNIQUE(run_id, migration_id, ordinal), and a separate table lets cancel-then-resume skip completed
// batch indices deterministically. No migration body was added (that would move the apply boundary).

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export class BackfillSpaceBudgetExceeded extends Data.TaggedError("Backfill.BackfillSpaceBudgetExceeded")<{
  readonly freeBytes: number
  readonly requiredBytes: number
}> {}

export class BackfillCancelled extends Data.TaggedError("Backfill.BackfillCancelled")<{
  readonly completedBatches: number
  readonly processedRows: number
}> {}

/**
 * Injectable cancellation: a plain mutable `{ cancelled: boolean }` object (flip to true to stop at
 * the next batch boundary) or an `AbortSignal`. Never throws mid-batch; cancel is only observed
 * BETWEEN batches so the run is always at a durable batch boundary when it stops.
 */
export type CancelToken = { cancelled: boolean } | AbortSignal

export type BatchSpec = {
  /** The position this batch starts at (e.g. primary-key offset / last-processed key). */
  readonly offset: number
  /** Number of rows this batch will process (for progress reporting). */
  readonly rows: number
}

export type BatchedBackfillInput = {
  readonly runId: string
  readonly migrationId: string
  /** File path used to compute free space via statfs. Omitted / ":memory:" skips the budget check. */
  readonly filename?: string
  readonly batchSize: number
  /** Minimum free bytes required BEFORE the backfill starts. Default 64 MiB. */
  readonly spaceBudgetBytes?: number
  readonly cancelToken?: CancelToken
  /** Returns the next batch starting at `offset`, or null when the work is complete. */
  readonly nextBatch: (offset: number, batchSize: number) => Effect.Effect<BatchSpec | null, unknown>
  /** Applies one batch of rows inside `tx`. Must be safe to re-run (idempotent) for a resumed batch. */
  readonly applyBatch: (tx: Transaction, batch: BatchSpec) => Effect.Effect<void, unknown>
}

export type BackfillOutcome = {
  /** Whether the loop stopped because the cancel token flipped between batches. */
  readonly cancelled: boolean
  readonly completedBatches: number
  readonly processedRows: number
}

type ProgressRow = {
  batch_index: number
  offset: number
  processed_rows: number
  state: string
}

/** Create the idempotent per-batch progress table (existing DBs get it on next startup). */
export function ensureTables(db: Database) {
  return db.run(sql`
    CREATE TABLE IF NOT EXISTS database_backfill_progress (
      run_id TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      offset INTEGER NOT NULL,
      processed_rows INTEGER NOT NULL CHECK (processed_rows >= 0),
      state TEXT NOT NULL CHECK (state IN ('completed', 'in_progress')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, migration_id, batch_index)
    )
  `)
}

const isCancelled = (token?: CancelToken): boolean => {
  if (!token) return false
  if ("cancelled" in token) return token.cancelled
  return token.aborted
}

/** Completed progress rows for a (run, migration) backfill, ordered by batch_index. */
function loadCompletedProgress(db: Database, runId: string, migrationId: string) {
  return Effect.gen(function* () {
    return yield* db.all<ProgressRow>(sql`
      SELECT batch_index, offset, processed_rows, state
      FROM database_backfill_progress
      WHERE run_id = ${runId} AND migration_id = ${migrationId} AND state = 'completed'
      ORDER BY batch_index ASC
    `).pipe(Effect.orDie)
  })
}

const freeSpaceBytes = (filename: string) =>
  Effect.tryPromise({
    try: async () => {
      const status = await statfs(filename)
      return Number(status.bsize) * Number(status.bavail)
    },
    catch: (error) => new BackfillSpaceBudgetExceeded({ freeBytes: 0, requiredBytes: Number.MAX_SAFE_INTEGER }),
  })

/**
 * Run a bounded, resumable batch backfill. Never holds a single unbounded transaction, writes
 * durable per-batch progress, checks the filesystem space budget before starting, and observes
 * cancellation ONLY between batches. A cancelled run stays at a batch boundary; a later call resumes
 * from the next uncompleted batch (completed batches are skipped, never re-applied).
 */
export function runBatchedBackfill(db: Database, input: BatchedBackfillInput) {
  return Effect.gen(function* () {
    yield* ensureTables(db)

    // Space budget BEFORE starting (design §10.6): refuse a backfill that cannot make progress.
    if (input.filename && input.filename !== ":memory:") {
      const budget = input.spaceBudgetBytes ?? 64 * 1024 * 1024
      const free = yield* freeSpaceBytes(input.filename)
      if (free < budget) return yield* Effect.fail(new BackfillSpaceBudgetExceeded({ freeBytes: free, requiredBytes: budget }))
    }

    // Resume state: the cursor is one past the end of the last completed batch; the next batch index
    // continues the monotonic counter, never re-using a completed index.
    const completed = yield* loadCompletedProgress(db, input.runId, input.migrationId)
    let cursor = completed.reduce((max, row) => Math.max(max, row.offset + row.processed_rows), 0)
    let batchIndex = completed.length
    let processedRows = completed.reduce((total, row) => total + row.processed_rows, 0)

    while (true) {
      if (isCancelled(input.cancelToken)) return { cancelled: true, completedBatches: batchIndex, processedRows }
      const batch = yield* input.nextBatch(cursor, input.batchSize)
      if (batch === null) return { cancelled: false, completedBatches: batchIndex, processedRows }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              INSERT INTO database_backfill_progress (run_id, migration_id, batch_index, offset, processed_rows, state, updated_at)
              VALUES (${input.runId}, ${input.migrationId}, ${batchIndex}, ${batch.offset}, 0, 'in_progress', ${Date.now()})
            `)
            yield* input.applyBatch(tx, batch)
            yield* tx.run(sql`
              UPDATE database_backfill_progress
              SET state = 'completed', processed_rows = ${batch.rows}, updated_at = ${Date.now()}
              WHERE run_id = ${input.runId} AND migration_id = ${input.migrationId} AND batch_index = ${batchIndex}
            `)
          }),
        )
        .pipe(Effect.orDie)
      cursor = batch.offset + batch.rows
      processedRows += batch.rows
      batchIndex += 1
    }
  })
}
