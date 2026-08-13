import { afterEach, describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import {
  EventArtifactChunkTable,
  EventArtifactTable,
  EventSequenceTable,
  EventSyncSequenceTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { MessageTable, SessionHistoryStateTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { HistoryAuthority } from "@/session/history-authority"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionDiffArtifact } from "@/session/diff-artifact"
import { SessionDiffArtifactFileChunkTable, SessionDiffMigrationReceiptTable } from "@/session/diff-artifact.sql"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { and, asc, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, EventV2.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const seed = Effect.fn("Test.seedLegacyDiff")(function* (input?: {
  corruptMessage?: boolean
  nullPatch?: boolean
  supersededArtifact?: boolean
}) {
  const sessions = yield* Session.Service
  const events = yield* EventV2.Service
  const { db } = yield* Database.Service
  const session = yield* sessions.create({ title: "legacy diff" })
  const messageID = MessageID.ascending()
  const patch = "你".repeat(Math.ceil((EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1024) / 3))
  const diffs = [
    { file: "src/large.ts", patch, additions: 2, deletions: 1, status: "modified" as const },
    ...(input?.nullPatch
      ? [{ file: "src/metadata-only.ts", patch: null, additions: 0, deletions: 0, status: "modified" as const }]
      : []),
  ] as unknown as NonNullable<SessionV1.User["summary"]>["diffs"]
  const message = {
    role: "user" as const,
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
    summary: {
      diffs,
    },
  }
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID,
      session_id: session.id,
      time_created: message.time.created,
      time_updated: message.time.created,
      data: message,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionTable)
    .set({ summary_diffs: message.summary.diffs })
    .where(eq(SessionTable.id, session.id))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionPromptEpochTable)
    .values({
      session_id: session.id,
      epoch: 0,
      state: "active",
      checkpoint_user_id: null,
      checkpoint_assistant_id: null,
      retained_tail_start_id: null,
      source_end_message_id: null,
      checkpoint_hash: null,
      projection_version: HistoryAuthority.PROJECTION_VERSION,
      canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
      base_message_count: 0,
      effective_history_hash: HistoryAuthority.hash([]),
      first_window_id: "win_legacy_diff_first",
      previous_window_id: null,
      window_id: "win_legacy_diff_active",
      world_state_baseline_hash: null,
      authority_state: "ready",
      recovery_reason: null,
      reason: "bootstrap",
      created_at: Date.now(),
      retired_at: null,
    })
    .run()
    .pipe(Effect.orDie)
  const sequence = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, session.id))
    .get()
    .pipe(Effect.orDie)
  const eventID = EventV2.ID.make(`evt_legacy_diff_${messageID}`)
  const syncSequence = yield* db
    .update(EventSyncSequenceTable)
    .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
    .where(eq(EventSyncSequenceTable.id, 1))
    .returning({ seq: EventSyncSequenceTable.seq })
    .get()
    .pipe(Effect.orDie)
  if (!syncSequence) return yield* Effect.die("sync sequence authority missing")
  yield* db
    .insert(EventTable)
    .values({
      id: eventID,
      aggregate_id: session.id,
      seq: (sequence?.seq ?? -1) + 1,
      type: EventV2.versionedType("message.updated", 1),
      data: { sessionID: session.id, info: { ...message, id: messageID, sessionID: session.id } },
      sync_seq: syncSequence.seq,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(EventSequenceTable)
    .set({ seq: (sequence?.seq ?? -1) + 1 })
    .where(eq(EventSequenceTable.aggregate_id, session.id))
    .run()
    .pipe(Effect.orDie)
  expect((yield* events.canonicalizeLegacyArtifacts({ limit: 1 })).processed).toBe(1)
  const artifact = yield* db
    .select()
    .from(EventArtifactTable)
    .where(eq(EventArtifactTable.event_id, eventID))
    .get()
    .pipe(Effect.orDie)
  if (!artifact) return yield* Effect.die("legacy artifact missing")
  const latest = input?.supersededArtifact
    ? yield* Effect.gen(function* () {
        const latestPatch = `${patch}\nlatest`
        const latestMessage = {
          ...message,
          summary: {
            diffs: [{ file: "src/large.ts", patch: latestPatch, additions: 3, deletions: 1, status: "modified" as const }],
          },
        }
        yield* db
          .update(MessageTable)
          .set({ data: latestMessage })
          .where(eq(MessageTable.id, messageID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ summary_diffs: latestMessage.summary.diffs })
          .where(eq(SessionTable.id, session.id))
          .run()
          .pipe(Effect.orDie)
        const latestSync = yield* db
          .update(EventSyncSequenceTable)
          .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
          .where(eq(EventSyncSequenceTable.id, 1))
          .returning({ seq: EventSyncSequenceTable.seq })
          .get()
          .pipe(Effect.orDie)
        if (!latestSync) return yield* Effect.die("latest sync sequence authority missing")
        const latestEventID = EventV2.ID.make(`evt_legacy_diff_latest_${messageID}`)
        yield* db
          .insert(EventTable)
          .values({
            id: latestEventID,
            aggregate_id: session.id,
            seq: (sequence?.seq ?? -1) + 2,
            type: EventV2.versionedType("message.updated", 1),
            data: { sessionID: session.id, info: { ...latestMessage, id: messageID, sessionID: session.id } },
            sync_seq: latestSync.seq,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(EventSequenceTable)
          .set({ seq: (sequence?.seq ?? -1) + 2 })
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .run()
          .pipe(Effect.orDie)
        expect((yield* events.canonicalizeLegacyArtifacts({ limit: 1 })).processed).toBe(1)
        const latestArtifact = yield* db
          .select()
          .from(EventArtifactTable)
          .where(eq(EventArtifactTable.event_id, latestEventID))
          .get()
          .pipe(Effect.orDie)
        if (!latestArtifact) return yield* Effect.die("latest legacy artifact missing")
        return { message: latestMessage, artifact: latestArtifact, patch: latestPatch }
      })
    : undefined
  if (input?.corruptMessage) {
    yield* db
      .run(sql`UPDATE message SET data = json_set(data, '$.summary.diffs[0].patch', 'changed') WHERE id = ${messageID}`)
      .pipe(Effect.orDie)
  }
  return {
    session,
    messageID,
    message: latest?.message ?? message,
    artifact: latest?.artifact ?? artifact,
    patch: latest?.patch ?? patch,
  }
})

function pathFor(template: string, sessionID: string) {
  return template.replace(":sessionID", sessionID)
}

function request(path: string, init?: RequestInit) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory, init)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("Session legacy diff physical migration", () => {
  it.instance(
    "revalidates committed chunks, preserves every PromptEpoch hash, CAS rewrites, and retries exactly",
    () =>
      Effect.gen(function* () {
        const input = yield* seed()
        const { db } = yield* Database.Service
        const before = HistoryAuthority.hash([{ info: { ...input.message, id: input.messageID, sessionID: input.session.id }, parts: [] }])

        const maintenance = yield* request(pathFor(SessionPaths.diffArtifactMaintenance, input.session.id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 1 }),
        })
        expect(maintenance.status).toBe(200)
        expect(yield* json<{ processed: number; committed: number; failed: number }>(maintenance)).toEqual({
          processed: 1,
          committed: 1,
          failed: 0,
        })
        expect(yield* SessionDiffArtifact.migrate({ sessionID: input.session.id, now: 101 })).toEqual({
          processed: 0,
          committed: 0,
          failed: 0,
        })
        const raw = yield* db.get<{ data: string }>(sql`SELECT CAST(data AS TEXT) AS data FROM message WHERE id = ${input.messageID}`)
        expect(raw?.data).not.toContain('"patch"')
        expect(raw?.data).not.toContain('"diffs"')
        const sessionSummary = yield* db
          .select({ diffs: SessionTable.summary_diffs })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.session.id))
          .get()
          .pipe(Effect.orDie)
        expect(sessionSummary?.diffs).toBeNull()
        const stored = yield* MessageV2.get({ sessionID: input.session.id, messageID: input.messageID })
        expect(stored.info.role === "user" ? stored.info.summary?.diffs : undefined).toEqual([])
        expect(stored.info.role === "user" ? stored.info.summary?.diffArtifact?.id : undefined).toBe(
          input.artifact.artifact_id,
        )
        expect(HistoryAuthority.hash([stored])).toBe(before)
        const receipt = yield* db
          .select()
          .from(SessionDiffMigrationReceiptTable)
          .where(eq(SessionDiffMigrationReceiptTable.message_id, input.messageID))
          .get()
          .pipe(Effect.orDie)
        expect(receipt?.state).toBe("committed")
        expect(receipt?.expected_session_summary_hash).not.toBe(receipt?.committed_session_summary_hash)
        expect(receipt?.committed_session_summary_hash).toBe(Hash.sha256("null"))
        expect(receipt?.epoch_hashes).toEqual([{ epoch: 0, before, after: before }])
        const manifestResponse = yield* request(
          `${pathFor(SessionPaths.diffArtifactManifest, input.session.id)}?${new URLSearchParams({
            messageID: input.messageID,
            artifactID: input.artifact.artifact_id,
            limit: "1",
          })}`,
        )
        expect(manifestResponse.status).toBe(200)
        const manifest = yield* json<typeof SessionDiffArtifact.Manifest.Type>(manifestResponse)
        expect(manifest.files).toEqual([
          expect.objectContaining({ file: "src/large.ts", patchBytes: Buffer.byteLength(input.patch) }),
        ])
        const fileResponse = yield* request(
          `${pathFor(SessionPaths.diffArtifactFile, input.session.id)}?${new URLSearchParams({
            messageID: input.messageID,
            artifactID: input.artifact.artifact_id,
            path: "src/large.ts",
            maxBytes: "1024",
          })}`,
        )
        expect(fileResponse.status).toBe(200)
        const file = yield* json<typeof SessionDiffArtifact.File.Type>(fileResponse)
        expect(file.truncated).toBe(true)
        expect(file.returnedBytes).toBeLessThanOrEqual(1024)
        expect(Buffer.from(file.patch).toString()).toBe(file.patch)

        const other = yield* Session.Service.pipe(Effect.flatMap((sessions) => sessions.create({ title: "other" })))
        const unauthorized = yield* request(
          `${pathFor(SessionPaths.diffArtifactManifest, other.id)}?${new URLSearchParams({
            messageID: input.messageID,
            artifactID: input.artifact.artifact_id,
          })}`,
        )
        expect(unauthorized.status).toBe(404)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "records hash mismatch without mutating message or history recovery authority",
    () =>
      Effect.gen(function* () {
        const input = yield* seed({ corruptMessage: true })
        const { db } = yield* Database.Service
        expect(yield* SessionDiffArtifact.migrate({ sessionID: input.session.id, now: 200 })).toEqual({
          processed: 1,
          committed: 0,
          failed: 1,
        })
        const raw = yield* db.get<{ patch: string }>(sql`
          SELECT json_extract(data, '$.summary.diffs[0].patch') AS patch FROM message WHERE id = ${input.messageID}
        `)
        expect(raw?.patch).toBe("changed")
        const receipt = yield* db
          .select()
          .from(SessionDiffMigrationReceiptTable)
          .where(eq(SessionDiffMigrationReceiptTable.message_id, input.messageID))
          .get()
          .pipe(Effect.orDie)
        expect(receipt?.state).toBe("migration_validation_failed")
        expect(receipt?.failure_reason).toContain("no longer matches")
        expect(
          yield* db
            .select()
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, input.session.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        const epoch = yield* db
          .select({ authority: SessionPromptEpochTable.authority_state })
          .from(SessionPromptEpochTable)
          .where(eq(SessionPromptEpochTable.session_id, input.session.id))
          .get()
          .pipe(Effect.orDie)
        expect(epoch?.authority).toBe("ready")
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "preserves a legacy null patch as one verified empty chunk",
    () =>
      Effect.gen(function* () {
        const input = yield* seed({ nullPatch: true })
        expect(yield* SessionDiffArtifact.migrate({ sessionID: input.session.id, now: 150 })).toEqual({
          processed: 1,
          committed: 1,
          failed: 0,
        })
        const manifestResponse = yield* request(
          `${pathFor(SessionPaths.diffArtifactManifest, input.session.id)}?${new URLSearchParams({
            messageID: input.messageID,
            artifactID: input.artifact.artifact_id,
          })}`,
        )
        expect(manifestResponse.status).toBe(200)
        const manifest = yield* json<typeof SessionDiffArtifact.Manifest.Type>(manifestResponse)
        expect(manifest.files).toContainEqual(
          expect.objectContaining({ file: "src/metadata-only.ts", patchBytes: 0 }),
        )
        const { db } = yield* Database.Service
        const emptyChunks = yield* db
          .select()
          .from(SessionDiffArtifactFileChunkTable)
          .where(
            and(
              eq(SessionDiffArtifactFileChunkTable.artifact_id, input.artifact.artifact_id),
              eq(SessionDiffArtifactFileChunkTable.file_index, 1),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        expect(emptyChunks).toHaveLength(1)
        expect(emptyChunks[0]?.data).toEqual(Buffer.alloc(0))
        expect(emptyChunks[0]?.chunk_hash).toBe(Hash.sha256(Buffer.alloc(0)))
        const fileResponse = yield* request(
          `${pathFor(SessionPaths.diffArtifactFile, input.session.id)}?${new URLSearchParams({
            messageID: input.messageID,
            artifactID: input.artifact.artifact_id,
            path: "src/metadata-only.ts",
          })}`,
        )
        expect(fileResponse.status).toBe(200)
        expect(yield* json<typeof SessionDiffArtifact.File.Type>(fileResponse)).toMatchObject({
          patch: "",
          patchBytes: 0,
          returnedBytes: 0,
          truncated: false,
        })
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "rewrites from the latest artifact when one Message has multiple historical diff events",
    () =>
      Effect.gen(function* () {
        const input = yield* seed({ supersededArtifact: true })
        const { db } = yield* Database.Service
        expect(yield* SessionDiffArtifact.migrate({ sessionID: input.session.id, now: 175 })).toEqual({
          processed: 1,
          committed: 1,
          failed: 0,
        })
        const receipt = yield* db
          .select()
          .from(SessionDiffMigrationReceiptTable)
          .where(eq(SessionDiffMigrationReceiptTable.message_id, input.messageID))
          .get()
          .pipe(Effect.orDie)
        expect(receipt).toMatchObject({
          artifact_id: input.artifact.artifact_id,
          source_event_id: input.artifact.event_id,
          state: "committed",
        })
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "fails closed when a committed artifact chunk is corrupted",
    () =>
      Effect.gen(function* () {
        const input = yield* seed()
        const { db } = yield* Database.Service
        const chunk = yield* db
          .select()
          .from(EventArtifactChunkTable)
          .where(eq(EventArtifactChunkTable.artifact_id, input.artifact.artifact_id))
          .orderBy(asc(EventArtifactChunkTable.chunk_index))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .update(EventArtifactChunkTable)
          .set({ data: Buffer.from("corrupt") })
          .where(
            and(
              eq(EventArtifactChunkTable.artifact_id, input.artifact.artifact_id),
              eq(EventArtifactChunkTable.chunk_index, chunk!.chunk_index),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        expect((yield* SessionDiffArtifact.migrate({ sessionID: input.session.id })).failed).toBe(1)
        const row = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, input.messageID))
          .get()
          .pipe(Effect.orDie)
        expect(
          row?.data.role === "user" && row.data.summary && typeof row.data.summary === "object"
            ? row.data.summary.diffs[0]?.patch
            : undefined,
        ).toBe(input.patch)
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "rolls back message, Session summary, and sidecars before recording a CAS failure",
    () =>
      Effect.gen(function* () {
        const input = yield* seed()
        const { db } = yield* Database.Service
        yield* db
          .run(sql.raw(`
            CREATE TRIGGER test_diff_session_cas_loss
            BEFORE UPDATE OF summary_diffs ON session
            WHEN OLD.id = '${input.session.id}'
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `))
          .pipe(Effect.orDie)

        expect(yield* SessionDiffArtifact.migrate({ sessionID: input.session.id, now: 300 })).toEqual({
          processed: 1,
          committed: 0,
          failed: 1,
        })
        const message = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, input.messageID))
          .get()
          .pipe(Effect.orDie)
        expect(
          message?.data.role === "user" && message.data.summary && typeof message.data.summary === "object"
            ? message.data.summary.diffs[0]?.patch
            : undefined,
        ).toBe(input.patch)
        expect(
          (
            yield* db
              .select({ diffs: SessionTable.summary_diffs })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.session.id))
              .get()
              .pipe(Effect.orDie)
          )?.diffs?.[0]?.patch,
        ).toBe(input.patch)
        expect(
          yield* db
            .select()
            .from(SessionDiffMigrationReceiptTable)
            .where(eq(SessionDiffMigrationReceiptTable.message_id, input.messageID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(expect.objectContaining({ state: "migration_validation_failed", failure_reason: "Session summary compare-and-swap lost" }))
      }),
    { git: true },
    30_000,
  )
})
