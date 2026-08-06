import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { MessageTable, PartTable, SessionIntentTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { SessionMutationEpoch } from "../../src/session/mutation-epoch"
import { SessionPromptIntent } from "../../src/session/prompt-intent"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const sessionID = SessionID.make("ses_prompt_intent_test")

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
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: "intent-test",
      directory: "/project",
      title: "intent-test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const claim = (input: {
  intentID: string
  messageID: MessageID
  variant?: SessionPromptIntent.Variant
  payloadHash?: string
  source?: SessionPromptIntent.Source
}) =>
  SessionPromptIntent.claim({
    intentID: input.intentID,
    sessionID,
    source: input.source ?? "composer",
    variant: input.variant ?? "original",
    payloadHash: input.payloadHash ?? "payload-a",
    messageID: input.messageID,
  })

const message = (messageID: MessageID): { info: SessionV1.User; parts: SessionV1.Part[] } => ({
  info: {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  },
  parts: [
    {
      id: PartID.make(`prt_${messageID}`),
      messageID,
      sessionID,
      type: "text",
      text: "atomic prompt",
    },
  ],
})

describe("SessionPromptIntent", () => {
  it.effect("exact retry with a different transport message ID returns the original admission", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_exact", messageID: MessageID.make("msg_exact_first") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "turn",
      })

      const retry = yield* claim({ intentID: "intent_exact", messageID: MessageID.make("msg_exact_retry") })
      expect(retry.kind).toBe("admitted")
      expect(String(retry.receipt.messageID)).toBe("msg_exact_first")
    }),
  )

  it.effect("a concurrent claimant cannot execute the same intent", () =>
    Effect.gen(function* () {
      yield* setup
      yield* claim({ intentID: "intent_in_progress", messageID: MessageID.make("msg_in_progress") })
      const error = yield* claim({
        intentID: "intent_in_progress",
        messageID: MessageID.make("msg_other_transport"),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.InProgress)
    }),
  )

  it.effect("variant or payload changes conflict instead of creating a second admission", () =>
    Effect.gen(function* () {
      yield* setup
      yield* SessionPromptIntent.prepare({ intentID: "intent_variant", sessionID, source: "intelligence" })
      yield* claim({
        intentID: "intent_variant",
        messageID: MessageID.make("msg_variant"),
        source: "intelligence",
      })
      const error = yield* claim({
        intentID: "intent_variant",
        messageID: MessageID.make("msg_variant_retry"),
        source: "intelligence",
        variant: "rewritten",
        payloadHash: "payload-b",
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.Conflict)
    }),
  )

  it.effect("different intents may admit identical payloads", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_same_text_a", messageID: MessageID.make("msg_same_a") })
      const second = yield* claim({ intentID: "intent_same_text_b", messageID: MessageID.make("msg_same_b") })
      expect(first.kind).toBe("claimed")
      expect(second.kind).toBe("claimed")
      const { db } = yield* Database.Service
      const rows = yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)
      expect(rows.filter((row) => row.intent_id.startsWith("intent_same_text_"))).toHaveLength(2)
    }),
  )

  it.effect("direct message, parts, and admitted receipt commit atomically and ACK retry is exact", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_atomic", messageID: MessageID.make("msg_atomic") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const admitted = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      })
      expect(admitted.state).toBe("admitted")
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "turn",
      })

      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, first.receipt.messageID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, first.receipt.messageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      const retry = yield* claim({ intentID: "intent_atomic", messageID: MessageID.make("msg_atomic_retry") })
      expect(retry.kind).toBe("admitted")
      expect(retry.receipt.messageID).toBe(first.receipt.messageID)
    }),
  )

  it.effect("a revert epoch prevents an old direct request from materializing any message", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_stale", messageID: MessageID.make("msg_stale") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ mutation_epoch: first.receipt.mutationEpoch + 1 })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const error = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionMutationEpoch.Stale)
      expect(
        yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, first.receipt.messageID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("a conflicting message ID rolls back parts and keeps the intent unadmitted", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_conflict", messageID: MessageID.make("msg_conflict") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      const conflict: typeof MessageTable.$inferInsert = {
        id: first.receipt.messageID,
        session_id: sessionID,
        data: {
          role: "user",
          time: { created: 1 },
          agent: "other",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } as typeof MessageTable.$inferInsert.data,
      }
      yield* db.insert(MessageTable).values(conflict).run().pipe(Effect.orDie)
      const error = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.Conflict)
      expect(
        yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, first.receipt.messageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, first.receipt.intentID))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitting")
    }),
  )

  it.effect("ACK-loss recovery reconciles the reserved direct message without re-execution", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_ack_loss", messageID: MessageID.make("msg_ack_loss") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      const message: typeof MessageTable.$inferInsert = {
        id: first.receipt.messageID,
        session_id: sessionID,
        time_created: 1,
        data: {
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } as typeof MessageTable.$inferInsert.data,
      }
      yield* db.insert(MessageTable).values(message).run().pipe(Effect.orDie)

      const retry = yield* claim({
        intentID: "intent_ack_loss",
        messageID: MessageID.make("msg_ack_loss_retry"),
      })
      expect(retry.kind).toBe("admitted")
      expect(String(retry.receipt.messageID)).toBe("msg_ack_loss")
    }),
  )

  it.effect("complete with goal_steer delivery stamps the correct delivery in the database", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_goal_steer", messageID: MessageID.make("msg_goal_steer") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "goal_steer",
      })
      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, "intent_goal_steer"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitted")
      expect(intent?.delivery).toBe("goal_steer")
    }),
  )

  it.effect("complete with queue delivery stamps the correct delivery in the database", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_queue", messageID: MessageID.make("msg_queue") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "queue",
      })
      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, "intent_queue"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitted")
      expect(intent?.delivery).toBe("queue")
    }),
  )
})
