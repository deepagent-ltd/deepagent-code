export * as SessionStore from "./store"

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm"
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
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  /** Clears suspension, reporting whether this caller consumed it. At most one concurrent caller receives true. */
  readonly consumeSuspended: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly suspend: (sessionIDs: Iterable<SessionSchema.ID>) => Effect.Effect<void>
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
      consumeSuspended: Effect.fn("SessionStore.consumeSuspended")(function* (sessionID) {
        return (
          (yield* db
            .update(SessionTable)
            .set({ time_suspended: null })
            .where(and(eq(SessionTable.id, sessionID), isNotNull(SessionTable.time_suspended)))
            .returning({ sessionID: SessionTable.id })
            .get()
            .pipe(Effect.orDie)) !== undefined
        )
      }),
      suspend: Effect.fn("SessionStore.suspend")(function* (sessionIDs) {
        const ids = Array.from(sessionIDs)
        if (ids.length === 0) return
        yield* db
          .update(SessionTable)
          .set({ time_suspended: Date.now() })
          .where(and(inArray(SessionTable.id, ids), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
