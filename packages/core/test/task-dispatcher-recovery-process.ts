#!/usr/bin/env bun

// Crash-simulation fixture for test/task-run-dispatcher.test.ts. The application Database layer
// memoizes per process, so "close the connection and reopen" needs a real second process: the
// "claim" phase submits a background run, claims it with an already-expired lease (the state a
// crashed owner leaves behind), and exits; the "recover" phase reopens the same file, runs the
// Core dispatcher + outbox delivery once each, and asserts the recovered ledger invariants here
// (exit non-zero on failure); the parent test checks facts + exit codes.

import { Effect, Layer } from "effect"
import { count, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, TaskNotificationOutboxTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { TaskOutbox } from "@deepagent-code/core/session/task-outbox"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskRunDispatcher } from "@deepagent-code/core/session/task-run-dispatcher"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { AbsolutePath } from "@deepagent-code/core/schema"

const filename = process.argv[2]!
// A stub project service: the real Project.defaultLayer bundles Database.defaultLayer (the
// process-global default path), and building it can hijack the memoized Database layer away from
// this fixture's file. The fixture needs only a deterministic project identity for the session.
const project = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    directories: () => Effect.succeed([]),
    resolve: (directory) =>
      Effect.succeed({
        id: ProjectV2.ID.make("prj_dispatcher_recovery_fixture"),
        directory,
      }),
    commit: () => Effect.void,
  }),
)

const database = Database.layerFromPath(filename)
const events = EventV2.layer.pipe(Layer.provide(database))
const sessionsLayer = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(project),
  Layer.provide(SessionExecution.noopLayer),
)
const stack = Layer.mergeAll(
  database,
  events,
  SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
  sessionsLayer,
  Layer.mergeAll(TaskRunDispatcher.layer(), TaskOutbox.layer()).pipe(
    Layer.provide(database),
    Layer.provide(sessionsLayer),
  ),
)
const phase = process.argv[3]!
const parentID = SessionSchema.ID.make(process.argv[4]!)
const directory = AbsolutePath.make("/tmp")
const spec = {
  parentSessionID: parentID,
  parentMessageID: SessionMessage.ID.make("msg_parent_call-recovery-1"),
  toolCallID: "call-recovery-1",
  deliveryMode: "background" as const,
  prompt: new Prompt({ text: "Research the durable recovery boundary." }),
  agent: "general",
  child: {
    title: "task: recovery fixture",
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
}

const gen = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const sessions = yield* SessionV2.Service
  if (phase === "claim") {
    yield* sessions.create({ id: parentID, location: { directory } })
    const submitted = yield* TaskRunAuthority.submit(db, events, sessions, spec)
    // The claim's `now` is 120s in the past, so this owner's lease is ALREADY expired at exit —
    // exactly the durable state a crashed dispatcher process leaves behind.
    yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: "owner-crashed",
      leaseMs: 30_000,
      now: Date.now() - 120_000,
    })
    console.log(`RUN_ID=${submitted.run.runID}`)
    return
  }

  // Recovery: the same scan finds the expired-lease running row, re-claims it (generation 2),
  // and the executor settles exactly once.
  const runID = process.argv[5]!
  const dispatcher = yield* TaskRunDispatcher.Service
  const claimed = yield* dispatcher.tick
  if (claimed !== 1) throw new Error(`expected exactly one recovery claim, got ${claimed}`)
  yield* dispatcher.awaitIdle

  const recovered = yield* TaskRunAuthority.get(db, runID)
  if (recovered?.state !== "completed") throw new Error(`run not settled: ${recovered?.state}`)
  if (recovered.claimGeneration !== 2) throw new Error(`expected claim_generation 2, got ${recovered.claimGeneration}`)
  if (recovered.executionOwner !== undefined) throw new Error("owner not released at settle")
  const receipts = yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie)
  if (receipts?.total !== 1) throw new Error(`receipts: ${receipts?.total}`)
  const settledEvents = yield* db
    .select({ total: count() })
    .from(TaskRunEventTable)
    .where(eq(TaskRunEventTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)

  // The settle transaction enqueued the background notification; delivery admits exactly ONE
  // parent session_input under the deterministic id and marks the row delivered.
  const outbox = yield* TaskOutbox.Service
  if ((yield* outbox.tick) !== 1) throw new Error("outbox delivery did not run")
  const row = yield* db
    .select()
    .from(TaskNotificationOutboxTable)
    .where(eq(TaskNotificationOutboxTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)
  if (row?.status !== "delivered") throw new Error(`outbox status: ${row?.status}`)
  const inputs = yield* db
    .select({ total: count() })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, parentID))
    .get()
    .pipe(Effect.orDie)
  if (inputs?.total !== 1) throw new Error(`parent session_input rows: ${inputs?.total}`)
  if ((yield* outbox.tick) !== 0) throw new Error("delivered row was re-claimed")
  if (settledEvents === undefined) throw new Error("run ledger missing")
  console.log("RECOVERED_OK")
})
await Effect.runPromise(gen.pipe(Effect.provide(stack), Effect.scoped))
