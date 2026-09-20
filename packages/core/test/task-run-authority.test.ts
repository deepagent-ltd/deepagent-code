import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "node:path"
import { and, count, eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { Project } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import {
  SessionInputTable,
  SessionTable,
  TaskAdmissionTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

// Durable TaskRun authority (Core V2-native task ownership): every assertion here maps to an
// approved invariant — one ledger transaction, deterministic child identity, atomic first-input
// admission via the EventV2 commit hook, owner/generation fenced claim + settle, and the
// immutable terminal receipt. Crash simulation closes the database scope and reopens the file.

type DatabaseService = Database.Interface["db"]

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projector, sessions)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
  }
})

const directory = AbsolutePath.make("/tmp")

const specFor = (parentSessionID: SessionSchema.ID, toolCallID = "call-task-1") => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Research and report the answer." }),
  agent: "general",
  child: {
    title: "task: authority test",
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
})

const admittedEventCount = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({ total: count() })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, EventV2.durableType(SessionEvent.PromptLifecycle.Admitted)),
      ),
    )
    .get()
    .pipe(Effect.orDie)

const inputRowCount = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({ total: count() })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)

describe("Core V2 durable TaskRun authority", () => {
  it.effect("admitRun admits once; exact retry returns the existing run with zero new rows", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = specFor(parent.id)

      const first = yield* TaskRunAuthority.admitRun(db, spec)
      expect(first.exactRetry).toBeFalse()
      expect(first.run.state).toBe("admitted")
      expect(first.run.inputState).toBe("pending")
      expect(first.run.childSessionID).toBe(
        TaskRunAuthority.deterministicChildSessionID({
          parentSessionID: spec.parentSessionID,
          parentMessageID: spec.parentMessageID,
          toolCallID: spec.toolCallID,
        }),
      )

      const retry = yield* TaskRunAuthority.admitRun(db, spec)
      expect(retry.exactRetry).toBeTrue()
      expect(retry.run.runID).toBe(first.run.runID)

      expect((yield* db.select({ total: count() }).from(TaskRunTable).get().pipe(Effect.orDie))?.total).toBe(1)
      expect((yield* db.select({ total: count() }).from(TaskAdmissionTable).get().pipe(Effect.orDie))?.total).toBe(1)
      expect((yield* db.select({ total: count() }).from(TaskRunEventTable).get().pipe(Effect.orDie))?.total).toBe(1)
      expect((yield* TaskRunAuthority.getByAdmission(db, spec))?.runID).toBe(first.run.runID)
    }),
  )

  it.effect("admitRun rejects the same admission key with a different request hash", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = specFor(parent.id)
      yield* TaskRunAuthority.admitRun(db, spec)

      const conflict = yield* TaskRunAuthority.admitRun(db, {
        ...spec,
        prompt: new Prompt({ text: "A different request entirely." }),
      }).pipe(Effect.flip)
      expect(conflict).toMatchObject({ _tag: "TaskRunAuthority.AdmissionConflict" })

      expect((yield* db.select({ total: count() }).from(TaskRunTable).get().pipe(Effect.orDie))?.total).toBe(1)
      expect((yield* db.select({ total: count() }).from(TaskAdmissionTable).get().pipe(Effect.orDie))?.total).toBe(1)
    }),
  )

  it.effect("submit admits exactly one session_input and converges retries with no new rows", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = specFor(parent.id)

      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, spec)
      expect(submitted.run.inputState).toBe("ready")
      expect((yield* inputRowCount(db, submitted.run.childSessionID))?.total).toBe(1)
      expect((yield* admittedEventCount(db, submitted.run.childSessionID))?.total).toBe(1)

      // Crash-after-commit retry: the deterministic input id converges on the existing row.
      yield* TaskRunAuthority.admitChildInput(db, events, submitted.run, spec.prompt)
      expect((yield* inputRowCount(db, submitted.run.childSessionID))?.total).toBe(1)
      expect((yield* admittedEventCount(db, submitted.run.childSessionID))?.total).toBe(1)

      const children = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, parent.id))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      expect(children[0]?.id).toBe(submitted.run.childSessionID)
      expect(children[0]?.permission).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    }),
  )

  it.effect("commit-hook failure rolls back the event and session_input; retry succeeds exactly once", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = specFor(parent.id)
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)
      yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, admitted.run)

      // Injection: pre-flip input_state so the in-transaction pending→ready CAS cannot match and
      // the hook dies inside the event transaction (the "hook that throws" path).
      yield* db
        .update(TaskRunTable)
        .set({ input_state: "conflict" })
        .where(eq(TaskRunTable.run_id, admitted.run.runID))
        .run()
        .pipe(Effect.orDie)

      const failed = yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBeTrue()
      // The rollback left NOTHING behind: no projected input, no admitted event, no CAS side effect.
      expect((yield* inputRowCount(db, admitted.run.childSessionID))?.total).toBe(0)
      expect((yield* admittedEventCount(db, admitted.run.childSessionID))?.total).toBe(0)
      const untouched = yield* TaskRunAuthority.get(db, admitted.run.runID)
      expect(untouched?.inputState).toBe("conflict")
      expect(untouched?.version).toBe(admitted.run.version)

      // Undo the injection: the retry must now succeed exactly once and stay idempotent.
      yield* db
        .update(TaskRunTable)
        .set({ input_state: "pending" })
        .where(eq(TaskRunTable.run_id, admitted.run.runID))
        .run()
        .pipe(Effect.orDie)
      const ready = yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt)
      expect(ready.inputState).toBe("ready")
      yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt)
      expect((yield* inputRowCount(db, admitted.run.childSessionID))?.total).toBe(1)
      expect((yield* admittedEventCount(db, admitted.run.childSessionID))?.total).toBe(1)
    }),
  )

  it.effect("execute claims, drains, and settles completed with the receipt exactly once (foreground: no outbox)", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = specFor(parent.id)
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, spec)

      const result = yield* TaskRunAuthority.execute({
        db,
        run: submitted.run,
        sessions,
        timeoutMs: 5_000,
      })
      expect(result.outcome).toBe("completed")

      const settled = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(settled?.state).toBe("completed")
      expect(settled?.executionOwner).toBeUndefined()
      expect(
        (yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total,
      ).toBe(1)
      expect(
        (yield* db.select({ total: count() }).from(TaskNotificationOutboxTable).get().pipe(Effect.orDie))?.total,
      ).toBe(0)

      const ledger = yield* db
        .select({ version: TaskRunEventTable.version, type: TaskRunEventTable.type })
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, submitted.run.runID))
        .orderBy(TaskRunEventTable.version)
        .all()
        .pipe(Effect.orDie)
      expect(ledger).toEqual([
        { version: 0, type: "run_admitted" },
        { version: 1, type: "input_ready" },
        { version: 2, type: "execution_started" },
        { version: 3, type: "run_settled" },
      ])
    }),
  )

  it.effect("settle converges an exact re-settle and conflicts on a divergent outcome", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id))
      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        leaseMs: 60_000,
        now: 1_000,
      })

      const first = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "done",
        output: "42",
        now: 2_000,
      })
      expect(first.converged).toBeFalse()

      const again = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "done",
        output: "42",
        now: 3_000,
      })
      expect(again.converged).toBeTrue()
      expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total).toBe(1)

      const divergent = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: claimed.claimGeneration,
        state: "failed",
        reason: "boom",
        now: 4_000,
      }).pipe(Effect.flip)
      expect(divergent).toMatchObject({
        _tag: "TaskRunAuthority.SettlementConflict",
        reason: "outcome_divergence",
      })
      expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total).toBe(1)
    }),
  )

  it.effect("settle with an expired lease is fenced off and writes no receipt", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id))
      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        leaseMs: 5_000,
        now: 1_000,
      })

      const refused = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "late",
        now: 60_000,
      }).pipe(Effect.flip)
      expect(refused).toMatchObject({
        _tag: "TaskRunAuthority.SettlementConflict",
        reason: "settlement_fence_lost",
      })
      expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total).toBe(0)

      // A recovered owner steals the fence (generation+1); the stale owner can never settle.
      const recoveredOwner = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-B",
        leaseMs: 60_000,
        now: 61_000,
      })
      expect(recoveredOwner.claimGeneration).toBe(2)
      expect(recoveredOwner.executionOwner).toBe("owner-B")
      const stale = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "stale-owner",
        now: 62_000,
      }).pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: "TaskRunAuthority.SettlementConflict",
        reason: "settlement_fence_lost",
      })
      expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total).toBe(0)

      const stillRunning = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(stillRunning?.state).toBe("running")
    }),
  )

  it.effect("an expired-lease running run is re-claimable exactly once and never re-admits the child input", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id))
      const first = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        leaseMs: 1_000,
        now: 1_000,
      })
      expect(first.claimGeneration).toBe(1)

      const recovered = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-B",
        leaseMs: 60_000,
        now: 5_000,
      })
      expect(recovered.claimGeneration).toBe(2)
      expect(recovered.executionOwner).toBe("owner-B")

      const concurrent = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-C",
        leaseMs: 60_000,
        now: 5_000,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(concurrent)).toBeTrue()

      // The child input was admitted exactly once across claim, expiry, and recovery.
      expect((yield* inputRowCount(db, submitted.run.childSessionID))?.total).toBe(1)
      expect((yield* admittedEventCount(db, submitted.run.childSessionID))?.total).toBe(1)

      // The recovering owner CAN settle; the fenced original cannot.
      const stale = yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-A",
        claimGeneration: first.claimGeneration,
        state: "completed",
        reason: "stale",
        now: 6_000,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBeTrue()
      yield* TaskRunAuthority.settle(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-B",
        claimGeneration: recovered.claimGeneration,
        state: "failed",
        reason: "recovered_and_failed",
        now: 6_000,
      })
      expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie))?.total).toBe(1)
    }),
  )

  it.effect("claim ignores historical v1 rows", () =>
    Effect.gen(function* () {
      const { db, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "job_v1_history",
          request_hash: "legacy",
          execution_runtime: "v1",
          parent_session_id: parent.id,
          parent_message_id: SessionV1.MessageID.make("msg_v1_history"),
          tool_call_id: "call-v1",
          child_session_id: SessionSchema.ID.make("ses_v1_history"),
          generation: 1,
          delivery_mode: "foreground",
          phase: "admission",
          state: "admitted",
          input_state: "ready",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const refused = yield* TaskRunAuthority.claim(db, {
        runID: "job_v1_history",
        ownerToken: "owner-v2",
        leaseMs: 60_000,
        now: 2_000,
      }).pipe(Effect.exit)
      expect(Exit.isFailure(refused)).toBeTrue()
    }),
  )

  it.effect("background settle enqueues one queued notification outbox row", () =>
    Effect.gen(function* () {
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory } })
      const spec = { ...specFor(parent.id, "call-bg-1"), deliveryMode: "background" as const }
      const admitted = yield* TaskRunAuthority.admitRun(db, spec)
      yield* TaskRunAuthority.ensureChildSession(db, sessions, spec, admitted.run)
      yield* TaskRunAuthority.admitChildInput(db, events, admitted.run, spec.prompt)
      const claimed = yield* TaskRunAuthority.claim(db, {
        runID: admitted.run.runID,
        ownerToken: "owner-bg",
        leaseMs: 60_000,
        now: 1_000,
      })
      yield* TaskRunAuthority.settle(db, {
        runID: admitted.run.runID,
        ownerToken: "owner-bg",
        claimGeneration: claimed.claimGeneration,
        state: "completed",
        reason: "done",
        output: "result text",
        now: 2_000,
      })

      const outbox = yield* db
        .select()
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.run_id, admitted.run.runID))
        .get()
        .pipe(Effect.orDie)
      expect(outbox?.status).toBe("pending")
      expect(outbox?.event_kind).toBe("terminal")
      expect(outbox?.correlation_id).toBe(admitted.run.runID)
      expect(outbox?.payload.text).toBe("result text")
      expect(outbox?.parent_session_id).toBe(parent.id)
    }),
  )

  test("crash between ledger commit and child create: reopen adopts the deterministic child with no orphan", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "taskrun-crash.db")
    const parentID = SessionSchema.ID.create()
    const fixture = path.join(import.meta.dirname, "task-run-crash-process.ts")

    // "Process 1" (child process, closed connection at exit): commits the ledger transaction and
    // dies at the crash point — before the child create and before input admission.
    const admitted = Bun.spawnSync([process.execPath, fixture, file, "admit", parentID], {
      cwd: import.meta.dirname + "/..",
    })
    expect(admitted.exitCode).toBe(0)
    const facts = admitted.stdout.toString()
    const runID = facts.match(/RUN_ID=(\S+)/)?.[1]
    const childSessionID = facts.match(/CHILD_SESSION_ID=(\S+)/)?.[1]
    expect(runID).toBeDefined()
    expect(childSessionID).toBeDefined()

    // Raw reopen (plain SQLite): the ledger survived the closed connection; the child did not.
    const raw = new BunDatabase(file)
    expect(raw.query("SELECT count(*) AS c FROM task_run").get()).toMatchObject({ c: 1 })
    expect(raw.query("SELECT input_state FROM task_run WHERE run_id = ?").get(runID!)).toMatchObject({
      input_state: "pending",
    })
    expect(
      raw.query("SELECT count(*) AS c FROM session WHERE parent_id = ?").get(parentID),
    ).toMatchObject({ c: 0 })
    raw.close()

    // "Process 2" (child process): adoption by the deterministic id, then the one input admission.
    const recovered = Bun.spawnSync([process.execPath, fixture, file, "recover", parentID], {
      cwd: import.meta.dirname + "/..",
    })
    expect(recovered.exitCode).toBe(0)
    expect(recovered.stdout.toString()).toContain("RECOVERED_OK")
  }, 120_000)
})
