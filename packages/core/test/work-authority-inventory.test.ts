import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"
import { StartupInventory } from "../src/session/runner/startup-inventory"
import { PreparedProviderTurn } from "../src/session/runner/prepared-provider-turn"
import { WorkAuthorityFixture } from "./fixture/work-authority"

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(WorkAuthorityFixture.verifier),
      Effect.provide(WorkAuthorityFixture.database(filename)),
      Effect.scoped,
    ),
  )
}

async function isolated(body: (filename: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "work-inventory-"))
  try {
    const filename = join(root, "work.sqlite")
    await run(filename, WorkAuthorityFixture.initialize())
    await body(filename)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// Real migrated SQLite and its triggers remain enabled. This fixture commits the caller's
// provider pair and Work permit atomically; it does not send HTTP or run SessionExecution.
const dispatched = Effect.fn("WorkInventoryFixture.dispatched")(function* (
  input: ReturnType<typeof WorkAuthorityFixture.binding>,
) {
  const db = (yield* Database.Service).db
  const reservation = yield* db.transaction(
    (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
    { behavior: "immediate" },
  )
  const turn = PreparedProviderTurn.prepare({
    sessionID: input.sessionID,
    requestOrdinal: 1,
    activityID: `activity-${input.workID}`,
    providerTurnSeq: 1,
    owner: "v2",
    stableSystemParts: [WorkAuthorityPolicy.TEXT_ONLY_PROFILE.instructions],
    volatileSystemParts: [],
    historyMessages: [{ role: "user", content: WorkAuthorityFixture.TEXT }],
    historyPromptEpoch: 1,
    historySourceEndMessageID: null,
    contextSelectionID: reservation.context_selection_id,
    contextProjectionHash: reservation.context_projection_hash,
    contextReadiness: "ready",
    contextSelectedRefs: [],
    toolRegistryIDs: [],
    toolPermissionFilteredIDs: [],
    toolFinalOfferedIDs: [],
    toolDefinitions: [],
    toolChoice: "none",
    toolCapability: "unsupported",
    toolLoweringOutcome: "omitted_no_support",
    toolResultReferences: [],
    samplingModelID: input.provider.modelID,
    samplingProviderID: input.provider.providerID,
    samplingMaxOutputTokens: 4_096,
    budget: {
      decision: "ok",
      estimatedFullRequestTokens: 1_024,
      physicalInputBudget: 1_024,
      reservedOutputTokens: 4_096,
      safetyMargin: 0,
      provenance: "host_guard",
    },
    wireRequestHash: "a".repeat(64),
    receiptID: reservation.receipt_id,
    providerAttemptID: reservation.attempt_id,
    userMessageID: input.inputID,
    preparedAt: WorkAuthorityFixture.NOW,
  })
  yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        yield* WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation))
        yield* tx.run(
          sql`UPDATE session_provider_attempt SET prepared_turn_hash = ${turn.prepared_turn_hash}, wire_request_hash = ${turn.wire_request_hash} WHERE attempt_id = ${reservation.attempt_id}`,
        )
        yield* tx.run(
          sql`UPDATE session_provider_attempt SET state = 'dispatching' WHERE attempt_id = ${reservation.attempt_id}`,
        )
        yield* tx.run(
          sql`UPDATE session_v2_provider_turn_receipt SET state = 'dispatching', prepared_turn_hash = ${turn.prepared_turn_hash}, wire_request_hash = ${turn.wire_request_hash}, prepared_turn = ${JSON.stringify(turn)}, dispatching_at = ${WorkAuthorityFixture.NOW} WHERE receipt_id = ${reservation.receipt_id}`,
        )
      }),
    { behavior: "immediate" },
  )
  return reservation
})

test.each(["reserved", "ready", "dispatching", "unknown", "settled"] as const)(
  "file reopen classifies %s without executing, releasing or editing authority",
  (state) =>
    isolated(async (filename) => {
      const input = WorkAuthorityFixture.binding()
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          if (state === "reserved") return
          yield* WorkAuthorityFixture.materialize(input)
          if (state === "ready") return
          const reservation = yield* dispatched(input)
          if (state === "dispatching") return
          if (state === "unknown") {
            yield* db.transaction(
              (tx) =>
                WorkAuthority.settleDispatchInTransaction(tx, {
                  reservationID: reservation.reservation_id,
                  outcome: "unknown",
                  now: WorkAuthorityFixture.NOW,
                }),
              { behavior: "immediate" },
            )
            return
          }
          yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx.run(
                  sql`UPDATE session_provider_attempt SET state = 'settled', settled_at = ${WorkAuthorityFixture.NOW} WHERE attempt_id = ${reservation.attempt_id}`,
                )
                yield* tx.run(
                  sql`UPDATE session_v2_provider_turn_receipt SET state = 'settled', outcome_hash = ${"d".repeat(64)}, outcome_artifact = '[]', terminal_at = ${WorkAuthorityFixture.NOW} WHERE receipt_id = ${reservation.receipt_id}`,
                )
                yield* WorkAuthority.settleDispatchInTransaction(tx, {
                  reservationID: reservation.reservation_id,
                  outcome: "settled",
                  usage: { inputTokens: 100, completionTokens: 60, reasoningTokens: 40 },
                  now: WorkAuthorityFixture.NOW,
                })
              }),
            { behavior: "immediate" },
          )
        }),
      )
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const before = yield* db.all("SELECT * FROM work_dispatch_reservation")
          const inventory = yield* StartupInventory.classifyStartup(db)
          expect(inventory.byCategory.work_execution).toEqual({
            safe_before_dispatch: state === "reserved" || state === "ready" ? 1 : 0,
            recovery: state === "dispatching" || state === "unknown" || state === "settled" ? 1 : 0,
            resolved: 0,
            unclassified: 0,
          })
          expect(inventory.byCategory.work_dispatch).toEqual({
            safe_before_dispatch: 0,
            recovery: state === "dispatching" || state === "unknown" ? 1 : 0,
            resolved: state === "settled" ? 1 : 0,
            unclassified: 0,
          })
          expect(inventory.ready).toBe(true)
          expect(yield* db.all("SELECT * FROM work_dispatch_reservation")).toEqual(before)
          expect((yield* db.all<{ count: number }>("SELECT count(*) count FROM session_input"))[0]?.count).toBe(
            state === "reserved" ? 0 : 1,
          )
          expect(
            (yield* db.all<{ count: number }>("SELECT count(*) count FROM session_v2_provider_turn_receipt"))[0]?.count,
          ).toBe(state === "reserved" ? 0 : 1)
        }),
      )
    }),
)

test("store-only dispatch without the matching provider transition is unclassified after reopen", () =>
  isolated(async (filename) => {
    const input = WorkAuthorityFixture.binding()
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
        yield* WorkAuthorityFixture.materialize(input)
        const reservation = yield* db.transaction(
          (tx) => WorkAuthority.reserveDispatchInTransaction(tx, WorkAuthorityFixture.dispatch(input)),
          { behavior: "immediate" },
        )
        yield* db.transaction(
          (tx) => WorkAuthority.authorizeDispatchInTransaction(tx, WorkAuthorityFixture.seal(reservation)),
          { behavior: "immediate" },
        )
      }),
    )
    await run(
      filename,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.byCategory.work_dispatch.unclassified).toBe(1)
        expect(inventory.byCategory.work_execution.unclassified).toBe(1)
        expect(
          (yield* db.all<{ charge: number }>("SELECT charged_tokens charge FROM work_dispatch_reservation"))[0]?.charge,
        ).toBe(5_120)
      }),
    )
  }))

test.each(["session", "input", "fingerprint", "dispatch-fingerprint", "escrow", "orphan"] as const)(
  "%s mismatch blocks startup and leaves all escrow intact",
  (mismatch) =>
    isolated(async (filename) => {
      await run(
        filename,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = WorkAuthorityFixture.binding()
          yield* WorkAuthority.reserve(db, { binding: input, now: WorkAuthorityFixture.NOW })
          yield* WorkAuthorityFixture.materialize(input)
          const reservation = yield* dispatched(input)
          if (mismatch === "session") yield* db.run("UPDATE session SET agent = 'different'")
          if (mismatch === "input") yield* db.run("UPDATE work_execution SET input_id = 'missing'")
          if (mismatch === "fingerprint") yield* db.run(sql`UPDATE work_execution SET binding_hash = ${"f".repeat(64)}`)
          if (mismatch === "dispatch-fingerprint")
            yield* db.run(sql`UPDATE work_dispatch_reservation SET request_hash = ${"f".repeat(64)}`)
          if (mismatch === "escrow") yield* db.run("UPDATE work_dispatch_reservation SET charged_tokens = 1")
          if (mismatch === "orphan") yield* db.run("DELETE FROM work_execution")
          const snapshot = yield* db.all("SELECT * FROM work_dispatch_reservation")
          const inventory = yield* StartupInventory.classifyStartup(db)
          expect(inventory.ready).toBe(false)
          expect(inventory.byCategory.work_dispatch.unclassified).toBe(1)
          expect(yield* db.all("SELECT * FROM work_dispatch_reservation")).toEqual(snapshot)
          expect(reservation.reserved_total_tokens).toBe(5_120)
        }),
      )
    }),
)
