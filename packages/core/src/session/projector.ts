export * as SessionProjector from "./projector"

import { and, asc, count, desc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventArtifactTable, EventSequenceTable, EventSyncSequenceTable, EventTable } from "../event/sql"
import { FilePartArtifact } from "../file-part-artifact"
import { FilePartArtifactBindingTable } from "../file-part-artifact.sql"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import { LongContext } from "./long-context"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionWireProjectionTable,
} from "./sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { legacyAssistant, legacyAssistantPartID, legacyUser } from "./legacy-wire"
import type { DeepMutable } from "../schema"
import { SessionSchema } from "./schema"
import { SessionToolQuota } from "./tool-quota.schema"
import { Hash } from "../util/hash"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const discardRevertedV2Tail = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  messageID: SessionV1.MessageID,
  includeTarget: boolean,
) {
  const target = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, SessionMessage.ID.make(messageID))),
    )
    .get()
    .pipe(Effect.orDie)
  if (!target) return
  const session = yield* db
    .select({ mutationEpoch: SessionTable.mutation_epoch })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* Effect.die(`SessionProjector: reverted Session ${sessionID} disappeared`)
  // RevertChanged precedes cleanup, so the current epoch names the one synthetic notice that
  // must survive removal of the old branch. The same event sequence replays this deletion.
  const noticeID = SessionMessage.ID.make(
    `msg_${Hash.sha256(`revert-notice:${sessionID}:${session.mutationEpoch}`).slice(0, 40)}`,
  )
  yield* db
    .delete(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        includeTarget ? gte(SessionMessageTable.seq, target.seq) : gt(SessionMessageTable.seq, target.seq),
        ne(SessionMessageTable.id, noticeID),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  return target
})

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

function createdSessionRow(event: SessionEvent.Created): typeof SessionTable.$inferInsert {
  return {
    id: event.data.info.id,
    v2_authority: true,
    project_id: event.data.info.projectID,
    workspace_id: event.data.info.location.workspaceID ?? null,
    parent_id: event.data.info.parentID,
    slug: event.data.slug,
    directory: event.data.info.location.directory,
    path: event.data.info.subpath,
    title: event.data.info.title,
    agent: event.data.info.agent,
    model: event.data.info.model,
    version: event.data.version,
    cost: event.data.info.cost,
    tokens_input: event.data.info.tokens.input,
    tokens_output: event.data.info.tokens.output,
    tokens_reasoning: event.data.info.tokens.reasoning,
    tokens_cache_read: event.data.info.tokens.cache.read,
    tokens_cache_write: event.data.info.tokens.cache.write,
    permission: event.data.info.permissions,
    summary_additions: event.data.info.summary?.additions,
    summary_deletions: event.data.info.summary?.deletions,
    summary_files: event.data.info.summary?.files,
    summary_diff_manifest: event.data.info.summary?.diffManifest
      ? {
          ...event.data.info.summary.diffManifest,
          truncationReasons: [...event.data.info.summary.diffManifest.truncationReasons],
        }
      : undefined,
    metadata: event.data.info.metadata,
    share_url: event.data.info.share?.url,
    preview: event.data.info.preview,
    time_created: DateTime.toEpochMillis(event.data.info.time.created),
    time_updated: DateTime.toEpochMillis(event.data.info.time.updated),
    time_archived: event.data.info.time.archived ? DateTime.toEpochMillis(event.data.info.time.archived) : undefined,
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
  "quota_event",
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

// ── W4-6: journal → V1-wire projection egress ────────────────────────────────────────────────
// The single production line: durable session.next.* events fold into SessionMessageTable (run
// above), and THIS egress derives the V1 wire rows from that folded state — publishing
// SessionV1.Event.MessageUpdated/PartUpdated so the existing V1 projection handlers write the
// wire tables and the SSE surface fans out to both clients. Exactly-once: the
// session_wire_projection fingerprint cursor (durable, unlike the F-17 drain-local map it
// replaces) skips byte-identical re-derivations across replay/overlap windows.

// Per-session memo for wire egress. Directory and ownership are fixed; an assistant's parent
// stays fixed across its streaming deltas but changes when the next user turn starts.
const wireSessionMemo = new Map<
  string,
  {
    parent: { assistantID: string; user: { id: string } | null } | null
    directory: { directory: string; path: string } | null
    v2Owned?: boolean
  }
>()
const WIRE_SESSION_MEMO_MAX = 2_000
const wireSessionEntry = (sessionID: SessionSchema.ID) => {
  const key = String(sessionID)
  let entry = wireSessionMemo.get(key)
  if (!entry) {
    if (wireSessionMemo.size >= WIRE_SESSION_MEMO_MAX) wireSessionMemo.clear()
    entry = { parent: null, directory: null }
    wireSessionMemo.set(key, entry)
  }
  return entry
}

const loadMessageRow = (db: DatabaseService, sessionID: SessionSchema.ID, messageID: SessionMessage.ID) =>
  db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
    .get()
    .pipe(Effect.orDie)

const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decodeMessage({ ...row.data, id: row.id, type: row.type })

const liveWireOwner = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({
      receiptID: V2ProviderTurnReceiptTable.receipt_id,
      ownerToken: V2ProviderTurnReceiptTable.owner_token,
      mode: V2ProviderTurnReceiptTable.owner_mode,
      state: V2ProviderTurnReceiptTable.state,
      directory: SessionTable.directory,
      workspaceID: SessionTable.workspace_id,
      expiresAt: SessionProviderOwnerLeaseTable.lease_expires_at,
      releasedAt: SessionProviderOwnerLeaseTable.released_at,
      now: sql<number>`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
    })
    .from(V2ProviderTurnReceiptTable)
    .innerJoin(
      SessionProviderOwnerLeaseTable,
      eq(SessionProviderOwnerLeaseTable.owner_token, V2ProviderTurnReceiptTable.owner_token),
    )
    .innerJoin(SessionTable, eq(SessionTable.id, V2ProviderTurnReceiptTable.session_id))
    .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
    .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

function wireFingerprintCursor(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entity: "message" | "part",
  entityID: string,
) {
  return db
    .select({ fingerprint: SessionWireProjectionTable.fingerprint })
    .from(SessionWireProjectionTable)
    .where(
      and(
        eq(SessionWireProjectionTable.session_id, sessionID),
        eq(SessionWireProjectionTable.entity, entity),
        eq(SessionWireProjectionTable.entity_id, entityID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
}

const recordWireFingerprint = (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  entity: "message" | "part",
  entityID: string,
  fingerprint: string,
) =>
  db
    .insert(SessionWireProjectionTable)
    .values({ session_id: sessionID, entity, entity_id: entityID, fingerprint, time_updated: Date.now() })
    .onConflictDoUpdate({
      target: [
        SessionWireProjectionTable.session_id,
        SessionWireProjectionTable.entity,
        SessionWireProjectionTable.entity_id,
      ],
      set: { fingerprint, time_updated: Date.now() },
    })
    .run()
    .pipe(Effect.orDie)

// Publish a wire entity when its content fingerprint advanced. Set-then-publish ordering (the
// cursor row lands before the event) keeps concurrent folds race-free, mirroring F-19.
// In-process fast path for the durable fingerprint cursor. A streaming turn re-enters this egress
// once per delta; each entry used to cost a synchronous SELECT plus a one-statement transaction
// (measured: 24k transactions and 46k cursor selects in a single run, the dominant writer load).
// The durable row is still written on every CHANGE (cross-process/replay dedup unchanged) — only
// the redundant read and the no-op write are skipped when this process already recorded the same
// fingerprint. Bounded so a long-lived server cannot grow it without limit.
const wireCursorMemo = new Map<string, string>()
const WIRE_CURSOR_MEMO_MAX = 10_000

function publishWireOnce(
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  entity: "message" | "part",
  entityID: string,
  fingerprint: string,
  publish: () => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const key = `${sessionID}:${entity}:${entityID}`
    if (wireCursorMemo.get(key) === fingerprint) return
    // Unknown in-process state: fall back to the durable cursor exactly as before.
    if (!wireCursorMemo.has(key)) {
      const cursor = yield* wireFingerprintCursor(db, sessionID, entity, entityID)
      if (cursor?.fingerprint === fingerprint) {
        if (wireCursorMemo.size < WIRE_CURSOR_MEMO_MAX) wireCursorMemo.set(key, fingerprint)
        return
      }
    }
    yield* recordWireFingerprint(db, sessionID, entity, entityID, fingerprint)
    if (wireCursorMemo.size >= WIRE_CURSOR_MEMO_MAX) wireCursorMemo.clear()
    wireCursorMemo.set(key, fingerprint)
    yield* publish().pipe(Effect.orDie)
  })
}

// Each assistant belongs to the most recent preceding user. Keep that answer for its streaming
// deltas; a session-wide first-user cache misgroups every later reply in the Desktop timeline.
const wireParent = (db: DatabaseService, sessionID: SessionSchema.ID, assistantID: string, seq: number) => {
  const entry = wireSessionEntry(sessionID)
  if (entry.parent?.assistantID === assistantID) return Effect.succeed(entry.parent.user)
  return db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "user"),
        lt(SessionMessageTable.seq, seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .get()
    .pipe(
      Effect.orDie,
      Effect.tap((row) =>
        Effect.sync(() => {
          wireSessionEntry(sessionID).parent = { assistantID, user: row ?? null }
        }),
      ),
    )
}

function wireRoot(directory: string, subpath: string | null) {
  if (!directory || !subpath) return directory
  if (path.isAbsolute(subpath)) {
    // Legacy rows may already store an absolute root; accept it only when it contains cwd.
    const relative = path.relative(subpath, directory)
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? directory : subpath
  }
  const segments = subpath.split(/[\\/]/).filter((segment) => segment && segment !== ".")
  // A traversal or malformed relative path cannot establish a wider workspace boundary.
  if (segments.includes("..")) return directory
  const root = path.resolve(directory, ...segments.map(() => ".."))
  return path.resolve(root, subpath) === path.resolve(directory) ? root : directory
}

// W4-6 — the canonical user/synthetic converter moved next to legacyAssistant in legacy-wire.ts
// (shared with the W-02 M-1 batch MD exporter); the projector re-uses it through that import.

// Derive + publish the V1 wire rows for one folded SessionMessage. Assistant rows carry the full
// legacyAssistant conversion (model/cost/tokens/path + synthesized step-finish); user rows carry
// the text part, file attachments, and the session's agent/model identity. Idempotent via the
// durable fingerprint cursor.
function publishWireForMessage(
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
) {
  return Effect.gen(function* () {
    const row = yield* loadMessageRow(db, sessionID, messageID)
    if (!row) return
    const message = decodeRow(row)
    const projected =
      message.type === "assistant"
        ? yield* Effect.gen(function* () {
            const parent = yield* wireParent(db, sessionID, message.id, row.seq)
            const directory = yield* db
              .select({ directory: SessionTable.directory, path: SessionTable.path })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            return legacyAssistant({
              sessionID,
              parentMessageID: SessionV1.MessageID.ascending(parent ? parent.id : message.id),
              directory: directory?.directory ?? "",
              root: wireRoot(directory?.directory ?? "", directory?.path ?? null),
              message,
            })
          })
        : message.type === "user" || message.type === "synthetic"
          ? yield* Effect.gen(function* () {
              const identity = yield* db
                .select({ agent: SessionTable.agent, model: SessionTable.model })
                .from(SessionTable)
                .where(eq(SessionTable.id, sessionID))
                .get()
                .pipe(Effect.orDie)
              return legacyUser({
                sessionID,
                message,
                agent: identity?.agent ?? null,
                model: identity?.model ?? null,
                // Runner-injected synthetic messages (e.g. the output-continuation nudge) surface
                // on the V1 wire as user rows with a synthetic text part (V1 parity).
                synthetic: message.type === "synthetic",
              })
            })
          : undefined
    if (!projected) return
    const projectedInfo = { ...projected.info, canonicalSeq: row.seq }
    const existing = yield* db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(eq(MessageTable.id, projectedInfo.id))
      .get()
      .pipe(Effect.orDie)
    // Ownership scoping (staged 6b-1): the host authors wire rows for legacy-loop sessions with
    // host-side extras (`structured`, host part ids, reference-mention parts...) the V2
    // projection does not model. The egress therefore only CREATES rows it cannot see (crash
    // recovery: the row was never written) plus assistant rows for V2-owned sessions (the
    // mirror's exact audience); existing host-authored rows stay untouched until 6b-2 retires
    // the mirror and the egress becomes the single writer.
    if (projectedInfo.role === "user") {
      if (existing) return
      const messageFingerprint = JSON.stringify(projectedInfo)
      yield* publishWireOnce(db, events, sessionID, "message", projectedInfo.id, messageFingerprint, () =>
        events.publish(SessionV1.Event.MessageUpdated, {
          sessionID,
          info: structuredClone(projectedInfo),
        }),
      )
      for (const part of projected.parts) {
        const fingerprint = JSON.stringify(part)
        yield* publishWireOnce(db, events, sessionID, "part", part.id, fingerprint, () =>
          events.publish(SessionV1.Event.PartUpdated, {
            sessionID,
            part: structuredClone(part),
            time: Date.now(),
          }),
        )
      }
      return
    }
    const v2Owned = yield* db
      .select({ id: V2ProviderTurnReceiptTable.receipt_id })
      .from(V2ProviderTurnReceiptTable)
      .where(and(eq(V2ProviderTurnReceiptTable.session_id, sessionID), eq(V2ProviderTurnReceiptTable.owner_mode, "v2")))
      .get()
      .pipe(Effect.orDie)
    if (v2Owned) {
      // Preserve Host-only extras, but canonical settlement owns time, usage and
      // identity. A pending wire row must not overwrite the completed projection.
      const mergedInfo =
        existing?.data && typeof existing.data === "object"
          ? ({
              ...structuredClone(existing.data),
              ...structuredClone(projectedInfo),
              finish: projectedInfo.finish,
              error: projectedInfo.error,
              variant: projectedInfo.variant,
            } as typeof projectedInfo)
          : projectedInfo
      const messageFingerprint = JSON.stringify(mergedInfo)
      yield* publishWireOnce(db, events, sessionID, "message", mergedInfo.id, messageFingerprint, () =>
        events.publish(SessionV1.Event.MessageUpdated, {
          sessionID,
          info: structuredClone(mergedInfo),
        }),
      )
    }
    for (const part of projected.parts) {
      const fingerprint = JSON.stringify(part)
      yield* publishWireOnce(db, events, sessionID, "part", part.id, fingerprint, () =>
        events.publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: structuredClone(part),
          time: Date.now(),
        }),
      )
    }
  })
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    // Live fragments have no replay authority. Keep only identities captured after
    // this process commits Started for a current V2 owner; never retain their text.
    const liveWireParts = new Map<
      string,
      {
        sessionID: SessionSchema.ID
        messageID: SessionMessage.ID
        partID: SessionV1.PartID
        receiptID: string
        ownerToken: string
        location: NonNullable<EventV2.Payload["location"]>
      }
    >()
    const liveWireKey = (sessionID: string, messageID: string, kind: "text" | "reasoning", fragmentID: string) =>
      JSON.stringify([sessionID, messageID, kind, fragmentID])
    const forgetLiveWireParts = (sessionID: string, messageID?: string, partID?: string) => {
      for (const [key, part] of liveWireParts) {
        if (
          part.sessionID === sessionID &&
          (messageID === undefined || part.messageID === messageID) &&
          (partID === undefined || part.partID === partID)
        )
          liveWireParts.delete(key)
      }
    }
    if (events.registerSnapshotCodec)
      yield* events.registerSnapshotCodec({
        codec: "session-projection",
        schemaVersion: 1,
        rebuildEventTypes: new Set(
          [
            SessionEvent.Created,
            SessionEvent.Updated,
            SessionEvent.DiffUpdated,
            SessionEvent.RevertChanged,
            SessionV1.Event.Created,
            SessionV1.Event.Updated,
            SessionV1.Event.MessageUpdated,
            SessionV1.Event.MessageRemoved,
            SessionV1.Event.PartUpdated,
            SessionV1.Event.PartRemoved,
            SessionEvent.AgentSwitched,
            SessionEvent.ModelSwitched,
            SessionEvent.PermissionsChanged,
            SessionEvent.ContextUpdated,
            SessionEvent.Synthetic,
            SessionEvent.StructuredCaptured,
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
          ].map((definition) => EventV2.versionedType(definition.type, definition.sync!.version)),
        ),
        revision: (aggregateID) =>
          Effect.gen(function* () {
            const session = yield* db
              .select({ mutationEpoch: SessionTable.mutation_epoch })
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
              .get()
              .pipe(Effect.orDie)
            const context = yield* db
              .select({ revision: SessionContextEpochTable.revision })
              .from(SessionContextEpochTable)
              .where(eq(SessionContextEpochTable.session_id, SessionSchema.ID.make(aggregateID)))
              .get()
              .pipe(Effect.orDie)
            const fileArtifacts = yield* db
              .select({
                eventID: FilePartArtifactBindingTable.event_id,
                canonicalDataHash: FilePartArtifactBindingTable.canonical_data_hash,
              })
              .from(FilePartArtifactBindingTable)
              .where(eq(FilePartArtifactBindingTable.aggregate_id, aggregateID))
              .orderBy(asc(FilePartArtifactBindingTable.seq))
              .all()
              .pipe(Effect.orDie)
            return `${session?.mutationEpoch ?? -1}:${context?.revision ?? -1}:${fileArtifacts
              .map((artifact) => `${artifact.eventID}:${artifact.canonicalDataHash}`)
              .join(",")}`
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
                      sql`(
                      EXISTS (
                        SELECT 1 FROM session_diff_migration_receipt receipt
                        WHERE receipt.message_id = ${MessageTable.id}
                          AND receipt.artifact_id = ${EventArtifactTable.artifact_id}
                          AND receipt.state = 'committed'
                      ) OR (
                        NOT EXISTS (
                          SELECT 1 FROM session_diff_migration_receipt receipt
                          WHERE receipt.message_id = ${MessageTable.id}
                            AND receipt.state = 'committed'
                        ) AND NOT EXISTS (
                          SELECT 1 FROM event_artifact newer
                          WHERE newer.aggregate_id = ${EventArtifactTable.aggregate_id}
                            AND newer.kind = ${EventArtifactTable.kind}
                            AND newer.seq > ${EventArtifactTable.seq}
                            AND json_extract(newer.canonical_data, '$.info.id') = ${MessageTable.id}
                        )
                      )
                    )`,
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
                          ? messageData(
                              row.canonicalData.info as (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
                            )
                          : row.data,
                      ),
                    },
                  }
                continue
              }
              if (tableName === "part") {
                const row = yield* db
                  .select()
                  .from(PartTable)
                  .where(
                    and(
                      eq(PartTable.session_id, SessionSchema.ID.make(aggregateID)),
                      gt(sql<string>`${PartTable.id}`, after),
                    ),
                  )
                  .orderBy(asc(PartTable.id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (!row) continue
                const { provenance: _, ...canonical } = row
                return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: canonical }
              }
              if (tableName === "file_part_artifact_binding") {
                let artifactAfter = after
                while (true) {
                  const part = yield* db
                    .select({ id: PartTable.id, messageID: PartTable.message_id, data: PartTable.data })
                    .from(PartTable)
                    .where(
                      and(
                        eq(PartTable.session_id, SessionSchema.ID.make(aggregateID)),
                        gt(sql<string>`${PartTable.id}`, artifactAfter),
                      ),
                    )
                    .orderBy(asc(PartTable.id))
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)
                  if (!part) break
                  const descriptor = FilePartArtifact.descriptor({
                    sessionID: aggregateID,
                    part: { id: part.id, messageID: part.messageID, sessionID: aggregateID, ...part.data },
                  })
                  if (descriptor) {
                    const metadata = yield* FilePartArtifact.snapshotRef(db, {
                      aggregateID,
                      partID: part.id,
                      descriptor,
                    })
                    return {
                      cursor: snapshotCursor(index, part.id),
                      tableName,
                      rowKey: part.id,
                      value: { partID: part.id, metadata },
                    }
                  }
                  artifactAfter = part.id
                }
                continue
              }
              if (tableName === "session_message") {
                const row = yield* db
                  .select()
                  .from(SessionMessageTable)
                  .where(
                    and(
                      eq(SessionMessageTable.session_id, SessionSchema.ID.make(aggregateID)),
                      gt(sql<string>`${SessionMessageTable.id}`, after),
                    ),
                  )
                  .orderBy(asc(SessionMessageTable.id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (!row) continue
                return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: row }
              }
              if (tableName === "session_input") {
                const row = yield* db
                  .select()
                  .from(SessionInputTable)
                  .where(
                    and(
                      eq(SessionInputTable.session_id, SessionSchema.ID.make(aggregateID)),
                      sql`${SessionInputTable.promoted_seq} is not null`,
                      gt(sql<string>`${SessionInputTable.id}`, after),
                    ),
                  )
                  .orderBy(asc(SessionInputTable.id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (!row) continue
                return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: row }
              }
              if (tableName === "quota_event") {
                const row = yield* db
                  .select({
                    id: EventTable.id,
                    aggregate_id: EventTable.aggregate_id,
                    seq: EventTable.seq,
                    type: EventTable.type,
                    data: EventTable.data,
                  })
                  .from(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, aggregateID),
                      inArray(EventTable.type, SessionToolQuota.types),
                      gt(EventTable.id, EventV2.ID.make(after || "evt_")),
                    ),
                  )
                  .orderBy(asc(EventTable.id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (!row) continue
                const value = Schema.decodeUnknownOption(SessionToolQuota.SnapshotFact, { onExcessProperty: "error" })({
                  ...row,
                  hash: SessionToolQuota.digest(row),
                })
                if (Option.isNone(value) || !SessionToolQuota.valid(value.value))
                  return yield* Effect.die(
                    new EventV2.InvalidSyncEventError({
                      type: "snapshot",
                      message: "Invalid original Session quota fact",
                    }),
                  )
                const capacity = yield* db
                  .select({ value: count() })
                  .from(EventTable)
                  .where(
                    and(eq(EventTable.aggregate_id, aggregateID), inArray(EventTable.type, SessionToolQuota.types)),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if ((capacity?.value ?? 0) > SessionToolQuota.LIMITS.loaded + SessionToolQuota.LIMITS.proposals)
                  return yield* Effect.die(
                    new EventV2.InvalidSyncEventError({
                      type: "snapshot",
                      message: "Session quota fact capacity exceeded",
                    }),
                  )
                return { cursor: snapshotCursor(index, row.id), tableName, rowKey: row.id, value: value.value }
              }
              if (after) continue
              const row = yield* db
                .select()
                .from(SessionContextEpochTable)
                .where(eq(SessionContextEpochTable.session_id, SessionSchema.ID.make(aggregateID)))
                .get()
                .pipe(Effect.orDie)
              if (!row) continue
              return { cursor: snapshotCursor(index, row.session_id), tableName, rowKey: row.session_id, value: row }
            }
          }),
        clear: (aggregateID, snapshotID) =>
          Effect.gen(function* () {
            const sessionID = SessionSchema.ID.make(aggregateID)
            yield* db
              .delete(SessionContextEpochTable)
              .where(eq(SessionContextEpochTable.session_id, sessionID))
              .run()
              .pipe(Effect.orDie)
            yield* db
              .delete(SessionMessageTable)
              .where(eq(SessionMessageTable.session_id, sessionID))
              .run()
              .pipe(Effect.orDie)
            yield* db
              .run(
                sql`
            DELETE FROM part
            WHERE session_id = ${sessionID}
              AND NOT EXISTS (
                SELECT 1 FROM event_snapshot_row row
                WHERE row.snapshot_id = ${snapshotID}
                  AND row.table_name = 'part'
                  AND row.row_key = part.id
              )
          `,
              )
              .pipe(Effect.orDie)
            yield* db
              .run(
                sql`
            DELETE FROM message
            WHERE session_id = ${sessionID}
              AND NOT EXISTS (
                SELECT 1 FROM event_snapshot_row row
                WHERE row.snapshot_id = ${snapshotID}
                  AND row.table_name = 'message'
                  AND row.row_key = message.id
              )
          `,
              )
              .pipe(Effect.orDie)
          }),
        import: (aggregateID, row, ownerID) => {
          if (row.tableName === "quota_event")
            return Effect.gen(function* () {
              const value = Schema.decodeUnknownOption(SessionToolQuota.SnapshotFact, { onExcessProperty: "error" })(
                row.value,
              )
              if (
                Option.isNone(value) ||
                !SessionToolQuota.valid(value.value) ||
                value.value.id !== row.rowKey ||
                value.value.aggregate_id !== aggregateID
              )
                return yield* Effect.die(
                  new EventV2.InvalidSyncEventError({
                    type: "snapshot",
                    message: "Session quota snapshot identity or schema changed",
                  }),
                )
              const fact = value.value
              const sequence = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                .get()
                .pipe(Effect.orDie)
              if (!sequence || fact.seq > sequence.seq)
                return yield* Effect.die(
                  new EventV2.InvalidSyncEventError({
                    type: "snapshot",
                    message: "Session quota fact exceeds original aggregate sequence",
                  }),
                )
              const existing = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.id, fact.id))
                .get()
                .pipe(Effect.orDie)
              if (existing) {
                if (
                  !isDeepStrictEqual(
                    {
                      id: existing.id,
                      aggregate_id: existing.aggregate_id,
                      seq: existing.seq,
                      type: existing.type,
                      data: existing.data,
                    },
                    { id: fact.id, aggregate_id: fact.aggregate_id, seq: fact.seq, type: fact.type, data: fact.data },
                  )
                )
                  return yield* Effect.die(
                    new EventV2.InvalidSyncEventError({
                      type: "snapshot",
                      message: "Session quota fact conflicts with original local charge",
                    }),
                  )
                return
              }
              const used = yield* db
                .select({ value: count() })
                .from(EventTable)
                .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.type, fact.type)))
                .get()
                .pipe(Effect.orDie)
              const limit =
                fact.type === SessionToolQuota.types[0]
                  ? SessionToolQuota.LIMITS.loaded
                  : SessionToolQuota.LIMITS.proposals
              if ((used?.value ?? 0) >= limit)
                return yield* Effect.die(
                  new EventV2.InvalidSyncEventError({
                    type: "snapshot",
                    message: "Session quota snapshot capacity exceeded",
                  }),
                )
              if (fact.type === SessionToolQuota.types[0]) {
                const duplicate = yield* db
                  .select({ id: EventTable.id })
                  .from(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, aggregateID),
                      eq(EventTable.type, fact.type),
                      sql`json_extract(${EventTable.data}, '$.ref') = ${fact.data.ref}`,
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                const turn = yield* db
                  .select({ value: count() })
                  .from(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, aggregateID),
                      eq(EventTable.type, fact.type),
                      sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${fact.data.assistantMessageID}`,
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (duplicate || (turn?.value ?? 0) >= SessionToolQuota.LIMITS.newPerTurn)
                  return yield* Effect.die(
                    new EventV2.InvalidSyncEventError({
                      type: "snapshot",
                      message: "Session quota snapshot duplicates or exceeds original turn charge",
                    }),
                  )
              }
              // Restore only ledger facts under the already-validated snapshot transaction. Allocate
              // this database's sequence; a peer's sync cursor never becomes local authority.
              const sync = yield* db
                .update(EventSyncSequenceTable)
                .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
                .where(eq(EventSyncSequenceTable.id, 1))
                .returning({ seq: EventSyncSequenceTable.seq })
                .get()
                .pipe(Effect.orDie)
              if (!sync)
                return yield* Effect.die(
                  new EventV2.InvalidSyncEventError({
                    type: "snapshot",
                    message: "Session quota sync sequence is unavailable",
                  }),
                )
              yield* db
                .insert(EventTable)
                .values({
                  id: fact.id,
                  aggregate_id: fact.aggregate_id,
                  seq: fact.seq,
                  type: fact.type,
                  data: fact.data,
                  sync_seq: sync.seq,
                })
                .run()
                .pipe(Effect.orDie)
            })
          if (row.tableName === "session") {
            const value = row.value as typeof SessionTable.$inferInsert
            if (value.id !== aggregateID || (ownerID !== undefined && value.workspace_id !== ownerID))
              return Effect.die(
                new EventV2.InvalidSyncEventError({
                  type: "snapshot",
                  message: `Session snapshot root does not match aggregate or owner ${aggregateID}`,
                }),
              )
            return Effect.gen(function* () {
              const { id: _, ...update } = value
              const updated = yield* db
                .update(SessionTable)
                .set(update)
                .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
                .returning({ id: SessionTable.id })
                .get()
                .pipe(Effect.orDie)
              if (!updated) yield* db.insert(SessionTable).values(value).run().pipe(Effect.orDie)
            })
          }
          if (row.tableName === "file_part_artifact_binding") {
            const value = row.value as { readonly partID?: unknown; readonly metadata?: unknown }
            if (
              value.partID !== row.rowKey ||
              !Schema.is(FilePartArtifact.Metadata)(value.metadata) ||
              value.metadata.aggregateID !== aggregateID
            )
              return Effect.die(
                new EventV2.InvalidSyncEventError({
                  type: "snapshot",
                  message: `Invalid file artifact snapshot row ${row.rowKey}`,
                }),
              )
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
            return db
              .insert(MessageTable)
              .values(value)
              .onConflictDoUpdate({ target: MessageTable.id, set: value })
              .run()
              .pipe(Effect.orDie)
          }
          if (row.tableName === "part") {
            const value = row.value as typeof PartTable.$inferInsert
            return db
              .insert(PartTable)
              .values(value)
              .onConflictDoUpdate({ target: PartTable.id, set: value })
              .run()
              .pipe(Effect.orDie)
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
              const existing = yield* db
                .select()
                .from(SessionInputTable)
                .where(eq(SessionInputTable.id, value.id))
                .get()
                .pipe(Effect.orDie)
              if (!existing) return yield* db.insert(SessionInputTable).values(value).run().pipe(Effect.orDie)
              if (!isDeepStrictEqual(existing, { ...value, promoted_seq: value.promoted_seq ?? null }))
                return yield* Effect.die(
                  new EventV2.InvalidSyncEventError({
                    type: "snapshot",
                    message: `Session input ${value.id} conflicts with local admission authority`,
                  }),
                )
            })
          if (row.tableName === "session_context_epoch")
            return db
              .insert(SessionContextEpochTable)
              .values(row.value as typeof SessionContextEpochTable.$inferInsert)
              .run()
              .pipe(Effect.orDie)
          return Effect.die(
            new EventV2.InvalidSyncEventError({
              type: "snapshot",
              message: `Unknown Session snapshot table ${row.tableName}`,
            }),
          )
        },
      })
    const guardReplayedUpdatePlacement = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      placement: { projectID: string; directory: string; workspaceID?: string },
    ) {
      const current = yield* db
        .select({
          projectID: SessionTable.project_id,
          directory: SessionTable.directory,
          workspaceID: SessionTable.workspace_id,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!current)
        return yield* Effect.die(
          new EventV2.InvalidSyncEventError({
            type: "session.updated",
            message: "Session update replay requires an existing projected Session",
          }),
        )
      if (
        current.projectID === placement.projectID &&
        current.directory === placement.directory &&
        (current.workspaceID ?? undefined) === (placement.workspaceID ?? undefined)
      )
        return
      return yield* Effect.die(
        new EventV2.InvalidSyncEventError({
          type: "session.updated",
          message: "Session update replay cannot change project, directory, or workspace placement",
        }),
      )
    })
    yield* events.beforeCommit((event) => SessionInput.guardReservedID(db, event))
    // Preview is a write-once V2 field. The durable projector guard closes the race between two
    // concurrent first-message updates: once a value exists, an event carrying a different (or
    // omitted) preview is rejected instead of letting a stale full-state mirror clear it.
    yield* events.beforeCommit((event) =>
      Effect.gen(function* () {
        if (!Schema.is(SessionEvent.Updated)(event)) return
        const current = yield* db
          .select({ preview: SessionTable.preview })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!current || current.preview === null || current.preview === event.data.info.preview) return
        return yield* Effect.die(
          new EventV2.InvalidSyncEventError({
            type: event.type,
            message: "Session preview is write-once and cannot be changed after first projection",
          }),
        )
      }),
    )
    yield* events.beforeCommit((event) =>
      Effect.gen(function* () {
        if (!event.replay) return
        if (
          (Schema.is(SessionEvent.Created)(event) ||
            Schema.is(SessionV1.Event.Created)(event) ||
            Schema.is(SessionEvent.Updated)(event) ||
            Schema.is(SessionV1.Event.Updated)(event) ||
            Schema.is(SessionEvent.Deleted)(event) ||
            Schema.is(SessionV1.Event.Deleted)(event)) &&
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
            (Schema.is(SessionEvent.Created)(event) || Schema.is(SessionV1.Event.Created)(event)) &&
            event.seq === 0 &&
            event.data.info.id === replaySessionID &&
            (Schema.is(SessionEvent.Created)(event)
              ? event.data.info.location.workspaceID
              : event.data.info.workspaceID) === event.replayOwnerID
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
        // The v1 wire event carries placement as flat info fields; the v2 authority nests them in
        // info.location. Both versions get the same placement freeze on the sync ingress.
        if (Schema.is(SessionEvent.Updated)(event))
          return yield* guardReplayedUpdatePlacement(event.data.sessionID, {
            projectID: event.data.info.projectID,
            directory: event.data.info.location.directory,
            workspaceID: event.data.info.location.workspaceID,
          })
        if (!Schema.is(SessionV1.Event.Updated)(event)) return
        yield* guardReplayedUpdatePlacement(event.data.sessionID, {
          projectID: event.data.info.projectID,
          directory: event.data.info.directory,
          workspaceID: event.data.info.workspaceID,
        })
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
    yield* events.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(createdSessionRow(event))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.location.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.location.workspaceID))
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
    // Native V2 update authority: full-state mirror of the SessionSchema.Info fields. Placement
    // (project/directory/workspace/path), identity (slug/version), and the remaining V1-only
    // columns (summary, revert, compacting) keep their independent event owners. Absent optional V2
    // state means cleared (null) for fields owned by this event; V1 import/replay remains available
    // for compatibility ingestion.
    yield* events.project(SessionEvent.Updated, (event) =>
      db
        .update(SessionTable)
        .set({
          parent_id: event.data.info.parentID ?? null,
          title: event.data.info.title,
          agent: event.data.info.agent ?? null,
          model: event.data.info.model ?? null,
          cost: event.data.info.cost,
          tokens_input: event.data.info.tokens.input,
          tokens_output: event.data.info.tokens.output,
          tokens_reasoning: event.data.info.tokens.reasoning,
          tokens_cache_read: event.data.info.tokens.cache.read,
          tokens_cache_write: event.data.info.tokens.cache.write,
          permission: [...event.data.info.permissions],
          metadata: event.data.info.metadata ?? null,
          share_url: event.data.info.share?.url ?? null,
          preview: event.data.info.preview ?? null,
          time_updated: DateTime.toEpochMillis(event.data.info.time.updated),
          time_archived: event.data.info.time.archived ? DateTime.toEpochMillis(event.data.info.time.archived) : null,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    // Native diff authority owns the bounded summary columns and the independently transported file
    // descriptors. It is intentionally separate from SessionEvent.Updated so a metadata/title update
    // cannot erase a large diff payload.
    yield* events.project(SessionEvent.DiffUpdated, (event) =>
      db
        .update(SessionTable)
        .set({
          summary_additions: event.data.summary.additions,
          summary_deletions: event.data.summary.deletions,
          summary_files: event.data.summary.files,
          summary_diff_manifest: event.data.summary.diffManifest
            ? {
                ...event.data.summary.diffManifest,
                truncationReasons: [...event.data.summary.diffManifest.truncationReasons],
              }
            : null,
          summary_diffs: event.data.diff.map((diff) => ({ ...diff })),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    // Revert is an independent authority. Local publish uses the commit hook to perform the
    // mutation_epoch CAS and supersede pending intent/steer rows; replay applies the event state here.
    yield* events.project(SessionEvent.RevertChanged, (event) => {
      if (!event.replay) return Effect.void
      return db
        .update(SessionTable)
        .set({
          mutation_epoch: event.data.mutationEpoch,
          revert: event.data.revert
            ? {
                ...event.data.revert,
                messageID: SessionV1.MessageID.make(event.data.revert.messageID),
                partID: event.data.revert.partID ? SessionV1.PartID.make(event.data.revert.partID) : undefined,
              }
            : null,
          ...(event.data.summary
            ? {
                summary_additions: event.data.summary.additions,
                summary_deletions: event.data.summary.deletions,
                summary_files: event.data.summary.files,
                summary_diff_manifest: event.data.summary.diffManifest
                  ? {
                      ...event.data.summary.diffManifest,
                      truncationReasons: [...event.data.summary.diffManifest.truncationReasons],
                    }
                  : null,
              }
            : {}),
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    // Native V2 deletion is terminal: the event's EventV2 commit installs the aggregate tombstone,
    // then this projector removes the materialized Session row in the same transaction. The
    // tombstone is intentionally not in the snapshot rebuild set; deleting an aggregate must not
    // be represented as a resurrectable empty snapshot.
    yield* events.project(SessionEvent.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
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
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
        // SessionRevert cleanup publishes these durable removals for the V1 mirror. Truncate the
        // V2 provider branch from the same message, including unmapped compaction/system rows.
        yield* discardRevertedV2Tail(db, event.data.sessionID, event.data.messageID, true)
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
        const target = yield* discardRevertedV2Tail(db, event.data.sessionID, event.data.messageID, false)
        if (!target) return
        if (target.type === "user") {
          yield* db
            .delete(SessionMessageTable)
            .where(and(eq(SessionMessageTable.id, target.id), eq(SessionMessageTable.session_id, event.data.sessionID)))
            .run()
            .pipe(Effect.orDie)
          return
        }
        if (target.type !== "assistant") return
        const prefix = `prt_${target.id.slice("msg_".length)}_`
        if (!event.data.partID.startsWith(prefix)) return
        const index = Number(event.data.partID.slice(prefix.length))
        if (!Number.isInteger(index) || index < 0) return
        const message = decodeMessage({ ...target.data, id: target.id, type: target.type })
        if (message.type !== "assistant" || index >= message.content.length) return
        const encoded = encodeMessage(
          new SessionMessage.Assistant({ ...message, content: message.content.slice(0, index) }),
        )
        const { id, type, ...data } = encoded
        yield* db
          .update(SessionMessageTable)
          .set({ data })
          .where(and(eq(SessionMessageTable.id, target.id), eq(SessionMessageTable.session_id, event.data.sessionID)))
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
        // R4 — a projected step-finish part does NOT apply usage: every such part is the mirror of
        // a turn whose Step.Ended event already applied the same usage below. Applying here too
        // double-counted every V2 turn (and each mirror re-projection re-counted it again).
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
    yield* events.project(SessionEvent.PermissionsChanged, (event) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return db
        .update(SessionTable)
        .set({ permission: event.data.permissions, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(
          Effect.orDie,
          Effect.andThen(run(db, event)),
          Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
        )
    })
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
          revertEpoch: event.data.revertEpoch,
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
        // Prompt selection becomes active at the safe promotion boundary. Queue inputs retain
        // their own model/agent even when later queued requests were already admitted.
        if (event.data.prompt.agent !== undefined || event.data.prompt.model !== undefined) {
          yield* db
            .update(SessionTable)
            .set({
              ...(event.data.prompt.agent === undefined ? {} : { agent: event.data.prompt.agent }),
              ...(event.data.prompt.model === undefined ? {} : { model: event.data.prompt.model }),
              time_updated: DateTime.toEpochMillis(event.data.timestamp),
            })
            .where(eq(SessionTable.id, event.data.sessionID))
            .run()
            .pipe(Effect.orDie)
          yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)
        }
      }),
    )
    yield* events.project(SessionEvent.InterruptRequested, (event) => {
      if (event.seq === undefined)
        return Effect.die("Synchronized Session interrupt event is missing aggregate sequence")
      return db
        .update(SessionTable)
        .set({ interrupt_seq: event.seq, time_updated: sql`${SessionTable.time_updated}` })
        .where(
          and(
            eq(SessionTable.id, event.data.sessionID),
            sql`(${SessionTable.interrupt_seq} IS NULL OR ${SessionTable.interrupt_seq} < ${event.seq})`,
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })
    yield* events.project(SessionEvent.Execution.Started, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Succeeded, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Failed, () => Effect.void)
    yield* events.project(SessionEvent.Execution.Interrupted, () => Effect.void)
    yield* events.project(SessionEvent.LoopBudget.Triggered, () => Effect.void)
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
    yield* events.project(SessionEvent.StructuredCaptured, (event) => run(db, event))
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
        if (event.data.reason === "hard_gate") {
          if (!event.data.checkpointID || !event.data.checkpointHash)
            return yield* Effect.die("Hard-gate compaction has no checkpoint binding")
          yield* LongContext.assertCheckpoint(
            db,
            event.data.sessionID,
            event.data.checkpointID,
            event.data.checkpointHash,
          ).pipe(Effect.orDie)
        }
        yield* run(db, event)
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, seq)
      })
    })

    // W4-6 — the journal→V1-wire egress runs OUTSIDE the projection transaction: publishing
    // V1 wire events from inside events.project would insert into the same event table the
    // fold is committing to (unique-aggregate collision). A post-commit listener sees the
    // journal after the fold settled, re-reads the folded SessionMessage, derives the wire
    // rows, and the durable fingerprint cursor keeps it exactly-once across replays. This
    // replaces the F-17 in-process mirror with the same listen structure but journal-derived,
    // crash-safe state.
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (Schema.is(SessionEvent.Text.Delta)(event) || Schema.is(SessionEvent.Reasoning.Delta)(event)) {
          if (event.replay || event.seq !== undefined || event.version !== undefined || !event.location) return
          const kind = Schema.is(SessionEvent.Text.Delta)(event) ? "text" : "reasoning"
          const fragmentID = Schema.is(SessionEvent.Text.Delta)(event) ? event.data.textID : event.data.reasoningID
          const part = liveWireParts.get(
            liveWireKey(event.data.sessionID, event.data.assistantMessageID, kind, fragmentID),
          )
          if (
            !part ||
            event.location.directory !== part.location.directory ||
            event.location.workspaceID !== part.location.workspaceID
          )
            return
          // This indexed owner/receipt fence only controls live display, never
          // provider admission. Cancellation or lost ownership cannot reuse it.
          const owner = yield* liveWireOwner(db, part.sessionID)
          if (
            !owner ||
            owner.receiptID !== part.receiptID ||
            owner.ownerToken !== part.ownerToken ||
            owner.mode !== "v2" ||
            owner.releasedAt !== null ||
            owner.expiresAt <= owner.now ||
            owner.directory !== part.location.directory ||
            (owner.workspaceID ?? undefined) !== part.location.workspaceID ||
            !["preparing", "dispatching", "streaming"].includes(owner.state)
          ) {
            liveWireParts.delete(liveWireKey(part.sessionID, part.messageID, kind, fragmentID))
            return
          }
          if (liveWireParts.get(liveWireKey(part.sessionID, part.messageID, kind, fragmentID)) !== part) return
          yield* events.publish(
            SessionV1.Event.PartDelta,
            {
              sessionID: part.sessionID,
              messageID: SessionV1.MessageID.make(part.messageID),
              partID: part.partID,
              field: "text",
              delta: event.data.delta,
            },
            { location: part.location },
          )
          return
        }
        if (
          Schema.is(SessionEvent.Step.Started)(event) ||
          Schema.is(SessionEvent.InterruptRequested)(event) ||
          Schema.is(SessionEvent.Execution.Succeeded)(event) ||
          Schema.is(SessionEvent.Execution.Failed)(event) ||
          Schema.is(SessionEvent.Execution.Interrupted)(event) ||
          Schema.is(SessionEvent.Deleted)(event) ||
          Schema.is(SessionEvent.Moved)(event) ||
          Schema.is(SessionEvent.RevertChanged)(event)
        )
          forgetLiveWireParts(event.data.sessionID)
        if (Schema.is(SessionEvent.Step.Ended)(event) || Schema.is(SessionEvent.Step.Failed)(event))
          forgetLiveWireParts(event.data.sessionID, event.data.assistantMessageID)
        if (Schema.is(SessionV1.Event.MessageRemoved)(event))
          forgetLiveWireParts(event.data.sessionID, event.data.messageID)
        if (Schema.is(SessionV1.Event.PartRemoved)(event))
          forgetLiveWireParts(event.data.sessionID, event.data.messageID, event.data.partID)
        if (Schema.is(SessionEvent.Text.Ended)(event))
          liveWireParts.delete(
            liveWireKey(event.data.sessionID, event.data.assistantMessageID, "text", event.data.textID),
          )
        if (Schema.is(SessionEvent.Reasoning.Ended)(event))
          liveWireParts.delete(
            liveWireKey(event.data.sessionID, event.data.assistantMessageID, "reasoning", event.data.reasoningID),
          )
        if (!event.type.startsWith("session.next.")) return
        const data = event.data as { sessionID?: string; assistantMessageID?: string; messageID?: string }
        if (typeof data.sessionID !== "string") return
        const messageIDs = [data.assistantMessageID, data.messageID].filter(
          (id): id is string => typeof id === "string",
        )
        if (messageIDs.length === 0) return
        yield* Effect.forEach(
          messageIDs,
          (messageID) =>
            publishWireForMessage(
              db,
              events,
              SessionSchema.ID.make(data.sessionID!),
              SessionMessage.ID.make(messageID),
            ),
          { concurrency: 2 },
        ).pipe(Effect.ignore)
        if (!Schema.is(SessionEvent.Text.Started)(event) && !Schema.is(SessionEvent.Reasoning.Started)(event)) return
        if (event.replay || event.seq === undefined || !event.location) return
        const kind = Schema.is(SessionEvent.Text.Started)(event) ? "text" : "reasoning"
        const fragmentID = Schema.is(SessionEvent.Text.Started)(event) ? event.data.textID : event.data.reasoningID
        const row = yield* loadMessageRow(db, event.data.sessionID, event.data.assistantMessageID)
        if (!row) return
        const message = decodeRow(row)
        if (message.type !== "assistant" || message.time.completed) return
        const index = message.content.findIndex((part) => part.type === kind && part.id === fragmentID)
        if (index < 0) return
        const placement = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (
          !placement ||
          event.location.directory !== placement.directory ||
          event.location.workspaceID !== (placement.workspaceID ?? undefined)
        )
          return
        const owner = yield* liveWireOwner(db, event.data.sessionID)
        if (
          !owner ||
          owner.mode !== "v2" ||
          owner.releasedAt !== null ||
          owner.expiresAt <= owner.now ||
          !["preparing", "dispatching", "streaming"].includes(owner.state)
        )
          return
        const partID = legacyAssistantPartID(message.id, index)
        const wire = yield* db
          .select({ data: PartTable.data })
          .from(PartTable)
          .where(
            and(
              eq(PartTable.id, partID),
              eq(PartTable.session_id, event.data.sessionID),
              eq(PartTable.message_id, SessionV1.MessageID.make(message.id)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (wire?.data.type !== kind) return
        if (liveWireParts.size >= 2048) return yield* Effect.logWarning("Live wire fragment identity limit reached")
        liveWireParts.set(liveWireKey(event.data.sessionID, message.id, kind, fragmentID), {
          sessionID: event.data.sessionID,
          messageID: message.id,
          partID,
          receiptID: owner.receiptID,
          ownerToken: owner.ownerToken,
          location: structuredClone(event.location),
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Effect.sync(() => liveWireParts.clear()))))
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
