import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { testEffect } from "../lib/effect"

// V2 IM durable-only — the admission half (src/im/im-agent-execution.ts). The durable execution
// record for a mention IS the `session_input` row: keyed by the deterministic prompt message id for
// (IM message, agent), so a duplicate delivery of the same mention reconciles as a SessionV2 exact
// retry (ONE row, never two) and a conflicting prompt under the same id fails typed. Session
// identity is stable per (group, agent): follow-up mentions adopt the same session.

const root = mkdtempSync(`${os.tmpdir()}/im-agent-execution-`)
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
// Noop execution: admission is durable; the advisory wake does not need a drain for these tests.
const v2Session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)
const it = testEffect(Layer.mergeAll(database, events, projector, store, projects, v2Session))

const mention = {
  groupID: "grp_im_test",
  messageID: "im_msg_1",
  agent: "auto",
  senderID: "user-1",
  content: "@auto please answer",
  directory: root,
}

const inputRowCount = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie)).length
  })

describe("IMAgentExecution.admitMention (durable admission)", () => {
  it.effect("a duplicate mention delivery reconciles as an exact retry — exactly one session_input", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const first = yield* IMAgentExecution.admitMention(session, mention)
      const duplicate = yield* IMAgentExecution.admitMention(session, mention)

      // Same session, same admitted row — the second call is an exact-retry no-op.
      expect(duplicate.sessionID).toBe(first.sessionID)
      expect(duplicate.admitted.id).toBe(first.admitted.id)
      expect(duplicate.admitted.admittedSeq).toBe(first.admitted.admittedSeq)
      expect(yield* inputRowCount(first.sessionID)).toBe(1)
      expect(first.sessionID.startsWith("ses_im_")).toBe(true)
    }),
  )

  it.effect("a conflicting prompt under the same mention id fails typed instead of mutating the work", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* IMAgentExecution.admitMention(session, mention)
      const conflict = yield* Effect.flip(
        IMAgentExecution.admitMention(session, { ...mention, content: "@auto DIFFERENT content" }),
      )
      expect(conflict).toBeInstanceOf(SessionV2.PromptConflictError)
      // The original admission is untouched.
      expect(yield* inputRowCount(IMAgentExecution.imSessionIDFor(mention.groupID, mention.agent))).toBe(1)
    }),
  )

  it.effect("follow-up mentions adopt the stable (group, agent) session; a different agent gets its own", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const first = yield* IMAgentExecution.admitMention(session, mention)
      const followUp = yield* IMAgentExecution.admitMention(session, { ...mention, messageID: "im_msg_2" })
      const otherAgent = yield* IMAgentExecution.admitMention(session, { ...mention, messageID: "im_msg_2", agent: "general" })

      // Same (group, agent) lane: one session, two durable inputs (steer coalescing is downstream).
      expect(followUp.sessionID).toBe(first.sessionID)
      expect(yield* inputRowCount(first.sessionID)).toBe(2)
      // A different mentioned agent is a different conversation lane.
      expect(otherAgent.sessionID).not.toBe(first.sessionID)

      // The session carries the IM binding the reply collector reads back.
      const info = yield* session.get(first.sessionID)
      expect(IMAgentExecution.imSessionMetadata(info)).toEqual({ groupID: mention.groupID, agent: mention.agent })
    }),
  )
})
