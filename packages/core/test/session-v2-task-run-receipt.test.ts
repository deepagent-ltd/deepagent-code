import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { V2TaskRunReceipt } from "../src/session/runner/v2-task-run-receipt"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const receipts = V2TaskRunReceipt.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, receipts))

const record = (service: V2TaskRunReceipt.Interface, overrides: Record<string, unknown> = {}) =>
  service.record({
    sessionId: "ses_task_receipt",
    runId: "run_task_receipt",
    childSessionId: "ses_child_task_receipt",
    generation: 1,
    state: "completed",
    reason: "task_completed",
    outcomeHash: "a".repeat(64),
    ownerToken: "owner_task_receipt",
    now: 1_000,
    ...overrides,
  })

describe("V2 task run receipt authority", () => {
  it.effect("records exactly one terminal receipt per settled run", () =>
    Effect.gen(function* () {
      const service = yield* V2TaskRunReceipt.Service
      const receipt = yield* record(service)
      expect(receipt).toMatchObject({
        sessionId: "ses_task_receipt",
        runId: "run_task_receipt",
        state: "completed",
        reason: "task_completed",
        generation: 1,
      })
      expect(yield* service.listForSession("ses_task_receipt")).toHaveLength(1)
    }),
  )

  it.effect("converges exact re-settlement and refuses divergent outcomes", () =>
    Effect.gen(function* () {
      const service = yield* V2TaskRunReceipt.Service
      const first = yield* record(service)
      expect((yield* record(service)).receiptId).toBe(first.receiptId)
      const outcome = (overrides: Record<string, unknown>) =>
        record(service, overrides).pipe(
          Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
        )
      // A divergent terminal reason for the same run is a typed conflict, never an overwrite,
      // and the typed error survives the service boundary.
      expect(yield* outcome({ reason: "task_cancelled" })).toBeInstanceOf(V2TaskRunReceipt.ConflictError)
      // Every compared evidence field diverges independently.
      expect(yield* outcome({ state: "failed" })).toBeInstanceOf(V2TaskRunReceipt.ConflictError)
      expect(yield* outcome({ outcomeHash: "b".repeat(64) })).toBeInstanceOf(V2TaskRunReceipt.ConflictError)
      // A divergent generation is equally a conflict.
      expect(yield* outcome({ generation: 2 })).toBeInstanceOf(V2TaskRunReceipt.ConflictError)
      expect(yield* service.listForSession("ses_task_receipt")).toHaveLength(1)
    }),
  )

  it.effect("admits only terminal states with valid evidence", () =>
    Effect.gen(function* () {
      const databaseService = yield* Database.Service
      const reject = (values: string) =>
        databaseService.db.run(sql`
        INSERT INTO session_v2_task_run_receipt (
          receipt_id, session_id, run_id, child_session_id, generation, state, reason, outcome_hash,
          owner_token, time_created
        ) VALUES ${sql.raw(`(${values})`)}
      `).pipe(Effect.exit)
      const base = "'ses_task_receipt', 'run_guard', 'ses_child_guard'"
      const hash = `'${"c".repeat(64)}'`
      // non-terminal state
      expect((yield* reject(`'r1', ${base}, 1, 'running', 'reason', ${hash}, 'o', 1`))._tag).toBe("Failure")
      // blank reason
      expect((yield* reject(`'r2', ${base}, 1, 'completed', ' ', ${hash}, 'o', 1`))._tag).toBe("Failure")
      // uppercase outcome hash
      expect((yield* reject(`'r3', ${base}, 1, 'completed', 'reason', '${"C".repeat(64)}', 'o', 1`))._tag).toBe(
        "Failure",
      )
      // zero generation
      expect((yield* reject(`'r4', ${base}, 0, 'completed', 'reason', ${hash}, 'o', 1`))._tag).toBe("Failure")
      // short outcome hash
      expect((yield* reject(`'r5', ${base}, 1, 'completed', 'reason', '${"d".repeat(63)}', 'o', 1`))._tag).toBe(
        "Failure",
      )
      // non-hex outcome hash
      expect((yield* reject(`'r6', ${base}, 1, 'completed', 'reason', '${"e".repeat(63)}g', 'o', 1`))._tag).toBe(
        "Failure",
      )
      // blank child session
      expect(
        (yield* reject(`'r7', 'ses_task_receipt', 'run_guard_child', ' ', 1, 'completed', 'reason', ${hash}, 'o', 1`))
          ._tag,
      ).toBe("Failure")
      // valid row is admitted
      expect((yield* reject(`'r8', ${base}, 1, 'completed', 'reason', ${hash}, 'o', 1`))._tag).toBe("Success")
      // immutable
      expect(
        (
          yield* databaseService.db
            .run(sql`UPDATE session_v2_task_run_receipt SET reason = 'x' WHERE receipt_id = 'r8'`)
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")
      // append only
      expect(
        (
          yield* databaseService.db
            .run(sql`DELETE FROM session_v2_task_run_receipt WHERE receipt_id = 'r8'`)
            .pipe(Effect.exit)
        )._tag,
      ).toBe("Failure")
    }),
  )
})
