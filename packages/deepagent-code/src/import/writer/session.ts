import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { ProjectV2 } from "@deepagent-code/core/project"
import type { SourceSession } from "../ir"
import { mapSession } from "../map/events"
import { sessionID } from "../util/ids"
import type { SessionImportResult } from "../types"

/**
 * Idempotently import one parsed session into the live deepagent-code database.
 *
 * Strategy (verified against `core/session/projector.ts` + `core/event.ts`):
 *   1. Resolve the session's cwd to the SAME project id deepagent-code itself
 *      uses (`ProjectV2.resolve` → git-remote hash, or git-root hash, or
 *      "global") and ensure that project row exists. This merges imported
 *      sessions into the user's real projects so they show in the sidebar when
 *      the matching directory is opened — no isolated `proj_imp_*` namespace.
 *   2. Delete any existing session row for this aggregate (FK cascade clears
 *      message/part/session_message/input/todo projections) and call
 *      `events.remove(aggregate)` to clear its event stream.
 *   3. `events.replayAll(serialized)` from seq 0 — the same path `sync.ts` uses,
 *      so all projectors (session/message/session_message) populate correctly.
 *
 * Because steps 2+3 run for the same stable aggregate id every time, re-running
 * an import fully replaces that session's history without duplicates.
 */
export const importSession = Effect.fn("Import.session")(function* (session: SourceSession) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const projectService = yield* ProjectV2.Service

  const aggregateID = sessionID(session.source, session.sourceId)

  // 1. resolve the REAL project id (matches native deepagent-code projects)
  const resolved = yield* projectService.resolve(AbsolutePath.make(session.cwd))
  const projectID = resolved.id
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make(resolved.directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  // 2. detect re-import, then clear prior state for a clean replay
  const prior = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID))).get().pipe(Effect.orDie)
  const reimport = !!prior
  if (prior) {
    yield* db.delete(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID))).run().pipe(Effect.orDie)
  }
  yield* events.remove(aggregateID).pipe(Effect.orDie)

  // 3. map + replay
  const serialized = mapSession(session, { projectID })
  yield* events.replayAll(serialized, { strictOwner: true }).pipe(Effect.orDie)

  const result: SessionImportResult = {
    sourceId: session.sourceId,
    targetId: aggregateID,
    turns: session.turns.length,
    reimport,
  }
  return result
})
