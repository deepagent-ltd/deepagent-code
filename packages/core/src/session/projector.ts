export * as SessionProjector from "./projector"

import { and, asc, desc, eq, gt, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventArtifactTable } from "../event/sql"
import { FilePartArtifact } from "../file-part-artifact"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"
import type { DeepMutable } from "../schema"
import { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

class PromptAlreadyProjected extends Error {}
export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    summary_diff_manifest: info.summary?.diffManifest
      ? { ...info.summary.diffManifest, truncationReasons: [...info.summary.diffManifest.truncationReasons] }
      : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ?? null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
    preview: info.preview,
  }
}

function sessionUpdateRow(info: SessionV1.SessionInfo) {
  const row = sessionRow(info)
  if (info.summary?.diffs !== undefined) return row
  const { summary_diffs: _, ...bounded } = row
  return bounded
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  if (info.role === "assistant") {
    const { id: _, sessionID: __, activityProgress: ___, ...rest } = info
    return rest as DeepMutable<typeof rest>
  }
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

const snapshotTableNames = [
  "session",
  "message",
  "part",
  "file_part_artifact_binding",
  "session_message",
  "session_input",
  "session_context_epoch",
] as const

function stripDiffPatches(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!record.summary || typeof record.summary !== "object" || Array.isArray(record.summary)) return value
  const summary = record.summary as Record<string, unknown>
  if (!Array.isArray(summary.diffs)) return value
  return {
    ...record,
    summary: {
      ...summary,
      diffs: summary.diffs.map((diff) => {
        if (!diff || typeof diff !== "object" || Array.isArray(diff)) return diff
        const { patch: _, ...descriptor } = diff as Record<string, unknown>
        return descriptor
      }),
    },
  }
}

function snapshotCursor(index: number, key: string) {
  return `${index}:${key}`
}

function parseSnapshotCursor(cursor: string | undefined) {
  if (!cursor) return { index: 0, key: "" }
  const separator = cursor.indexOf(":")
  const index = Number(cursor.slice(0, separator))
  if (separator < 0 || !Number.isInteger(index) || index < 0 || index >= snapshotTableNames.length)
    throw new EventV2.InvalidSyncEventError({ type: "snapshot", message: `Invalid Session snapshot cursor ${cursor}` })
  return { index, key: cursor.slice(separator + 1) }
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    if (events.registerSnapshotCodec) yield* events.registerSnapshotCodec({
      codec: "session-projection",
      schemaVersion: 1,
      rebuildEventTypes: new Set([
        SessionV1.Event.Created,
        SessionV1.Event.Updated,
        SessionV1.Event.MessageUpdated,
        SessionV1.Event.MessageRemoved,
        SessionV1.Event.PartUpdated,
        SessionV1.Event.PartRemoved,
        SessionEvent.AgentSwitched,
        SessionEvent.ModelSwitched,
        SessionEvent.ContextUpdated,
        SessionEvent.Synthetic,
        SessionEvent.Shell.Started,
        SessionEvent.Shell.Ended,
        SessionEvent.Step.Started,
        SessionEvent.Step.Ended,
        SessionEvent.Step.Failed,
        SessionEvent.Text.Started,
        SessionEvent.Text.Ended,
        SessionEvent.Tool.Input.Started,
        SessionEvent.Tool.Input.Ended,
        SessionEvent.Tool.Called,
        SessionEvent.Tool.Progress,
        SessionEvent.Tool.Success,
        SessionEvent.Tool.Failed,
        SessionEvent.Reasoning.Started,
        SessionEvent.Reasoning.Ended,
        SessionEvent.Compaction.Ended,
      ].map((definition) => EventV2.versionedType(definition.type, definition.sync!.version))),
      revision: (aggregateID) =>
        Effect.gen(function* () {
          const session = yield* db.select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID))).get().pipe(Effect.orDie)
          const context = yield* db.select({ revision: SessionContextEpochTable.revision })
            .from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, SessionSchema.ID.make(aggregateID))).get().pipe(Effect.orDie)
          return `${session?.mutationEpoch ?? -1}:${context?.revision ?? -1}`
        }),
      next: (aggregateID, cursor) =>
        Effect.gen(function* () {
          const position = parseSnapshotCursor(cursor)
          for (const [index, tableName] of snapshotTableNames.entries()) {
            if (index < position.index) continue
            const after = index === position.index ? position.key : ""
            if (tableName === "session") {
              if (after) continue
              const row = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
                .get()
                .pipe(Effect.orDie)
              if (!row) return
              return {
                cursor: snapshotCursor(index, row.id),
                tableName,
                rowKey: row.id,
                value: {
                  id: row.id,
                  project_id: row.project_id,
                  workspace_id: row.workspace_id,
                  parent_id: row.parent_id,
                  slug: row.slug,
                  directory: row.directory,
                  path: row.path,
                  title: row.title,
                  version: row.version,
                  share_url: row.share_url,
                  summary_additions: row.summary_additions,
                  summary_deletions: row.summary_deletions,
                  summary_files: row.summary_files,
                  summary_diffs: row.summary_diffs?.map(({ patch: _, ...diff }) => diff),
                  summary_diff_manifest: row.summary_diff_manifest,
                  metadata: row.metadata,
                  cost: row.cost,
                  tokens_input: row.tokens_input,
                  tokens_output: row.tokens_output,
                  tokens_reasoning: row.tokens_reasoning,
                  tokens_cache_read: row.tokens_cache_read,
                  tokens_cache_write: row.tokens_cache_write,
                  revert: row.revert,
                  permission: row.permission,
                  agent: row.agent,
                  model: row.model,
                  time_created: row.time_created,
                  time_updated: row.time_updated,
                  time_compacting: row.time_compacting,
                  time_archived: row.time_archived,
                  preview: row.preview,
                },
              }
            }
            if (tableName === "message") {
              const row = yield* db
                .select({
                  id: MessageTable.id,
                  session_id: MessageTable.session_id,
                  time_created: MessageTable.time_created,
                  time_updated: MessageTable.time_updated,
                  data: MessageTable.data,
                  canonicalData: EventArtifactTable.canonical_data,
                })
                .from(MessageTable)
                .leftJoin(
                  EventArtifactTable,
                  and(
                    eq(EventArtifactTable.aggregate_id, aggregateID),
                    sql`json_extract(${EventArtifactTable.canonical_data}, '$.info.id') = ${MessageTable.id}`,
                  ),
                )
                .where(
                  and(
                    eq(MessageTable.session_id, SessionSchema.ID.make(aggregateID)),
                    gt(sql<string>`${MessageTable.id}`, after),
                  ),
                )
                .orderBy(asc(MessageTable.id))
                .limit(1)
                .get()
                .pipe(Effect.orDie)
              if (row)
                return {
                  cursor: snapshotCursor(index, row.id),
                  tableName,
                  rowKey: row.id,
                  value: {
                    id: row.id,
                    session_id: row.session_id,
                    time_created: row.time_created,
                    time_updated: row.time_updated,
                    data: stripDiffPatches(
                      row.canonicalData && typeof row.canonicalData.info === "object" && row.canonicalData.info
                        ? messageData(row.canonicalData.info as (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"])
                        : row.data,
                    ),
                  },
                }
              continue
            }
            if (tableName === "part") {
              const row = yield* db.select().from(PartTable)
                .where(and(eq(PartTable.session_id, SessionSchema.ID.make(aggregateID)), gt(sql<string>`${PartTable.id}`, after)))
                .orderBy(asc(PartTable.id)).limit(1).get().pipe(Effect.orDie)
              if (!row) continue
              const { provenance: _, ...canonical } = row
              return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: canonical }
            }
            if (tableName === "file_part_artifact_binding") {
              let artifactAfter = after
              while (true) {
                const part = yield* db.select({ id: PartTable.id, messageID: PartTable.message_id, data: PartTable.data }).from(PartTable)
                  .where(and(eq(PartTable.session_id, SessionSchema.ID.make(aggregateID)), gt(sql<string>`${PartTable.id}`, artifactAfter)))
                  .orderBy(asc(PartTable.id)).limit(1).get().pipe(Effect.orDie)
                if (!part) break
                const descriptor = FilePartArtifact.descriptor({
                  sessionID: aggregateID,
                  part: { id: part.id, messageID: part.messageID, sessionID: aggregateID, ...part.data },
                })
                if (descriptor) {
                  const metadata = yield* FilePartArtifact.snapshotRef(db, { aggregateID, partID: part.id, descriptor })
                  return { cursor: snapshotCursor(index, part.id), tableName, rowKey: part.id, value: { partID: part.id, metadata } }
                }
                artifactAfter = part.id
              }
              continue
            }
            if (tableName === "session_message") {
              const row = yield* db.select().from(SessionMessageTable)
                .where(and(eq(SessionMessageTable.session_id, SessionSchema.ID.make(aggregateID)), gt(sql<string>`${SessionMessageTable.id}`, after)))
                .orderBy(asc(SessionMessageTable.id)).limit(1).get().pipe(Effect.orDie)
              if (!row) continue
              return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: row }
            }
            if (tableName === "session_input") {
              const row = yield* db.select().from(SessionInputTable)
                .where(and(
                  eq(SessionInputTable.session_id, SessionSchema.ID.make(aggregateID)),
                  sql`${SessionInputTable.promoted_seq} is not null`,
                  gt(sql<string>`${SessionInputTable.id}`, after),
                ))
                .orderBy(asc(SessionInputTable.id)).limit(1).get().pipe(Effect.orDie)
              if (!row) continue
              return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: row }
            }
            if (after) continue
            const row = yield* db.select().from(SessionContextEpochTable)
              .where(eq(SessionContextEpochTable.session_id, SessionSchema.ID.make(aggregateID)))
              .get().pipe(Effect.orDie)
            if (!row) continue
            return { cursor: snapshotCursor(index, row.session_id), tableName, rowKey: row.session_id, value: row }
          }
        }),
      clear: (aggregateID, snapshotID) =>
        Effect.gen(function* () {
          const sessionID = SessionSchema.ID.make(aggregateID)
          yield* db.delete(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, sessionID)).run().pipe(Effect.orDie)
          yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run().pipe(Effect.orDie)
          yield* db.run(sql`
            DELETE FROM part
            WHERE session_id = ${sessionID}
              AND NOT EXISTS (
                SELECT 1 FROM event_snapshot_row row
                WHERE row.snapshot_id = ${snapshotID}
                  AND row.table_name = 'part'
                  AND row.row_key = part.id
              )
          `).pipe(Effect.orDie)
          yield* db.run(sql`
            DELETE FROM message
            WHERE session_id = ${sessionID}
              AND NOT EXISTS (
                SELECT 1 FROM event_snapshot_row row
                WHERE row.snapshot_id = ${snapshotID}
                  AND row.table_name = 'message'
                  AND row.row_key = message.id
              )
          `).pipe(Effect.orDie)
        }),
      import: (aggregateID, row, ownerID) => {
        if (row.tableName === "session") {
          const value = row.value as typeof SessionTable.$inferInsert
          if (
            value.id !== aggregateID ||
            (ownerID !== undefined && value.workspace_id !== ownerID)
          )
            return Effect.die(
              new EventV2.InvalidSyncEventError({
                type: "snapshot",
                message: `Session snapshot root does not match aggregate or owner ${aggregateID}`,
              }),
            )
          return Effect.gen(function* () {
            const { id: _, ...update } = value
            const updated = yield* db.update(SessionTable).set(update).where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
              .returning({ id: SessionTable.id }).get().pipe(Effect.orDie)
            if (!updated) yield* db.insert(SessionTable).values(value).run().pipe(Effect.orDie)
          })
        }
        if (row.tableName === "file_part_artifact_binding") {
          const value = row.value as { readonly partID?: unknown; readonly metadata?: unknown }
          if (value.partID !== row.rowKey || !Schema.is(FilePartArtifact.Metadata)(value.metadata) || value.metadata.aggregateID !== aggregateID)
            return Effect.die(new EventV2.InvalidSyncEventError({ type: "snapshot", message: `Invalid file artifact snapshot row ${row.rowKey}` }))
          return FilePartArtifact.bindSnapshotRef({ metadata: value.metadata, partID: value.partID }).pipe(
            Effect.provideService(Database.Service, { db }),
          )
        }
        if (row.value.session_id !== aggregateID)
          return Effect.die(
            new EventV2.InvalidSyncEventError({
              type: "snapshot",
              message: `Session snapshot row ${row.tableName}:${row.rowKey} crosses aggregate authority`,
            }),
          )
        if (row.tableName === "message") {
          const value = row.value as typeof MessageTable.$inferInsert
          return db.insert(MessageTable).values(value).onConflictDoUpdate({ target: MessageTable.id, set: value }).run().pipe(Effect.orDie)
        }
        if (row.tableName === "part") {
          const value = row.value as typeof PartTable.$inferInsert
          return db.insert(PartTable).values(value).onConflictDoUpdate({ target: PartTable.id, set: value }).run().pipe(Effect.orDie)
        }
        if (row.tableName === "session_message")
          return db
            .insert(SessionMessageTable)
            .values(row.value as typeof SessionMessageTable.$inferInsert)
            .run()
            .pipe(Effect.orDie)
        if (row.tableName === "session_input")
          return Effect.gen(function* () {
            const value = row.value as typeof SessionInputTable.$inferInsert
            const existing = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, value.id)).get().pipe(Effect.orDie)
            if (!existing) return yield* db.insert(SessionInputTable).values(value).run().pipe(Effect.orDie)
            if (!isDeepStrictEqual(existing, { ...value, promoted_seq: value.promoted_seq ?? null }))
              return yield* Effect.die(new EventV2.InvalidSyncEventError({ type: "snapshot", message: `Session input ${value.id} conflicts with local admission authority` }))
          })
        if (row.tableName === "session_context_epoch")
          return db
            .insert(SessionContextEpochTable)
            .values(row.value as typeof SessionContextEpochTable.$inferInsert)
            .run()
            .pipe(Effect.orDie)
        return Effect.die(
          new EventV2.InvalidSyncEventError({ type: "snapshot", message: `Unknown Session snapshot table ${row.tableName}` }),
        )
      },
    })
    yield* events.beforeCommit((event) => SessionInput.guardReservedID(db, event))
    yield* events.beforeCommit((event) =>
      Effect.gen(function* () {
        if (!event.replay) return
        if (
          (Schema.is(SessionV1.Event.Created)(event) || Schema.is(SessionV1.Event.Updated)(event)) &&
          event.data.info.id !== event.data.sessionID
        )
          return yield* Effect.die(
            new EventV2.InvalidSyncEventError({
              type: event.type,
              message: "Session replay identity does not match its aggregate",
            }),
          )
        const replaySessionID =
          event.replayOwnerID &&
          typeof event.data === "object" &&
          event.data !== null &&
          "sessionID" in event.data &&
          Schema.is(SessionSchema.ID)(event.data.sessionID)
            ? event.data.sessionID
            : undefined
        if (replaySessionID) {
          const authority = yield* db
            .select({ workspaceID: SessionTable.workspace_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, replaySessionID))
            .get()
            .pipe(Effect.orDie)
          const freshCreated =
            !authority &&
            Schema.is(SessionV1.Event.Created)(event) &&
            event.seq === 0 &&
            event.data.info.id === replaySessionID &&
            event.data.info.workspaceID === event.replayOwnerID
          if ((!authority && !freshCreated) || (authority && authority.workspaceID !== event.replayOwnerID))
            return yield* Effect.die(
              new EventV2.InvalidSyncEventError({
                type: event.type,
                message: "Session replay owner does not match the current workspace authority",
              }),
            )
        }
        if (Schema.is(SessionEvent.Moved)(event) && !event.replayExact)
          return yield* Effect.die(
            new EventV2.InvalidSyncEventError({
              type: event.type,
              message: "Session placement replay requires a durable transfer operation receipt",
            }),
          )
        if (!Schema.is(SessionV1.Event.Updated)(event)) return
        const current = yield* db
          .select({
            projectID: SessionTable.project_id,
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!current)
          return yield* Effect.die(
            new EventV2.InvalidSyncEventError({
              type: event.type,
              message: "Session update replay requires an existing projected Session",
            }),
          )
        if (
          current.projectID === event.data.info.projectID &&
          current.directory === event.data.info.directory &&
          (current.workspaceID ?? undefined) === (event.data.info.workspaceID ?? undefined)
        )
          return
        return yield* Effect.die(
          new EventV2.InvalidSyncEventError({
            type: event.type,
            message: "Session update replay cannot change project, directory, or workspace placement",
          }),
        )
      }),
    )
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionUpdateRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory ?? null,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        const existing = yield* db
          .select({ session_id: MessageTable.session_id })
          .from(MessageTable)
          .where(eq(MessageTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (existing && existing.session_id !== sessionID)
          return yield* Effect.die(`SessionProjector: message ${id} cannot move between sessions`)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.id, event.data.partID),
              eq(PartTable.message_id, event.data.messageID),
              eq(PartTable.session_id, event.data.sessionID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(
            and(
              eq(PartTable.id, event.data.partID),
              eq(PartTable.message_id, event.data.messageID),
              eq(PartTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const parent = yield* db
          .select({ session_id: MessageTable.session_id })
          .from(MessageTable)
          .where(eq(MessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (!parent || parent.session_id !== sessionID)
          return yield* Effect.die(`SessionProjector: part ${id} has a cross-session parent message`)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        if (row && (row.message_id !== messageID || row.session_id !== sessionID))
          return yield* Effect.die(`SessionProjector: part ${id} cannot move between messages or sessions`)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(
          Effect.orDie,
          Effect.andThen(run(db, event)),
          Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
        )
    })
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        const messageID = event.data.messageID
        const existing = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (existing) return yield* Effect.die(new PromptAlreadyProjected())
        yield* run(db, event)
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionInput.projectLegacyPrompted(db, {
          id: messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.seq,
        })
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Admitted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Promoted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* insertMessage(
          db,
          event,
          yield* SessionInput.projectPromoted(db, {
            id: event.data.messageID,
            sessionID: event.data.sessionID,
            prompt: event.data.prompt,
            timeCreated: event.data.timeCreated,
            promotedSeq: event.seq,
          }),
        )
      }),
    )
    yield* events.project(SessionEvent.InterruptRequested, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Started, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Succeeded, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Failed, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Interrupted, () => Effect.void)
    yield* events.project(SessionEvent.ContextUpdated, (event) => {
      if (!event.replay || event.seq === undefined) return run(db, event)
      return run(db, event).pipe(
        Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
      )
    })
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* applyUsage(db, event.data.sessionID, {
          cost: event.data.cost,
          tokens: event.data.tokens,
        })
      }),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => {
      if (event.version === 1) return Effect.void
      const seq = event.seq
      if (seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return Effect.gen(function* () {
        yield* run(db, event)
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, seq)
      })
    })
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
