import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MessageTable,
  SessionTable,
  TaskNotificationOutboxTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageID, SessionID } from "../../src/session/schema"
import {
  admitParentInput,
  claimOutboxItem,
  deliverOne,
  reconcileExpiredProcessing,
} from "../../src/session/task-delivery"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)

const DIRECTORY = "/delivery_test_dir"
const PARENT_SESSION_ID = SessionID.make("ses_delivery_parent")
const OWNER = "delivery-test-owner"

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
      id: PARENT_SESSION_ID,
      project_id: ProjectV2.ID.global,
      slug: "delivery-parent",
      directory: DIRECTORY,
      title: "parent",
      version: "test",
      agent: "build",
      model: { providerID: "test", id: "model" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const seedOutbox = (suffix: string, now = 1_000) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const runID = `run_delivery_${suffix}`
    const childSessionID = SessionID.make(`ses_delivery_${suffix}`)
    const messageID = MessageID.ascending(`msg_task_notify_${suffix}`)
    const payload = { agent: "researcher", text: `Task ${suffix} completed.` }

    yield* db
      .insert(SessionTable)
      .values({
        id: childSessionID,
        project_id: ProjectV2.ID.global,
        parent_id: PARENT_SESSION_ID,
        slug: `delivery-child-${suffix}`,
        directory: DIRECTORY,
        title: `child-${suffix}`,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(TaskRunTable)
      .values({
        run_id: runID,
        request_hash: `hash-${suffix}`,
        parent_session_id: PARENT_SESSION_ID,
        parent_message_id: MessageID.ascending(`msg_delivery_parent_${suffix}`),
        tool_call_id: `call-${suffix}`,
        child_session_id: childSessionID,
        generation: 1,
        delivery_mode: "background",
        phase: "settled",
        state: "completed",
        version: 1,
        control_state: "closed",
        input_state: "ready",
        available_at: 0,
        start_attempts: 1,
        attempts: 1,
        time_created: now,
        time_updated: now,
        time_settled: now,
      } as any)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(TaskNotificationOutboxTable)
      .values({
        id: `task-notify:${runID}`,
        run_id: runID,
        message_id: messageID,
        parent_session_id: PARENT_SESSION_ID,
        directory: DIRECTORY,
        payload,
        status: "pending",
        attempts: 0,
        available_at: now,
        event_kind: "terminal",
        correlation_id: `task-notify:${runID}`,
        payload_hash: Hash.sha256(JSON.stringify(payload)),
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    return { runID, messageID }
  })

const assistantReceipt = (id: MessageID, parentID: MessageID, completed = 2_000) =>
  ({
    info: {
      id,
      sessionID: PARENT_SESSION_ID,
      role: "assistant",
      parentID,
      time: { created: completed - 1, completed },
    },
    parts: [],
  }) as unknown as SessionV1.WithParts

const persistReceipt = (receipt: SessionV1.WithParts) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(MessageTable)
      .values({
        id: receipt.info.id,
        session_id: PARENT_SESSION_ID,
        time_created: receipt.info.time.created,
        time_updated:
          "completed" in receipt.info.time
            ? (receipt.info.time.completed ?? receipt.info.time.created)
            : receipt.info.time.created,
        data: receipt.info as any,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("DET-DELIVERY-01 durable notification delivery", () => {
  it.effect("acks only after the exact terminal assistant receipt is persisted", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seedOutbox("persisted")
      const item = yield* claimOutboxItem({ ownerToken: OWNER, directory: DIRECTORY })
      if (!item) return yield* Effect.die("outbox item was not claimed")
      const response = assistantReceipt(MessageID.ascending("msg_delivery_response_persisted"), item.messageID)
      const databaseService = yield* Database.Service
      let providerCalls = 0

      const delivered = yield* deliverOne({
        item,
        ownerToken: OWNER,
        driveParentLoop: () =>
          persistReceipt(response).pipe(
            Effect.provideService(Database.Service, databaseService),
            Effect.tap(() => Effect.sync(() => providerCalls += 1)),
            Effect.as(response),
          ),
      })
      expect(delivered).toBe(true)
      expect(providerCalls).toBe(1)

      const { db } = yield* Database.Service
      const row = yield* db
        .select({ status: TaskNotificationOutboxTable.status, responseID: TaskNotificationOutboxTable.response_message_id })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toEqual({ status: "delivered", responseID: response.info.id })
    }),
  )

  it.effect("marks recovery_required when the loop returns a receipt that was not persisted", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seedOutbox("missing_receipt")
      const item = yield* claimOutboxItem({ ownerToken: OWNER, directory: DIRECTORY })
      if (!item) return yield* Effect.die("outbox item was not claimed")
      const response = assistantReceipt(MessageID.ascending("msg_delivery_response_missing"), item.messageID)

      expect(
        yield* deliverOne({ item, ownerToken: OWNER, driveParentLoop: () => Effect.succeed(response) }),
      ).toBe(false)
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ status: TaskNotificationOutboxTable.status, error: TaskNotificationOutboxTable.last_error })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.status).toBe("response_recovery_required")
      expect(row?.error).toContain("did not persist the exact terminal receipt")
      expect(yield* claimOutboxItem({ ownerToken: "other", directory: DIRECTORY, now: 9_999 })).toBeUndefined()
    }),
  )

  it.effect("reconciles an expired processing item from its persisted receipt without a provider replay", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seedOutbox("reconcile")
      const item = yield* claimOutboxItem({ ownerToken: OWNER, directory: DIRECTORY, now: 1_100, leaseMs: 100 })
      if (!item) return yield* Effect.die("outbox item was not claimed")
      const parentInputID = yield* admitParentInput({ item, ownerToken: OWNER, now: 1_101 })
      const response = assistantReceipt(MessageID.ascending("msg_delivery_response_reconcile"), parentInputID)
      yield* persistReceipt(response)

      const { db } = yield* Database.Service
      yield* db
        .update(TaskNotificationOutboxTable)
        .set({ status: "processing", response_started_at: 1_102, lease_expires_at: 1_150 })
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .run()
        .pipe(Effect.orDie)
      yield* reconcileExpiredProcessing({ directory: DIRECTORY, now: 1_200 })

      const row = yield* db
        .select({ status: TaskNotificationOutboxTable.status, responseID: TaskNotificationOutboxTable.response_message_id })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toEqual({ status: "delivered", responseID: response.info.id })
    }),
  )

  it.effect("leaves a pre-provider lease loss reclaimable instead of marking the item dead", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seedOutbox("claim_lost")
      const item = yield* claimOutboxItem({
        ownerToken: OWNER,
        directory: DIRECTORY,
        now: 1_100,
        leaseMs: 10,
      })
      if (!item) return yield* Effect.die("outbox item was not claimed")
      let providerCalls = 0

      expect(
        yield* deliverOne({
          item,
          ownerToken: OWNER,
          driveParentLoop: () =>
            Effect.sync(() => {
              providerCalls += 1
              return assistantReceipt(MessageID.ascending("msg_must_not_run"), item.messageID)
            }),
        }),
      ).toBe(false)
      expect(providerCalls).toBe(0)

      const { db } = yield* Database.Service
      const afterLoss = yield* db
        .select({ status: TaskNotificationOutboxTable.status })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(afterLoss?.status).toBe("admitting")

      const reclaimed = yield* claimOutboxItem({
        ownerToken: "replacement-owner",
        directory: DIRECTORY,
        now: 1_200,
      })
      expect(reclaimed?.id).toBe(item.id)
      expect(reclaimed?.attempts).toBe(item.attempts + 1)
    }),
  )
})
