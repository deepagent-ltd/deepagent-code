export * as V2TaskRunReceipt from "./v2-task-run-receipt"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../../database/database"
import { Identifier } from "../../id/id"
import { V2TaskRunReceiptTable } from "./v2-task-run-receipt.sql"

type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

export type TaskRunReceipt = {
  readonly receiptId: string
  readonly sessionId: string
  readonly runId: string
  readonly childSessionId: string
  readonly generation: number
  readonly state: "completed" | "failed" | "cancelled" | "interrupted" | "closed"
  readonly reason: string
  readonly outcomeHash: string
  readonly ownerToken: string
  readonly timeCreated: number
}

export type RecordInput = {
  readonly sessionId: string
  readonly runId: string
  readonly childSessionId: string
  readonly generation: number
  readonly state: TaskRunReceipt["state"]
  readonly reason: string
  readonly outcomeHash: string
  readonly ownerToken: string
  readonly now: number
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("V2TaskRunReceipt.ConflictError", {
  reason: Schema.String,
}) {}

// Optional capability seam: compositions wired for the V2 capability port provide a recorder and
// settleTaskRun records the compensation receipt inside its own settlement transaction. Default
// undefined keeps unwired compositions receipt-less without writing legacy state.
export const CurrentTaskRunTerminalRecorder = Context.Reference<
  | ((tx: Transaction, input: RecordInput) => Effect.Effect<TaskRunReceipt, ConflictError>)
  | undefined
>("@deepagent-code/v2/TaskRunReceipt/CurrentTaskRunTerminalRecorder", { defaultValue: () => undefined })

export function recordInTransaction(tx: Transaction, input: RecordInput): Effect.Effect<TaskRunReceipt, ConflictError> {
  return Effect.gen(function* () {
    const existing = yield* tx
      .select()
      .from(V2TaskRunReceiptTable)
      .where(eq(V2TaskRunReceiptTable.run_id, input.runId))
      .get()
      .pipe(Effect.orDie)
    // Exact re-settlement converges on identical evidence; any divergence is a conflict and
    // never overwrites the recorded terminal outcome. Session/child/owner identity is implied by
    // the run key itself, so only the terminal evidence participates in the comparison.
    if (existing) {
      if (
        existing.state !== input.state ||
        existing.reason !== input.reason ||
        existing.outcome_hash !== input.outcomeHash ||
        existing.generation !== input.generation
      )
        return yield* new ConflictError({ reason: "task_run_receipt_outcome_divergence" })
      return fromRow(existing)
    }
    const receipt: TaskRunReceipt = {
      receiptId: Identifier.ascending("job"),
      sessionId: input.sessionId,
      runId: input.runId,
      childSessionId: input.childSessionId,
      generation: input.generation,
      state: input.state,
      reason: input.reason,
      outcomeHash: input.outcomeHash,
      ownerToken: input.ownerToken,
      timeCreated: input.now,
    }
    yield* tx
      .insert(V2TaskRunReceiptTable)
      .values({
        receipt_id: receipt.receiptId,
        session_id: receipt.sessionId,
        run_id: receipt.runId,
        child_session_id: receipt.childSessionId,
        generation: receipt.generation,
        state: receipt.state,
        reason: receipt.reason,
        outcome_hash: receipt.outcomeHash,
        owner_token: receipt.ownerToken,
        time_created: receipt.timeCreated,
      })
      .run()
      .pipe(Effect.orDie)
    return receipt
  })
}

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<TaskRunReceipt, ConflictError>
  readonly listForSession: (sessionId: string) => Effect.Effect<readonly TaskRunReceipt[], never>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/TaskRunReceipt") {}

function fromRow(row: typeof V2TaskRunReceiptTable.$inferSelect): TaskRunReceipt {
  return {
    receiptId: row.receipt_id,
    sessionId: row.session_id,
    runId: row.run_id,
    childSessionId: row.child_session_id,
    generation: row.generation,
    state: row.state,
    reason: row.reason,
    outcomeHash: row.outcome_hash,
    ownerToken: row.owner_token,
    timeCreated: row.time_created,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    return {
      record: (input) =>
        db.transaction((tx) => recordInTransaction(tx, input), { behavior: "immediate" }).pipe(
          // Typed divergence stays catchable; SQL failures are defects.
          Effect.catchIf((error) => !(error instanceof ConflictError), (error) => Effect.die(error)),
        ),
      listForSession: (sessionId) =>
        db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.session_id, sessionId))
          .all()
          .pipe(Effect.map((rows) => rows.map(fromRow)), Effect.orDie),
    }
  }),
)
