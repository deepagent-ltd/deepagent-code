// provider lifecycle gap C: durable provider-turn stage evidence.
// One row per (session_id, activity_id, turn_id) records the furthest stage a provider turn
// reached (claim -> snapshot -> history -> request -> dispatch -> settle), so a turn
// stuck between "legacy activity claimed" and "provider receipt created" can be
// attributed post-hoc. This is observability evidence, NOT an authority:
//  - every write is a single forward-only upsert (stage order never regresses),
//  - every write swallows its own failure — a turn must never die for evidence.
import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionTurnStageEvidenceTable, type TurnStage } from "./turn-stage-evidence.sql"

export namespace TurnStageEvidence {
  // Lifecycle order — index IS the forward-only ordering used by the upsert guard.
  export const Stages = [
    "activity_claimed",
    "snapshot_started",
    "snapshot_finished",
    "snapshot_degraded",
    "history_loaded",
    "request_prepared",
    "provider_dispatch_started",
    "terminal_settled",
  ] as const satisfies readonly TurnStage[]
  export type Stage = (typeof Stages)[number]

  export type Db = Database.Interface["db"]
  export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

  export interface RecordInput {
    readonly sessionID: string
    readonly activityID: string
    /** Unique identity of this provider turn; omitted only by legacy callers. */
    readonly turnID?: string
    readonly stage: Stage
    readonly details?: Record<string, unknown>
    readonly now?: number
  }

  export type Row = typeof SessionTurnStageEvidenceTable.$inferSelect

  const stageOrderCase = (column: string) =>
    `CASE ${column}` + Stages.map((stage, index) => ` WHEN '${stage}' THEN ${index}`).join("") + " ELSE -1 END"

  const upsertSql = (input: RecordInput, now: number) => {
    const details = input.details ? JSON.stringify(input.details) : null
    const stageAt = input.now ?? now
    const turnID = input.turnID ?? input.activityID
    return sql`
      INSERT INTO session_turn_stage_evidence (session_id, activity_id, turn_id, stage, details, stage_at, updated_at)
      VALUES (${input.sessionID}, ${input.activityID}, ${turnID}, ${input.stage}, ${details}, ${stageAt}, ${now})
      ON CONFLICT(session_id, activity_id, turn_id) DO UPDATE SET
        stage = excluded.stage,
        details = excluded.details,
        stage_at = excluded.stage_at,
        updated_at = excluded.updated_at
      WHERE ${sql.raw(stageOrderCase("excluded.stage"))} >=
            ${sql.raw(stageOrderCase("session_turn_stage_evidence.stage"))}
    `
  }

  const logFailure = (input: RecordInput) => (cause: Cause.Cause<unknown>) =>
    Effect.logWarning(`turn stage evidence write failed (${input.stage}, ${input.sessionID}): ${Cause.pretty(cause)}`)

  // Reuse the caller's transaction when one is already open at the boundary.
  export const recordInTransaction = (tx: Tx, input: RecordInput): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* tx.run(upsertSql(input, input.now ?? Date.now()))
    }).pipe(Effect.catchCause(logFailure(input)))

  // Standalone boundary (no enclosing transaction): one small independent write.
  export const record = (db: Db, input: RecordInput): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* db.run(upsertSql(input, input.now ?? Date.now()))
    }).pipe(Effect.catchCause(logFailure(input)))

  // Read paths (diagnostics) — errors propagate to the caller on purpose.
  export const latest = (
    db: Db,
    input: { readonly sessionID: string; readonly activityID?: string; readonly turnID?: string },
  ) =>
    db
      .select()
      .from(SessionTurnStageEvidenceTable)
      .where(
        and(
          eq(SessionTurnStageEvidenceTable.session_id, input.sessionID),
          ...(input.activityID ? [eq(SessionTurnStageEvidenceTable.activity_id, input.activityID)] : []),
          ...(input.turnID ? [eq(SessionTurnStageEvidenceTable.turn_id, input.turnID)] : []),
        ),
      )
      .orderBy(desc(SessionTurnStageEvidenceTable.updated_at))
      .get()

  export const recent = (
    db: Db,
    input: {
      readonly sessionID: string
      readonly activityID?: string
      readonly turnID?: string
      readonly limit?: number
    },
  ) =>
    db
      .select()
      .from(SessionTurnStageEvidenceTable)
      .where(
        and(
          eq(SessionTurnStageEvidenceTable.session_id, input.sessionID),
          ...(input.activityID ? [eq(SessionTurnStageEvidenceTable.activity_id, input.activityID)] : []),
          ...(input.turnID ? [eq(SessionTurnStageEvidenceTable.turn_id, input.turnID)] : []),
        ),
      )
      .orderBy(desc(SessionTurnStageEvidenceTable.updated_at))
      .limit(input.limit ?? 20)
      .all()
}
