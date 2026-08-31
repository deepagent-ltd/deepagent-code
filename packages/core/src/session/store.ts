export * as SessionStore from "./store"

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  /** Lists durable execution claims. Recovery must classify them before any provider work may resume. */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  /**
   * Records write-ahead intent before a process-local execution starts. AUTH-P2-4 close: this is a
   * CONDITIONAL UPDATE (CAS — `WHERE time_suspended IS NULL`), and the effect reports whether the
   * claim won (`true`) or the session was already suspended (`false`). The CAS itself is the fence
   * (SQLite serializes writers); cross-process handoff is a future design — the boundary is
   * process-local coordination.
   */
  readonly claim: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Releases the execution claim; `true` when the release transitioned a suspended session back. */
  readonly release: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(isNotNull(SessionTable.time_suspended))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID) {
        // CAS: the conditional UPDATE (WHERE time_suspended IS NULL) is the fence — SQLite
        // serializes writers, so exactly one claimant transitions null -> <our token>. The
        // wrapped .run() discards changes, so we write a per-call UNIQUE token and read it
        // back: matching our token => this call won; anything else => already claimed.
        const token = Date.now() * 1000 + claimSeq++
        yield* db
          .update(SessionTable)
          .set({ time_suspended: token, time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
        const row = yield* db
          .select({ time_suspended: SessionTable.time_suspended })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return row?.time_suspended === token
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID) {
        yield* db
          .update(SessionTable)
          .set({ time_suspended: null, time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), isNotNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
        const row = yield* db
          .select({ time_suspended: SessionTable.time_suspended })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return row?.time_suspended === null
      }),
    })
  }),
)

let claimSeq = 0

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
