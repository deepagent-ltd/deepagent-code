import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskNotificationOutboxTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import {
  acknowledgeDelivery,
  renewProcessingLease,
  type OutboxItem,
} from "../../src/session/task-delivery"
import { prepare } from "../../src/session/task-input"
import { MessageID, SessionID } from "../../src/session/schema"
import { admitTaskRun } from "../../src/tool/task-run"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const it = testEffect(database)
const directory = "/wave3_durability"
const parentSessionID = SessionID.make("ses_wave3_parent")

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
      slug: "wave3-parent",
      directory,
      title: "parent",
      version: "test",
      agent: "build",
      model: { providerID: "test-provider", id: "test-model" },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("wave-3 durable control-plane regressions", () => {
  it.effect("materializes the same schema-valid child input envelope on exact retry", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admitTaskRun({
        parentSessionID,
        parentMessageID: MessageID.ascending("msg_wave3_parent_input"),
        toolCallID: "call_wave3_prepare",
        request: { description: "inspect exact projection" },
        deliveryMode: "foreground",
        now: 1_000,
        executionSpec: {
          prompt: { text: "Inspect the durable input." },
          agent: "researcher",
          model: { providerID: "test-provider", modelID: "test-model", variant: "precise" },
          tools: { read: true, edit: false },
          permission: [],
        },
      })

      const first = yield* prepare(admission.run)
      const retry = yield* prepare(admission.run)
      const decoded = Schema.decodeUnknownSync(SessionV1.User)({
        id: first.messageID,
        sessionID: SessionID.make(first.sessionID),
        ...first.messageData,
      })

      expect(first.messageID === admission.run.childMessageID).toBe(true)
      expect(retry.messageID).toBe(first.messageID)
      expect(retry.parts[0]?.partID === first.parts[0]?.partID).toBe(true)
      expect(retry.materializedHash).toBe(first.materializedHash)
      expect(decoded.agent).toBe("researcher")
      expect(String(decoded.model.providerID)).toBe("test-provider")
      expect(String(decoded.model.modelID)).toBe("test-model")
      expect(decoded.model.variant).toBe("precise")
      expect(decoded.tools).toEqual({ read: true, edit: false })
    }),
  )

  it.effect("renews and acknowledges a processing item only through its live owner fence", () =>
    Effect.gen(function* () {
      yield* setup
      const admission = yield* admitTaskRun({
        parentSessionID,
        parentMessageID: MessageID.ascending("msg_wave3_delivery_parent"),
        toolCallID: "call_wave3_delivery",
        request: { description: "deliver result" },
        deliveryMode: "background",
        now: 1_000,
      })
      const payload = { agent: "researcher", text: "Background task completed." }
      const item = {
        id: `task-notify:${admission.run.runID}`,
        runID: admission.run.runID,
        correlationID: `task-notify:${admission.run.runID}`,
        messageID: MessageID.ascending("msg_wave3_notification"),
        parentSessionID,
        directory,
        payload,
        payloadHash: Hash.sha256(JSON.stringify(payload)),
        attempts: 1,
        timeCreated: 1_000,
      } satisfies OutboxItem
      const { db } = yield* Database.Service
      yield* db
        .insert(TaskNotificationOutboxTable)
        .values({
          id: item.id,
          run_id: item.runID,
          message_id: item.messageID,
          parent_session_id: item.parentSessionID,
          directory: item.directory,
          payload: item.payload,
          status: "processing",
          attempts: item.attempts,
          available_at: 1_000,
          lease_owner: "wave3-owner",
          lease_expires_at: 1_200,
          event_kind: "terminal",
          correlation_id: item.correlationID,
          payload_hash: item.payloadHash,
          parent_input_message_id: item.messageID,
          response_started_at: 1_050,
          time_created: item.timeCreated,
          time_updated: 1_050,
        })
        .run()
        .pipe(Effect.orDie)

      yield* renewProcessingLease({
        item,
        ownerToken: "wave3-owner",
        leaseMs: 300,
        now: 1_100,
      })
      const renewed = yield* db
        .select({ leaseExpiresAt: TaskNotificationOutboxTable.lease_expires_at })
        .from(TaskNotificationOutboxTable)
        .where(eq(TaskNotificationOutboxTable.id, item.id))
        .get()
        .pipe(Effect.orDie)
      expect(renewed?.leaseExpiresAt).toBe(1_400)

      const staleOwner = yield* renewProcessingLease({
        item,
        ownerToken: "replacement-owner",
        leaseMs: 300,
        now: 1_150,
      }).pipe(
        Effect.as("renewed" as const),
        Effect.catchTag("TaskDelivery.Conflict", () => Effect.succeed("fenced" as const)),
      )
      expect(staleOwner).toBe("fenced")
      expect(
        yield* acknowledgeDelivery({
          item,
          ownerToken: "wave3-owner",
          responseMessageID: MessageID.ascending("msg_wave3_response"),
          now: 1_401,
        }),
      ).toBe(false)
      expect(
        yield* acknowledgeDelivery({
          item,
          ownerToken: "wave3-owner",
          responseMessageID: MessageID.ascending("msg_wave3_response"),
          now: 1_200,
        }),
      ).toBe(true)
    }),
  )
})
