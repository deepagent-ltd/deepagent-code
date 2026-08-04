import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  SessionTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { Effect, Layer } from "effect"
import { count, eq } from "drizzle-orm"
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
  requestHash,
  settleTaskRun,
  startTaskRun,
} from "../../src/tool/task-run"
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
    now: input?.now,
  })

describe("TaskRun durable store", () => {
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
            reason: "structured_output_valid",
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
      const admission = yield* admit({ messageID: MessageID.ascending("msg_settlement") })
      const claimed = yield* claimTaskProvisioning({ run: admission.run, owner: "worker", now: 10 })
      const running = (yield* startTaskRun(claimed!, "worker", 11))!
      const rawMessageID = MessageID.ascending("msg_raw_result")
      const finalMessageID = MessageID.ascending("msg_structured_result")
      yield* markTaskResearchCompleted(running, "worker", rawMessageID, 12)
      yield* markTaskFinalizing(running, "worker", 2, rawMessageID, 13)
      yield* markTaskFinalized(running, "worker", finalMessageID, 14)

      const winner = yield* settleTaskRun({
        run: running,
        owner: "worker",
        state: "completed",
        reason: "structured_output_valid",
        output: '{"answer":"ok"}',
        structuredResultMessageID: finalMessageID,
        notification: {
          directory: "/project",
          payload: { agent: "build", text: "complete" },
        },
        now: 15,
      })
      const loser = yield* settleTaskRun({
        run: running,
        owner: "worker",
        state: "error",
        reason: "provider_error",
        error: { code: "provider_error", message: "late failure" },
        now: 16,
      })

      expect(winner.won).toBe(true)
      expect(winner.run.rawResultMessageID).toBe(rawMessageID)
      expect(winner.run.structuredResultMessageID).toBe(finalMessageID)
      expect(loser.won).toBe(false)
      expect(loser.run.state).toBe("completed")
      expect(loser.run.output).toBe('{"answer":"ok"}')

      const { db } = yield* Database.Service
      expect(yield* db.select({ count: count() }).from(TaskNotificationOutboxTable).get().pipe(Effect.orDie)).toEqual({
        count: 1,
      })
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
