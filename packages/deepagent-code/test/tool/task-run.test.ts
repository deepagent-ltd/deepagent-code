import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MessageTable,
  PartTable,
  SessionTable,
  TaskStructuredOutputEvidencePartTable,
  TaskStructuredOutputEvidenceTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { Context, Effect, Exit, Layer } from "effect"
import { count, eq, sql } from "drizzle-orm"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  acknowledgeTaskNotification,
  admitTaskRun,
  claimTaskNotifications,
  claimTaskProvisioning,
  failAdmittedTaskRun,
  getActiveTaskRunByChild,
  markTaskFinalized,
  markTaskFinalizing,
  markTaskResearchCompleted,
  rejectTaskNotification,
  recoverExpiredTaskRuns,
  renewTaskRunLease,
  requestClose,
  requestHash,
  requestInterrupt,
  settleTaskRun,
  startTaskRun,
  type Run,
} from "../../src/tool/task-run"
import { persistStructuredFinalizerResponse } from "../../src/tool/task-structured-output-evidence"
import { V2TaskRunReceipt } from "@deepagent-code/core/session/runner/v2-task-run-receipt"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { settleRun } from "../../src/session/task-executor"
import { claimRun, enqueueRun } from "../../src/session/task-dispatcher"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)
const parentSessionID = SessionID.make("ses_task_run_parent")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: "task-run-parent",
      directory: "/project",
      title: "parent",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admit = (input?: {
  messageID?: MessageID
  callID?: string
  childSessionID?: SessionID
  joinRunID?: string
  parentRunID?: string
  request?: unknown
  deliveryMode?: "foreground" | "background"
  executionSpec?: Run["executionSpec"]
  now?: number
}) =>
  admitTaskRun({
    parentSessionID,
    parentMessageID: input?.messageID ?? MessageID.ascending("msg_task_run"),
    toolCallID: input?.callID ?? "call-1",
    childSessionID: input?.childSessionID,
    joinRunID: input?.joinRunID,
    parentRunID: input?.parentRunID,
    request: input?.request ?? { prompt: "research", subagent_type: "researcher" },
    deliveryMode: input?.deliveryMode ?? "foreground",
    executionSpec: input?.executionSpec,
    now: input?.now,
  })

describe("TaskRun durable store", () => {
  const recorderContext = Context.make(V2TaskRunReceipt.CurrentTaskRunTerminalRecorder, V2TaskRunReceipt.recordInTransaction)
  const wired = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideContext(recorderContext))

  it.effect("records a compensation receipt inside the settlement transaction when wired", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const admitted = yield* admit({ messageID: MessageID.ascending("msg_receipt_wired"), callID: "call-receipt" })
      const claimed = yield* claimTaskProvisioning({ run: admitted.run, owner: "worker", now: 1 })
      const running = yield* startTaskRun(claimed!, "worker", 2)
      const settled = yield* wired(
        settleTaskRun({
          run: running!,
          owner: "worker",
          state: "completed",
          reason: "text_output_valid",
          output: '{"result":"ok"}',
          now: 3,
        }),
      )
      expect(settled.won).toBe(true)
      // The compensation receipt is recorded atomically with the settlement, bound to the run.
      const receipts = yield* db
        .select()
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, admitted.run.runID))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        session_id: parentSessionID,
        child_session_id: admitted.run.childSessionID,
        state: "completed",
        reason: "text_output_valid",
        owner_token: "worker",
      })
      // Unwired compositions stay receipt-less.
      const other = yield* admit({ messageID: MessageID.ascending("msg_receipt_unwired"), callID: "call-unwired" })
      const otherClaimed = yield* claimTaskProvisioning({ run: other.run, owner: "worker", now: 4 })
      const otherRunning = yield* startTaskRun(otherClaimed!, "worker", 5)
      const otherSettled = yield* settleTaskRun({
        run: otherRunning!,
        owner: "worker",
        state: "completed",
        reason: "text_output_valid",
        now: 6,
      })
      expect(otherSettled.won).toBe(true)
      expect(
        yield* db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, other.run.runID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.effect("rolls the settlement back when the recorded receipt evidence diverges", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const admitted = yield* admit({ messageID: MessageID.ascending("msg_receipt_conflict"), callID: "call-conflict" })
      const claimed = yield* claimTaskProvisioning({ run: admitted.run, owner: "worker", now: 1 })
      const running = yield* startTaskRun(claimed!, "worker", 2)
      // Terminal authority recorded elsewhere (e.g. a V2 composition) precedes this settlement.
      yield* db.transaction(
        (tx) =>
          V2TaskRunReceipt.recordInTransaction(tx, {
            sessionId: parentSessionID,
            runId: admitted.run.runID,
            childSessionId: admitted.run.childSessionID,
            generation: admitted.run.generation,
            state: "completed",
            reason: "first_settlement",
            outcomeHash: "a".repeat(64),
            ownerToken: "worker",
            now: 3,
          }),
        { behavior: "immediate" },
      )
      // A divergent settlement is a conflict; the whole settlement transaction rolls back,
      // including the notification outbox row carried in the same transaction.
      const second = yield* wired(
        settleTaskRun({
          run: running!,
          owner: "worker",
          state: "completed",
          reason: "divergent_settlement",
          notification: { directory: "/project", payload: { agent: "build", text: "complete" } },
          now: 4,
        }),
      ).pipe(Effect.exit)
      expect(second._tag).toBe("Failure")
      expect(
        (
          yield* db
            .select({ count: count() })
            .from(TaskNotificationOutboxTable)
            .get()
            .pipe(Effect.orDie)
        )?.count,
      ).toBe(0)
      // The recorded evidence is untouched and the run never settled.
      const receipts = yield* db
        .select()
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, admitted.run.runID))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ reason: "first_settlement", state: "completed" })
      expect(
        (
          yield* db
            .select({ state: TaskRunTable.state })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, admitted.run.runID))
            .get()
            .pipe(Effect.orDie)
        )?.state,
      ).toBe("running")
    }),
  )

  it.effect("folds error settlements into failed receipts while pinning the raw state", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const admitted = yield* admit({ messageID: MessageID.ascending("msg_receipt_error_fold"), callID: "call-fold" })
      const claimed = yield* claimTaskProvisioning({ run: admitted.run, owner: "worker", now: 1 })
      const running = yield* startTaskRun(claimed!, "worker", 2)
      yield* wired(
        settleTaskRun({ run: running!, owner: "worker", state: "error", reason: "child_crashed", now: 3 }),
      )
      const receipts = yield* db
        .select()
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, admitted.run.runID))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ state: "failed", reason: "child_crashed" })
      // The raw terminal state stays recoverable from the outcome hash.
      expect(receipts[0].outcome_hash).toBe(
        requestHash({ state: "error", reason: "child_crashed", output: null, error: null }),
      )
    }),
  )

  it.effect("records control-plane settlement receipts for interrupt, close, and pre-execution failure", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const receiptsFor = (runID: string) =>
        db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, runID))
          .all()
          .pipe(Effect.orDie)
      // Interrupt of an admitted run settles it as cancelled with a control-plane receipt.
      const admitted = yield* admit({ messageID: MessageID.ascending("msg_receipt_interrupt"), callID: "call-int" })
      yield* wired(requestInterrupt({ runID: admitted.run.runID, reason: "user_interrupt", now: 1 }))
      expect(yield* receiptsFor(admitted.run.runID)).toEqual([
        expect.objectContaining({
          state: "cancelled",
          reason: "user_interrupt",
          owner_token: "control-plane",
        }),
      ])
      // Control-plane close of an admitted run records a closed receipt.
      const closable = yield* admit({ messageID: MessageID.ascending("msg_receipt_close"), callID: "call-close" })
      yield* wired(requestClose({ rootRunID: closable.run.runID, reason: "session_closed", now: 2 }))
      expect(yield* receiptsFor(closable.run.runID)).toEqual([
        expect.objectContaining({
          state: "closed",
          reason: "session_closed",
          owner_token: "control-plane",
        }),
      ])
      // Pre-execution failure of an admitted run records a failed receipt.
      const failing = yield* admit({ messageID: MessageID.ascending("msg_receipt_fail"), callID: "call-fail" })
      yield* wired(
        failAdmittedTaskRun({
          run: failing.run,
          reason: "provisioning_failed",
          error: { code: "provisioning_failed", message: "nope" },
          now: 3,
        }),
      )
      expect(yield* receiptsFor(failing.run.runID)).toEqual([
        expect.objectContaining({
          state: "failed",
          reason: "provisioning_failed",
          owner_token: "control-plane",
        }),
      ])
      // Unwired control-plane settlements stay receipt-less.
      const bare = yield* admit({ messageID: MessageID.ascending("msg_receipt_bare"), callID: "call-bare" })
      yield* requestInterrupt({ runID: bare.run.runID, reason: "user_interrupt", now: 4 })
      expect(yield* receiptsFor(bare.run.runID)).toHaveLength(0)
    }),
  )

  it.effect("records a control-plane receipt when an expired lease settles the run", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const admission = yield* admit({
        messageID: MessageID.ascending("msg_receipt_lease"),
        callID: "call-lease",
        deliveryMode: "background",
      })
      yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: 100, leaseMs: 50 })
      const recovered = yield* wired(recoverExpiredTaskRuns({ directory: "/project", now: 150 }))
      expect(recovered).toHaveLength(1)
      expect(
        yield* db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, admission.run.runID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        expect.objectContaining({
          state: "failed",
          reason: "execution_lease_expired",
          owner_token: "control-plane",
        }),
      ])
    }),
  )

  it.effect("records executor settlement receipts with priority-resolved evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const receiptsFor = (runID: string) =>
        db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, runID))
          .all()
          .pipe(Effect.orDie)
      // Normal completion: receipt carries the executor owner and the exact row evidence.
      const first = yield* admit({ messageID: MessageID.ascending("msg_receipt_exec_done"), callID: "call-exec-1" })
      const firstClaimed = yield* claimTaskProvisioning({ run: first.run, owner: "worker", now: 1 })
      const firstRunning = yield* startTaskRun(firstClaimed!, "worker", 2)
      const firstSettled = yield* wired(
        settleRun({
          runID: firstRunning!.runID,
          parentSessionID,
          ownerToken: "worker",
          claimGeneration: firstRunning!.claimGeneration,
          deliveryMode: "foreground",
          directory: "/project",
          agentType: "build",
          state: "completed",
          reason: "text_output_valid",
          output: "done",
          childSessionID: firstRunning!.childSessionID,
          now: 3,
        }),
      )
      expect(firstSettled.won).toBe(true)
      expect(yield* receiptsFor(firstRunning!.runID)).toEqual([
        expect.objectContaining({
          state: "completed",
          reason: "text_output_valid",
          owner_token: "worker",
          outcome_hash: requestHash({
            state: "completed",
            reason: "text_output_valid",
            output: "done",
            error: null,
          }),
        }),
      ])
      // Interrupt intent overrides a non-completed settlement: the receipt pins the resolved
      // evidence (interrupted state, null output, synthesized error) under the executor owner.
      const second = yield* admit({ messageID: MessageID.ascending("msg_receipt_exec_int"), callID: "call-exec-2" })
      const secondClaimed = yield* claimTaskProvisioning({ run: second.run, owner: "worker", now: 4 })
      const secondRunning = yield* startTaskRun(secondClaimed!, "worker", 5)
      yield* requestInterrupt({ runID: secondRunning!.runID, reason: "user_stop", now: 6 })
      const secondSettled = yield* wired(
        settleRun({
          runID: secondRunning!.runID,
          parentSessionID,
          ownerToken: "worker",
          claimGeneration: secondRunning!.claimGeneration,
          deliveryMode: "foreground",
          directory: "/project",
          agentType: "build",
          state: "failed",
          reason: "executor_error",
          childSessionID: secondRunning!.childSessionID,
          now: 7,
        }),
      )
      expect(secondSettled.won).toBe(true)
      expect(secondSettled.finalState).toBe("interrupted")
      expect(yield* receiptsFor(secondRunning!.runID)).toEqual([
        expect.objectContaining({
          state: "interrupted",
          reason: "user_stop",
          owner_token: "worker",
          outcome_hash: requestHash({
            state: "interrupted",
            reason: "user_stop",
            output: null,
            error: { code: "interrupted", message: "user_stop" },
          }),
        }),
      ])
    }),
  )

  it.effect("records a control-plane receipt when pre-start attempts are exhausted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const admitted = yield* admit({
        messageID: MessageID.ascending("msg_receipt_prestart"),
        callID: "call-prestart",
      })
      yield* enqueueRun({ runID: admitted.run.runID, runVersion: admitted.run.version })
      yield* wired(claimRun({ ownerToken: "worker", directory: "/project", maxPrestartAttempts: 0 }))
      expect(
        yield* db
          .select()
          .from(V2TaskRunReceiptTable)
          .where(eq(V2TaskRunReceiptTable.run_id, admitted.run.runID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        expect.objectContaining({
          state: "failed",
          reason: "prestart_attempts_exhausted",
          owner_token: "control-plane",
        }),
      ])
    }),
  )

  it.effect("canonical request hashes ignore object key order", () =>
    Effect.sync(() => {
      expect(requestHash({ b: [2, { y: true, x: null }], a: 1 })).toBe(
        requestHash({ a: 1, b: [2, { x: null, y: true }] }),
      )
      expect(requestHash({ prompt: "a" })).toBe("732acbb3e402e912437dbe53442ca54368b45e73c284acbf4c0530fac53cca74")
      expect(requestHash({ prompt: "a" })).not.toBe(requestHash({ prompt: "b" }))
    }),
  )

  it.effect("exact retry returns the original run and rejects conflicting reuse", () =>
    Effect.gen(function* () {
      yield* setup
      const messageID = MessageID.ascending("msg_exact_retry")
      const first = yield* admit({ messageID, callID: "call-exact" })
      const retry = yield* admit({ messageID, callID: "call-exact" })

      expect(first.exactRetry).toBe(false)
      expect(first.runCreated).toBe(true)
      expect(retry.exactRetry).toBe(true)
      expect(retry.run.runID).toBe(first.run.runID)
      expect(retry.run.childSessionID).toBe(first.run.childSessionID)

      const requestConflict = yield* Effect.flip(
        admit({ messageID, callID: "call-exact", request: { prompt: "different" } }),
      )
      expect(requestConflict.reason).toBe("request")

      const deliveryConflict = yield* Effect.flip(
        admit({ messageID, callID: "call-exact", deliveryMode: "background" }),
      )
      expect(deliveryConflict.reason).toBe("delivery")
    }),
  )

  it.effect("preflight failure settles the admitted run and audit event exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admit({ messageID: MessageID.ascending("msg_preflight_failure") })
      const failed = yield* failAdmittedTaskRun({
        run: admission.run,
        reason: "workspace_preflight_dirty",
        error: { code: "workspace_dirty", message: "dirty checkout" },
        now: 123,
      })

      expect(failed).toMatchObject({
        state: "failed",
        phase: "settled",
        controlState: "closed",
        reason: "workspace_preflight_dirty",
        version: admission.run.version + 1,
        timeSettled: 123,
      })
      expect(
        yield* failAdmittedTaskRun({
          run: admission.run,
          reason: "workspace_preflight_dirty",
          error: { code: "workspace_dirty", message: "duplicate" },
          now: 124,
        }),
      ).toBeUndefined()

      const { db } = yield* Database.Service
      const events = yield* db
        .select()
        .from(TaskRunEventTable)
        .where(eq(TaskRunEventTable.run_id, admission.run.runID))
        .all()
        .pipe(Effect.orDie)
      expect(events.filter((event) => event.type === "run_settled")).toHaveLength(1)
      expect(events.find((event) => event.type === "run_settled")).toMatchObject({
        from_state: "admitted",
        to_state: "failed",
        reason: "workspace_preflight_dirty",
      })
    }),
  )

  it.effect("admission records the causal run graph and rejects a closed parent", () =>
    Effect.gen(function* () {
      yield* setup
      const parentRun = yield* admit({
        messageID: MessageID.ascending("msg_causal_parent"),
        callID: "call-causal-parent",
      })
      const childRun = yield* admit({
        messageID: MessageID.ascending("msg_causal_child"),
        callID: "call-causal-child",
        parentRunID: parentRun.run.runID,
      })

      expect(childRun.run.parentRunID).toBe(parentRun.run.runID)
      expect(childRun.run.rootRunID).toBe(parentRun.run.runID)

      yield* failAdmittedTaskRun({
        run: parentRun.run,
        reason: "parent_closed",
        error: { code: "parent_closed", message: "parent is no longer open" },
      })
      const rejected = yield* Effect.flip(
        admit({
          messageID: MessageID.ascending("msg_causal_rejected"),
          callID: "call-causal-rejected",
          parentRunID: parentRun.run.runID,
        }),
      )
      expect(rejected.reason).toBe("ancestor_closed")
    }),
  )

  it.effect("concurrent database connections admit and settle exactly once", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const filename = `${directory}/task-run.sqlite`
      const databases = yield* Effect.all(
        [Database.layerFromPath(filename), Database.layerFromPath(filename)].map((layer) =>
          Layer.build(layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))),
        ),
        { concurrency: "unbounded" },
      )
      yield* setup.pipe(Effect.provide(databases[0]))
      const messageID = MessageID.ascending("msg_concurrent_admission")
      const admissions = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          admit({ messageID, callID: "call-concurrent" }).pipe(Effect.provide(databases[index % databases.length])),
        ),
        { concurrency: "unbounded" },
      )
      const run = admissions[0].run
      expect(new Set(admissions.map((item) => item.run.runID)).size).toBe(1)
      expect(admissions.filter((item) => item.runCreated)).toHaveLength(1)

      const claimed = yield* claimTaskProvisioning({ run, owner: "worker", now: 1 }).pipe(Effect.provide(databases[0]))
      const running = yield* startTaskRun(claimed!, "worker", 2).pipe(Effect.provide(databases[0]))
      const settlements = yield* Effect.all(
        [
          settleTaskRun({
            run: running!,
            owner: "worker",
            state: "completed",
            reason: "text_output_valid",
            output: '{"result":"ok"}',
            notification: { directory: "/project", payload: { agent: "build", text: "complete" } },
            now: 3,
          }).pipe(Effect.provide(databases[0])),
          settleTaskRun({
            run: running!,
            owner: "worker",
            state: "error",
            reason: "provider_error",
            error: { code: "provider_error", message: "late failure" },
            notification: { directory: "/project", payload: { agent: "build", text: "failed" } },
            now: 3,
          }).pipe(Effect.provide(databases[1])),
        ],
        { concurrency: "unbounded" },
      )
      expect(settlements.filter((item) => item.won)).toHaveLength(1)

      const counts = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return {
          runs: yield* db.select({ count: count() }).from(TaskRunTable).get().pipe(Effect.orDie),
          notifications: yield* db
            .select({ count: count() })
            .from(TaskNotificationOutboxTable)
            .get()
            .pipe(Effect.orDie),
        }
      }).pipe(Effect.provide(databases[0]))
      expect(counts.runs).toEqual({ count: 1 })
      expect(counts.notifications).toEqual({ count: 1 })
    }),
  )

  it.effect("one active run per child, joined admissions share it, and later runs increment generation", () =>
    Effect.gen(function* () {
      yield* setup
      const childSessionID = SessionID.make("ses_task_run_child")
      const first = yield* admit({ childSessionID, messageID: MessageID.ascending("msg_generation_1") })
      const claimed = yield* claimTaskProvisioning({ run: first.run, owner: "worker-1", now: 100, leaseMs: 50 })
      expect(claimed?.state).toBe("provisioning")
      const running = yield* startTaskRun(claimed!, "worker-1", 101)
      expect(running?.state).toBe("running")
      expect((yield* getActiveTaskRunByChild(childSessionID))?.runID).toBe(first.run.runID)

      const unjoined = yield* Effect.flip(
        admit({ childSessionID, messageID: MessageID.ascending("msg_generation_conflict"), callID: "call-conflict" }),
      )
      expect(unjoined.reason).toBe("join")

      const joined = yield* admit({
        childSessionID,
        joinRunID: first.run.runID,
        messageID: MessageID.ascending("msg_generation_join"),
        callID: "call-join",
        request: { prompt: "additional context" },
      })
      expect(joined.runCreated).toBe(false)
      expect(joined.run.runID).toBe(first.run.runID)

      expect(
        (yield* settleTaskRun({
          run: running!,
          owner: "worker-1",
          state: "completed",
          reason: "text_output_valid",
          output: "done",
          now: 102,
        })).won,
      ).toBe(true)
      expect(yield* getActiveTaskRunByChild(childSessionID)).toBeUndefined()

      const second = yield* admit({
        childSessionID,
        messageID: MessageID.ascending("msg_generation_2"),
        callID: "call-2",
      })
      expect(second.run.generation).toBe(first.run.generation + 1)
      expect(second.run.runID).not.toBe(first.run.runID)
      expect(second.run.continuationOfRunID).toBe(first.run.runID)
    }),
  )

  it.effect("provisioning lease permits only its owner until expiry", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admit({ messageID: MessageID.ascending("msg_lease") })
      const first = yield* claimTaskProvisioning({ run: admission.run, owner: "worker-a", now: 1_000, leaseMs: 100 })
      expect(first?.executionOwner).toBe("worker-a")
      expect(
        yield* claimTaskProvisioning({ run: admission.run, owner: "worker-b", now: 1_099, leaseMs: 100 }),
      ).toBeUndefined()
      expect(
        (yield* claimTaskProvisioning({ run: admission.run, owner: "worker-b", now: 1_100, leaseMs: 100 }))
          ?.executionOwner,
      ).toBe("worker-b")
      expect(yield* startTaskRun(first!, "worker-a", 1_101)).toBeUndefined()
      expect((yield* startTaskRun(admission.run, "worker-b", 1_102))?.state).toBe("running")
    }),
  )

  it.effect("expired provisioning settles before a late worker can create the child", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admit({
        messageID: MessageID.ascending("msg_provisioning_recovery"),
        deliveryMode: "background",
      })
      const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: 100, leaseMs: 50 })

      expect(yield* recoverExpiredTaskRuns({ directory: "/project", now: 149 })).toEqual([])
      const recovered = yield* recoverExpiredTaskRuns({ directory: "/project", now: 150 })
      expect(recovered).toHaveLength(1)
      expect(recovered[0].state).toBe("failed")
      expect(recovered[0].reason).toBe("execution_lease_expired")
      expect(yield* startTaskRun(claimed!, "worker", 151)).toBeUndefined()

      const outbox = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.select().from(TaskNotificationOutboxTable).get().pipe(Effect.orDie)
      })
      expect(outbox?.payload.text).toContain("durable child session was being provisioned")
      expect(outbox?.payload.text).not.toContain("Partial work is preserved")
    }),
  )

  it.effect("running leases renew and expired runs settle once with an atomic recovery notification", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const filename = `${directory}/task-run-recovery.sqlite`
      const databases = yield* Effect.all(
        [Database.layerFromPath(filename), Database.layerFromPath(filename)].map((layer) =>
          Layer.build(layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))),
        ),
        { concurrency: "unbounded" },
      )
      yield* setup.pipe(Effect.provide(databases[0]))
      const admission = yield* admit({ messageID: MessageID.ascending("msg_recovery") }).pipe(
        Effect.provide(databases[0]),
      )
      const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: 100, leaseMs: 50 }).pipe(
        Effect.provide(databases[0]),
      )
      const running = (yield* startTaskRun(claimed!, "worker", 101, 50).pipe(Effect.provide(databases[0])))!

      expect(
        yield* renewTaskRunLease({ run: running, owner: "other", now: 140, leaseMs: 100 }).pipe(
          Effect.provide(databases[1]),
        ),
      ).toBe(false)
      expect(
        yield* renewTaskRunLease({ run: running, owner: "worker", now: 140, leaseMs: 100 }).pipe(
          Effect.provide(databases[0]),
        ),
      ).toBe(true)
      expect(
        yield* recoverExpiredTaskRuns({ directory: "/project", now: 239 }).pipe(Effect.provide(databases[1])),
      ).toEqual([])
      expect(
        yield* renewTaskRunLease({ run: running, owner: "worker", now: 240, leaseMs: 100 }).pipe(
          Effect.provide(databases[0]),
        ),
      ).toBe(false)
      expect(
        (yield* settleTaskRun({
          run: running,
          owner: "worker",
          state: "completed",
          reason: "text_output_valid",
          output: "late result before recovery",
          now: 240,
        }).pipe(Effect.provide(databases[0]))).won,
      ).toBe(false)

      const recovered = yield* Effect.all(
        databases.map((database) =>
          recoverExpiredTaskRuns({ directory: "/project", now: 240 }).pipe(Effect.provide(database)),
        ),
        { concurrency: "unbounded" },
      )
      expect(recovered.flat()).toHaveLength(1)
      expect(recovered.flat()[0].state).toBe("failed")
      expect(recovered.flat()[0].reason).toBe("execution_lease_expired")
      expect(
        (yield* settleTaskRun({
          run: running,
          owner: "worker",
          state: "completed",
          reason: "text_output_valid",
          output: "late result",
          now: 241,
        }).pipe(Effect.provide(databases[0]))).won,
      ).toBe(false)

      const counts = yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        return {
          runs: yield* db
            .select({ count: count() })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.reason, "execution_lease_expired"))
            .get()
            .pipe(Effect.orDie),
          notifications: yield* db
            .select({ count: count() })
            .from(TaskNotificationOutboxTable)
            .get()
            .pipe(Effect.orDie),
        }
      }).pipe(Effect.provide(databases[1]))
      expect(counts).toEqual({ runs: { count: 1 }, notifications: { count: 1 } })
    }),
  )

  it.effect("phase refs persist and settlement CAS has one immutable winner", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admit({
        messageID: MessageID.ascending("msg_settlement"),
        executionSpec: {
          prompt: { text: "inspect" },
          agent: "researcher",
          model: { providerID: "test", modelID: "test" },
          structuredOutput: {
            schema: { type: "object" },
            allowTextFallback: true,
            receiptVersion: 1,
            maxAttempts: 2,
          },
        },
      })
      const time = Date.now()
      const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: time })
      const running = (yield* startTaskRun(claimed!, "worker", time + 1))!
      const rawMessageID = MessageID.ascending("msg_raw_result")
      const requestMessageID = MessageID.ascending("msg_structured_request")
      const finalMessageID = MessageID.ascending("msg_structured_result")
      const { db } = yield* Database.Service
      yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${running.childSessionID}, ${ProjectV2.ID.global}, 'task-run-child', '/project', 'child', 'test', ${time}, ${time})
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
          (${rawMessageID}, ${running.childSessionID}, ${time + 2}, ${time + 2}, '{"role":"assistant"}'),
          (${requestMessageID}, ${running.childSessionID}, ${time + 3}, ${time + 3},
            ${JSON.stringify({
              role: "user",
              metadata: {
                deepagent: {
                  structured_finalizer: {
                    run_id: running.runID,
                    attempt: 2,
                    source_message_id: rawMessageID,
                    allow_text: false,
                  },
                },
              },
            })}),
          (${finalMessageID}, ${running.childSessionID}, ${time + 4}, ${time + 4},
            ${JSON.stringify({ role: "assistant", parentID: requestMessageID, structured: { answer: "ok" } })})
      `)
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
          ('prt_task_raw', ${rawMessageID}, ${running.childSessionID}, ${time + 2}, ${time + 2}, '{"type":"text","text":"research"}'),
          ('prt_task_result', ${finalMessageID}, ${running.childSessionID}, ${time + 4}, ${time + 4}, '{"type":"text","text":"{\\"answer\\":\\"ok\\"}"}')
      `)
      yield* markTaskResearchCompleted(running, "worker", rawMessageID, time + 2)
      yield* markTaskFinalizing(running, "worker", 2, rawMessageID, time + 3)
      yield* persistStructuredFinalizerResponse({
        runID: running.runID,
        childSessionID: running.childSessionID,
        ownerToken: "worker",
        claimGeneration: running.claimGeneration,
        attempt: 2,
        sourceMessageID: rawMessageID,
        responseMessageID: finalMessageID,
        contract: running.executionSpec!.structuredOutput!,
        receipt: { attempt: 2, transport: "structured" },
        output: '{"answer":"ok"}',
        now: time + 4,
      })
      yield* markTaskFinalized(running, "worker", finalMessageID, time + 4)

      const winner = yield* settleTaskRun({
        run: running,
        owner: "worker",
        state: "completed",
        reason: "structured_output_valid",
        output: '{"answer":"ok"}',
        structuredResultMessageID: finalMessageID,
        structuredOutputReceipt: { attempt: 2, transport: "structured" },
        notification: {
          directory: "/project",
          payload: { agent: "build", text: "complete" },
        },
        now: time + 5,
      })
      const loser = yield* settleTaskRun({
        run: running,
        owner: "worker",
        state: "error",
        reason: "provider_error",
        error: { code: "provider_error", message: "late failure" },
        now: time + 6,
      })

      expect(winner.won).toBe(true)
      expect(winner.run.rawResultMessageID).toBe(rawMessageID)
      expect(winner.run.structuredResultMessageID).toBe(finalMessageID)
      expect(winner.run.structuredOutputReceipt).toEqual({ attempt: 2, transport: "structured" })
      expect(loser.won).toBe(false)
      expect(loser.run.state).toBe("completed")
      expect(loser.run.output).toBe('{"answer":"ok"}')

      expect(yield* db.select({ count: count() }).from(TaskNotificationOutboxTable).get().pipe(Effect.orDie)).toEqual({
        count: 1,
      })
      expect(
        yield* db
          .select({
            terminalState: TaskStructuredOutputEvidenceTable.terminal_state,
            attempts: TaskStructuredOutputEvidenceTable.attempts,
            rawMessageID: TaskStructuredOutputEvidenceTable.raw_result_message_id,
            resultMessageID: TaskStructuredOutputEvidenceTable.result_message_id,
            output: TaskStructuredOutputEvidenceTable.output,
          })
          .from(TaskStructuredOutputEvidenceTable)
          .where(eq(TaskStructuredOutputEvidenceTable.run_id, running.runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        terminalState: "completed",
        attempts: 2,
        rawMessageID,
        resultMessageID: finalMessageID,
        output: '{"answer":"ok"}',
      })
      expect(
        yield* db
          .select({ count: count() })
          .from(TaskStructuredOutputEvidencePartTable)
          .where(eq(TaskStructuredOutputEvidencePartTable.run_id, running.runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ count: 2 })

      expect(
        Exit.isFailure(
          yield* db
            .run(sql`UPDATE message SET data = '{"role":"assistant","tampered":true}' WHERE id = ${rawMessageID}`)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* db
            .run(sql`UPDATE part SET data = '{"type":"text","text":"tampered"}' WHERE id = 'prt_task_raw'`)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* db
            .run(
              sql`
              INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
              VALUES ('prt_task_late', ${rawMessageID}, ${running.childSessionID}, ${time + 6}, ${time + 6},
                '{"type":"text","text":"late"}')
            `,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* db.run(sql`DELETE FROM part WHERE id = 'prt_task_raw'`).pipe(Effect.exit))).toBe(
        true,
      )
      expect(Exit.isFailure(yield* db.run(sql`DELETE FROM message WHERE id = ${rawMessageID}`).pipe(Effect.exit))).toBe(
        true,
      )
      expect(
        Exit.isFailure(
          yield* db
            .run(sql`UPDATE task_structured_output_evidence SET output = 'tampered' WHERE run_id = ${running.runID}`)
            .pipe(Effect.exit),
        ),
      ).toBe(true)

      yield* db.delete(SessionTable).where(eq(SessionTable.id, parentSessionID)).run().pipe(Effect.orDie)
      expect(
        yield* db
          .select({ count: count() })
          .from(TaskStructuredOutputEvidenceTable)
          .where(eq(TaskStructuredOutputEvidenceTable.run_id, running.runID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ count: 0 })
    }),
  )

  it.effect("outbox claims are leased, retry with backoff, and stale acknowledgements fail closed", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admit({ messageID: MessageID.ascending("msg_outbox"), deliveryMode: "background" })
      const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: 1 })
      const running = (yield* startTaskRun(claimed!, "worker", 2))!
      yield* settleTaskRun({
        run: running,
        owner: "worker",
        state: "error",
        reason: "provider_error",
        error: { code: "provider_error", message: "provider unavailable" },
        notification: {
          directory: "/project",
          payload: { agent: "build", variant: "high", text: "failed" },
        },
        now: 10,
      })

      const first = (yield* claimTaskNotifications({
        owner: "dispatcher-a",
        directory: "/project",
        now: 10,
        leaseMs: 50,
      }))[0]
      expect(first.attempts).toBe(1)
      expect(
        yield* claimTaskNotifications({ owner: "dispatcher-b", directory: "/project", now: 59, leaseMs: 50 }),
      ).toEqual([])
      const reclaimed = (yield* claimTaskNotifications({
        owner: "dispatcher-a",
        directory: "/project",
        now: 60,
        leaseMs: 50,
      }))[0]
      expect(reclaimed.attempts).toBe(2)
      expect(
        yield* acknowledgeTaskNotification({
          id: first.id,
          owner: "dispatcher-a",
          attempts: first.attempts,
          now: 61,
        }),
      ).toBe(false)
      expect(
        yield* rejectTaskNotification({
          id: reclaimed.id,
          owner: "dispatcher-a",
          attempts: reclaimed.attempts,
          error: "temporary",
          now: 62,
        }),
      ).toBe(false)
      expect(yield* claimTaskNotifications({ owner: "dispatcher-c", directory: "/project", now: 2_061 })).toEqual([])
      const third = (yield* claimTaskNotifications({ owner: "dispatcher-c", directory: "/project", now: 2_062 }))[0]
      expect(third.attempts).toBe(3)
      expect(
        yield* acknowledgeTaskNotification({
          id: third.id,
          owner: "dispatcher-c",
          attempts: third.attempts,
          now: 2_063,
        }),
      ).toBe(true)
      expect(yield* claimTaskNotifications({ owner: "dispatcher-d", directory: "/project", now: 10_000 })).toEqual([])

      const { db } = yield* Database.Service
      expect(
        (yield* db
          .select({ status: TaskNotificationOutboxTable.status })
          .from(TaskNotificationOutboxTable)
          .where(eq(TaskNotificationOutboxTable.id, third.id))
          .get()
          .pipe(Effect.orDie))?.status,
      ).toBe("delivered")
      expect(
        (yield* db
          .select({ state: TaskRunTable.state })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, admission.run.runID))
          .get()
          .pipe(Effect.orDie))?.state,
      ).toBe("error")
    }),
  )
})
