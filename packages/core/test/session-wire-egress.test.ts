import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { ModelV2 } from "@deepagent-code/core/model"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import {
  MessageTable,
  PartTable,
  SessionTable,
  SessionWireProjectionTable,
} from "@deepagent-code/core/session/sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { testEffect } from "./lib/effect"

// W4-6 — the journal→V1-wire projection egress. The single production line folds session.next
// events into SessionMessageTable and derives V1 wire rows from that folded state; these tests
// pin the egress contract: wire rows land after the fold, the durable fingerprint cursor
// suppresses byte-identical re-derivations, and completed steps carry the synthesized
// step-finish wire part.

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))

const zero = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const wireID = SessionV1.MessageID.make

// Each test owns a distinct session: the event table's (aggregate_id, seq) is unique, so a
// shared sessionID would collide on seq 0 across tests.
const seedSession = (sessionID: SessionV2.ID, placement?: { directory: string; path: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: placement?.directory ?? "/project",
        path: placement?.path ?? "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

// Marks the session V2-owned: a v2 owner-mode turn receipt exists, which opens the egress's
// assistant message-info publishing (legacy/host-owned sessions keep host-authored rows).
const seedV2Ownership = (sessionID: SessionV2.ID, token: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // The lease CHECK requires database-observed time (julianday('now')), not client clocks.
    const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
    yield* db
      .insert(SessionProviderOwnerLeaseTable)
      .values({
        owner_token: token,
        registered_at: databaseNow,
        heartbeat_at: databaseNow,
        lease_expires_at: sql`${databaseNow} + 60000`,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(V2ProviderTurnReceiptTable)
      .values({
        receipt_id: `${token}_receipt`,
        session_id: sessionID,
        request_ordinal: 1,
        activity_id: "act_egress",
        provider_turn_seq: 1,
        user_message_id: "msg_wire_user",
        history_prompt_epoch: 1,
        request_input_hash: "hash",
        provider_id: "fake",
        model_id: "model",
        protocol: "openai-chat",
        owner_mode: "v2",
        owner_token: token,
        // Admission trigger: receipts enter as preparing with created_at < lease expiry; the
        // settled transition is not needed for the egress's ownership check.
        state: "preparing",
        created_at: databaseNow,
      })
      .run()
      .pipe(Effect.orDie)
  })

const wireMessageRole = (messageID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(eq(MessageTable.id, wireID(messageID)))
      .get()
      .pipe(Effect.orDie)
    return (row?.data as { role?: string } | undefined)?.role
  })

const wireCursorCount = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ entity: SessionWireProjectionTable.entity })
      .from(SessionWireProjectionTable)
      .where(eq(SessionWireProjectionTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

describe("SessionProjector wire egress (W4-6)", () => {
  it.effect("projects an absolute worktree root from the session's relative subpath", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const [sessionID, directory, subpath, root] of [
        ["ses_wire_worktree_root", "/project/worktrees/child", "", "/project/worktrees/child"],
        ["ses_wire_nested_root", "/project/src/nested", "src/nested", "/project"],
        ["ses_wire_legacy_root", "/project/src", "/project", "/project"],
        ["ses_wire_foreign_root", "/project/src", "/foreign", "/project/src"],
        ["ses_wire_unknown_parent", "/project/sibling", "../sibling", "/project/sibling"],
      ] as const) {
        const id = SessionV2.ID.make(sessionID)
        const assistantID = SessionMessage.ID.make(`msg_${sessionID}_assistant`)
        yield* seedSession(id, { directory, path: subpath })
        yield* seedV2Ownership(id, `owner_${sessionID}`)
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: id,
          messageID: SessionMessage.ID.make(`msg_${sessionID}_user`),
          prompt: new Prompt({ text: "where am I?" }),
          delivery: "steer",
          timestamp: zero,
        })
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: id,
          timestamp: DateTime.makeUnsafe(1),
          assistantMessageID: assistantID,
          agent: "build",
          model,
        })
        const wire = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, wireID(assistantID)))
          .get()
          .pipe(Effect.orDie)
        expect((wire?.data as { path?: { cwd: string; root: string } } | undefined)?.path).toEqual({
          cwd: directory,
          root,
        })
      }
    }),
  )

  it.effect("derives wire rows for a prompted user message and an assistant step", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_wire_basic")
      yield* seedSession(sessionID)
      yield* seedV2Ownership(sessionID, "owner_wire_basic")
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_wire_user"),
        prompt: new Prompt({ text: "hello wire" }),
        delivery: "steer",
        timestamp: zero,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_wire_assistant"),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make("msg_wire_assistant"),
        textID: "txt_wire_1",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: SessionMessage.ID.make("msg_wire_assistant"),
        textID: "txt_wire_1",
        text: "wire reply",
      })

      expect(yield* wireMessageRole("msg_wire_user")).toBe("user")
      expect(yield* wireMessageRole("msg_wire_assistant")).toBe("assistant")
      expect(yield* wireCursorCount(sessionID)).toBeGreaterThan(0)
    }),
  )

  it.effect("fingerprint cursor suppresses byte-identical re-derivation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_wire_dedupe")
      yield* seedSession(sessionID)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_wire_dedupe_user"),
        prompt: new Prompt({ text: "dedupe me" }),
        delivery: "steer",
        timestamp: zero,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_wire_dedupe"),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make("msg_wire_dedupe"),
        textID: "txt_dedupe",
      })
      // Two identical Text.Ended boundaries fold to the same SessionMessage content; the wire
      // egress re-derives a byte-identical part and the fingerprint cursor must skip the second
      // publish (cursor row count stays put between the two).
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: SessionMessage.ID.make("msg_wire_dedupe"),
        textID: "txt_dedupe",
        text: "stable",
      })
      const afterFirst = yield* wireCursorCount(sessionID)
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        assistantMessageID: SessionMessage.ID.make("msg_wire_dedupe"),
        textID: "txt_dedupe",
        text: "stable",
      })
      const afterSecond = yield* wireCursorCount(sessionID)
      expect(afterSecond).toBe(afterFirst)
      expect(afterFirst).toBeGreaterThan(0)
    }),
  )

  it.effect("a completed assistant step carries the synthesized step-finish wire part", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_wire_finish")
      yield* seedSession(sessionID)
      yield* seedV2Ownership(sessionID, "owner_wire_finish")
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_wire_finish_user"),
        prompt: new Prompt({ text: "finish me" }),
        delivery: "steer",
        timestamp: zero,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_wire_finish_assistant"),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make("msg_wire_finish_assistant"),
        finish: "stop",
        cost: 0.25,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const { db } = yield* Database.Service
      const finishPart = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(eq(PartTable.message_id, wireID("msg_wire_finish_assistant")))
        .all()
        .pipe(Effect.orDie)
      expect(finishPart.some((row) => row.id.includes("finish"))).toBe(true)
    }),
  )
})
