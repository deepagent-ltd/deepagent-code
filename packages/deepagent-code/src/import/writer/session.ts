import { Effect } from "effect"
import { and, eq, or } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionInputTable, SessionSteerTable, SessionTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { ProjectV2 } from "@deepagent-code/core/project"
import type { SourceSession } from "../ir"
import { mapSession } from "../map/events"
import { eventID, sessionID } from "../util/ids"
import type { SessionImportResult } from "../types"
import { ImportBatchReceiptTable } from "@deepagent-code/core/import-job.sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"

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
 * an import replaces only untouched imported history. Adopted or locally changed
 * conversations are preserved and reported as protected.
 */
// True when `dir` is a filesystem root ("/" or a Windows drive/UNC root). Mirrors
// project/instance-context.isFilesystemRoot without pulling node:path into this module's
// dependency surface; the check is the same (strip trailing separators → empty or bare drive).
function isFilesystemRootPath(dir: string): boolean {
  const trimmed = dir.trim()
  if (!trimmed) return false
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized === "" || /^[A-Za-z]:$/.test(normalized)
}

export const importSession = Effect.fn("Import.session")(function* (
  session: SourceSession,
  receipt?: { jobID: string; batchID: string; sourceDigest: string; assertAuthority?: Effect.Effect<void, Error> },
) {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const projectService = yield* ProjectV2.Service

  const aggregateID = sessionID(session.source, session.sourceId)

  // Fail-closed: never import a session whose OWN cwd is a filesystem root ("/"). The session's
  // directory becomes its route/instance directory, and the boot guard (assertSafeInstanceRoot)
  // rejects a root-rooted directory — so such a session could never be opened and would surface as
  // a permanent "unexpected server error". Note we check the SOURCE cwd, not the resolved project
  // directory: a non-git session legitimately maps to the `global` project whose worktree sentinel
  // is "/" (handled safely by containsPath), and that must still import. Per-session imports are
  // isolated (Effect.either upstream), so failing here skips just this one and records a warning.
  if (isFilesystemRootPath(session.cwd)) {
    return yield* Effect.fail(
      new Error(
        `refusing to import session ${session.sourceId}: its cwd is the filesystem root (${JSON.stringify(session.cwd)})`,
      ),
    )
  }

  // 1. resolve the REAL project id (matches native deepagent-code projects)
  const resolved = yield* projectService.resolve(AbsolutePath.make(session.cwd))
  const projectID = resolved.id
  const serialized = mapSession(session, { projectID })
  // Replacement and its receipt are one batch. Cancellation cannot land between deletion
  // and replay; a crash rolls back both, including an existing imported conversation.
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          if (receipt?.assertAuthority) yield* receipt.assertAuthority
          if (receipt) {
            const priorReceipt = yield* db
              .select()
              .from(ImportBatchReceiptTable)
              .where(
                and(
                  eq(ImportBatchReceiptTable.job_id, receipt.jobID),
                  eq(ImportBatchReceiptTable.batch_id, receipt.batchID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (priorReceipt) {
              if (priorReceipt.source_digest !== receipt.sourceDigest || priorReceipt.target_id !== aggregateID)
                return yield* Effect.die(
                  new Error("IMPORT_BATCH_CONFLICT: receipt belongs to different source content"),
                )
              if ("kind" in priorReceipt.result)
                return yield* Effect.fail(new Error("IMPORT_BATCH_CONFLICT: session batch has a file receipt"))
              return priorReceipt.result
            }
          }
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make(resolved.directory), sandboxes: [] })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)

          // 2. detect re-import, then clear prior state for a clean replay
          const reimport = yield* assertReplaceableSession(session)
          const prior = reimport
          if (prior) {
            yield* db
              .delete(SessionTable)
              .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
              .run()
              .pipe(Effect.orDie)
          }
          yield* events.remove(aggregateID).pipe(Effect.orDie)

          // 3. map + replay
          yield* events.replayAll(serialized, { strictOwner: true }).pipe(Effect.orDie)

          const result: SessionImportResult = {
            sourceId: session.sourceId,
            targetId: aggregateID,
            turns: session.turns.length,
            reimport,
          }
          if (receipt)
            yield* db
              .insert(ImportBatchReceiptTable)
              .values({
                job_id: receipt.jobID,
                batch_id: receipt.batchID,
                source_id: session.sourceId,
                source_digest: receipt.sourceDigest,
                target_id: aggregateID,
                result,
                committed_at: Date.now(),
              })
              .run()
              .pipe(Effect.orDie)
          return result
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie, Effect.uninterruptible)
})

/** Read-only preflight; the writer repeats this under its BEGIN IMMEDIATE transaction.
 * The database writer lock also serializes native adoption/admission. The import flock
 * only excludes other import jobs and must never be treated as a Session execution lock.
 */
export const assertReplaceableSession = Effect.fn("Import.assertReplaceableSession")(function* (
  session: SourceSession,
) {
  const db = (yield* Database.Service).db
  const id = SessionSchema.ID.make(sessionID(session.source, session.sourceId))
  const prior = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
  if (!prior) return false
  const refuse = () =>
    Effect.fail(
      new Error(
        `IMPORT_SESSION_PROTECTED: ${id} has been adopted, changed locally, or cannot be proven to be untouched imported history`,
      ),
    )
  if (
    prior.v2_authority ||
    prior.execution_claim_token !== null ||
    prior.mutation_epoch !== 0 ||
    prior.interrupt_seq !== null ||
    prior.parent_id !== null ||
    prior.workspace_id !== null ||
    prior.time_archived !== null ||
    prior.time_compacting !== null ||
    prior.revert !== null ||
    prior.metadata?.importedFrom !== session.source ||
    prior.metadata?.sourceSessionId !== session.sourceId
  )
    return yield* refuse()
  const inputs = yield* db
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, id))
    .all()
    .pipe(Effect.orDie)
  const steer = yield* db
    .select({ id: SessionSteerTable.id })
    .from(SessionSteerTable)
    .where(eq(SessionSteerTable.session_id, id))
    .get()
    .pipe(Effect.orDie)
  const task = yield* db
    .select({ id: TaskRunTable.run_id })
    .from(TaskRunTable)
    .where(or(eq(TaskRunTable.parent_session_id, id), eq(TaskRunTable.child_session_id, id)))
    .get()
    .pipe(Effect.orDie)
  const child = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, id))
    .get()
    .pipe(Effect.orDie)
  if (steer || task || child) return yield* refuse()
  const sequence = yield* db
    .select()
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, id))
    .get()
    .pipe(Effect.orDie)
  if (
    !sequence ||
    sequence.owner_id !== null ||
    sequence.snapshot_id !== null ||
    sequence.retention_floor_seq !== null ||
    sequence.write_fence_transfer_id !== null
  )
    return yield* refuse()
  const history = yield* db
    .select({ id: EventTable.id, seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, id))
    .orderBy(EventTable.seq)
    .all()
    .pipe(Effect.orDie)
  if (
    history.length !== sequence.seq + 1 ||
    history.some((event, index) => event.seq !== index || event.id !== eventID(session.sourceId, event.seq, event.type))
  )
    return yield* refuse()
  const bySequence = new Map(history.map((event) => [event.seq, event]))
  if (
    inputs.some((input) => {
      const event = bySequence.get(input.admitted_seq)
      return (
        input.promoted_seq !== input.admitted_seq ||
        input.revert_epoch !== null ||
        event?.type !== "session.next.prompted.1" ||
        event.data.messageID !== input.id ||
        event.data.delivery !== input.delivery ||
        CanonicalJson.stringify(event.data.prompt) !== CanonicalJson.stringify(input.prompt)
      )
    })
  )
    return yield* refuse()
  return true
})
