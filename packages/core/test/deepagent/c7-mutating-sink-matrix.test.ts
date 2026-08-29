import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { receiptRefFor } from "@deepagent-code/core/deepagent/consumer-receipts"
import { tmpdir } from "../fixture/tmpdir"

// C7-04 — mutating tool/event side-effect sandbox matrix (user-authorized pause point; fixture
// only, append-only sandbox sink in a temp directory — never a production store or real repo).
// The production contract (design §12/§13): the sink is append-only AND keyed by effect identity
// (effect id + idempotency key + result hash), so a consumer redelivery (at-least-once receipt)
// can NEVER duplicate an EFFECT. Matrix dimensions: success + redelivery, sink failure, interrupt
// (SSE/timeout/cancel), process-kill (crash-then-retry). Every cell asserts ≤1 effect append.

type SinkRow = { effectId: string; idempotencyKey: string; resultHash: string }

/** Append-only sandbox sink with effect-idempotency (the production contract). */
const makeSink = async (dir: string) => {
  const file = path.join(dir, "sink.jsonl")
  const readAll = async (): Promise<SinkRow[]> => {
    try {
      const text = await fs.readFile(file, "utf8")
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SinkRow)
    } catch {
      return []
    }
  }
  return {
    file,
    append: async (row: SinkRow): Promise<boolean> => {
      const rows = await readAll()
      if (rows.some((existing) => existing.effectId === row.effectId)) return false // dedupe by effect identity
      await fs.appendFile(file, JSON.stringify(row) + "\n")
      return true
    },
    readAll,
  }
}

const runWithDb = <A>(body: (db: Database.Interface["db"]) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(Database.layerFromPath(":memory:"))
      const database = Context.get(ctx, Database.Service)
      return yield* body(database.db)
    }).pipe(Effect.scoped),
  )

describe("C7-04 mutating sink matrix (append-only, effect-idempotent)", () => {
  test("success + redelivery: the sink sees exactly ONE append", async () => {
    await using tmp = await tmpdir()
    const sink = await makeSink(tmp.path)
    const kind = "c7-sink" as const
    const key = receiptRefFor(kind, "evt-1")

    const outcome = await runWithDb((db) =>
      Effect.gen(function* () {
        const first = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-1",
          now: 1_000,
          sideEffect: Effect.promise(() => sink.append({ effectId: "effect-1", idempotencyKey: key, resultHash: "h1" })),
        })
        const second = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-1",
          now: 2_000,
          sideEffect: Effect.promise(() => sink.append({ effectId: "effect-1", idempotencyKey: key, resultHash: "h1" })),
        })
        return { first, second }
      }),
    )
    expect(outcome.first.kind).toBe("executed")
    expect(outcome.second.kind).toBe("existing") // redelivery is a no-op (done receipt)
    expect((await sink.readAll()).length).toBe(1)
  })

  test("sink failure: receipt stays pending, the retry re-runs, and the sink still has ONE effect append", async () => {
    await using tmp = await tmpdir()
    const sink = await makeSink(tmp.path)
    const kind = "c7-sink" as const
    const key = receiptRefFor(kind, "evt-2")

    const outcome = await runWithDb((db) =>
      Effect.gen(function* () {
        const first = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-2",
          now: 1_000,
          sideEffect: Effect.gen(function* () {
            yield* Effect.promise(() => sink.append({ effectId: "effect-2", idempotencyKey: key, resultHash: "h2" }))
            return yield* Effect.fail(new Error("sink burst"))
          }),
        }).pipe(Effect.exit)
        const second = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-2",
          now: 2_000,
          sideEffect: Effect.promise(() => sink.append({ effectId: "effect-2", idempotencyKey: key, resultHash: "h2" })),
        })
        return { first, second }
      }),
    )
    expect(outcome.first._tag).toBe("Failure") // side effect failed → receipt stays pending
    expect(outcome.second.kind).toBe("executed")
    expect((await sink.readAll()).length).toBe(1) // the sandbox sink deduped by effect identity
  })

  test("interrupt (SSE/timeout/cancel mid-effect): later delivery is absorbed by the sink (indeterminate NO replay of a duplicate effect)", async () => {
    await using tmp = await tmpdir()
    const sink = await makeSink(tmp.path)
    const kind = "c7-sink" as const
    const key = receiptRefFor(kind, "evt-3")

    const outcome = await runWithDb((db) =>
      Effect.gen(function* () {
        const interrupted = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-3",
          now: 1_000,
          sideEffect: Effect.gen(function* () {
            yield* Effect.promise(() => sink.append({ effectId: "effect-3", idempotencyKey: key, resultHash: "h3" }))
            return yield* Effect.interrupt
          }),
        }).pipe(Effect.exit)
        const resumed = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-3",
          now: 2_000,
          sideEffect: Effect.promise(() => sink.append({ effectId: "effect-3", idempotencyKey: key, resultHash: "h3" })),
        })
        return { interrupted, resumed }
      }),
    )
    expect(outcome.interrupted._tag).toBe("Failure") // indeterminate window: receipt pending, no auto-replay
    expect(outcome.resumed.kind).toBe("executed")
    expect((await sink.readAll()).length).toBe(1) // one effect even across the interrupted window
  })

  test("process-kill (crash-then-retry): the sandbox sink dup-absorbs — one effect append", async () => {
    await using tmp = await tmpdir()
    const sink = await makeSink(tmp.path)
    const kind = "c7-sink" as const
    const key = receiptRefFor(kind, "evt-4")

    const outcome = await runWithDb((db) =>
      Effect.gen(function* () {
        // Crash simulation: first delivery writes the sink then the process "dies" before the
        // receipt commit — the pending receipt row is the E3 redelivery handoff.
        const crash = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-4",
          now: 1_000,
          sideEffect: Effect.gen(function* () {
            yield* Effect.promise(() => sink.append({ effectId: "effect-4", idempotencyKey: key, resultHash: "h4" }))
            return yield* Effect.interrupt
          }),
        }).pipe(Effect.exit)
        const redelivered = yield* ConsumerReceipts.runOnce(db, {
          consumerKind: kind,
          sourceEventId: "evt-4",
          now: 3_000,
          sideEffect: Effect.promise(() => sink.append({ effectId: "effect-4", idempotencyKey: key, resultHash: "h4" })),
        })
        return { crash, redelivered }
      }),
    )
    expect(outcome.crash._tag).toBe("Failure")
    expect(outcome.redelivered.kind).toBe("executed")
    expect((await sink.readAll()).length).toBe(1)
  })
})
