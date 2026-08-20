/**
 * BUG-407-010 §13.3 / REL-002 — a giant user-message summary must not multiply through the
 * `message.updated` sync stream. The durable message authority keeps the full summary (inline
 * patch bodies included), but every published/replayed event carries only the bounded client
 * projection (patch bodies stripped, diff descriptors capped), so updating the same message 20
 * times yields 20 bounded events whose cumulative bytes never scale with the patch body.
 *
 * Everything is driven through the real `Session.updateMessage` state machine and the real
 * EventV2 sync persistence; no authority rows are inserted directly.
 */
import { expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { EventTable } from "@deepagent-code/core/event/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { MessageTable } from "@deepagent-code/core/session/sql"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(
  Session.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionProjector.defaultLayer,
  SessionProviderOwner.layer.pipe(Layer.provide(Database.defaultLayer)),
  LocationIdentity.defaultLayer,
)
const it = testEffect(layer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") }

const PATCH_MARKER = "GIANT_PATCH_MARKER"
const PATCH_LINES = 64
const DIFF_COUNT = MessageV2.ClientDiffLimits.files + 300
const UPDATES = 20

it.instance(
  "20 updates of a giant message keep every message.updated event bounded (no patch multiplication)",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* TestInstance
      const session = yield* sessions.create({ title: "giant message event budget" })
      const messageID = MessageID.ascending()

      const patchBody = Array.from({ length: PATCH_LINES }, (_, line) => `${PATCH_MARKER}:${line}`).join("\n")
      const diffs = Array.from({ length: DIFF_COUNT }, (_, index) => ({
        file: `generated/file-${String(index).padStart(4, "0")}.txt`,
        additions: PATCH_LINES,
        deletions: 0,
        patch: patchBody,
      }))
      const patchBytesPerUpdate = Buffer.byteLength(patchBody) * DIFF_COUNT

      const eventsBefore = yield* db
        .select({ count: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .all()
        .pipe(Effect.orDie)

      for (let update = 0; update < UPDATES; update += 1) {
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model,
          summary: { additions: PATCH_LINES * DIFF_COUNT, deletions: 0, files: DIFF_COUNT, diffs },
        } as never)
      }

      const rows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const updated = rows.filter((row) => row.type === "message.updated.1")
      expect(updated.length).toBe(UPDATES)
      expect(rows.length).toBe(eventsBefore.length + UPDATES)

      const encoded = updated.map((row) => JSON.stringify(row.data))
      for (const json of encoded) expect(json).not.toContain(PATCH_MARKER)

      const projectionBytes = encoded.map((json) => Buffer.byteLength(json))
      const maxBytes = Math.max(...projectionBytes)
      // Each event must stay far below both one update's patch body and the 4 MiB encoded
      // payload gate, independent of how large the patch is.
      expect(maxBytes).toBeLessThan(patchBytesPerUpdate / 4)
      expect(maxBytes).toBeLessThan(1024 * 1024)

      // BUG-407-010 §13.3: cumulative event bytes must not multiply with the patch body —
      // 20 bounded projections stay under a single update's patch total.
      const cumulativeBytes = projectionBytes.reduce((total, bytes) => total + bytes, 0)
      expect(cumulativeBytes).toBeLessThan(patchBytesPerUpdate)

      for (const row of updated) {
        const info = row.data["info"] as { summary?: { diffs?: Array<Record<string, unknown>> } }
        const projected = info.summary?.diffs ?? []
        expect(projected.length).toBe(MessageV2.ClientDiffLimits.files)
        for (const item of projected) expect(Object.keys(item)).not.toContain("patch")
      }

      // The durable authority still owns the full summary; only the wire projection is bounded.
      const stored = yield* db
        .select({ data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      expect(JSON.stringify(stored?.data)).toContain(PATCH_MARKER)
    }),
  { timeout: 30_000 },
)
