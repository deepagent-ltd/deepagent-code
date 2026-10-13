import { expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { MessageTable, PartTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"

function runtime(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  return Layer.mergeAll(database, events, projector)
}

const readAssistant = (messageID: string) => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(MessageTable)
    .where(eq(MessageTable.id, SessionV1.MessageID.make(messageID))).get().pipe(Effect.orDie)
  if (!row) return yield* Effect.die("Missing actual wire row")
  return Schema.decodeUnknownSync(SessionV1.Assistant)({ ...row.data, id: row.id, sessionID: row.session_id })
})

test("fileDB canonical settlement replaces pending wire time/usage while preserving Host extras, publication and reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dac-wire-settlement-test-"))
  const filename = path.join(root, "wire.sqlite")
  const sessionID = SessionV2.ID.make(`ses_wire_settlement_${crypto.randomUUID()}`)
  const model = { id: ModelV2.ID.make("deepseek-flash"), providerID: ProviderV2.ID.make("deepseek") }
  const turns = [
    { id: SessionMessage.ID.make("msg_wire_settlement_read"), created: 1791623105173, completed: 1791623105429,
      finish: "tool-calls", cost: 0.25,
      tokens: { input: 18285, output: 40, reasoning: 28, cache: { read: 512, write: 0 } } },
    { id: SessionMessage.ID.make("msg_wire_settlement_final"), created: 1791623106450, completed: 1791623106532,
      finish: "stop", cost: 0.125,
      tokens: { input: 478, output: 26, reasoning: 0, cache: { read: 18176, write: 0 } } },
  ]
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const observed: SessionV1.Assistant[] = []
      yield* events.listen((event) => Effect.sync(() => {
        if (event.type !== SessionV1.Event.MessageUpdated.type) return
        const info = (event.data as { info?: SessionV1.Info }).info
        if (info?.role === "assistant") observed.push(structuredClone(info))
      }))
      yield* db.insert(ProjectTable).values({ id: Project.ID.global,
        worktree: AbsolutePath.make(root), sandboxes: [] }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global,
        slug: "wire-settlement", directory: root, path: root, title: "Wire settlement", version: "test" })
        .run().pipe(Effect.orDie)
      const databaseNow = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
      const owner = `wire-owner-${crypto.randomUUID()}`
      yield* db.insert(SessionProviderOwnerLeaseTable).values({ owner_token: owner,
        registered_at: databaseNow, heartbeat_at: databaseNow,
        lease_expires_at: sql`${databaseNow} + 60000` }).run().pipe(Effect.orDie)
      // A fixture ownership marker selects the real V2 wire egress. No provider,
      // model executor, receipt terminal transition or Work admission is run.
      yield* db.insert(V2ProviderTurnReceiptTable).values({ receipt_id: `${owner}-receipt`, session_id: sessionID,
        request_ordinal: 1, activity_id: "act_wire_fixture", provider_turn_seq: 1,
        user_message_id: "msg_wire_settlement_user", history_prompt_epoch: 1,
        request_input_hash: "fixture", provider_id: "deepseek", model_id: "deepseek-flash",
        protocol: "openai-chat", owner_mode: "v2", owner_token: owner, state: "preparing", created_at: databaseNow })
        .run().pipe(Effect.orDie)
      yield* events.publish(SessionEvent.Prompted, { sessionID,
        messageID: SessionMessage.ID.make("msg_wire_settlement_user"),
        prompt: new Prompt({ text: "A local wire fixture" }), delivery: "steer", timestamp: DateTime.makeUnsafe(1) })
      for (const turn of turns) {
        yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: turn.id,
          timestamp: DateTime.makeUnsafe(turn.created), agent: "build", model })
        const pending = yield* readAssistant(turn.id)
        expect(pending.time.completed).toBeUndefined()
        expect(pending.tokens.input).toBe(0)
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
          ...pending, time: { created: turn.created - 1 }, providerID: ProviderV2.ID.make("stale-host"),
          modelID: ModelV2.ID.make("stale-model"), parentID: SessionV1.MessageID.make("msg_stale_parent"),
          path: { cwd: "/stale", root: "/stale" }, finish: "stale-host-finish", variant: "stale-host-variant",
          error: { name: "UnknownError", data: { message: "stale-host-error" } },
          structured: { hostOnly: turn.id }, providerAttemptID: `host-receipt-${turn.id}`,
        } })
        yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: turn.id,
          timestamp: DateTime.makeUnsafe(turn.completed), finish: turn.finish, cost: turn.cost, tokens: turn.tokens })
        const settled = yield* readAssistant(turn.id)
        expect(settled).toMatchObject({ time: { created: turn.created, completed: turn.completed },
          tokens: turn.tokens, cost: turn.cost, finish: turn.finish, providerID: "deepseek", modelID: "deepseek-flash",
          parentID: "msg_wire_settlement_user", path: { cwd: root, root },
          structured: { hostOnly: turn.id }, providerAttemptID: `host-receipt-${turn.id}` })
        expect(settled.error).toBeUndefined()
        expect(settled.variant).toBeUndefined()
        expect(observed.findLast((message) => message.id === SessionV1.MessageID.make(turn.id))).toMatchObject({
          time: { completed: turn.completed }, tokens: turn.tokens, cost: turn.cost,
        })
        const parts = yield* db.select().from(PartTable).where(eq(PartTable.message_id, SessionV1.MessageID.make(turn.id)))
          .all().pipe(Effect.orDie)
        expect(parts.find((part) => part.data.type === "step-finish")?.data).toMatchObject({
          reason: turn.finish, tokens: turn.tokens, cost: turn.cost,
        })
      }
      const aggregate = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(aggregate).toMatchObject({ cost: 0.375, tokens_input: 18763, tokens_output: 66,
        tokens_reasoning: 28, tokens_cache_read: 18688, tokens_cache_write: 0 })
      // Content re-derivation retains settlement and cannot count usage twice.
      for (const turn of turns) {
        const before = yield* readAssistant(turn.id)
        expect(before.time.completed).toBe(turn.completed)
        expect(before.tokens).toEqual(turn.tokens)
        yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: turn.id,
          timestamp: DateTime.makeUnsafe(turn.completed + 1), textID: `text-${turn.id}` })
        yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: turn.id,
          timestamp: DateTime.makeUnsafe(turn.completed + 2), textID: `text-${turn.id}`, text: "Exact projected content" })
        const after = yield* readAssistant(turn.id)
        expect(after.time).toEqual(before.time)
        expect(after.tokens).toEqual(before.tokens)
        yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: turn.id,
          timestamp: DateTime.makeUnsafe(turn.completed + 3), textID: `text-${turn.id}`, text: "Exact projected content" })
        expect(yield* readAssistant(turn.id)).toEqual(after)
      }
      const after = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(after).toMatchObject({ cost: 0.375, tokens_input: 18763, tokens_output: 66,
        tokens_reasoning: 28, tokens_cache_read: 18688, tokens_cache_write: 0 })
    }).pipe(Effect.scoped, Effect.provide(runtime(filename))))

    // Reopen only the physical SQLite file read-only. The fixture marker does
    // not model a provider attempt, so this is not a Session startup proof.
    {
      const { Database } = await import("bun:sqlite")
      const reopened = new Database(filename, { create: false, readonly: true })
      try {
      for (const turn of turns) {
        const row = reopened.query<{ data: string }, [string]>(
          "SELECT json_set(data,'$.id',id,'$.sessionID',session_id) AS data FROM message WHERE id = ?",
        ).get(turn.id)
        expect(row).not.toBeNull()
        const assistant = Schema.decodeUnknownSync(Schema.fromJsonString(SessionV1.Assistant))(row!.data)
        expect(assistant.time).toEqual({ created: turn.created, completed: turn.completed })
        expect(assistant.tokens).toEqual(turn.tokens)
        expect(assistant.cost).toBe(turn.cost)
      }
      expect(reopened.query(
        "SELECT cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session WHERE id = ?",
      ).get(sessionID)).toMatchObject({ cost: 0.375, tokens_input: 18763, tokens_output: 66,
        tokens_reasoning: 28, tokens_cache_read: 18688, tokens_cache_write: 0 })
      } finally {
        reopened.close()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
