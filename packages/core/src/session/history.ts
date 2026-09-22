import { and, asc, desc, eq, gt, gte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: 2 },
  )
  return yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq), decodeMessageRow)
})

/**
 * W-02 M-1 — the FULL-history variant of the loader. `load` returns the active context (rows from
 * the latest compaction onward); a batch MD export must read every durable message of the session
 * instead, so this walks the whole ordered journal with the same decode path. Compaction rows are
 * included so the exporter can render checkpoint markers.
 */
export const loadAll = Effect.fn("SessionHistory.loadAll")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(rows, decodeMessageRow)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export * as SessionHistory from "./history"
