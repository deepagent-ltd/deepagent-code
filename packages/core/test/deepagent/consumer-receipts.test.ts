import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { consumerReceiptMigration } from "@deepagent-code/core/deepagent/consumer-receipt-sql"

// C5-10 — per-consumer side-effect receipts: durable idempotency (run once per (consumer, sourceEvent)),
// redelivery → typed existing, sink failure → pending stays (E3 retry), cold recovery → no re-exec.

type Db = Database.Interface["db"]

function run<A, E>(code: (db: Db) => Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [consumerReceiptMigration])
      return yield* code(db)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

const refusalOf = <A>(effect: Effect.Effect<A, ConsumerReceipts.ConsumerReceiptError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

describe("C5-10 per-consumer side-effect receipts", () => {
  test("first delivery executes the side effect and records a `done` receipt", async () => {
    await run((db) =>
      Effect.gen(function* () {
        let ran = 0
        const result = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: "goal_tick",
          sourceEventId: "ev-tick-1",
          sideEffect: Effect.sync(() => {
            ran++
          }),
          now: 10,
        })
        expect(result.kind).toBe("executed")
        if (result.kind !== "executed") return
        expect(result.receipt.status).toBe("done")
        expect(result.receipt.attempts).toBe(1)
        expect(result.receipt.receiptRef).toMatch(/^[0-9a-f]{64}$/)
        expect(ran).toBe(1)
      }),
    )
  })

  test("redelivery → typed `existing`; the side effect runs EXACTLY ONCE (spy)", async () => {
    await run((db) =>
      Effect.gen(function* () {
        let ran = 0
        const sideEffect = Effect.sync(() => {
          ran++
        })
        const first = yield* ConsumerReceipts.runOnce(db, { consumerKind: "handoff", sourceEventId: "ev-ho-1", sideEffect, now: 10 })
        expect(first.kind).toBe("executed")
        expect(ran).toBe(1)
        // Redelivery of the same (consumer, sourceEvent) → the durable receipt says done → no re-run.
        const again = yield* ConsumerReceipts.runOnce(db, { consumerKind: "handoff", sourceEventId: "ev-ho-1", sideEffect, now: 20 })
        expect(again.kind).toBe("existing")
        if (again.kind !== "existing") return
        expect(again.receipt.status).toBe("done")
        expect(ran).toBe(1)
      }),
    )
  })

  test("per-consumer key isolation: different consumers of the same event each run once", async () => {
    await run((db) =>
      Effect.gen(function* () {
        let goalRan = 0
        let pushRan = 0
        const a = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: "goal_tick",
          sourceEventId: "ev-shared",
          sideEffect: Effect.sync(() => {
            goalRan++
          }),
          now: 10,
        })
        const b = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: "push",
          sourceEventId: "ev-shared",
          sideEffect: Effect.sync(() => {
            pushRan++
          }),
          now: 10,
        })
        expect(a.kind).toBe("executed")
        expect(b.kind).toBe("executed")
        expect(goalRan).toBe(1)
        expect(pushRan).toBe(1)
      }),
    )
  })

  test("sink failure → the receipt stays `pending` (E3 retry semantics) and can resume", async () => {
    await run((db) =>
      Effect.gen(function* () {
        let attempts = 0
        const failing = Effect.gen(function* () {
          attempts++
          if (attempts === 1) return yield* Effect.fail(new Error("sink boom"))
          return undefined
        })
        // First delivery fails → typed refusal, receipt stays pending.
        const err = yield* refusalOf(
          ConsumerReceipts.runOnce(db, { consumerKind: "archive", sourceEventId: "ev-ar-1", sideEffect: failing, now: 10 }),
        )
        expect(err?.reason).toBe("sink_failed")
        const pending = yield* ConsumerReceipts.receiptFor(db, "archive", "ev-ar-1")
        expect(pending?.status).toBe("pending")
        expect(pending?.attempts).toBe(1)
        // E3 retry resumes the same pending receipt; the sink succeeds → done.
        const retry = yield* ConsumerReceipts.runOnce(db, { consumerKind: "archive", sourceEventId: "ev-ar-1", sideEffect: failing, now: 20 })
        expect(retry.kind).toBe("executed")
        if (retry.kind !== "executed") return
        expect(retry.receipt.status).toBe("done")
        expect(retry.receipt.attempts).toBe(2)
      }),
    )
  })

  test("cold recovery: after a simulated restart a done receipt is NOT re-executed", async () => {
    const fs = await import("node:fs/promises")
    const dir = await fs.mkdtemp("/tmp/dsh-c510-")
    const path = `${dir}/db.sqlite`
    const ensure = (db: Db) =>
      db
        .run(
          sql`CREATE TABLE IF NOT EXISTS \`deepagent_consumer_receipt\` (
            \`consumer_kind\` text NOT NULL,
            \`source_event_id\` text NOT NULL,
            \`status\` text NOT NULL,
            \`attempts\` integer NOT NULL DEFAULT 0,
            \`last_error\` text,
            \`receipt_ref\` text,
            \`created_at\` integer NOT NULL,
            \`updated_at\` integer NOT NULL,
            \`resolved_at\` integer,
            CONSTRAINT \`deepagent_consumer_receipt_pk\` PRIMARY KEY(\`consumer_kind\`, \`source_event_id\`)
          )`,
        )
        .pipe(Effect.orDie)
    let ran = 0
    const sideEffect = Effect.sync(() => {
      ran++
    })
    // Layer 1: complete the side effect.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* ensure(db)
        const r = yield* ConsumerReceipts.runOnce(db, { consumerKind: "panel", sourceEventId: "ev-pn-1", sideEffect, now: 5 })
        expect(r.kind).toBe("executed")
        expect(ran).toBe(1)
      }).pipe(Effect.provide(Database.layerFromPath(path)), Effect.scoped),
    )
    // Layer 2: simulated restart — the durable receipt restores and the done receipt is not re-run.
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* ensure(db)
        return yield* ConsumerReceipts.runOnce(db, { consumerKind: "panel", sourceEventId: "ev-pn-1", sideEffect, now: 6 })
      }).pipe(Effect.provide(Database.layerFromPath(path)), Effect.scoped),
    )
    expect(recovered.kind).toBe("existing")
    expect(ran).toBe(1)
  })

  test("invalid input (empty consumer kind) is a typed refusal", async () => {
    await run((db) =>
      Effect.gen(function* () {
        const err = yield* refusalOf(
          ConsumerReceipts.runOnce(db, { consumerKind: "", sourceEventId: "ev-x", sideEffect: Effect.sync(() => {}), now: 1 }),
        )
        expect(err?.reason).toBe("invalid_input")
      }),
    )
  })
})
