import { describe, expect } from "bun:test"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@deepagent-code/core/util/log"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessageTable } from "@deepagent-code/core/session/sql"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { GOAL_ROLLBACK_NOTICE, liveRollback, liveRollbackNotice } from "../../src/session/goal-loop-wiring"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  // QUAL-007: the core SessionProjector materializes event-created sessions; without it message
  // writes hit the session FK. It also folds SessionEvent.Synthetic into SessionMessageTable — the
  // "next loaded history" these notices assert against.
  SessionProjector.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  Storage.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  // Module-level constants: memoized by layer identity, so these are the SAME bus + connection the
  // Session/Revert layers above resolve internally (no split-brain).
  EventV2Bridge.defaultLayer,
  Database.defaultLayer,
)

const it = testEffect(env)

const user = Effect.fn("test.user")(function* (sessionID: SessionID, agent = "default") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent,
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
  })
})

/** Every Synthetic notice in the session's loaded history, in fold order. */
const syntheticNotices = Effect.fn("test.syntheticNotices")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ id: SessionMessageTable.id, data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "synthetic")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => ({ id: row.id, text: "text" in row.data ? row.data.text : undefined }))
})

describe("C2 user revert notice", () => {
  it.live(
    "revert lands exactly one Synthetic notice; unrevert is symmetric; deterministic id never duplicates",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const info = yield* sessions.create({ title: "revert notice" })
        const first = yield* user(info.id)
        yield* text(info.id, first.id, "first")
        const second = yield* user(info.id)
        yield* text(info.id, second.id, "second")

        yield* sessions.commitRevert({
          sessionID: info.id,
          revert: { messageID: first.id },
          summary: { additions: 0, deletions: 0, files: 0 },
        })
        const afterRevert = yield* syntheticNotices(info.id)
        expect(afterRevert).toHaveLength(1)
        expect(afterRevert[0]!.text).toBe(
          `The user reverted the conversation to message ${first.id}; all later messages and file changes were undone.`,
        )

        // Replay / re-publish with the same deterministic id is a no-op, not a duplicate.
        const { db } = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        yield* SessionInput.publishSyntheticNoticeOnce(db, events, {
          sessionID: info.id,
          messageID: afterRevert[0]!.id,
          text: "duplicate",
        })
        expect(yield* syntheticNotices(info.id)).toHaveLength(1)

        yield* sessions.commitUnrevert({ sessionID: info.id })
        const afterUnrevert = yield* syntheticNotices(info.id)
        expect(afterUnrevert).toHaveLength(2)
        expect(afterUnrevert[1]!.text).toBe("The user restored the previously reverted conversation.")

        // A NEW revert is a new mutation epoch → a distinct notice (the key is not over-deduped).
        yield* sessions.commitRevert({
          sessionID: info.id,
          revert: { messageID: second.id },
          summary: { additions: 0, deletions: 0, files: 0 },
        })
        const afterSecondRevert = yield* syntheticNotices(info.id)
        expect(afterSecondRevert).toHaveLength(3)
        expect(afterSecondRevert[2]!.text).toBe(
          `The user reverted the conversation to message ${second.id}; all later messages and file changes were undone.`,
        )

        // clearRevert is SessionRevert.cleanup's internal commit: it discards the reverted branch
        // PERMANENTLY (nothing is restored), so it must NOT land a false "restored" notice.
        yield* sessions.clearRevert(info.id)
        expect(yield* syntheticNotices(info.id)).toHaveLength(3)
      }),
    ),
  )
})

describe("B5 autonomous rollback notice", () => {
  it.live(
    "liveRollback publishes ONLY the B5 notice per (goalID, tick) — the C2 user-revert notice is suppressed on the autonomous path",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const { db } = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const info = yield* sessions.create({ title: "rollback notice" })
          const first = yield* user(info.id)
          yield* text(info.id, first.id, "edit one")

          const rollback = liveRollback(
            revert,
            (sid) =>
              sessions
                .messages({ sessionID: SessionID.make(sid) })
                .pipe(
                  Effect.map((msgs) => msgs.at(-1)?.info.id ?? null),
                  Effect.catchCause(() => Effect.succeed(null)),
                ),
            liveRollbackNotice(events, db),
          )

          yield* rollback({ goalId: "g-test", sessionId: info.id, reason: "critical failure at tick 2", tick: 2 })
          expect((yield* sessions.get(info.id)).revert).not.toBeNull()
          // Exactly ONE notice: the actor-accurate B5 one. The C2 "user reverted" notice is gated off
          // on the autonomous path — no double notice, no wrong attribution.
          const afterRollback = yield* syntheticNotices(info.id)
          expect(afterRollback).toHaveLength(1)
          expect(afterRollback[0]!.text).toBe(GOAL_ROLLBACK_NOTICE)

          // Same (goalID, tick) — e.g. a cold-tick re-execution after a crash — never duplicates.
          yield* rollback({ goalId: "g-test", sessionId: info.id, reason: "critical failure at tick 2", tick: 2 })
          expect(yield* syntheticNotices(info.id)).toHaveLength(1)

          // A different round is a different notice.
          yield* rollback({ goalId: "g-test", sessionId: info.id, reason: "critical failure at tick 3", tick: 3 })
          expect(yield* syntheticNotices(info.id)).toHaveLength(2)

          // The SAME SessionRevert entry point without the gate (genuine user revert) keeps the C2 notice.
          const third = yield* user(info.id)
          yield* text(info.id, third.id, "user edit")
          yield* revert.revert({ sessionID: info.id, messageID: third.id })
          const afterUserRevert = yield* syntheticNotices(info.id)
          expect(afterUserRevert).toHaveLength(3)
          expect(afterUserRevert[2]!.text).toBe(
            `The user reverted the conversation to message ${third.id}; all later messages and file changes were undone.`,
          )
        }),
      { git: true },
    ),
  )
})
