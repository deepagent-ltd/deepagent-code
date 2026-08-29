import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { MigrationIdentity } from "@deepagent-code/core/database/migration-identity"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import sessionUsageMigration from "@deepagent-code/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@deepagent-code/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@deepagent-code/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@deepagent-code/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@deepagent-code/core/database/migration/20260605042240_add_context_epoch_agent"
import eventDropDistinctMigration from "@deepagent-code/core/database/migration/20260712040000_deepagent_event_drop_distinct"
import timeSuspendedMigration from "@deepagent-code/core/database/migration/20260803000000_time_suspended"
import taskRunDeliveryMigration from "@deepagent-code/core/database/migration/20260724134000_task_run_delivery"
import subagentControlPlaneMigration from "@deepagent-code/core/database/migration/20260803000001_subagent_control_plane_l1"
import taskAdmissionRepairMigration from "@deepagent-code/core/database/migration/20260805000000_repair_task_admission"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import sessionMetadataMigration from "@deepagent-code/core/database/migration/20260511173437_session-metadata"
import compactionContinuationAdmissionMigration from "@deepagent-code/core/database/migration/20260810160000_compaction_continuation_admission"
import partIntegrityBackfillMigration from "@deepagent-code/core/database/migration/20260810170000_part_integrity_backfill"
import legacyActivityProgressMigration from "@deepagent-code/core/database/migration/20260811090000_legacy_activity_progress"
import legacyActivityOwnerMigration from "@deepagent-code/core/database/migration/20260811100000_legacy_activity_owner"
import eventSnapshotAuthorityMigration from "@deepagent-code/core/database/migration/20260813100000_event_snapshot_authority"
import filePartArtifactMigration from "@deepagent-code/core/database/migration/20260813130000_file_part_artifact"
import eventSnapshotChunksMigration from "@deepagent-code/core/database/migration/20260813131000_event_snapshot_chunks"
import eventImmutableMigration from "@deepagent-code/core/database/migration/20260813135000_event_immutable"
import eventSidecarCompactionMigration from "@deepagent-code/core/database/migration/20260813140000_event_sidecar_compaction"
import preparedProviderTurnReceiptMigration from "@deepagent-code/core/database/migration/20260811223000_prepared_provider_turn_receipt"
import learningAdmissionOutboxMigration from "@deepagent-code/core/database/migration/20260812005647_learning_admission_outbox"
import activityPermissionRouteFeedbackMigration from "@deepagent-code/core/database/migration/20260812014934_activity_permission_route_feedback"
import releasedKnowledgeSnapshotMigration from "@deepagent-code/core/database/migration/20260811185417_released_knowledge_snapshot_authority"
import providerAttemptPreDispatchTerminalMigration from "@deepagent-code/core/database/migration/20260812043000_provider_attempt_pre_dispatch_terminal"
import providerOwnerAuthorityMigration from "@deepagent-code/core/database/migration/20260812050000_provider_owner_authority"
import providerTurnIdentityAuthorityMigration from "@deepagent-code/core/database/migration/20260812053000_provider_turn_identity_authority"
import taskStructuredOutputReceiptSchemaMigration from "@deepagent-code/core/database/migration/20260812114412_task_structured_output_receipt_schema"
import taskStructuredOutputReceiptMigration from "@deepagent-code/core/database/migration/20260812114500_task_structured_output_receipt_authority"
import taskExecutionSpecAuthorityMigration from "@deepagent-code/core/database/migration/20260812210000_task_execution_spec_authority"
import taskStructuredOutputEvidenceAuthorityMigration from "@deepagent-code/core/database/migration/20260812220000_task_structured_output_evidence_authority"
import providerCrossStateRecoveryMigration from "@deepagent-code/core/database/migration/20260812061000_provider_cross_state_recovery"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@deepagent-code/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const receiptNamespace = "sec_receipt_migration"
const receiptProjectScope = "prjctx_receipt_migration"
const emptyReleasedRefsFingerprint = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
const preparedTurnHash = "b".repeat(64)
const systemStableHash = "c".repeat(64)
const systemVolatileHash = "d".repeat(64)
const wireRequestHash = "e".repeat(64)
const contextEligibility = {
  requested: {
    contextFederationShadow: false,
    locationIndexesV2Shadow: false,
    contextProjectionV2: false,
    contextQueryToolsV2: false,
    coreV2ExecutionOwner: false,
  },
  enabled: {
    contextFederationShadow: false,
    locationIndexesV2Shadow: false,
    contextProjectionV2: false,
    contextQueryToolsV2: false,
    coreV2ExecutionOwner: false,
  },
  blocked: {},
  project: {
    projectScopeKey: receiptProjectScope,
    stage: "all",
    bucket: 0,
    selected: true,
    killSwitch: false,
  },
}
const contextReadiness = {
  revision: "context-readiness-migration",
  state: "ready",
  identityBound: true,
  indexAvailable: true,
  storageHealthy: true,
  reasons: [],
  observedAt: 0,
  expiresAt: 100,
}

describe("DatabaseMigration", () => {
  test("rejects duplicate migration IDs before changing the database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const duplicate = {
          id: "duplicate-migration-id",
          up: () => Effect.die("duplicate migration must not run"),
        }
        const result = yield* DatabaseMigration.applyOnly(db, [duplicate, duplicate]).pipe(Effect.exit)

        expect(result).toMatchObject({ _tag: "Failure" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()
      }),
    )
  })

  test("stages EventV2 history without rewriting legacy rows and fences old writers", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`,
        )
        yield* db.run(
          sql`CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)`,
        )
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a', 1, NULL)`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-a', 'session-a', 0, 'test.1', '{}')`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-b', 'session-a', 1, 'test.1', '{}')`)

        yield* DatabaseMigration.applyOnly(db, [eventSnapshotAuthorityMigration])
        const oldWriter = yield* db
          .run(
            sql`INSERT INTO event(id, aggregate_id, seq, type, data) VALUES ('event-old-writer', 'session-a', 2, 'test.1', '{}')`,
          )
          .pipe(Effect.exit)
        yield* db.run(sql`UPDATE event_sync_sequence SET seq = seq + 1 WHERE id = 1`)
        yield* db.run(
          sql`INSERT INTO event(id, aggregate_id, seq, type, data, sync_seq) VALUES ('event-new-writer', 'session-a', 2, 'test.1', '{}', (SELECT seq FROM event_sync_sequence WHERE id = 1))`,
        )

        expect(oldWriter._tag).toBe("Failure")
        expect(yield* db.all(sql`SELECT id, sync_seq FROM event ORDER BY rowid`)).toEqual([
          { id: "event-a", sync_seq: null },
          { id: "event-b", sync_seq: null },
          { id: "event-new-writer", sync_seq: 3 },
        ])
        expect(yield* db.all(sql`SELECT sync_seq, event_id FROM event_sync_index`)).toEqual([
          { sync_seq: 3, event_id: "event-new-writer" },
        ])
        expect(
          yield* db.get(
            sql`SELECT seq, backfill_complete, length(generation) AS generation_length, length(cursor_secret) AS secret_length FROM event_sync_sequence WHERE id = 1`,
          ),
        ).toEqual({ seq: 3, backfill_complete: 0, generation_length: 32, secret_length: 64 })
      }),
    )
  })

  test("keeps EventV2 rows append-only after bounded maintenance is installed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE event (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_artifact (artifact_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE event_artifact_chunk (artifact_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE file_part_artifact (
          artifact_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, body_bytes INTEGER NOT NULL,
          chunk_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL, codec_version INTEGER NOT NULL,
          complete INTEGER NOT NULL, created_at INTEGER NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_chunk (artifact_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_binding (
          aggregate_id TEXT NOT NULL, artifact_id TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_import (artifact_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session_diff_artifact_file (artifact_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session_diff_artifact_file_chunk (artifact_id TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_diff_migration_receipt (
          artifact_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL
        )`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-a', '{}')`)
        yield* DatabaseMigration.applyOnly(db, [eventImmutableMigration])

        const updated = yield* db
          .run(sql`UPDATE event SET data = '{"changed":true}' WHERE id = 'event-a'`)
          .pipe(Effect.exit)
        expect(String(updated)).toContain("event_update_immutable")
        expect(yield* db.get(sql`SELECT data FROM event WHERE id = 'event-a'`)).toEqual({ data: "{}" })

        yield* db.run(sql`INSERT INTO file_part_artifact VALUES ('artifact-a', 'hash-a', 1, 1, 1, 1, 0, 1)`)
        yield* db.run(sql`UPDATE file_part_artifact SET complete = 1 WHERE artifact_id = 'artifact-a'`)
        const artifactUpdated = yield* db
          .run(sql`UPDATE file_part_artifact SET body_hash = 'hash-b' WHERE artifact_id = 'artifact-a'`)
          .pipe(Effect.exit)
        expect(String(artifactUpdated)).toContain("file_part_artifact_update_immutable")
      }),
    )
  })
  test("keeps compacted replay and snapshot authorities append-only", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event (
          id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
          type TEXT NOT NULL, data TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE event_artifact (
          event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
          original_data_hash TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE event_dedupe (
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
          data_hash TEXT NOT NULL, source_data TEXT, compacted_at INTEGER NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE event_snapshot (
          snapshot_id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          snapshot_hash TEXT NOT NULL, body TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact (
          artifact_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_binding (
          event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
          artifact_id TEXT NOT NULL, original_data_hash TEXT NOT NULL,
          canonical_data_hash TEXT NOT NULL, canonical_data TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_import (
          event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE CASCADE,
          original_data_hash TEXT NOT NULL, canonical_data_hash TEXT NOT NULL,
          canonical_data TEXT NOT NULL, created_at INTEGER NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE file_part_artifact_discard (
          event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE CASCADE,
          original_data_hash TEXT NOT NULL, canonical_data_hash TEXT NOT NULL,
          canonical_data TEXT NOT NULL, created_at INTEGER NOT NULL
        )`)
        yield* DatabaseMigration.applyOnly(db, [eventSidecarCompactionMigration])
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a')`)
        yield* db.run(sql`INSERT INTO event_dedupe VALUES (
          'session-a', 0, 'event-a', 'test.1', '${"a".repeat(64)}', '{}', 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot VALUES ('snapshot-a', 'session-a', '${"b".repeat(64)}', '{}')`)

        expect(
          String(
            yield* db
              .run(
                sql`
          UPDATE event_dedupe SET data_hash = '${"c".repeat(64)}' WHERE event_id = 'event-a'
        `,
              )
              .pipe(Effect.exit),
          ),
        ).toContain("event_dedupe_update_immutable")
        expect(
          String(yield* db.run(sql`DELETE FROM event_dedupe WHERE event_id = 'event-a'`).pipe(Effect.exit)),
        ).toContain("event_dedupe_delete_immutable")
        yield* db.run(sql`UPDATE event_dedupe SET source_data = NULL WHERE event_id = 'event-a'`)
        expect(
          String(
            yield* db
              .run(
                sql`
          UPDATE event_snapshot SET snapshot_hash = '${"c".repeat(64)}' WHERE snapshot_id = 'snapshot-a'
        `,
              )
              .pipe(Effect.exit),
          ),
        ).toContain("event_snapshot_update_immutable")

        yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = 'session-a'`)
        expect(yield* db.all(sql`SELECT * FROM event_dedupe`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot`)).toEqual([])

        yield* db.run(sql`INSERT INTO file_part_artifact VALUES ('file-a', '${"a".repeat(64)}')`)
        yield* db.run(sql`INSERT INTO file_part_artifact_import VALUES (
          'file-event-a', 'session-file', 1, 'file-a', '${"b".repeat(64)}',
          '${"c".repeat(64)}', '{}', 1
        )`)
        expect(
          String(
            yield* db
              .run(
                sql`
          UPDATE file_part_artifact_import SET original_data_hash = '${"d".repeat(64)}'
        `,
              )
              .pipe(Effect.exit),
          ),
        ).toContain("file_part_artifact_import_update_immutable")
        expect(String(yield* db.run(sql`DELETE FROM file_part_artifact_import`).pipe(Effect.exit))).toContain(
          "file_part_artifact_import_not_consumed",
        )
        yield* db.run(sql`INSERT INTO file_part_artifact_binding VALUES (
          'file-event-a', 'session-file', 1, 'file-a', '${"b".repeat(64)}', '${"c".repeat(64)}', '{}'
        )`)
        yield* db.run(sql`DELETE FROM file_part_artifact_import`)
        yield* db.run(sql`INSERT INTO file_part_artifact_import VALUES (
          'file-event-b', 'session-file', 2, 'file-a', '${"b".repeat(64)}',
          '${"c".repeat(64)}', '{}', 1
        )`)
        yield* db.run(sql`DELETE FROM file_part_artifact WHERE artifact_id = 'file-a'`)
        expect(yield* db.all(sql`SELECT * FROM file_part_artifact_import`)).toEqual([])
      }),
    )
  })
  test("upgrades the exact legacy snapshot candidate schema without losing rows or chunks", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE event_sequence (
          aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT
        )`)
        yield* db.run(sql`CREATE TABLE event (
          id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
        )`)
        yield* DatabaseMigration.applyOnly(db, [
          eventSnapshotAuthorityMigration,
          filePartArtifactMigration,
          eventSnapshotChunksMigration,
        ])
        yield* db.run(sql`DROP TABLE file_part_artifact_discard`)
        yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq) VALUES ('session-legacy-snapshot', 0)`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt(
          snapshot_id, aggregate_id, through_seq, expected_latest, owner_id, codec, schema_version,
          projection_revision, cursor, row_count, encoded_bytes, content_hash, tables, state, created_at, updated_at
        ) VALUES (
          'snapshot-legacy', 'session-legacy-snapshot', 0, 0, NULL, 'session-projection', 1,
          'revision-legacy', NULL, 1, 2, ${"a".repeat(64)}, '{"session":1}', 'complete', 1, 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot(
          snapshot_id, aggregate_id, through_seq, sync_seq, codec, schema_version,
          snapshot_hash, body, owner_id, created_at
        ) VALUES (
          'snapshot-legacy', 'session-legacy-snapshot', 0, 1, 'session-projection', 1,
          ${"b".repeat(64)}, '{}', NULL, 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_chunk(row_hash, chunk_index, data, chunk_hash)
          VALUES (${"c".repeat(64)}, 0, X'7B7D', ${"d".repeat(64)})`)
        yield* db.run(sql`INSERT INTO event_snapshot_row(
          snapshot_id, aggregate_id, row_index, table_name, row_key,
          row_hash, row_bytes, chunk_count, chain_hash
        ) VALUES (
          'snapshot-legacy', 'session-legacy-snapshot', 0, 'session', 'session-legacy-snapshot',
          ${"c".repeat(64)}, 2, 1, ${"e".repeat(64)}
        )`)
        yield* db.run(sql`UPDATE event_sequence SET retention_floor_seq = 0, snapshot_id = 'snapshot-legacy'
          WHERE aggregate_id = 'session-legacy-snapshot'`)

        yield* db.run(sql`DROP TRIGGER event_sequence_snapshot_validate_update`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_delete_active_guard`)
        yield* db.run(sql`ALTER TABLE event_snapshot RENAME TO event_snapshot_current`)
        yield* db.run(sql`CREATE TABLE event_snapshot (
          snapshot_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
          sync_seq INTEGER NOT NULL UNIQUE CHECK (sync_seq >= 0),
          codec TEXT NOT NULL CHECK (length(codec) > 0),
          schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
          snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
          body TEXT NOT NULL CHECK (json_valid(body)),
          owner_id TEXT, created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, through_seq)
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot SELECT * FROM event_snapshot_current`)
        yield* db.run(sql`DROP TABLE event_snapshot_current`)

        yield* db.run(sql`DROP TRIGGER event_snapshot_row_immutable`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_row_delete_guard`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_row_chunk_cleanup`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_aggregate_cleanup`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_chunk_delete_guard`)
        yield* db.run(sql`ALTER TABLE event_snapshot_row RENAME TO event_snapshot_row_current`)
        yield* db.run(sql`CREATE TABLE event_snapshot_row (
          snapshot_id TEXT NOT NULL,
          row_index INTEGER NOT NULL CHECK (row_index >= 0),
          table_name TEXT NOT NULL CHECK (length(table_name) > 0),
          row_key TEXT NOT NULL CHECK (length(row_key) > 0),
          row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
          row_bytes INTEGER NOT NULL CHECK (row_bytes > 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
          chain_hash TEXT NOT NULL CHECK (length(chain_hash) = 64),
          PRIMARY KEY (snapshot_id, row_index),
          UNIQUE (snapshot_id, table_name, row_key)
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_row(
          snapshot_id, row_index, table_name, row_key, row_hash, row_bytes, chunk_count, chain_hash
        ) SELECT snapshot_id, row_index, table_name, row_key, row_hash, row_bytes, chunk_count, chain_hash
          FROM event_snapshot_row_current`)
        yield* db.run(sql`DROP TABLE event_snapshot_row_current`)

        yield* db.run(sql`ALTER TABLE event_snapshot_attempt RENAME TO event_snapshot_attempt_current`)
        yield* db.run(sql`CREATE TABLE event_snapshot_attempt (
          snapshot_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
          expected_latest INTEGER NOT NULL CHECK (expected_latest >= 0),
          owner_id TEXT,
          codec TEXT NOT NULL CHECK (length(codec) > 0),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          projection_revision TEXT NOT NULL,
          cursor TEXT,
          row_count INTEGER NOT NULL CHECK (row_count >= 0),
          encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          tables TEXT NOT NULL CHECK (json_valid(tables)),
          state TEXT NOT NULL CHECK (state IN ('prepared', 'staged', 'complete')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt SELECT * FROM event_snapshot_attempt_current`)
        yield* db.run(sql`DROP TABLE event_snapshot_attempt_current`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt(
          snapshot_id, aggregate_id, through_seq, expected_latest, codec, schema_version,
          projection_revision, row_count, encoded_bytes, content_hash, tables, state, created_at, updated_at
        ) VALUES (
          'snapshot-orphan-attempt', 'session-missing', 0, 0, 'session-projection', 1,
          'revision-orphan', 1, 2, ${"f".repeat(64)}, '{}', 'staged', 1, 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_chunk(row_hash, chunk_index, data, chunk_hash)
          VALUES (${"4".repeat(64)}, 0, X'7B7D', ${"5".repeat(64)})`)
        yield* db.run(sql`INSERT INTO event_snapshot_row(
          snapshot_id, row_index, table_name, row_key, row_hash, row_bytes, chunk_count, chain_hash
        ) VALUES (
          'snapshot-orphan-attempt', 0, 'session', 'session-missing',
          ${"4".repeat(64)}, 2, 1, ${"6".repeat(64)}
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_chunk(row_hash, chunk_index, data, chunk_hash)
          VALUES (${"1".repeat(64)}, 0, X'7B7D', ${"2".repeat(64)})`)
        yield* db.run(sql`INSERT INTO event_snapshot_row(
          snapshot_id, row_index, table_name, row_key, row_hash, row_bytes, chunk_count, chain_hash
        ) VALUES (
          'snapshot-crash-staged', 0, 'session', 'session-crash-staged',
          ${"1".repeat(64)}, 2, 1, ${"3".repeat(64)}
        )`)

        yield* DatabaseMigration.applyOnly(db, [eventSidecarCompactionMigration])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info('event_snapshot_row')`)).map((row) => row.name),
        ).toEqual([
          "snapshot_id",
          "aggregate_id",
          "row_index",
          "table_name",
          "row_key",
          "row_hash",
          "row_bytes",
          "chunk_count",
          "chain_hash",
        ])
        expect(yield* db.get(sql`SELECT aggregate_id, row_key, row_bytes FROM event_snapshot_row`)).toEqual({
          aggregate_id: "session-legacy-snapshot",
          row_key: "session-legacy-snapshot",
          row_bytes: 2,
        })
        expect(yield* db.get(sql`SELECT hex(data) AS data, chunk_hash FROM event_snapshot_chunk`)).toEqual({
          data: "7B7D",
          chunk_hash: "d".repeat(64),
        })
        expect(
          yield* db.all(sql`SELECT * FROM event_snapshot_row WHERE snapshot_id = 'snapshot-crash-staged'`),
        ).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot_chunk WHERE row_hash = ${"1".repeat(64)}`)).toEqual([])
        expect(
          yield* db.all(sql`SELECT * FROM event_snapshot_attempt WHERE snapshot_id = 'snapshot-orphan-attempt'`),
        ).toEqual([])
        expect(
          yield* db.all(sql`SELECT * FROM event_snapshot_row WHERE snapshot_id = 'snapshot-orphan-attempt'`),
        ).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot_chunk WHERE row_hash = ${"4".repeat(64)}`)).toEqual([])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list('event_snapshot')`)).filter(
            (index) => index.unique === 1,
          ),
        ).toHaveLength(2)
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_part_artifact_discard'`,
          ),
        ).toEqual({ name: "file_part_artifact_discard" })
        expect(yield* db.all(sql`PRAGMA foreign_key_list('event_snapshot_attempt')`)).toContainEqual(
          expect.objectContaining({
            table: "event_sequence",
            from: "aggregate_id",
            to: "aggregate_id",
            on_delete: "CASCADE",
          }),
        )
        expect(
          yield* db.get(sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'event_snapshot_row_hash_idx'
        `),
        ).toEqual({ name: "event_snapshot_row_hash_idx" })
        expect(
          yield* db.get(sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'event_snapshot_row_aggregate_idx'
        `),
        ).toEqual({ name: "event_snapshot_row_aggregate_idx" })
        expect(
          yield* db.get(sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'event_snapshot_attempt_aggregate_idx'
        `),
        ).toEqual({ name: "event_snapshot_attempt_aggregate_idx" })
        expect(
          (yield* db
            .run(
              sql`INSERT INTO event_snapshot_attempt(
          snapshot_id, aggregate_id, through_seq, expected_latest, codec, schema_version,
          projection_revision, row_count, encoded_bytes, content_hash, tables, state, created_at, updated_at
        ) VALUES (
          'snapshot-orphan', 'session-missing', 0, 0, 'session-projection', 1,
          'revision-orphan', 0, 0, ${"f".repeat(64)}, '{}', 'prepared', 1, 1
        )`,
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")

        yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id = 'session-legacy-snapshot'`)
        expect(yield* db.all(sql`SELECT * FROM event_snapshot`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot_attempt`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot_row`)).toEqual([])
        expect(yield* db.all(sql`SELECT * FROM event_snapshot_chunk`)).toEqual([])
      }),
    )
  })
  test("rejects conflicting legacy snapshot authorities without mutating staged rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(
          sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`,
        )
        yield* db.run(sql`CREATE TABLE event (
          id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
        )`)
        yield* DatabaseMigration.applyOnly(db, [
          eventSnapshotAuthorityMigration,
          filePartArtifactMigration,
          eventSnapshotChunksMigration,
        ])
        yield* db.run(sql`DROP TABLE file_part_artifact_discard`)
        yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq) VALUES ('session-a', 0), ('session-b', 0)`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt(
          snapshot_id, aggregate_id, through_seq, expected_latest, codec, schema_version,
          projection_revision, row_count, encoded_bytes, content_hash, tables, state, created_at, updated_at
        ) VALUES (
          'snapshot-conflict', 'session-a', 0, 0, 'session-projection', 1,
          'revision-conflict', 1, 2, ${"a".repeat(64)}, '{"session":1}', 'complete', 1, 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot(
          snapshot_id, aggregate_id, through_seq, sync_seq, codec, schema_version,
          snapshot_hash, body, created_at
        ) VALUES (
          'snapshot-conflict', 'session-b', 0, 1, 'session-projection', 1,
          ${"b".repeat(64)}, '{}', 1
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_chunk(row_hash, chunk_index, data, chunk_hash)
          VALUES (${"c".repeat(64)}, 0, X'7B7D', ${"d".repeat(64)})`)
        yield* db.run(sql`INSERT INTO event_snapshot_row(
          snapshot_id, aggregate_id, row_index, table_name, row_key,
          row_hash, row_bytes, chunk_count, chain_hash
        ) VALUES (
          'snapshot-conflict', 'session-a', 0, 'session', 'session-a',
          ${"c".repeat(64)}, 2, 1, ${"e".repeat(64)}
        )`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_row_immutable`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_row_delete_guard`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_row_chunk_cleanup`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_aggregate_cleanup`)
        yield* db.run(sql`DROP TRIGGER event_snapshot_chunk_delete_guard`)
        yield* db.run(sql`ALTER TABLE event_snapshot_row RENAME TO event_snapshot_row_current`)
        yield* db.run(sql`CREATE TABLE event_snapshot_row (
          snapshot_id TEXT NOT NULL, row_index INTEGER NOT NULL, table_name TEXT NOT NULL,
          row_key TEXT NOT NULL, row_hash TEXT NOT NULL, row_bytes INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL, chain_hash TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, row_index), UNIQUE (snapshot_id, table_name, row_key)
        )`)
        yield* db.run(sql`INSERT INTO event_snapshot_row
          SELECT snapshot_id, row_index, table_name, row_key, row_hash, row_bytes, chunk_count, chain_hash
          FROM event_snapshot_row_current`)
        yield* db.run(sql`DROP TABLE event_snapshot_row_current`)

        const before = yield* db.get(sql`SELECT snapshot_id, row_key, row_hash FROM event_snapshot_row`)
        const result = yield* DatabaseMigration.applyOnly(db, [eventSidecarCompactionMigration]).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(String(result)).toContain("conflicting aggregate authorities")
        expect(yield* db.get(sql`SELECT snapshot_id, row_key, row_hash FROM event_snapshot_row`)).toEqual(before)
        expect(yield* db.get(sql`SELECT hex(data) AS data FROM event_snapshot_chunk`)).toEqual({ data: "7B7D" })
        expect(
          yield* db.get(sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_part_artifact_discard'
        `),
        ).toBeUndefined()
      }),
    )
  })
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* seedReceiptScope(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name, dflt_value FROM pragma_table_info('session_context_epoch') WHERE name = 'agent'`,
          ),
        ).toEqual({ name: "agent", dflt_value: "'build'" })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_run', 'task_admission', 'task_notification_outbox') ORDER BY name`,
          ),
        ).toEqual([{ name: "task_admission" }, { name: "task_notification_outbox" }, { name: "task_run" }])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('task_run_child_generation_idx', 'task_run_child_active_idx', 'task_notification_outbox_due_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "task_notification_outbox_due_idx" },
          { name: "task_run_child_active_idx" },
          { name: "task_run_child_generation_idx" },
        ])
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(yield* db.get(sql`SELECT name FROM pragma_table_info('session') WHERE name = 'time_suspended'`)).toEqual(
          { name: "time_suspended" },
        )
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_time_suspended_idx'`,
          ),
        ).toEqual({ name: "session_time_suspended_idx" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_tool_argument_receipt'`,
          ),
        ).toEqual({ name: "session_tool_argument_receipt" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_fork_intent') WHERE name = 'side_effects_completed_at'`,
          ),
        ).toEqual({ name: "side_effects_completed_at" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_fork_intent_side_effects_idx'`,
          ),
        ).toEqual({ name: "session_fork_intent_side_effects_idx" })
        expect(
          yield* db.all(
            sql`SELECT name FROM pragma_table_info('session_tool_request_receipt') WHERE name IN ('provider_request_hash', 'response_chain_reuse_decision', 'response_chain_refusal_reason') ORDER BY name`,
          ),
        ).toEqual([
          { name: "provider_request_hash" },
          { name: "response_chain_refusal_reason" },
          { name: "response_chain_reuse_decision" },
        ])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('session_tool_argument_receipt_call_idx', 'session_tool_argument_receipt_created_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "session_tool_argument_receipt_call_idx" },
          { name: "session_tool_argument_receipt_created_idx" },
        ])
        expect(
          yield* db.get(
            sql`SELECT name, dflt_value FROM pragma_table_info('session_tool_argument_receipt') WHERE name = 'validation_outcome'`,
          ),
        ).toEqual({ name: "validation_outcome", dflt_value: "'not_evaluated'" })
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'owner-constraint-test',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint, owner_token, request_state, created_at
          ) VALUES (
            'receipt-constraint-test', 1, 'session-constraint-test', 'message-constraint-test',
            'provider-test', 'model-test', '[]', '[]', '[]', '[]',
            ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]', ${emptyReleasedRefsFingerprint},
            'owner-constraint-test', 'dispatched', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_argument_receipt (
            receipt_id, layer, ordinal, event_type, payload_keys, unavailable_reason, created_at
          ) VALUES (
            'receipt-constraint-test', 'raw_frame', 0, 'raw', '[]', 'raw_receipt_gate_disabled', 1
          )
        `)
        const emptyEvidence = yield* db
          .run(
            sql`
            INSERT INTO session_tool_argument_receipt (
              receipt_id, layer, ordinal, event_type, payload_keys, created_at
            ) VALUES (
              'receipt-constraint-test', 'ai_sdk_input', 0, 'tool-call', '[]', 1
            )
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(emptyEvidence)).toBe(true)
        const invalidOutcome = yield* db
          .run(
            sql`
            UPDATE session_tool_argument_receipt
            SET validation_outcome = 'untrusted'
            WHERE receipt_id = 'receipt-constraint-test'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(invalidOutcome)).toBe(true)
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("reapplying tracked migrations is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const before = yield* db.get(sql`SELECT count(*) as count FROM migration`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual(before)
      }),
    )
  })

  test("accepts the historical subagent control-plane migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed)
          VALUES ('20260803000000_subagent_control_plane_l1', 1)
        `)

        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.all(sql`
            SELECT id FROM migration
            WHERE id LIKE '2026080300000%'
            ORDER BY id
          `),
        ).toEqual([
          { id: "20260803000000_subagent_control_plane_l1" },
          { id: "20260803000000_time_suspended" },
          { id: "20260803000001_subagent_control_plane_l1" },
        ])
      }),
    )
  })

  test("accepts historical event-maintenance migration ids without replay", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const identities = [
          [MigrationIdentity.Historical.finalAuthorities, MigrationIdentity.Canonical.finalAuthorities],
          [MigrationIdentity.Historical.eventMaintenance, MigrationIdentity.Canonical.eventMaintenance],
          [MigrationIdentity.Historical.eventSidecarLifecycle, MigrationIdentity.Canonical.eventSidecarLifecycle],
          [MigrationIdentity.Historical.eventSidecarIndexes, MigrationIdentity.Canonical.eventSidecarIndexes],
          [MigrationIdentity.Historical.eventAggregateIndexes, MigrationIdentity.Canonical.eventAggregateIndexes],
        ] as const
        yield* Effect.forEach(
          identities,
          ([historical, canonical]) =>
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.run(sql`DELETE FROM migration WHERE id = ${canonical}`)
                yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${historical}, 1)`)
              }),
            ),
          { discard: true },
        )
        const before = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)

        yield* DatabaseMigration.apply(db)

        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)).toEqual(before)
        expect(
          yield* db.all<{ id: string }>(sql`
            SELECT id FROM migration
            WHERE id IN (${sql.join(
              identities.flatMap(([historical, canonical]) => [historical, canonical]).map((id) => sql`${id}`),
              sql`, `,
            )})
            ORDER BY id
          `),
        ).toEqual(identities.map(([historical]) => ({ id: historical })).sort((a, b) => a.id.localeCompare(b.id)))
      }),
    )
  })

  test("reconciles the known merged migration lineage without rewriting current authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const mergedInsertions = new Set([
          "20260812120000_legacy_provider_recovery",
          "20260812130000_legacy_activity_lifecycle_expand",
          "20260812140000_session_diff_manifest",
          MigrationIdentity.Canonical.eventMaintenance,
          "20260813100000_event_snapshot_authority",
          "20260813110000_provider_recovery_authority_bridge",
          "20260813120000_legacy_provider_receipt_supersession",
          "20260813125000_event_sync_backfill_authority",
          "20260813130000_file_part_artifact",
          "20260813131000_event_snapshot_chunks",
          "20260813132000_session_diff_artifact",
          "20260813133000_session_transfer_authority",
          "20260813134000_database_capability",
          "20260813135000_event_immutable",
          "20260813140000_event_sidecar_compaction",
          MigrationIdentity.Canonical.eventSidecarLifecycle,
          MigrationIdentity.Canonical.eventSidecarIndexes,
          MigrationIdentity.Canonical.eventAggregateIndexes,
          "20260813120346_v2_provider_parity_campaign",
          "20260813121129_v2_provider_parity_response_fingerprint",
          "20260813121200_v2_provider_parity_campaign_authority",
          "20260813150000_single_authority_snapshot_merge",
        ])

        yield* DatabaseMigration.applyOnly(
          db,
          migrations.filter(
            (migration) =>
              !mergedInsertions.has(migration.id) &&
              migration.id <= "20260820130000_compaction_continuation_fail_closed",
          ),
        )
        yield* db.run(sql`
          INSERT INTO event_sequence(aggregate_id, seq, owner_id)
          VALUES ('aggregate-merged-history', 0, NULL)
        `)
        yield* db.run(sql`
          INSERT INTO event(id, aggregate_id, seq, type, data)
          VALUES ('event-merged-history', 'aggregate-merged-history', 0, 'merge.history', '{"preserved":true}')
        `)

        yield* DatabaseMigration.apply(db)

        const completedMigrations = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((migration) => migration.id),
        )
        expect([...mergedInsertions].every((id) => completedMigrations.has(id))).toBe(true)
        expect(yield* db.get(sql`SELECT data FROM event WHERE id = 'event-merged-history'`)).toEqual({
          data: '{"preserved":true}',
        })
        expect(
          yield* db.get(sql`
            SELECT state, cursor_rowid, high_water_rowid, processed_count
            FROM event_sync_backfill WHERE id = 1
          `),
        ).toEqual({ state: "pending", cursor_rowid: 0, high_water_rowid: 1, processed_count: 0 })
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'session_prompt_epoch_message',
              'session_legacy_activity_run',
              'event_snapshot',
              'file_part_artifact',
              'session_transfer_operation',
              'database_capability',
              'session_v2_provider_parity_baseline'
            )
            ORDER BY name
          `),
        ).toEqual([
          { name: "database_capability" },
          { name: "event_snapshot" },
          { name: "file_part_artifact" },
          { name: "session_legacy_activity_run" },
          { name: "session_prompt_epoch_message" },
          { name: "session_transfer_operation" },
          { name: "session_v2_provider_parity_baseline" },
        ])
        expect(
          yield* db.get(sql`
            SELECT capability, minimum_reader_protocol, minimum_writer_protocol
            FROM database_capability
          `),
        ).toEqual({
          capability: "bounded_event_snapshot_v1",
          minimum_reader_protocol: 2,
          minimum_writer_protocol: 2,
        })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])

        const completedBeforeRetry = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual(completedBeforeRetry)
      }),
    )
  })

  test("rejects divergent and gapped migration histories before running DDL", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`CREATE TABLE sentinel (value TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO sentinel VALUES ('unchanged')`)
        yield* db.run(sql`INSERT INTO migration VALUES (${migrations[1]!.id}, 1)`)
        const marker = { id: "migration-a", up: () => db.run(sql`DELETE FROM sentinel`) }
        const later = { id: "migration-b", up: () => Effect.void }

        const gapped = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(String(gapped)).toContain("database migration history")
        expect(yield* db.all(sql`SELECT value FROM sentinel`)).toEqual([{ value: "unchanged" }])

        yield* db.run(sql`DELETE FROM migration`)
        yield* db.run(sql`INSERT INTO migration VALUES ('incompatible-lineage', 1)`)
        const divergent = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(String(divergent)).toContain("incompatible lineage")
        expect(yield* db.all(sql`SELECT value FROM sentinel`)).toEqual([{ value: "unchanged" }])

        // Focused migration tests intentionally apply slices and remain independent of the global journal.
        yield* db.run(sql`DELETE FROM migration`)
        yield* DatabaseMigration.applyOnly(db, [marker, later])
        expect(yield* db.all(sql`SELECT value FROM sentinel`)).toEqual([])
      }),
    )
  })

  test("upgrades a pre-snapshot database without inventing a released head", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex(
          (migration) => migration.id === releasedKnowledgeSnapshotMigration.id,
        )
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        yield* seedReceiptScope(db)

        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'released_knowledge_snapshot_head'`,
          ),
        ).toBeUndefined()

        yield* DatabaseMigration.applyOnly(db, [releasedKnowledgeSnapshotMigration])

        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'released_knowledge_snapshot_head'`,
          ),
        ).toEqual({ name: "released_knowledge_snapshot_head" })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM released_knowledge_snapshot_head`)).toEqual({ count: 0 })
        expect(yield* db.run(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("legacy activity migration backfills V2 source identity and rejects mismatched legacy admissions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_intent (
          intent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, admitted_message_id TEXT,
          delivery TEXT, selected_payload_hash TEXT, state TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE session_input (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
          delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL, promoted_seq INTEGER,
          time_created INTEGER NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE session_activity (
          activity_id TEXT PRIMARY KEY, trigger_input_id TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE part (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_tool_request_receipt (receipt_id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_migration')`)
        yield* db.run(sql`INSERT INTO session_input VALUES
          ('input-v2', 'ses_migration', '{"text":"v2"}', 'turn', 1, 7, 11)`)
        yield* db.run(sql`INSERT INTO session_activity VALUES ('activity-v2', 'input-v2')`)

        yield* DatabaseMigration.applyOnly(db, [legacyActivityProgressMigration])
        expect(
          yield* db.get(sql`
            SELECT source_kind, payload_fingerprint_kind, payload_fingerprint
            FROM session_activity_admission WHERE admission_id = 'v2:input-v2'
          `),
        ).toEqual({
          source_kind: "session_input",
          payload_fingerprint_kind: "source_identity",
          payload_fingerprint: "session-input:input-v2",
        })

        yield* db.run(sql`INSERT INTO session_intent VALUES
          ('legacy-intent', 'ses_migration', 'legacy-message', 'turn', 'payload-hash', 'admitted')`)
        yield* db.run(sql`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES ('legacy-admission', 'ses_migration', 'legacy_intent', 'legacy-intent',
            'legacy-message', 'turn', 'payload_hash', 'payload-hash', 12)
        `)
        yield* db.run(sql`INSERT INTO session_legacy_activity VALUES
          ('legacy-activity', 'ses_migration', 0, 'legacy-admission', 'active', NULL, 12, NULL)`)
        yield* db.run(sql`INSERT INTO session_legacy_activity_admission
          (activity_id, admission_id, ordinal, role, attached_at)
          VALUES ('legacy-activity', 'legacy-admission', 0, 'trigger', 12)`)
        yield* DatabaseMigration.applyOnly(db, [legacyActivityOwnerMigration])
        expect(
          yield* db.get(sql`SELECT owner_token FROM session_legacy_activity WHERE activity_id = 'legacy-activity'`),
        ).toEqual({ owner_token: "pre-owner-migration" })
        expect(
          Exit.isFailure(
            yield* db
              .run(sql`UPDATE session_legacy_activity SET owner_token = 'other' WHERE activity_id = 'legacy-activity'`)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_activity_admission (
                  admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
                  delivery, payload_fingerprint_kind, payload_fingerprint, created_at
                ) VALUES ('invalid-admission', 'ses_migration', 'legacy_intent', 'legacy-intent',
                  'legacy-message', 'turn', 'source_identity', 'session-input:legacy-message', 12)
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("enforces provider receipt lifecycle and compaction part provenance", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'owner-1',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          ), (
            'owner-released',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          UPDATE session_provider_owner_lease
          SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          WHERE owner_token = 'owner-released'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_tool_request_receipt (
                  receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
                  registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
                  released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
                  released_knowledge_binding_state, released_knowledge_exact_refs,
                  released_knowledge_exact_refs_fingerprint, request_state, created_at
                ) VALUES (
                  'receipt-provider-unowned', 99, 'session-provider-lifecycle', 'message-provider-lifecycle',
                  'provider-test', 'model-test', '[]', '[]', '[]', '[]',
                  ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
                  ${emptyReleasedRefsFingerprint}, 'prepared', 1
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_tool_request_receipt (
                  receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
                  registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
                  released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
                  released_knowledge_binding_state, released_knowledge_exact_refs,
                  released_knowledge_exact_refs_fingerprint, owner_token, request_state, created_at
                ) VALUES (
                  'receipt-provider-expired-owner', 98, 'session-provider-lifecycle', 'message-provider-lifecycle',
                  'provider-test', 'model-test', '[]', '[]', '[]', '[]',
                  ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
                  ${emptyReleasedRefsFingerprint}, 'owner-released', 'prepared', 100
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            request_state, provider_state, prompt_epoch, prompt_window_id, effective_history_hash,
            request_input_hash, owner_token, context_selection_id, context_eligibility,
            context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint, created_at
          ) VALUES (
            'receipt-provider-lifecycle', 1, 'session-provider-lifecycle', 'message-provider-lifecycle',
            'provider-test', 'model-test', '[]', '[]', '[]', '[]', 'prepared', 'preparing',
            0, 'window-0', 'history-0', 'input-hash', 'owner-1', NULL,
            ${JSON.stringify(contextEligibility)}, ${JSON.stringify(contextReadiness)},
            ${contextActivation(1)},
            lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
            ${emptyReleasedRefsFingerprint}, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            request_state, provider_state, prompt_epoch, prompt_window_id, effective_history_hash,
            request_input_hash, owner_token, context_selection_id, context_eligibility,
            context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint, created_at
          ) VALUES (
            'receipt-provider-forged-activation', 2, 'session-provider-lifecycle', 'message-provider-lifecycle',
            'provider-test', 'model-test', '[]', '[]', '[]', '[]', 'prepared', 'preparing',
            0, 'window-forged', 'history-forged', 'input-forged', 'owner-1', NULL,
            ${JSON.stringify(contextEligibility)}, ${JSON.stringify(contextReadiness)},
            ${contextActivation(2).replace('"readinessAgeMs":2', '"readinessAgeMs":99')},
            lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
            ${emptyReleasedRefsFingerprint}, 2
          )
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id = 'receipt-provider-forged-activation'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                    adapter_prepared_at = 2, provider_request_hash = ${wireRequestHash},
                    prepared_turn_hash = ${preparedTurnHash},
                    system_stable_hash = ${systemStableHash},
                    system_volatile_hash = ${systemVolatileHash},
                    wire_request_hash = ${wireRequestHash},
                    tool_definition_hash = ${preparedTurnHash}
                WHERE receipt_id = 'receipt-provider-forged-activation'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'dispatching'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        for (const update of [
          sql`UPDATE session_tool_request_receipt SET final_request_hash = ${wireRequestHash} WHERE receipt_id = 'receipt-provider-lifecycle'`,
          sql`UPDATE session_tool_request_receipt SET provider_request_hash = ${wireRequestHash} WHERE receipt_id = 'receipt-provider-lifecycle'`,
          sql`UPDATE session_tool_request_receipt SET adapter_prepared_at = 2 WHERE receipt_id = 'receipt-provider-lifecycle'`,
          sql`UPDATE session_tool_request_receipt SET prompt_cache_key = 'cache-key' WHERE receipt_id = 'receipt-provider-lifecycle'`,
          sql`UPDATE session_tool_request_receipt SET tool_definition_hash = ${preparedTurnHash} WHERE receipt_id = 'receipt-provider-lifecycle'`,
          sql`UPDATE session_tool_request_receipt SET final_offered_tool_ids = '["read"]' WHERE receipt_id = 'receipt-provider-lifecycle'`,
        ]) {
          expect(Exit.isFailure(yield* db.run(update).pipe(Effect.exit))).toBe(true)
        }
        for (const invalidSeal of [
          sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                provider_request_hash = ${wireRequestHash}, adapter_prepared_at = 2,
                prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
                system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
                tool_definition_hash = ''
            WHERE receipt_id = 'receipt-provider-lifecycle'
          `,
          sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                provider_request_hash = ${wireRequestHash}, adapter_prepared_at = 2,
                prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
                system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
                tool_definition_hash = ${preparedTurnHash}, final_offered_tool_ids = '[1,1]'
            WHERE receipt_id = 'receipt-provider-lifecycle'
          `,
          sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                provider_request_hash = ${wireRequestHash}, adapter_prepared_at = 2,
                prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
                system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
                tool_definition_hash = ${preparedTurnHash}, final_offered_tool_ids = '["read", "read"]'
            WHERE receipt_id = 'receipt-provider-lifecycle'
          `,
        ]) {
          expect(Exit.isFailure(yield* db.run(invalidSeal).pipe(Effect.exit))).toBe(true)
        }
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
              adapter_prepared_at = 2, provider_request_hash = ${wireRequestHash},
              prepared_turn_hash = ${preparedTurnHash},
              system_stable_hash = ${systemStableHash},
              system_volatile_hash = ${systemVolatileHash},
              wire_request_hash = ${wireRequestHash},
              tool_definition_hash = ${preparedTurnHash}
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching', dispatching_at = 3, request_state = 'dispatched'
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'prepared'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET released_knowledge_selected_refs = '[{"sourceStore":"project"}]'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'streaming', streaming_at = 4
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'settled', terminal_at = 5
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET response_fingerprint = 'response-hash'
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET final_request_hash = 'different-final-hash'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET context_activation = '{"outcome":"mutated"}'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET released_knowledge_exact_refs = '[{"id":"mutated"}]'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_tool_request_receipt (
                  receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
                  registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
                  request_state, provider_state, prompt_epoch, prompt_window_id, effective_history_hash,
                  request_input_hash, final_request_hash, adapter_prepared_at, owner_token, created_at
                ) VALUES (
                  'receipt-provider-missing-context', 2, 'session-provider-lifecycle',
                  'message-provider-lifecycle', 'provider-test', 'model-test', '[]', '[]', '[]', '[]',
                  'prepared', 'prepared', 0, 'window-0', 'history-0', 'input-hash-2', 'final-hash-2',
                  2, 'owner-2', 2
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-provenance', '/repo', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-provenance', 'project-provenance', 'provenance', '/repo', 'Provenance', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-provenance', 'session-provenance', 1, 1, '{}')
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-provenance-other', 'project-provenance', 'provenance-other', '/repo',
            'Provenance other', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-provenance-other', 'session-provenance-other', 1, 1, '{}')
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                VALUES (
                  'part-cross-session', 'message-provenance', 'session-provenance-other',
                  1, 1, '{"type":"text","text":"x"}'
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO part (id, message_id, session_id, provenance, time_created, time_updated, data)
                VALUES (
                  'part-invalid-provenance', 'message-provenance', 'session-provenance',
                  '{"source":"unknown","durable":true}', 1, 1, '{"type":"text","text":"x"}'
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, provenance, time_created, time_updated, data)
          VALUES (
            'part-valid-provenance', 'message-provenance', 'session-provenance',
            '{"source":"compaction_continue","owner_session_id":"session-provenance","owner_prompt_epoch":1,"owner_run_id":"run-1","durable":true}',
            1, 1, '{"type":"text","text":"x"}'
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE part
                SET message_id = 'message-provenance-other', session_id = 'session-provenance-other'
                WHERE id = 'part-valid-provenance'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE part
                SET provenance = '{"source":"compaction_continue","owner_session_id":"session-provenance","owner_prompt_epoch":2,"owner_run_id":"run-1","durable":true}'
                WHERE id = 'part-valid-provenance'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("upgrades an existing learning-job database with a fenced admission outbox", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const outboxMigrationIndex = migrations.findIndex(
          (migration) => migration.id === learningAdmissionOutboxMigration.id,
        )
        expect(outboxMigrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, outboxMigrationIndex))
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learning_admission_outbox'`,
          ),
        ).toBeUndefined()

        yield* DatabaseMigration.applyOnly(db, [learningAdmissionOutboxMigration])

        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learning_admission_outbox'`,
          ),
        ).toEqual({ name: "learning_admission_outbox" })
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'learning_admission_outbox_%'
            ORDER BY name
          `),
        ).toEqual([
          { name: "learning_admission_outbox_identity_immutable" },
          { name: "learning_admission_outbox_job_binding" },
          { name: "learning_admission_outbox_terminal_immutable" },
          { name: "learning_admission_outbox_transition_guard" },
        ])
        yield* db.run(sql`
          INSERT INTO learning_admission_outbox (
            intent_id, session_id, run_id, trigger, dedupe_key, payload_json,
            payload_fingerprint, state, created_at, updated_at
          ) VALUES (
            'intent-upgrade', 'session-upgrade', 'run-upgrade', 'session_finalization',
            'session_finalization:session-upgrade:run-upgrade', '{}', ${"a".repeat(64)},
            'pending', 1, 1
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE learning_admission_outbox
                SET state = 'admitted', job_id = 'missing-job', candidate_input_ref = 'artifact-ref',
                    settled_at = 2, updated_at = 2
                WHERE intent_id = 'intent-upgrade'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE learning_admission_outbox
          SET state = 'rejected', rejection_code = 'legacy_terminal_missing_exact_intent',
              rejection_detail = 'exact terminal admission payload was unavailable', settled_at = 2, updated_at = 2
          WHERE intent_id = 'intent-upgrade'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE learning_admission_outbox
                SET rejection_detail = 'rewritten', updated_at = 3
                WHERE intent_id = 'intent-upgrade'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("upgrades durable permission routing and keeps route and feedback immutable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex(
          (migration) => migration.id === activityPermissionRouteFeedbackMigration.id,
        )
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        expect(yield* db.all(sql`PRAGMA table_info(session_activity_permission_request)`)).not.toContainEqual(
          expect.objectContaining({ name: "workspace_id" }),
        )
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('permission-route-project', '/tmp/permission-route-project', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id
          ) VALUES (
            'permission-route-session', 'permission-route-project', 'permission-route-session',
            '/tmp/permission-route-project', 'Permission route migration', '1', 1, 1, 'wrk_original'
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch, version, time_created, time_admitted, time_updated
          ) VALUES (
            'permission-route-intent', 'permission-route-session', 'composer', 'admitted', 'original',
            'permission-route-payload', 'turn', 'permission-route-message', 0, 1, 1, 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id, delivery,
            payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES (
            'permission-route-admission', 'permission-route-session', 'legacy_intent', 'permission-route-intent',
            'permission-route-message', 'turn', 'payload_hash', 'permission-route-payload', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token, state,
            terminal_reason, created_at, settled_at
          ) VALUES (
            'permission-route-activity', 'permission-route-session', 0, 'permission-route-admission',
            'permission-route-owner', 'active', NULL, 1, NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity_permission_request (
            request_id, activity_kind, activity_id, session_id, project_id, request_kind,
            idempotency_key, permission, patterns, always_patterns, metadata_hash,
            tool_message_id, tool_call_id, state, authority_epoch, requested_scope,
            owner_type, owner_id, created_at, expires_at, decided_at
          ) VALUES (
            'permission-route-request', 'legacy', 'permission-route-activity',
            'permission-route-session', 'permission-route-project', 'tool',
            'permission-route-request-key', 'bash', '["ls"]', '[]', 'metadata-hash',
            'permission-route-message', 'permission-route-call', 'pending', 0, 'once',
            'runtime', 'permission-route-owner', 1, NULL, NULL
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [activityPermissionRouteFeedbackMigration])

        expect(yield* db.all(sql`PRAGMA table_info(session_activity_permission_request)`)).toContainEqual(
          expect.objectContaining({ name: "workspace_id" }),
        )
        expect(yield* db.all(sql`PRAGMA table_info(session_activity_permission_decision)`)).toContainEqual(
          expect.objectContaining({ name: "feedback" }),
        )
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name IN (
              'session_activity_permission_route_immutable',
              'session_activity_permission_feedback_immutable'
            )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_activity_permission_feedback_immutable" },
          { name: "session_activity_permission_route_immutable" },
        ])
        expect(
          yield* db.get(sql`
            SELECT workspace_id FROM session_activity_permission_request
            WHERE request_id = 'permission-route-request'
          `),
        ).toEqual({ workspace_id: "wrk_original" })
        yield* db.run(sql`
          INSERT INTO session_activity_permission_decision (
            decision_id, request_id, idempotency_key, decision, actor_type, actor_id,
            scope, authority_epoch, decided_at, expires_at, feedback
          ) VALUES (
            'permission-route-decision', 'permission-route-request', 'permission-route-decision-key',
            'denied', 'user', 'permission-user', 'once', 0, 2, NULL, 'keep this feedback'
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_activity_permission_request
                SET workspace_id = 'wrk_rewritten'
                WHERE request_id = 'permission-route-request'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_activity_permission_decision
                SET feedback = 'rewritten'
                WHERE request_id = 'permission-route-request'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("fails closed for pre-W3 prepared receipts while preserving terminal recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const preparedTurnMigrationIndex = migrations.findIndex(
          (migration) => migration.id === preparedProviderTurnReceiptMigration.id,
        )
        expect(preparedTurnMigrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, preparedTurnMigrationIndex))
        yield* seedReceiptScope(db)

        for (const [index, state] of ["prepared", "dispatching", "streaming"].entries()) {
          const receiptID = `receipt-pre-w3-${state}`
          yield* db.run(sql`
            INSERT INTO session_tool_request_receipt (
              receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
              registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
              request_state, provider_state, prompt_epoch, prompt_window_id, effective_history_hash,
              request_input_hash, owner_token, context_selection_id, context_eligibility,
              context_readiness, context_activation, context_activation_fingerprint,
              released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
              released_knowledge_binding_state, released_knowledge_exact_refs,
              released_knowledge_exact_refs_fingerprint, created_at
            ) VALUES (
              ${receiptID}, ${index + 1}, 'session-pre-w3', ${`message-pre-w3-${state}`},
              'provider-test', 'model-test', '[]', '[]', '[]', '[]', 'prepared', 'preparing',
              0, ${`window-pre-w3-${state}`}, ${`history-pre-w3-${state}`},
              ${`input-pre-w3-${state}`}, 'owner-pre-w3', NULL, '{}', '{}', '{}',
              lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
              ${emptyReleasedRefsFingerprint}, ${index + 1}
            )
          `)
          yield* db.run(sql`
            UPDATE session_tool_request_receipt
            SET released_knowledge_selected_refs = '[]',
                released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
            WHERE receipt_id = ${receiptID}
          `)
          yield* db.run(sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                provider_request_hash = ${wireRequestHash}, adapter_prepared_at = 2
            WHERE receipt_id = ${receiptID}
          `)
          if (state === "prepared") continue
          yield* db.run(sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'dispatching', request_state = 'dispatched', dispatching_at = 3
            WHERE receipt_id = ${receiptID}
          `)
          if (state === "dispatching") continue
          yield* db.run(sql`
            UPDATE session_tool_request_receipt
            SET provider_state = 'streaming', streaming_at = 4
            WHERE receipt_id = ${receiptID}
          `)
        }

        yield* DatabaseMigration.applyOnly(db, [preparedProviderTurnReceiptMigration])

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'dispatching', request_state = 'dispatched', dispatching_at = 5
                WHERE receipt_id = 'receipt-pre-w3-prepared'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'failed', terminal_at = 5, request_error_code = 'pre_w3_prepared_quarantined'
          WHERE receipt_id = 'receipt-pre-w3-prepared'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'settled', terminal_at = 5
          WHERE receipt_id = 'receipt-pre-w3-dispatching'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'indeterminate_after_crash', terminal_at = 5,
              request_error_code = 'pre_w3_streaming_recovery'
          WHERE receipt_id = 'receipt-pre-w3-streaming'
        `)

        expect(
          yield* db.all<{
            receipt_id: string
            provider_state: string
            prepared_turn_hash: string | null
            tool_result_reference_ids: string
            tool_result_reference_count: number
          }>(sql`
            SELECT receipt_id, provider_state, prepared_turn_hash,
                   tool_result_reference_ids, tool_result_reference_count
            FROM session_tool_request_receipt
            WHERE receipt_id LIKE 'receipt-pre-w3-%'
            ORDER BY receipt_id
          `),
        ).toEqual([
          {
            receipt_id: "receipt-pre-w3-dispatching",
            provider_state: "settled",
            prepared_turn_hash: null,
            tool_result_reference_ids: "[]",
            tool_result_reference_count: 0,
          },
          {
            receipt_id: "receipt-pre-w3-prepared",
            provider_state: "failed",
            prepared_turn_hash: null,
            tool_result_reference_ids: "[]",
            tool_result_reference_count: 0,
          },
          {
            receipt_id: "receipt-pre-w3-streaming",
            provider_state: "indeterminate_after_crash",
            prepared_turn_hash: null,
            tool_result_reference_ids: "[]",
            tool_result_reference_count: 0,
          },
        ])
      }),
    )
  })

  test("upgrades provider attempt transition law without classifying live rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex(
          (migration) => migration.id === providerAttemptPreDispatchTerminalMigration.id,
        )
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO context_location_identity (
            security_namespace_id, location_key, project_scope_key,
            canonical_root, observed_project_id, created_at
          ) VALUES (
            ${receiptNamespace}, 'attempt-upgrade-location', ${receiptProjectScope},
            '/tmp/attempt-upgrade', 'attempt-upgrade-project', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('attempt-upgrade-project', '/tmp/attempt-upgrade', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('attempt-upgrade-session', 'attempt-upgrade-project', 'attempt-upgrade',
                  '/tmp/attempt-upgrade', 'Attempt upgrade', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
          VALUES ('attempt-upgrade-input', 'attempt-upgrade-session', '{"text":"upgrade"}', 'steer', 0, 0, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES (
            'attempt-upgrade-activity', 'attempt-upgrade-session', 0,
            'attempt-upgrade-input', 'steer', 'active', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, inline_audit, created_at
          ) VALUES (
            'attempt-upgrade-selection', 'attempt-upgrade-session', 'attempt-upgrade-activity', 0,
            'attempt-upgrade-input', 'attempt-upgrade-location', ${receiptNamespace}, ${receiptProjectScope},
            'query', 'authorization', 1, 'execution', 'sources', 0, 100,
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, '{}', '{}', '[]', 'projection',
            'projection-hash', 1, 'degraded_unavailable', '{}', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, state, created_at
          ) VALUES
            ('attempt-upgrade-prepared', 'attempt-upgrade-session', 'attempt-upgrade-activity', 0,
             'attempt-upgrade-selection', 'projection-hash', 'request-0', 'provider', 'prepared', 1),
            ('attempt-upgrade-dispatching', 'attempt-upgrade-session', 'attempt-upgrade-activity', 1,
             'attempt-upgrade-selection', 'projection-hash', 'request-1', 'provider', 'dispatching', 2),
            ('attempt-upgrade-orphan', 'attempt-upgrade-session', 'attempt-upgrade-activity', 2,
             'attempt-upgrade-selection', 'projection-hash', 'request-2', 'provider', 'prepared', 3),
            ('attempt-upgrade-started-receipt', 'attempt-upgrade-session', 'attempt-upgrade-activity', 3,
             'attempt-upgrade-selection', 'projection-hash', 'request-3', 'provider', 'prepared', 4)
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            context_eligibility, context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, final_request_hash, adapter_prepared_at,
            prompt_epoch, prompt_window_id, effective_history_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES (
            'attempt-upgrade-receipt', 1, 'attempt-upgrade-session', 'attempt-upgrade-input',
            'attempt-upgrade-prepared', 'attempt-upgrade-selection', '{}', '{}', '{}',
            lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope},
            'unavailable', '[]', ${emptyReleasedRefsFingerprint},
            'provider', 'model', '[]', '[]', '[]', '[]', NULL, NULL, NULL, NULL, NULL,
            'prepared', 'preparing', 'stale-owner', 3
          ), (
            'attempt-upgrade-started-receipt', 2, 'attempt-upgrade-session', 'attempt-upgrade-input',
            'attempt-upgrade-started-receipt', 'attempt-upgrade-selection', '{}', '{}', '{}',
            lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope},
            'unavailable', '[]', ${emptyReleasedRefsFingerprint},
            'provider', 'model', '[]', '[]', '[]', '[]', NULL, NULL, 0,
            'attempt-upgrade-window', 'attempt-upgrade-history',
            'prepared', 'preparing', 'stale-owner', 4
          )
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id = 'attempt-upgrade-started-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
              provider_request_hash = ${wireRequestHash},
              prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
              system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
              tool_result_reference_ids = '[]', tool_result_reference_count = 0,
              tool_definition_hash = ${wireRequestHash}, adapter_prepared_at = 4
          WHERE receipt_id = 'attempt-upgrade-started-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching', request_state = 'dispatched', dispatching_at = 5
          WHERE receipt_id = 'attempt-upgrade-started-receipt'
        `)
        yield* db.run(sql`
          INSERT INTO compaction_run (
            run_id, session_id, from_prompt_epoch, trigger, state, created_at,
            source_window_id, source_effective_history_hash, source_message_count, source_projection_version,
            continuation_wakeup_at, continuation_state, continuation_receipt_id,
            continuation_admitted_at
          ) VALUES (
            'attempt-upgrade-compaction', 'attempt-upgrade-session', 0, 'turn_start', 'committed', 4,
            'attempt-upgrade-window', 'attempt-upgrade-history', 1, 1,
            4, 'admitted', 'attempt-upgrade-receipt', 4
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [providerAttemptPreDispatchTerminalMigration])

        expect(
          yield* db.all<{
            attempt_id: string
            state: string
            settled_at: number | null
            error_code: string | null
          }>(sql`
            SELECT attempt_id, state, settled_at, error_code
            FROM session_provider_attempt
            ORDER BY provider_turn_seq
          `),
        ).toEqual([
          {
            attempt_id: "attempt-upgrade-prepared",
            state: "prepared",
            settled_at: null,
            error_code: null,
          },
          {
            attempt_id: "attempt-upgrade-dispatching",
            state: "dispatching",
            settled_at: null,
            error_code: null,
          },
          {
            attempt_id: "attempt-upgrade-orphan",
            state: "prepared",
            settled_at: null,
            error_code: null,
          },
          {
            attempt_id: "attempt-upgrade-started-receipt",
            state: "prepared",
            settled_at: null,
            error_code: null,
          },
        ])
        expect(
          yield* db.get(sql`
            SELECT provider_state, request_state, terminal_at, request_error_code
            FROM session_tool_request_receipt
            WHERE receipt_id = 'attempt-upgrade-receipt'
          `),
        ).toEqual({
          provider_state: "preparing",
          request_state: "prepared",
          terminal_at: null,
          request_error_code: null,
        })
        expect(
          yield* db.get(sql`
            SELECT continuation_state, continuation_receipt_id, continuation_admitted_at,
                   continuation_wakeup_at, continuation_error_code
            FROM compaction_run
            WHERE run_id = 'attempt-upgrade-compaction'
          `),
        ).toEqual({
          continuation_state: "admitted",
          continuation_receipt_id: "attempt-upgrade-receipt",
          continuation_admitted_at: 4,
          continuation_wakeup_at: 4,
          continuation_error_code: null,
        })
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET state = 'failed', settled_at = 3
                WHERE attempt_id = 'attempt-upgrade-dispatching'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(false)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, state, created_at
          ) VALUES (
            'attempt-upgrade-post-migration', 'attempt-upgrade-session', 'attempt-upgrade-activity', 4,
            'attempt-upgrade-selection', 'projection-hash', 'request-4', 'provider', 'prepared', 5
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET state = 'failed', settled_at = 5
                WHERE attempt_id = 'attempt-upgrade-post-migration'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'failed', settled_at = 5, error_code = 'provider_not_dispatched'
          WHERE attempt_id = 'attempt-upgrade-post-migration'
        `)
        yield* DatabaseMigration.applyOnly(db, [providerOwnerAuthorityMigration])
        expect(
          yield* db.all(sql`
            SELECT attempt_id, owner_token
            FROM session_provider_attempt
            ORDER BY provider_turn_seq
          `),
        ).toEqual([
          { attempt_id: "attempt-upgrade-prepared", owner_token: null },
          { attempt_id: "attempt-upgrade-dispatching", owner_token: null },
          { attempt_id: "attempt-upgrade-orphan", owner_token: null },
          { attempt_id: "attempt-upgrade-started-receipt", owner_token: null },
          { attempt_id: "attempt-upgrade-post-migration", owner_token: null },
        ])
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_provider_attempt (
                  attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
                  projection_hash, request_hash, provider_id, state, created_at
                ) VALUES (
                  'attempt-upgrade-unowned-new', 'attempt-upgrade-session', 'attempt-upgrade-activity', 5,
                  'attempt-upgrade-selection', 'projection-hash', 'request-5', 'provider', 'prepared', 6
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES ('attempt-upgrade-owner', 5, 5, 10)
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES (
            'attempt-upgrade-owned-new', 'attempt-upgrade-session', 'attempt-upgrade-activity', 5,
            'attempt-upgrade-selection', 'projection-hash', 'request-5', 'provider',
            'attempt-upgrade-owner', 'prepared', 6
          )
        `)
      }),
    )
  })

  test("enforces exact provider attempt receipt and wire identity", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO context_location_identity (
            security_namespace_id, location_key, project_scope_key,
            canonical_root, observed_project_id, created_at
          ) VALUES (
            ${receiptNamespace}, 'provider-identity-location', ${receiptProjectScope},
            '/tmp/provider-identity', 'provider-identity-project', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('provider-identity-project', '/tmp/provider-identity', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('provider-identity-session', 'provider-identity-project', 'provider-identity',
                  '/tmp/provider-identity', 'Provider identity', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
          VALUES ('provider-identity-input', 'provider-identity-session', '{"text":"identity"}', 'steer', 0, 0, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES ('provider-identity-activity', 'provider-identity-session', 0,
                    'provider-identity-input', 'steer', 'active', 1)
        `)
        yield* db.run(sql`
          UPDATE session_activity
          SET state = 'settled', settled_at = 2
          WHERE activity_id = 'provider-identity-activity'
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES ('provider-identity-wrong-activity', 'provider-identity-session', 1,
                    'provider-identity-input', 'steer', 'active', 2)
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, inline_audit, created_at
          ) VALUES (
            'provider-identity-selection', 'provider-identity-session', 'provider-identity-activity', 0,
            'provider-identity-input', 'provider-identity-location', ${receiptNamespace}, ${receiptProjectScope},
            'query', 'authorization', 1, 'execution', 'sources', 0, 100,
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, '{}', '{}', '[]', 'projection',
            'provider-identity-projection', 1, 'degraded_unavailable', '{}', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'provider-identity-owner',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES
            ('provider-identity-valid', 'provider-identity-session', 'provider-identity-activity', 0,
             'provider-identity-selection', 'provider-identity-projection', ${"a".repeat(64)},
             'provider', 'provider-identity-owner', 'prepared', 2),
            ('provider-identity-wrong-activity', 'provider-identity-session', 'provider-identity-wrong-activity', 1,
             'provider-identity-selection', 'provider-identity-projection', ${"a".repeat(64)},
             'provider', 'provider-identity-owner', 'prepared', 2),
            ('provider-identity-wrong-projection', 'provider-identity-session', 'provider-identity-activity', 2,
             'provider-identity-selection', 'wrong-projection', ${"a".repeat(64)},
             'provider', 'provider-identity-owner', 'prepared', 2),
            ('provider-identity-wrong-provider', 'provider-identity-session', 'provider-identity-activity', 3,
             'provider-identity-selection', 'provider-identity-projection', ${"a".repeat(64)},
             'wrong-provider', 'provider-identity-owner', 'prepared', 2),
            ('provider-identity-wrong-request', 'provider-identity-session', 'provider-identity-activity', 4,
             'provider-identity-selection', 'provider-identity-projection', ${"f".repeat(64)},
             'provider', 'provider-identity-owner', 'prepared', 2)
        `)

        for (const [ordinal, attemptID] of [
          "provider-identity-wrong-activity",
          "provider-identity-wrong-projection",
          "provider-identity-wrong-provider",
          "provider-identity-wrong-request",
        ].entries()) {
          expect(
            Exit.isFailure(
              yield* db
                .run(
                  sql`
                  INSERT INTO session_tool_request_receipt (
                    receipt_id, request_ordinal, session_id, user_message_id,
                    provider_attempt_id, context_selection_id,
                    released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
                    released_knowledge_binding_state, released_knowledge_exact_refs,
                    released_knowledge_exact_refs_fingerprint,
                    provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
                    final_offered_tool_ids, call_ids, request_input_hash,
                    request_state, provider_state, owner_token, created_at
                  ) VALUES (
                    ${`receipt-${attemptID}`}, ${ordinal + 1}, 'provider-identity-session',
                    'provider-identity-input', ${attemptID}, 'provider-identity-selection',
                    ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
                    ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
                    ${"a".repeat(64)}, 'prepared', 'preparing', 'provider-identity-owner', 3
                  )
                `,
                )
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }

        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            context_eligibility, context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_input_hash,
            prompt_epoch, prompt_window_id, effective_history_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES (
            'provider-identity-receipt', 10, 'provider-identity-session', 'provider-identity-input',
            'provider-identity-valid', 'provider-identity-selection',
            ${JSON.stringify(contextEligibility)}, ${JSON.stringify(contextReadiness)},
            ${contextActivation(3, "provider-identity-selection", "provider-identity-projection")},
            lower(hex(zeroblob(32))), ${receiptNamespace}, ${receiptProjectScope},
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
            ${"a".repeat(64)}, 0, 'provider-identity-window', 'provider-identity-history',
            'prepared', 'preparing', 'provider-identity-owner', 3
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_tool_request_receipt (
                  receipt_id, request_ordinal, session_id, user_message_id,
                  provider_attempt_id, context_selection_id,
                  released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
                  released_knowledge_binding_state, released_knowledge_exact_refs,
                  released_knowledge_exact_refs_fingerprint,
                  provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
                  final_offered_tool_ids, call_ids, request_input_hash,
                  request_state, provider_state, owner_token, created_at
                ) VALUES (
                  'provider-identity-duplicate', 11, 'provider-identity-session', 'provider-identity-input',
                  'provider-identity-valid', 'provider-identity-selection',
                  ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
                  ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
                  ${"a".repeat(64)}, 'prepared', 'preparing', 'provider-identity-owner', 3
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id = 'provider-identity-receipt'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET prepared_turn_hash = ${preparedTurnHash}
                WHERE attempt_id = 'provider-identity-valid'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET prepared_turn_hash = ${"B".repeat(64)}, wire_request_hash = ${wireRequestHash}
                WHERE attempt_id = 'provider-identity-valid'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
          WHERE attempt_id = 'provider-identity-valid'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
          WHERE attempt_id = 'provider-identity-valid'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET prepared_turn_hash = ${"f".repeat(64)}, wire_request_hash = ${wireRequestHash}
                WHERE attempt_id = 'provider-identity-valid'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
                    provider_request_hash = ${wireRequestHash},
                    prepared_turn_hash = ${"f".repeat(64)}, system_stable_hash = ${systemStableHash},
                    system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
                    tool_result_reference_ids = '[]', tool_result_reference_count = 0,
                    tool_definition_hash = ${wireRequestHash}, adapter_prepared_at = 4
                WHERE receipt_id = 'provider-identity-receipt'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', final_request_hash = ${wireRequestHash},
              provider_request_hash = ${wireRequestHash},
              prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
              system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
              tool_result_reference_ids = '[]', tool_result_reference_count = 0,
              tool_definition_hash = ${wireRequestHash}, adapter_prepared_at = 4
          WHERE receipt_id = 'provider-identity-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'dispatching'
          WHERE attempt_id = 'provider-identity-valid'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching', request_state = 'dispatched', dispatching_at = 5
          WHERE receipt_id = 'provider-identity-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
          WHERE attempt_id = 'provider-identity-wrong-request'
        `)
        yield* db.run(sql`
          UPDATE session_provider_owner_lease
          SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          WHERE owner_token = 'provider-identity-owner'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET state = 'indeterminate_after_crash', error_code = 'caller_supplied_recovery'
                WHERE attempt_id = 'provider-identity-wrong-request'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET state = 'indeterminate_after_crash', error_code = 'process_recovery'
                WHERE attempt_id = 'provider-identity-wrong-request'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'provider-identity-recovery-owner',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'indeterminate_after_crash', error_code = 'process_recovery'
          WHERE attempt_id = 'provider-identity-wrong-request'
        `)
        expect(
          yield* db.get(sql`
            SELECT state, error_code, settled_at, prepared_turn_hash, wire_request_hash
            FROM session_provider_attempt
            WHERE attempt_id = 'provider-identity-wrong-request'
          `),
        ).toEqual({
          state: "indeterminate_after_crash",
          error_code: "process_recovery",
          settled_at: null,
          prepared_turn_hash: preparedTurnHash,
          wire_request_hash: wireRequestHash,
        })
      }),
    )
  })

  test("preserves exact historical receipts but rejects ambiguous and mismatched provider attempt upgrades", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex(
          (migration) => migration.id === providerTurnIdentityAuthorityMigration.id,
        )
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO context_location_identity (
            security_namespace_id, location_key, project_scope_key,
            canonical_root, observed_project_id, created_at
          ) VALUES (
            ${receiptNamespace}, 'provider-upgrade-location', ${receiptProjectScope},
            '/tmp/provider-upgrade', 'provider-upgrade-project', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('provider-upgrade-project', '/tmp/provider-upgrade', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('provider-upgrade-session', 'provider-upgrade-project', 'provider-upgrade',
                  '/tmp/provider-upgrade', 'Provider upgrade', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
          VALUES ('provider-upgrade-input', 'provider-upgrade-session', '{"text":"upgrade"}', 'steer', 0, 0, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES ('provider-upgrade-activity', 'provider-upgrade-session', 0,
                    'provider-upgrade-input', 'steer', 'active', 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, inline_audit, created_at
          ) VALUES (
            'provider-upgrade-selection', 'provider-upgrade-session', 'provider-upgrade-activity', 0,
            'provider-upgrade-input', 'provider-upgrade-location', ${receiptNamespace}, ${receiptProjectScope},
            'query', 'authorization', 1, 'execution', 'sources', 0, 100,
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, '{}', '{}', '[]', 'projection',
            'provider-upgrade-projection', 1, 'degraded_unavailable', '{}', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES ('provider-upgrade-owner', 1, 1, 100)
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES ('provider-upgrade-attempt', 'provider-upgrade-session', 'provider-upgrade-activity', 0,
                    'provider-upgrade-selection', 'provider-upgrade-projection', ${"a".repeat(64)},
                    'provider', 'provider-upgrade-owner', 'prepared', 2)
        `)
        for (const ordinal of [1, 2]) {
          yield* db.run(sql`
            INSERT INTO session_tool_request_receipt (
              receipt_id, request_ordinal, session_id, user_message_id,
              provider_attempt_id, context_selection_id,
              released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
              released_knowledge_binding_state, released_knowledge_exact_refs,
              released_knowledge_exact_refs_fingerprint,
              provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
              final_offered_tool_ids, call_ids, request_input_hash,
              request_state, provider_state, owner_token, created_at
            ) VALUES (
              ${`provider-upgrade-receipt-${ordinal}`}, ${ordinal}, 'provider-upgrade-session',
              'provider-upgrade-input', 'provider-upgrade-attempt', 'provider-upgrade-selection',
              ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
              ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
              ${"a".repeat(64)}, 'prepared', 'preparing', 'provider-upgrade-owner', ${ordinal + 2}
            )
          `)
        }
        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [providerTurnIdentityAuthorityMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.all(sql`
            SELECT name FROM pragma_table_info('session_provider_attempt')
            WHERE name IN ('prepared_turn_hash', 'wire_request_hash')
          `),
        ).toEqual([])
        yield* db.run(sql`
          DELETE FROM session_tool_request_receipt
          WHERE receipt_id IN ('provider-upgrade-receipt-1', 'provider-upgrade-receipt-2')
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_input_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES (
            'provider-upgrade-receipt-1', 1, 'provider-upgrade-session',
            'provider-upgrade-input', 'provider-upgrade-attempt', 'provider-upgrade-selection',
            ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
            ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
            ${"f".repeat(64)}, 'prepared', 'preparing', 'provider-upgrade-owner', 3
          )
        `)
        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [providerTurnIdentityAuthorityMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.all(sql`
            SELECT name FROM pragma_table_info('session_provider_attempt')
            WHERE name IN ('prepared_turn_hash', 'wire_request_hash')
          `),
        ).toEqual([])
        yield* db.run(sql`
          DELETE FROM session_tool_request_receipt
          WHERE receipt_id = 'provider-upgrade-receipt-1'
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_input_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES (
            'provider-upgrade-receipt-1', 1, 'provider-upgrade-session',
            'provider-upgrade-input', 'provider-upgrade-attempt', 'provider-upgrade-selection',
            ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
            ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
            ${"a".repeat(64)}, 'prepared', 'preparing', 'provider-upgrade-owner', 3
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [providerTurnIdentityAuthorityMigration])
        expect(
          yield* db.get(sql`
            SELECT released_at IS NOT NULL AS released
            FROM session_provider_owner_lease
            WHERE owner_token = 'provider-upgrade-owner'
          `),
        ).toEqual({ released: 1 })
        expect(
          yield* db.get(sql`
            SELECT prepared_turn_hash, wire_request_hash
            FROM session_provider_attempt
            WHERE attempt_id = 'provider-upgrade-attempt'
          `),
        ).toEqual({ prepared_turn_hash: null, wire_request_hash: null })
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET state = 'dispatching'
                WHERE attempt_id = 'provider-upgrade-attempt'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_provider_attempt (
                  attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
                  projection_hash, request_hash, provider_id, owner_token, state, created_at
                ) VALUES (
                  'provider-upgrade-backdated-attempt', 'provider-upgrade-session',
                  'provider-upgrade-activity', 1, 'provider-upgrade-selection',
                  'provider-upgrade-projection', ${"a".repeat(64)}, 'provider',
                  'provider-upgrade-owner', 'prepared', 1
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_provider_attempt
                SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
                WHERE attempt_id = 'provider-upgrade-attempt'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'failed', settled_at = 5, error_code = 'legacy_wire_identity_missing'
          WHERE attempt_id = 'provider-upgrade-attempt'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'failed', terminal_at = 5,
              request_error_code = 'legacy_wire_identity_missing'
          WHERE receipt_id = 'provider-upgrade-receipt-1'
        `)
        expect(
          yield* db.get(sql`
            SELECT attempt.state AS attempt_state, receipt.provider_state AS receipt_state
            FROM session_provider_attempt attempt
            JOIN session_tool_request_receipt receipt
              ON receipt.provider_attempt_id = attempt.attempt_id
            WHERE attempt.attempt_id = 'provider-upgrade-attempt'
          `),
        ).toEqual({ attempt_state: "failed", receipt_state: "failed" })
      }),
    )
  })

  test("rejects future and overlong pre-authority provider owner leases", async () => {
    for (const lease of [
      {
        ownerToken: "provider-upgrade-future-owner",
        registeredAt: Date.now() + 60_000,
        heartbeatAt: Date.now() + 60_000,
        leaseExpiresAt: Date.now() + 120_000,
      },
      {
        ownerToken: "provider-upgrade-overlong-owner",
        registeredAt: 1,
        heartbeatAt: 1,
        leaseExpiresAt: 31_536_000_002,
      },
    ]) {
      await run(
        Effect.gen(function* () {
          const db = yield* makeDb
          const migrationIndex = migrations.findIndex(
            (migration) => migration.id === providerTurnIdentityAuthorityMigration.id,
          )
          yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
          yield* db.run(sql`
            INSERT INTO session_provider_owner_lease (
              owner_token, registered_at, heartbeat_at, lease_expires_at
            ) VALUES (
              ${lease.ownerToken}, ${lease.registeredAt}, ${lease.heartbeatAt}, ${lease.leaseExpiresAt}
            )
          `)
          expect(
            Exit.isFailure(
              yield* DatabaseMigration.applyOnly(db, [providerTurnIdentityAuthorityMigration]).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            yield* db.all(sql`
              SELECT name FROM pragma_table_info('session_provider_attempt')
              WHERE name IN ('prepared_turn_hash', 'wire_request_hash')
            `),
          ).toEqual([])
        }),
      )
    }
  })

  test("permits only exact physical-start evidence to quarantine an undispatched provider receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [providerCrossStateRecoveryMigration])
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('provider-cross-state-project', '/tmp/provider-cross-state', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('provider-cross-state-session', 'provider-cross-state-project', 'provider-cross-state',
                  '/tmp/provider-cross-state', 'Provider cross state', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
          VALUES ('provider-cross-state-input', 'provider-cross-state-session', '{"text":"cross"}', 'steer', 0, 0, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES ('provider-cross-state-activity', 'provider-cross-state-session', 0,
                    'provider-cross-state-input', 'steer', 'active', 1)
        `)
        yield* db.run(sql`
          INSERT INTO context_location_identity (
            security_namespace_id, location_key, project_scope_key,
            canonical_root, observed_project_id, created_at
          ) VALUES (
            ${receiptNamespace}, 'provider-cross-state-location', ${receiptProjectScope},
            '/tmp/provider-cross-state', 'provider-cross-state-project', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, inline_audit, created_at
          ) VALUES (
            'provider-cross-state-selection', 'provider-cross-state-session', 'provider-cross-state-activity', 0,
            'provider-cross-state-input', 'provider-cross-state-location', ${receiptNamespace}, ${receiptProjectScope},
            'query', 'authorization', 1, 'execution', 'sources', 0, 100,
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, '{}', '{}', '[]', 'projection',
            'provider-cross-state-projection', 1, 'degraded_unavailable', '{}', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'provider-cross-state-owner',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES (
            'provider-cross-state-attempt', 'provider-cross-state-session', 'provider-cross-state-activity', 0,
            'provider-cross-state-selection', 'provider-cross-state-projection', ${wireRequestHash},
            'provider', 'provider-cross-state-owner', 'prepared', 2
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            context_eligibility, context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_input_hash,
            prompt_epoch, prompt_window_id, effective_history_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES (
            'provider-cross-state-receipt', 1, 'provider-cross-state-session',
            'provider-cross-state-input', 'provider-cross-state-attempt', 'provider-cross-state-selection',
            ${JSON.stringify(contextEligibility)}, ${JSON.stringify(contextReadiness)},
            ${contextActivation(3, "provider-cross-state-selection", "provider-cross-state-projection")},
            lower(hex(zeroblob(32))),
            ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
            ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
            ${wireRequestHash}, 0, 'provider-cross-state-window', 'provider-cross-state-history',
            'prepared', 'preparing', 'provider-cross-state-owner', 3
          )
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id = 'provider-cross-state-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
          WHERE attempt_id = 'provider-cross-state-attempt'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', adapter_prepared_at = 4,
              final_request_hash = ${wireRequestHash}, provider_request_hash = ${wireRequestHash},
              prepared_turn_hash = ${preparedTurnHash},
              system_stable_hash = ${systemStableHash}, system_volatile_hash = ${systemVolatileHash},
              wire_request_hash = ${wireRequestHash}, tool_definition_hash = ${wireRequestHash},
              tool_result_reference_ids = '[]', tool_result_reference_count = 0
          WHERE receipt_id = 'provider-cross-state-receipt'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'dispatching'
          WHERE attempt_id = 'provider-cross-state-attempt'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                  UPDATE session_tool_request_receipt
                  SET provider_state = 'indeterminate_after_crash', terminal_at = 5,
                      request_error_code = 'wrong_recovery_reason'
                  WHERE receipt_id = 'provider-cross-state-receipt'
                `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'indeterminate_after_crash', terminal_at = 5,
              request_error_code = 'provider_started_outcome_unknown_after_process_restart'
          WHERE receipt_id = 'provider-cross-state-receipt'
        `)
        expect(
          yield* db.get(sql`
            SELECT provider_state, request_error_code
            FROM session_tool_request_receipt
            WHERE receipt_id = 'provider-cross-state-receipt'
          `),
        ).toEqual({
          provider_state: "indeterminate_after_crash",
          request_error_code: "provider_started_outcome_unknown_after_process_restart",
        })
      }),
    )
  })

  test("quarantines exact provider cross-state upgrades but rejects identity mismatches atomically", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex(
          (migration) => migration.id === providerCrossStateRecoveryMigration.id,
        )
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        yield* seedReceiptScope(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('provider-cross-upgrade-project', '/tmp/provider-cross-upgrade', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('provider-cross-upgrade-session', 'provider-cross-upgrade-project', 'provider-cross-upgrade',
                  '/tmp/provider-cross-upgrade', 'Provider cross upgrade', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
          VALUES ('provider-cross-upgrade-input', 'provider-cross-upgrade-session',
                  '{"text":"cross"}', 'steer', 0, 0, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, reason, created_at, authority_state
          ) VALUES (
            'provider-cross-upgrade-session', 0, 'active', 'bootstrap', 1, 'legacy_pending'
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
          ) VALUES ('provider-cross-upgrade-activity', 'provider-cross-upgrade-session', 0,
                    'provider-cross-upgrade-input', 'steer', 'active', 1)
        `)
        yield* db.run(sql`
          INSERT INTO context_location_identity (
            security_namespace_id, location_key, project_scope_key,
            canonical_root, observed_project_id, created_at
          ) VALUES (
            ${receiptNamespace}, 'provider-cross-upgrade-location', ${receiptProjectScope},
            '/tmp/provider-cross-upgrade', 'provider-cross-upgrade-project', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_context_selection (
            selection_id, session_id, activity_id, revision, trigger_input_id, location_key,
            security_namespace_id, project_scope_key,
            query_fingerprint, authorization_fingerprint, authorization_epoch,
            execution_fingerprint, selected_source_fingerprint,
            observed_location_mutation_epoch, next_revalidation_at,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            graph_revisions, graph_statuses, selected_refs, projection,
            projection_hash, token_count, artifact_write_status, inline_audit, created_at
          ) VALUES (
            'provider-cross-upgrade-selection', 'provider-cross-upgrade-session',
            'provider-cross-upgrade-activity', 0, 'provider-cross-upgrade-input',
            'provider-cross-upgrade-location', ${receiptNamespace}, ${receiptProjectScope},
            'query', 'authorization', 1, 'execution', 'sources', 0, 100,
            'unavailable', '[]', ${emptyReleasedRefsFingerprint}, '{}', '{}', '[]', 'projection',
            'provider-cross-upgrade-projection', 1, 'degraded_unavailable', '{}', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_owner_lease (
            owner_token, registered_at, heartbeat_at, lease_expires_at
          ) VALUES (
            'provider-cross-upgrade-owner',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, session_id, activity_id, provider_turn_seq, selection_id,
            projection_hash, request_hash, provider_id, owner_token, state, created_at
          ) VALUES
            ('provider-cross-upgrade-attempt-dispatching', 'provider-cross-upgrade-session',
             'provider-cross-upgrade-activity', 0, 'provider-cross-upgrade-selection',
             'provider-cross-upgrade-projection', ${wireRequestHash}, 'provider',
             'provider-cross-upgrade-owner', 'prepared', 2),
            ('provider-cross-upgrade-attempt-streaming', 'provider-cross-upgrade-session',
             'provider-cross-upgrade-activity', 1, 'provider-cross-upgrade-selection',
             'provider-cross-upgrade-projection', ${wireRequestHash}, 'provider',
             'provider-cross-upgrade-owner', 'prepared', 2),
            ('provider-cross-upgrade-attempt-settled', 'provider-cross-upgrade-session',
             'provider-cross-upgrade-activity', 2, 'provider-cross-upgrade-selection',
             'provider-cross-upgrade-projection', ${wireRequestHash}, 'provider',
             'provider-cross-upgrade-owner', 'prepared', 2),
            ('provider-cross-upgrade-attempt-failed', 'provider-cross-upgrade-session',
             'provider-cross-upgrade-activity', 3, 'provider-cross-upgrade-selection',
             'provider-cross-upgrade-projection', ${wireRequestHash}, 'provider',
             'provider-cross-upgrade-owner', 'prepared', 2)
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id,
            provider_attempt_id, context_selection_id,
            context_eligibility, context_readiness, context_activation, context_activation_fingerprint,
            released_knowledge_security_namespace_id, released_knowledge_project_scope_key,
            released_knowledge_binding_state, released_knowledge_exact_refs,
            released_knowledge_exact_refs_fingerprint,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_input_hash,
            prompt_epoch, prompt_window_id, effective_history_hash,
            request_state, provider_state, owner_token, created_at
          ) VALUES
            ('provider-cross-upgrade-receipt-dispatching', 1, 'provider-cross-upgrade-session',
             'provider-cross-upgrade-input', 'provider-cross-upgrade-attempt-dispatching',
             'provider-cross-upgrade-selection', '{}', '{}', '{}', lower(hex(zeroblob(32))),
             ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
             ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
             ${wireRequestHash}, 0, 'provider-cross-upgrade-window', 'provider-cross-upgrade-history',
             'prepared', 'preparing', 'provider-cross-upgrade-owner', 3),
            ('provider-cross-upgrade-receipt-streaming', 2, 'provider-cross-upgrade-session',
             'provider-cross-upgrade-input', 'provider-cross-upgrade-attempt-streaming',
             'provider-cross-upgrade-selection', '{}', '{}', '{}', lower(hex(zeroblob(32))),
             ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
             ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
             ${wireRequestHash}, 0, 'provider-cross-upgrade-window', 'provider-cross-upgrade-history',
             'prepared', 'preparing', 'provider-cross-upgrade-owner', 3),
            ('provider-cross-upgrade-receipt-settled', 3, 'provider-cross-upgrade-session',
             'provider-cross-upgrade-input', 'provider-cross-upgrade-attempt-settled',
             'provider-cross-upgrade-selection', '{}', '{}', '{}', lower(hex(zeroblob(32))),
             ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
             ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
             ${wireRequestHash}, 0, 'provider-cross-upgrade-window', 'provider-cross-upgrade-history',
             'prepared', 'preparing', 'provider-cross-upgrade-owner', 3),
            ('provider-cross-upgrade-receipt-failed', 4, 'provider-cross-upgrade-session',
             'provider-cross-upgrade-input', 'provider-cross-upgrade-attempt-failed',
             'provider-cross-upgrade-selection', '{}', '{}', '{}', lower(hex(zeroblob(32))),
             ${receiptNamespace}, ${receiptProjectScope}, 'unavailable', '[]',
             ${emptyReleasedRefsFingerprint}, 'provider', 'model', '[]', '[]', '[]', '[]',
             ${wireRequestHash}, 0, 'provider-cross-upgrade-window', 'provider-cross-upgrade-history',
             'prepared', 'preparing', 'provider-cross-upgrade-owner', 3)
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET released_knowledge_selected_refs = '[]',
              released_knowledge_selected_refs_fingerprint = ${emptyReleasedRefsFingerprint}
          WHERE receipt_id LIKE 'provider-cross-upgrade-receipt-%'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET prepared_turn_hash = ${preparedTurnHash}, wire_request_hash = ${wireRequestHash}
          WHERE attempt_id LIKE 'provider-cross-upgrade-attempt-%'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', adapter_prepared_at = 4,
              final_request_hash = ${wireRequestHash}, provider_request_hash = ${wireRequestHash},
              prepared_turn_hash = ${preparedTurnHash}, system_stable_hash = ${systemStableHash},
              system_volatile_hash = ${systemVolatileHash}, wire_request_hash = ${wireRequestHash},
              tool_definition_hash = ${wireRequestHash}, tool_result_reference_ids = '[]',
              tool_result_reference_count = 0
          WHERE receipt_id LIKE 'provider-cross-upgrade-receipt-%'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'dispatching'
          WHERE attempt_id LIKE 'provider-cross-upgrade-attempt-%'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'streaming', first_event_at = 5
          WHERE attempt_id = 'provider-cross-upgrade-attempt-streaming'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'settled', settled_at = 6
          WHERE attempt_id = 'provider-cross-upgrade-attempt-settled'
        `)
        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'failed', settled_at = 6, error_code = 'provider_failed'
          WHERE attempt_id = 'provider-cross-upgrade-attempt-failed'
        `)
        yield* db.run(sql`
          INSERT INTO compaction_run (
            run_id, session_id, from_prompt_epoch, trigger, state, created_at,
            source_window_id, source_effective_history_hash, source_message_count,
            source_projection_version, continuation_wakeup_at,
            continuation_state, continuation_receipt_id, continuation_admitted_at
          ) VALUES (
            'provider-cross-upgrade-continuation', 'provider-cross-upgrade-session', 0,
            'turn_start', 'committed', 5, 'provider-cross-upgrade-window',
            'provider-cross-upgrade-history', 1, 1, 5,
            'admitted', 'provider-cross-upgrade-receipt-dispatching', 5
          )
        `)

        const bindingTrigger = yield* db.get<{ sql: string }>(sql`
          SELECT sql
          FROM sqlite_master
          WHERE type = 'trigger' AND name = 'session_tool_request_receipt_binding_immutable'
        `)
        expect(bindingTrigger).toBeDefined()
        yield* db.run(sql`DROP TRIGGER session_tool_request_receipt_binding_immutable`)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_id = 'mismatched-provider'
          WHERE receipt_id = 'provider-cross-upgrade-receipt-dispatching'
        `)

        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [providerCrossStateRecoveryMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(sql`
            SELECT provider_state, request_error_code, terminal_at
            FROM session_tool_request_receipt
            WHERE receipt_id = 'provider-cross-upgrade-receipt-dispatching'
          `),
        ).toEqual({ provider_state: "prepared", request_error_code: null, terminal_at: null })
        expect(
          yield* db.get(sql`
            SELECT continuation_state, continuation_error_code
            FROM compaction_run
            WHERE run_id = 'provider-cross-upgrade-continuation'
          `),
        ).toEqual({ continuation_state: "admitted", continuation_error_code: null })
        expect(
          yield* db.get(sql`
            SELECT authority_state, recovery_reason
            FROM session_prompt_epoch
            WHERE session_id = 'provider-cross-upgrade-session' AND state = 'active'
          `),
        ).toEqual({ authority_state: "legacy_pending", recovery_reason: null })
        expect(
          yield* db.get(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name = 'session_tool_request_receipt_cross_state_recovery_guard'
          `),
        ).toBeUndefined()

        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_id = 'provider'
          WHERE receipt_id = 'provider-cross-upgrade-receipt-dispatching'
        `)
        yield* db.run(sql.raw(bindingTrigger!.sql))
        yield* DatabaseMigration.applyOnly(db, [providerCrossStateRecoveryMigration])
        expect(
          yield* db.all(sql`
            SELECT provider_state, request_error_code, terminal_at
            FROM session_tool_request_receipt
            WHERE receipt_id LIKE 'provider-cross-upgrade-receipt-%'
            ORDER BY request_ordinal
          `),
        ).toEqual(
          Array.from({ length: 4 }, () => ({
            provider_state: "indeterminate_after_crash",
            request_error_code: "provider_started_outcome_unknown_after_process_restart",
            terminal_at: expect.any(Number),
          })),
        )
        expect(
          yield* db.all(sql`
            SELECT state, error_code, settled_at, first_event_at
            FROM session_provider_attempt
            WHERE attempt_id LIKE 'provider-cross-upgrade-attempt-%'
            ORDER BY provider_turn_seq
          `),
        ).toEqual([
          { state: "dispatching", error_code: null, settled_at: null, first_event_at: null },
          { state: "streaming", error_code: null, settled_at: null, first_event_at: 5 },
          { state: "settled", error_code: null, settled_at: 6, first_event_at: null },
          { state: "failed", error_code: "provider_failed", settled_at: 6, first_event_at: null },
        ])
        expect(
          yield* db.get(sql`
            SELECT continuation_state, continuation_receipt_id, continuation_error_code,
                   continuation_dispatching_at, continuation_terminal_at
            FROM compaction_run
            WHERE run_id = 'provider-cross-upgrade-continuation'
          `),
        ).toEqual({
          continuation_state: "indeterminate",
          continuation_receipt_id: "provider-cross-upgrade-receipt-dispatching",
          continuation_error_code: "provider_started_outcome_unknown_after_process_restart",
          continuation_dispatching_at: expect.any(Number),
          continuation_terminal_at: expect.any(Number),
        })
        expect(
          yield* db.get(sql`
            SELECT authority_state, recovery_reason
            FROM session_prompt_epoch
            WHERE session_id = 'provider-cross-upgrade-session' AND state = 'active'
          `),
        ).toEqual({
          authority_state: "recovery_required",
          recovery_reason: "provider outcome is unknown after process restart",
        })
        expect(
          yield* db.get(sql`
            SELECT state, reason
            FROM session_history_state
            WHERE session_id = 'provider-cross-upgrade-session'
          `),
        ).toEqual({
          state: "recovery_required",
          reason: "provider outcome is unknown after process restart",
        })
      }),
    )
  })

  test("enforces durable prompt history recovery state invariants", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-history-authority', '/repo', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-history-authority', 'project-history-authority', 'history-authority', '/repo',
            'History authority', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, reason, created_at, authority_state,
            projection_version, canonicalization_version, base_message_count,
            effective_history_hash, first_window_id, window_id
          ) VALUES (
            'session-history-authority', 0, 'active', 'bootstrap', 1, 'ready',
            1, 1, 0, 'history-hash', 'window-0', 'window-0'
          )
        `)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET authority_state = 'recovery_required'
                WHERE session_id = 'session-history-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_history_state (
                  session_id, state, reason, time_created, time_updated
                ) VALUES (
                  'session-history-authority', 'recovery_required', 'corrupt history', 1, 1
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(sql`
          UPDATE session_prompt_epoch
          SET authority_state = 'recovery_required', recovery_reason = 'corrupt history'
          WHERE session_id = 'session-history-authority' AND epoch = 0
        `)
        yield* db.run(sql`
          INSERT INTO session_history_state (
            session_id, state, reason, time_created, time_updated
          ) VALUES (
            'session-history-authority', 'recovery_required', 'corrupt history', 1, 1
          )
        `)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET authority_state = 'ready', recovery_reason = NULL
                WHERE session_id = 'session-history-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_history_state
                SET reason = NULL
                WHERE session_id = 'session-history-authority'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            sql`
              SELECT authority_state, recovery_reason
              FROM session_prompt_epoch
              WHERE session_id = 'session-history-authority' AND epoch = 0
            `,
          ),
        ).toEqual({ authority_state: "recovery_required", recovery_reason: "corrupt history" })
        expect(
          yield* db.get(
            sql`
              SELECT state, reason
              FROM session_history_state
              WHERE session_id = 'session-history-authority'
            `,
          ),
        ).toEqual({ state: "recovery_required", reason: "corrupt history" })

        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-missing-authority', 'project-history-authority', 'missing-authority', '/repo',
            'Missing authority', '1', 2, 2
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-missing-authority', 'session-missing-authority', 2, 2, '{"role":"user"}')
        `)
        yield* db.run(sql`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, reason, created_at, authority_state,
            projection_version, canonicalization_version, base_message_count,
            effective_history_hash, first_window_id, window_id, source_end_message_id
          ) VALUES (
            'session-missing-authority', 0, 'active', 'bootstrap', 2, 'ready',
            1, 1, 0, 'missing-history-hash', 'missing-window-0', 'missing-window-0',
            'message-missing-authority'
          )
        `)
        yield* db.run(sql`DELETE FROM message WHERE id = 'message-missing-authority'`)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET recovery_reason = NULL
                WHERE session_id = 'session-missing-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_prompt_epoch
          SET authority_state = 'recovery_required', recovery_reason = 'referenced message missing'
          WHERE session_id = 'session-missing-authority' AND epoch = 0
        `)
        expect(
          yield* db.get(sql`
            SELECT authority_state, recovery_reason
            FROM session_prompt_epoch
            WHERE session_id = 'session-missing-authority' AND epoch = 0
          `),
        ).toEqual({
          authority_state: "recovery_required",
          recovery_reason: "referenced message missing",
        })
      }),
    )
  })

  test("adds nullable Session suspension without inferring historical recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('historical')`)

        yield* DatabaseMigration.applyOnly(db, [timeSuspendedMigration])

        expect(yield* db.get(sql`SELECT time_suspended FROM session WHERE id = 'historical'`)).toEqual({
          time_suspended: null,
        })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_time_suspended_idx'`,
          ),
        ).toEqual({ name: "session_time_suspended_idx" })
      }),
    )
  })

  test("preserves historical task admission and outbox rows across the L1 rebuild", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            attempts, time_created, time_updated
          ) VALUES (
            'run_historical', 'run_historical', 'request', 'ses_parent', 'msg_parent',
            'call_historical', 'ses_child', 1, 'background', 'research', 'researching',
            2, 100, 200
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_admission (
            admission_key, request_hash, run_id, parent_session_id, parent_message_id,
            tool_call_id, delivery_mode, time_created
          ) VALUES (
            'admission_historical', 'request', 'run_historical', 'ses_parent', 'msg_parent',
            'call_historical', 'background', 100
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_notification_outbox (
            id, run_id, message_id, parent_session_id, directory, payload, status,
            attempts, available_at, time_created, time_updated
          ) VALUES (
            'outbox_historical', 'run_historical', 'msg_outbox', 'ses_parent', '/repo', '{}',
            'delivering', 1, 150, 100, 200
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [subagentControlPlaneMigration])

        expect(
          yield* db.get(
            sql`SELECT state, phase, control_state, input_state, workspace_preflight_state, start_attempts FROM task_run WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({
          state: "running",
          phase: "research",
          control_state: "open",
          input_state: "legacy",
          workspace_preflight_state: "legacy",
          start_attempts: 2,
        })
        expect(
          yield* db.get(
            sql`SELECT admission_key, origin_kind, origin_key FROM task_admission WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({
          admission_key: "admission_historical",
          origin_kind: "task_tool",
          origin_key: "admission_historical",
        })
        expect(
          yield* db.get(
            sql`SELECT status, event_kind, time_admitted FROM task_notification_outbox WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({ status: "processing", event_kind: "terminal", time_admitted: null })
        const activeIndex = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'task_run_child_active_idx'`,
        )
        expect(activeIndex?.sql).toContain(
          "WHERE state IN ('admitted', 'provisioning', 'running', 'researching', 'finalizing')",
        )
        expect(activeIndex?.sql).not.toContain("'queued'")
      }),
    )
  })

  test("preserves unknown historical structured transport and backfills only exact receipts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_structured_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration, subagentControlPlaneMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            reason, attempts, raw_result_message_id, structured_result_message_id, output,
            time_created, time_updated, time_settled
          ) VALUES
          (
            'run_structured', 'run_structured', 'request-structured', 'ses_structured_parent',
            'msg-structured-parent', 'call-structured', 'ses-structured-child', 1, 'foreground',
            'settled', 'completed', 'structured_output_valid', 1, 'msg-structured-research',
            'msg-structured-result',
            '{"result":"ok"}', 100, 110, 110
          ),
          (
            'run_text_fallback', 'run_text_fallback', 'request-text', 'ses_structured_parent',
            'msg-text-parent', 'call-text', 'ses-text-child', 1, 'foreground',
            'settled', 'completed', 'structured_output_text_fallback', 2, 'msg-text-research', 'msg-text-result',
            '{"result":"ok"}', 100, 120, 120
          ),
          (
            'run_degraded', 'run_degraded', 'request-degraded', 'ses_structured_parent',
            'msg-degraded-parent', 'call-degraded', 'ses-degraded-child', 1, 'foreground',
            'settled', 'completed', 'structured_output_degraded_text', 2, 'msg-degraded-research', NULL,
            '{"_degraded":true,"_reason":"structured_output_invalid","_attempts":2,"_raw":"research"}',
            100, 130, 130
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, data) VALUES
            ('msg-text-research', 'ses-text-child', '{"role":"assistant"}'),
            ('msg-text-result', 'ses-text-child', '{"role":"assistant"}'),
            ('msg-degraded-research', 'ses-degraded-child', '{"role":"assistant"}')
        `)

        yield* DatabaseMigration.applyOnly(db, [
          taskStructuredOutputReceiptSchemaMigration,
          taskStructuredOutputReceiptMigration,
        ])

        expect(
          yield* db.all(sql`
            SELECT run_id, structured_output_receipt
            FROM task_run
            ORDER BY run_id
          `),
        ).toEqual([
          {
            run_id: "run_degraded",
            structured_output_receipt: '{"attempt":2,"transport":"degraded_text","reason":"structured_output_invalid"}',
          },
          { run_id: "run_structured", structured_output_receipt: null },
          { run_id: "run_text_fallback", structured_output_receipt: '{"attempt":2,"transport":"text_fallback"}' },
        ])
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET structured_output_receipt = '{"attempt":1,"transport":"structured"}'
                WHERE run_id = 'run_degraded'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET output = '{"result":"changed"}'
                WHERE run_id = 'run_structured'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET time_updated = time_updated + 1
                WHERE run_id = 'run_structured'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(false)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET reason = 'structured_output_text_fallback'
                WHERE run_id = 'run_structured'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO task_run (
                  run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
                  tool_call_id, child_session_id, generation, delivery_mode, phase, state,
                  reason, attempts, structured_result_message_id, structured_output_receipt,
                  time_created, time_updated, time_settled
                ) VALUES (
                  'run_invalid_receipt', 'run_invalid_receipt', 'request-invalid',
                  'ses_structured_parent', 'msg-invalid-parent', 'call-invalid',
                  'ses-invalid-child', 1, 'foreground', 'settled', 'completed',
                  'structured_output_text_fallback', 2, 'msg-invalid-result',
                  '{"attempt":1,"transport":"text_fallback"}', 100, 140, 140
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("rejects ambiguous historical task structured output receipts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_ambiguous_structured_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration, subagentControlPlaneMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            reason, attempts, structured_result_message_id, output,
            time_created, time_updated, time_settled
          ) VALUES (
            'run_ambiguous_degraded', 'run_ambiguous_degraded', 'request-ambiguous',
            'ses_ambiguous_structured_parent', 'msg-ambiguous-parent', 'call-ambiguous',
            'ses-ambiguous-child', 1, 'foreground', 'settled', 'completed',
            'structured_output_degraded_text', 2, NULL,
            '{"_degraded":true,"_attempts":2,"_raw":"research"}', 100, 110, 110
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputReceiptSchemaMigration])
        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputReceiptMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.all(sql`
            SELECT name FROM pragma_table_info('task_run')
            WHERE name = 'structured_output_receipt'
          `),
        ).toEqual([{ name: "structured_output_receipt" }])
        expect(
          yield* db.get(sql`
            SELECT structured_output_receipt
            FROM task_run
            WHERE run_id = 'run_ambiguous_degraded'
          `),
        ).toEqual({ structured_output_receipt: null })
      }),
    )
  })

  test("freezes durable task structured contracts and binds new terminal receipts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_execution_spec_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration, subagentControlPlaneMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            execution_spec, time_created, time_updated
          ) VALUES (
            'run_invalid_execution_spec', 'run_invalid_execution_spec', 'request-invalid-spec',
            'ses_execution_spec_parent', 'msg-invalid-spec-parent', 'call-invalid-spec',
            'ses-invalid-spec-child', 1, 'foreground', 'admission', 'admitted',
            '{"structuredOutput":{"schema":{},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":3}}',
            100, 100
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputReceiptSchemaMigration])
        yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputReceiptMigration])

        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [taskExecutionSpecAuthorityMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(sql`
            SELECT json_extract(execution_spec, '$.structuredOutput.maxAttempts') AS max_attempts
            FROM task_run
            WHERE run_id = 'run_invalid_execution_spec'
          `),
        ).toEqual({ max_attempts: 3 })
        expect(
          yield* db.get(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger' AND name = 'task_run_execution_spec_immutable'
          `),
        ).toBeUndefined()

        yield* db.run(sql`
          UPDATE task_run
          SET execution_spec = '{"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"object"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}'
          WHERE run_id = 'run_invalid_execution_spec'
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, data) VALUES
            ('msg-valid-research', 'ses-invalid-spec-child', '{"role":"assistant"}'),
            ('msg-valid-result', 'ses-invalid-spec-child', '{"role":"assistant"}'),
            ('msg-fallback-research', 'ses-no-fallback-child', '{"role":"assistant"}'),
            ('msg-fallback-result', 'ses-no-fallback-child', '{"role":"assistant"}')
        `)
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            execution_spec, time_created, time_updated
          ) VALUES
          (
            'run_contract_requires_receipt', 'run_contract_requires_receipt', 'request-contract-receipt',
            'ses_execution_spec_parent', 'msg-contract-parent', 'call-contract-receipt',
            'ses-contract-child', 1, 'foreground', 'admission', 'admitted',
            '{"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"object"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}',
            100, 100
          ),
          (
            'run_contract_disallows_fallback', 'run_contract_disallows_fallback', 'request-no-fallback',
            'ses_execution_spec_parent', 'msg-no-fallback-parent', 'call-no-fallback',
            'ses-no-fallback-child', 1, 'foreground', 'admission', 'admitted',
            '{"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"object"},"allowTextFallback":false,"receiptVersion":1,"maxAttempts":2}}',
            100, 100
          ),
          (
            'run_historical_contract', 'run_historical_contract', 'request-historical-contract',
            'ses_execution_spec_parent', 'msg-historical-parent', 'call-historical-contract',
            'ses-historical-child', 1, 'foreground', 'settled', 'completed',
            '{"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"object"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}',
            100, 200
          )
        `)
        yield* db.run(sql`
          UPDATE task_run
          SET reason = 'text_output_valid', attempts = 1, time_settled = 200
          WHERE run_id = 'run_historical_contract'
        `)
        yield* DatabaseMigration.applyOnly(db, [taskExecutionSpecAuthorityMigration])

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET execution_spec = '{"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":{"schema":{"type":"array"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}'
                WHERE run_id = 'run_invalid_execution_spec'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET phase = 'settled', state = 'completed', reason = 'text_output_valid',
                  attempts = 1, output = 'plain text', time_settled = 200, time_updated = 200
                WHERE run_id = 'run_contract_requires_receipt'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET phase = 'settled', state = 'completed', reason = 'structured_output_text_fallback',
                  attempts = 2, raw_result_message_id = 'msg-fallback-research',
                  structured_result_message_id = 'msg-fallback-result',
                  structured_output_receipt = '{"attempt":2,"transport":"text_fallback"}',
                  time_settled = 200, time_updated = 200
                WHERE run_id = 'run_contract_disallows_fallback'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run SET time_updated = 201
                WHERE run_id = 'run_historical_contract'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(false)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET output = 'historical terminal payload cannot be rewritten'
                WHERE run_id = 'run_historical_contract'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET reason = 'structured_output_valid', structured_result_message_id = 'msg-inferred',
                  structured_output_receipt = '{"attempt":1,"transport":"structured"}'
                WHERE run_id = 'run_historical_contract'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET phase = 'settled', state = 'completed', reason = 'structured_output_valid',
                  attempts = 1, raw_result_message_id = 'msg-valid-research',
                  structured_result_message_id = 'msg-valid-result',
                  structured_output_receipt = '{"attempt":1,"transport":"structured"}',
                  time_settled = 200, time_updated = 200
                WHERE run_id = 'run_invalid_execution_spec'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(false)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run
                SET output = '{"result":"rewritten"}'
                WHERE run_id = 'run_invalid_execution_spec'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO task_run (
                  run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
                  tool_call_id, child_session_id, generation, delivery_mode, phase, state,
                  reason, attempts, structured_result_message_id, structured_output_receipt,
                  time_created, time_updated, time_settled
                ) VALUES (
                  'run_unbound_receipt', 'run_unbound_receipt', 'request-unbound-receipt',
                  'ses_execution_spec_parent', 'msg-unbound-parent', 'call-unbound-receipt',
                  'ses-unbound-child', 1, 'foreground', 'settled', 'completed',
                  'structured_output_valid', 1, 'msg-unbound-result',
                  '{"attempt":1,"transport":"structured"}', 100, 200, 200
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO task_run (
                  run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
                  tool_call_id, child_session_id, generation, delivery_mode, phase, state,
                  execution_spec, time_created, time_updated
                ) VALUES (
                  'run_invalid_new_spec', 'run_invalid_new_spec', 'request-invalid-new-spec',
                  'ses_execution_spec_parent', 'msg-invalid-new-parent', 'call-invalid-new-spec',
                  'ses-invalid-new-child', 1, 'foreground', 'admission', 'admitted',
                  '{"structuredOutput":{"schema":{},"allowTextFallback":1,"receiptVersion":1,"maxAttempts":2}}',
                  300, 300
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO task_run (
                  run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
                  tool_call_id, child_session_id, generation, delivery_mode, phase, state,
                  execution_spec, time_created, time_updated
                ) VALUES (
                  'run_missing_structured_identity', 'run_missing_structured_identity',
                  'request-missing-structured-identity', 'ses_execution_spec_parent',
                  'msg-missing-structured-identity-parent', 'call-missing-structured-identity',
                  'ses-missing-structured-identity-child', 1, 'foreground', 'admission', 'admitted',
                  '{"structuredOutput":{"schema":{},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}}',
                  300, 300
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("rejects pre-authority structured evidence and binds exact material snapshots", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const authorityIndex = migrations.findIndex(
          (migration) => migration.id === taskStructuredOutputEvidenceAuthorityMigration.id,
        )
        expect(authorityIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, authorityIndex))
        const now = Date.now()
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-evidence', '/project-evidence', '[]', ${now}, ${now})
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES
            ('session-evidence-parent', 'project-evidence', 'parent', '/project-evidence', 'parent', 'test', ${now}, ${now}),
            ('session-evidence-child', 'project-evidence', 'child', '/project-evidence', 'child', 'test', ${now}, ${now})
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
            ('message-evidence-raw', 'session-evidence-child', ${now}, ${now}, '{"role":"assistant"}'),
            ('message-evidence-result', 'session-evidence-child', ${now}, ${now}, '{"role":"assistant"}')
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
            ('part-evidence-raw', 'message-evidence-raw', 'session-evidence-child', ${now}, ${now},
              '{"type":"text","text":"research"}'),
            ('part-evidence-result', 'message-evidence-result', 'session-evidence-child', ${now}, ${now},
              '{"type":"text","text":"{\\"result\\":\\"ok\\"}"}')
        `)
        const contract = '{"schema":{"type":"object"},"allowTextFallback":true,"receiptVersion":1,"maxAttempts":2}'
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            attempts, execution_owner, lease_expires_at, execution_spec, version,
            time_created, time_updated
          ) VALUES (
            'run-evidence', 'run-evidence', 'request-evidence', 'session-evidence-parent',
            'message-evidence-parent', 'call-evidence', 'session-evidence-child', 1,
            'foreground', 'finalize', 'finalizing', 1, 'evidence-owner', ${now + 60_000},
            ${`{"prompt":{"text":"inspect"},"agent":"researcher","model":{"providerID":"test","modelID":"test"},"structuredOutput":${contract}}`},
            3, ${now}, ${now}
          )
        `)
        const preAuthorityInsert = yield* db
          .run(
            sql`
          INSERT INTO task_structured_output_evidence (
            run_id, child_session_id, owner_token, claim_generation, expected_version,
            terminal_state, attempts, contract_json, raw_result_message_id, raw_message_json,
            raw_parts_json, result_message_id, result_message_json, result_parts_json,
            output, structured_output_receipt, failure_code, created_at
          ) VALUES (
            'run-evidence', 'session-evidence-child', 'evidence-owner', 0, 3,
            'completed', 1, ${contract}, 'message-evidence-raw', '{"role":"assistant"}',
            '[]', 'message-evidence-result', '{"role":"assistant"}', '[]',
            '{"result":"ok"}', '{"attempt":1,"transport":"structured"}', NULL, ${now}
          )
        `,
          )
          .pipe(Effect.exit)
        expect(Exit.isSuccess(preAuthorityInsert)).toBe(true)

        expect(
          Exit.isFailure(
            yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputEvidenceAuthorityMigration]).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name = 'task_structured_output_evidence_insert_guard'
          `),
        ).toBeUndefined()

        yield* db.run(sql`DELETE FROM task_structured_output_evidence WHERE run_id = 'run-evidence'`)
        yield* DatabaseMigration.applyOnly(db, [taskStructuredOutputEvidenceAuthorityMigration])
        yield* db.run(sql`
          INSERT INTO task_structured_output_evidence (
            run_id, child_session_id, owner_token, claim_generation, expected_version,
            terminal_state, attempts, contract_json, raw_result_message_id, raw_message_json,
            raw_parts_json, result_message_id, result_message_json, result_parts_json,
            output, structured_output_receipt, failure_code, created_at
          ) VALUES (
            'run-evidence', 'session-evidence-child', 'evidence-owner', 0, 3,
            'completed', 1, ${contract}, 'message-evidence-raw', '{"role":"assistant"}',
            '[]', 'message-evidence-result', '{"role":"assistant"}', '[]',
            '{"result":"ok"}', '{"attempt":1,"transport":"structured"}', NULL, ${now}
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_structured_output_evidence_part (
            run_id, role, ordinal, part_id, message_id, session_id, part_json
          ) VALUES
            ('run-evidence', 'raw', 0, 'part-evidence-raw', 'message-evidence-raw',
              'session-evidence-child', '{"type":"text","text":"research"}'),
            ('run-evidence', 'result', 0, 'part-evidence-result', 'message-evidence-result',
              'session-evidence-child', '{"type":"text","text":"{\\"result\\":\\"ok\\"}"}')
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE task_run SET
                  phase = 'settled', state = 'completed', reason = 'structured_output_valid', attempts = 1,
                  raw_result_message_id = 'message-evidence-raw',
                  structured_result_message_id = 'message-evidence-result',
                  structured_output_receipt = '{"attempt":1,"transport":"structured"}',
                  output = '{"result":"ok"}', execution_owner = NULL, lease_expires_at = NULL,
                  version = 4, time_updated = ${now + 1}, time_settled = ${now + 1}
                WHERE run_id = 'run-evidence'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* db.get(sql`SELECT state, phase, version FROM task_run WHERE run_id = 'run-evidence'`)).toEqual({
          state: "finalizing",
          phase: "finalize",
          version: 3,
        })
      }),
    )
  })

  test("repairs the canonical admission on databases already affected by the L1 cascade", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            attempts, time_created, time_updated
          ) VALUES (
            'run_repair', 'run_repair', 'request_repair', 'ses_parent', 'msg_repair',
            'call_repair', 'ses_child_repair', 1, 'foreground', 'research', 'completed',
            1, 100, 200
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_admission (
            admission_key, request_hash, run_id, parent_session_id, parent_message_id,
            tool_call_id, delivery_mode, time_created
          ) VALUES (
            'admission_repair', 'request_repair', 'run_repair', 'ses_parent', 'msg_repair',
            'call_repair', 'foreground', 100
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [subagentControlPlaneMigration])
        yield* db.run(sql`DELETE FROM task_admission WHERE run_id = 'run_repair'`)

        yield* DatabaseMigration.applyOnly(db, [taskAdmissionRepairMigration])

        expect(
          yield* db.get(
            sql`SELECT admission_key, request_hash, tool_call_id, origin_key FROM task_admission WHERE run_id = 'run_repair'`,
          ),
        ).toEqual({
          admission_key: "admission_repair",
          request_hash: "request_repair",
          tool_call_id: "call_repair",
          origin_key: "admission_repair",
        })
      }),
    )
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })

  // §A4 event_dropped DISTINCT (P4.6) — the unique-index migration must be robust on a dev/beta DB that
  // already accumulated DUPLICATE event_id drop rows (flags-ON + same event shed multiple times under
  // backpressure BEFORE the onConflictDoNothing fix). A naive CREATE UNIQUE INDEX would throw `UNIQUE
  // constraint failed`, aborting the migration txn and wedging startup. The dedupe-before-index step must
  // collapse the duplicates first so the index builds cleanly.
  test("event_dropped distinct: dedupes historical duplicate event_id rows BEFORE the unique index (no throw)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        // recreate the P3.13 (20260712010000) table shape WITHOUT the unique index, as a pre-fix DB has it.
        yield* db.run(sql`
          CREATE TABLE deepagent_event_drop (
            id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
            event_id text NOT NULL,
            workspace_id text NOT NULL,
            reason text NOT NULL,
            priority text NOT NULL,
            created_at integer NOT NULL
          )
        `)
        // the same event shed 3× under backpressure (3 rows, same event_id) + a distinct event (1 row).
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 100)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 200)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 300)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_other', 'wrk_1', 'backpressure', 'normal', 400)`,
        )

        // the migration must NOT throw despite the duplicate event_id rows.
        yield* DatabaseMigration.applyOnly(db, [eventDropDistinctMigration])

        // one row per event_id survived; the duplicate collapsed to its EARLIEST (MIN(rowid) → created_at 100).
        expect(yield* db.all(sql`SELECT event_id, created_at FROM deepagent_event_drop ORDER BY event_id`)).toEqual([
          { event_id: "dae_dup", created_at: 100 },
          { event_id: "dae_other", created_at: 400 },
        ])
        // event_dropped_total (COUNT(*)) now == 2 DISTINCT events, not 4 shed-attempts.
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 2 })

        // the UNIQUE index is in place, so a re-shed of an existing event is a no-op (onConflictDoNothing works).
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(deepagent_event_drop)`)).find(
            (index) => index.name === "deepagent_event_drop_event_id_idx",
          ),
        ).toMatchObject({ unique: 1 })
        // prove the constraint is live: an ON CONFLICT DO NOTHING insert of an existing id changes nothing.
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 999) ON CONFLICT DO NOTHING`,
        )
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 2 })
      }),
    )
  })

  // fresh/duplicate-free table: the DELETE is a harmless no-op and the index still builds.
  test("event_dropped distinct: DELETE is a no-op on a duplicate-free table, index still applies", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE deepagent_event_drop (
            id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
            event_id text NOT NULL,
            workspace_id text NOT NULL,
            reason text NOT NULL,
            priority text NOT NULL,
            created_at integer NOT NULL
          )
        `)
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_a', 'wrk_1', 'backpressure', 'normal', 100)`,
        )
        yield* DatabaseMigration.applyOnly(db, [eventDropDistinctMigration])
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(deepagent_event_drop)`)).find(
            (index) => index.name === "deepagent_event_drop_event_id_idx",
          ),
        ).toMatchObject({ unique: 1 })
      }),
    )
  })

  test("compaction continuation admission migrates legacy wakeups from durable provider evidence", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE compaction_run (
            run_id text PRIMARY KEY NOT NULL,
            session_id text NOT NULL,
            state text NOT NULL,
            continuation_wakeup_at integer
          )
        `)
        yield* db.run(sql`
          CREATE TABLE compaction_artifact (
            run_id text NOT NULL,
            session_id text NOT NULL,
            message_id text NOT NULL,
            state text NOT NULL,
            kind text NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session_tool_request_receipt (
            receipt_id text PRIMARY KEY NOT NULL,
            request_ordinal integer NOT NULL,
            session_id text NOT NULL,
            user_message_id text NOT NULL,
            provider_state text NOT NULL,
            dispatching_at integer,
            terminal_at integer,
            request_error_code text,
            response_fingerprint text,
            created_at integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO compaction_run (run_id, session_id, state, continuation_wakeup_at) VALUES
            ('orphan-wakeup', 'ses_orphan', 'committed', 10),
            ('prepared-wakeup', 'ses_prepared', 'committed', 20),
            ('dispatching-wakeup', 'ses_dispatching', 'committed', 30),
            ('settled-without-response', 'ses_incomplete', 'committed', 40)
        `)
        yield* db.run(sql`
          INSERT INTO compaction_artifact (run_id, session_id, message_id, state, kind) VALUES
            ('orphan-wakeup', 'ses_orphan', 'msg_orphan', 'committed', 'continue'),
            ('prepared-wakeup', 'ses_prepared', 'msg_prepared', 'committed', 'continue'),
            ('dispatching-wakeup', 'ses_dispatching', 'msg_dispatching', 'committed', 'continue'),
            ('settled-without-response', 'ses_incomplete', 'msg_incomplete', 'committed', 'continue')
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt
            (receipt_id, request_ordinal, session_id, user_message_id, provider_state,
             dispatching_at, terminal_at, request_error_code, created_at)
          VALUES
            ('receipt-prepared', 1, 'ses_prepared', 'msg_prepared', 'prepared', NULL, NULL, NULL, 21),
            ('receipt-dispatching', 1, 'ses_dispatching', 'msg_dispatching', 'dispatching', 31, NULL, NULL, 31),
            ('receipt-incomplete', 1, 'ses_incomplete', 'msg_incomplete', 'settled', 41, 42, NULL, 41)
        `)

        yield* DatabaseMigration.applyOnly(db, [compactionContinuationAdmissionMigration])

        expect(
          yield* db.all(sql`
            SELECT run_id, continuation_state, continuation_receipt_id,
                   continuation_admitted_at, continuation_dispatching_at, continuation_error_code
            FROM compaction_run
            ORDER BY run_id
          `),
        ).toEqual([
          {
            run_id: "dispatching-wakeup",
            continuation_state: "dispatching",
            continuation_receipt_id: "receipt-dispatching",
            continuation_admitted_at: 30,
            continuation_dispatching_at: 31,
            continuation_error_code: null,
          },
          {
            run_id: "orphan-wakeup",
            continuation_state: "pending",
            continuation_receipt_id: null,
            continuation_admitted_at: null,
            continuation_dispatching_at: null,
            continuation_error_code: "legacy_wakeup_without_provider_admission",
          },
          {
            run_id: "prepared-wakeup",
            continuation_state: "admitted",
            continuation_receipt_id: "receipt-prepared",
            continuation_admitted_at: 20,
            continuation_dispatching_at: null,
            continuation_error_code: null,
          },
          {
            run_id: "settled-without-response",
            continuation_state: "indeterminate",
            continuation_receipt_id: "receipt-incomplete",
            continuation_admitted_at: 40,
            continuation_dispatching_at: 41,
            continuation_error_code: null,
          },
        ])
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE compaction_run
                SET continuation_state = 'settled', continuation_terminal_at = 40
                WHERE run_id = 'orphan-wakeup'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE compaction_run
                SET continuation_state = 'settled', continuation_terminal_at = 40
                WHERE run_id = 'dispatching-wakeup'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'settled', response_fingerprint = 'response-hash', terminal_at = 40
          WHERE receipt_id = 'receipt-dispatching'
        `)
        yield* db.run(sql`
          UPDATE compaction_run
          SET continuation_state = 'settled', continuation_terminal_at = 40
          WHERE run_id = 'dispatching-wakeup'
        `)
        expect(
          yield* db.get(sql`
            SELECT continuation_state, continuation_terminal_at
            FROM compaction_run
            WHERE run_id = 'dispatching-wakeup'
          `),
        ).toEqual({ continuation_state: "settled", continuation_terminal_at: 40 })
      }),
    )
  })

  test("part integrity backfill quarantines pre-existing cross-session rows and blocks history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE project (id text PRIMARY KEY NOT NULL, worktree text, sandboxes text,
            time_created integer NOT NULL, time_updated integer NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE session (id text PRIMARY KEY NOT NULL, project_id text NOT NULL,
            slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL,
            time_created integer NOT NULL, time_updated integer NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE message (id text PRIMARY KEY NOT NULL, session_id text NOT NULL,
            time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE part (id text PRIMARY KEY NOT NULL, message_id text NOT NULL,
            session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
            data text NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE session_prompt_epoch (session_id text NOT NULL, epoch integer NOT NULL,
            state text NOT NULL, authority_state text, recovery_reason text,
            PRIMARY KEY (session_id, epoch))
        `)
        yield* db.run(sql`
          CREATE TABLE session_history_state (session_id text PRIMARY KEY NOT NULL,
            state text NOT NULL, reason text, time_created integer NOT NULL, time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)
        `)
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`INSERT INTO project VALUES ('p', '/repo', '[]', 1, 1)`)
        yield* db.run(sql`INSERT INTO session VALUES
          ('session-a', 'p', 'a', '/repo', 'A', '1', 1, 1),
          ('session-b', 'p', 'b', '/repo', 'B', '1', 1, 1)`)
        yield* db.run(sql`INSERT INTO message VALUES ('message-a', 'session-a', 1, 1, '{}')`)
        yield* db.run(sql`INSERT INTO part VALUES
          ('part-bad', 'message-a', 'session-b', 1, 1, '{"type":"text","text":"secret"}'),
          ('part-missing-session', 'message-a', 'session-missing', 1, 1, '{"type":"text","text":"orphan"}')`)
        yield* db.run(sql`INSERT INTO session_prompt_epoch VALUES ('session-a', 0, 'active', 'legacy_pending', NULL)`)
        yield* db.run(sql`INSERT INTO session_prompt_epoch VALUES ('session-b', 0, 'active', 'legacy_pending', NULL)`)

        yield* DatabaseMigration.applyOnly(db, [partIntegrityBackfillMigration])

        expect(
          yield* db.all(
            sql`SELECT part_id, message_id, part_session_id, message_session_id, reason FROM session_part_integrity_quarantine ORDER BY part_id`,
          ),
        ).toEqual([
          {
            part_id: "part-bad",
            message_id: "message-a",
            part_session_id: "session-b",
            message_session_id: "session-a",
            reason: "part_parent_cross_session",
          },
          {
            part_id: "part-missing-session",
            message_id: "message-a",
            part_session_id: "session-missing",
            message_session_id: "session-a",
            reason: "part_parent_cross_session",
          },
        ])
        expect(yield* db.all(sql`SELECT session_id, state FROM session_history_state ORDER BY session_id`)).toEqual([
          { session_id: "session-a", state: "recovery_required" },
          { session_id: "session-b", state: "recovery_required" },
        ])
        expect(
          yield* db.all(sql`SELECT session_id, authority_state FROM session_prompt_epoch ORDER BY session_id`),
        ).toEqual([
          { session_id: "session-a", authority_state: "recovery_required" },
          { session_id: "session-b", authority_state: "recovery_required" },
        ])
      }),
    )
  })
})

function seedReceiptScope(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
      VALUES (${receiptNamespace}, 'implicit_local', 'receipt-namespace-binding', 1)
    `)
    yield* db.run(sql`
      INSERT INTO context_project_scope_identity (
        security_namespace_id, project_scope_key, project_kind, project_identity_hash, created_at
      ) VALUES (
        ${receiptNamespace}, ${receiptProjectScope}, 'registered_root', 'receipt-project-identity', 1
      )
    `)
  })
}

function contextActivation(recordedAt: number, selectionId?: string, projectionHash?: string) {
  return JSON.stringify({
    schemaVersion: 1,
    recordedAt,
    readinessAgeMs: recordedAt,
    readinessExpiresInMs: contextReadiness.expiresAt - recordedAt,
    outcome: "not_requested",
    enabledCapabilities: [],
    fallbackReasons: [],
    decision: contextEligibility,
    ...(selectionId && projectionHash ? { selection: { selectionId, projectionHash } } : {}),
  })
}
