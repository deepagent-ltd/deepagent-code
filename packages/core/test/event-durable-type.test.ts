import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { durableType } from "@deepagent-code/core/event/define"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { testEffect } from "./lib/effect"

// Durable-log type authority. Synchronized events are STORED under a version-suffixed type
// (`session.next.tool.success.1`) while the definition's own `type` stays bare, so any query that
// filters the log by the bare name matches zero rows and silently degrades to "no evidence".
// Production paid for exactly that: the finalizer's attribution and validation harvest both
// filtered the bare tool names, so every settled activity reported
// `skipped: no_attributable_paths`. This pins the round trip so the drift cannot return.

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database, EventV2.layer.pipe(Layer.provide(database))))

const sessionID = SessionSchema.ID.make("ses_durable_type")

describe("durable event type authority", () => {
  it.effect("a synchronized definition is stored under its versioned type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1_700_000_000_000),
        assistantMessageID: SessionMessage.ID.make("msg_durable_type"),
        callID: "call_durable_type",
        structured: { resource: "workspace.ts" },
        content: [],
        provider: { executed: false },
      })

      const stored = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(stored.map((row) => row.type)).toEqual(["session.next.tool.success.1"])
      // The definition's bare name is NOT what the log contains — querying it yields nothing.
      expect(durableType(SessionEvent.Tool.Success)).toBe("session.next.tool.success.1")
      expect(durableType(SessionEvent.Tool.Success)).not.toBe(SessionEvent.Tool.Success.type)
      const byBare = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.type, SessionEvent.Tool.Success.type))
        .all()
        .pipe(Effect.orDie)
      expect(byBare).toEqual([])
    }),
  )

  it.effect("an unsynchronized definition keeps its bare type", () =>
    Effect.gen(function* () {
      // Input.Delta is live-only (no sync block): it must NOT be version-suffixed, otherwise the
      // versioned name would be unreachable for streamed deltas.
      expect(SessionEvent.Tool.Input.Delta.sync).toBeUndefined()
      expect(durableType(SessionEvent.Tool.Input.Delta)).toBe("session.next.tool.input.delta")
    }),
  )
})
