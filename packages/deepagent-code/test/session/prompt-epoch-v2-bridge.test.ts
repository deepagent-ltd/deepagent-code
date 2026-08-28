import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { PromptEpoch } from "@/session/prompt-epoch"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { testEffect } from "../lib/effect"

// §16.3 order 4 — the V2 turn receipt history-window identity bridge: the lookup feeds the runner
// seam (CurrentHistoryEpochLookup) with the durable PromptEpoch active row. Read-only contract:
// absent epoch (pre-bootstrap / fresh V2-driven child) returns undefined so the runner keeps its
// pre-seam ContextEpoch-revision identity; retired rows never count.
const it = testEffect(Database.defaultLayer)

// The test database is the shared file-backed store; keep session IDs unique per run so repeated
// runs never collide on the one-active-epoch-per-session constraint.
const runID = randomUUID()

// The prompt_epoch insert trigger requires the owning session row (prompt_epoch_session_missing).
const insertSession = (sessionID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID as never,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "epoch bridge test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const insertEpoch = (input: { sessionID: string; epoch: number; state: "active" | "retired" }) =>
  Effect.gen(function* () {
    yield* insertSession(input.sessionID)
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionPromptEpochTable)
      .values({
        session_id: input.sessionID,
        epoch: input.epoch,
        state: input.state,
        reason: input.epoch === 0 ? "bootstrap" : "compaction",
        created_at: Date.now(),
      })
      .pipe(Effect.orDie)
  })

describe("PromptEpoch.historyEpochLookup (§16.3 order 4 V2 receipt identity bridge)", () => {
  it.effect("returns the active epoch for the session", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = `ses_eb_active_${runID}`
      yield* insertEpoch({ sessionID, epoch: 3, state: "active" })
      const epoch = yield* PromptEpoch.historyEpochLookup(database)(sessionID)
      expect(epoch).toBe(3)
    }),
  )

  it.effect("returns undefined when no epoch row exists (pre-bootstrap / V2-only child)", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const epoch = yield* PromptEpoch.historyEpochLookup(database)(`ses_eb_missing_${runID}`)
      expect(epoch).toBeUndefined()
    }),
  )

  it.effect("ignores retired epochs and reads the active one only", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = `ses_eb_retired_${runID}`
      yield* insertEpoch({ sessionID, epoch: 1, state: "retired" })
      yield* insertEpoch({ sessionID, epoch: 2, state: "retired" })
      expect(yield* PromptEpoch.historyEpochLookup(database)(sessionID)).toBeUndefined()
      yield* insertEpoch({ sessionID, epoch: 3, state: "active" })
      const epoch = yield* PromptEpoch.historyEpochLookup(database)(sessionID)
      expect(epoch).toBe(3)
    }),
  )
})
