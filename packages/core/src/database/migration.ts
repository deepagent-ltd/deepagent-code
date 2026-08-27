export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Cause, Data, Effect, Exit, Schedule, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import { MigrationIdentity } from "./migration-identity"
import { DatabaseUpgradeRun } from "./upgrade-run"
import { DatabaseMigrationLease as MigrationLease, type MigrationLease as MigrationLeaseHandle } from "./migration-lease"
import type { UpgradeRun } from "../contract/upgrade-run"
import { InstallationVersion, InstallationCommit } from "../installation/version"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

// A migration DDL can fail transiently when another connection (a second desktop instance, a
// lingering daemon, or an in-process worker) holds an active statement against the old schema:
// SQLite returns SQLITE_LOCKED immediately and busy_timeout does not apply to schema locks.
// The migration transaction rolls back cleanly, so retrying once the competing connection
// releases is safe; without the retry a desktop startup dies on a transient race.
class TransientLock extends Data.TaggedError("DatabaseMigration.TransientLock")<{ readonly detail: string }> {}

const isLockError = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const record = value as { code?: string; message?: string; cause?: unknown }
  if (record.code === "SQLITE_LOCKED" || record.code === "SQLITE_BUSY") return true
  if (typeof record.message === "string" && /(database is locked|database table is locked|database is busy)/i.test(record.message))
    return true
  return record.cause !== undefined ? isLockError(record.cause) : false
}

const isTransientLockCause = (cause: Cause.Cause<unknown>): boolean => cause.reasons.some(isLockError)

const transientLockRetry = Schedule.spaced("2 seconds").pipe(Schedule.take(30))
export const historicalAliases = new Map([
  ["20260530232709_lovely_romulus", "20260511173437_session-metadata"],
  ["20260803000000_subagent_control_plane_l1", "20260803000001_subagent_control_plane_l1"],
  [MigrationIdentity.Historical.finalAuthorities, MigrationIdentity.Canonical.finalAuthorities],
  [MigrationIdentity.Historical.eventMaintenance, MigrationIdentity.Canonical.eventMaintenance],
  [MigrationIdentity.Historical.eventSidecarLifecycle, MigrationIdentity.Canonical.eventSidecarLifecycle],
  [MigrationIdentity.Historical.eventSidecarIndexes, MigrationIdentity.Canonical.eventSidecarIndexes],
  [MigrationIdentity.Historical.eventAggregateIndexes, MigrationIdentity.Canonical.eventAggregateIndexes],
])
export const mergedHistoryAnchor = "20260813041400_context_activation_semantic_authority"
export const mergedHistoryInsertions = new Set([
  "20260812120000_legacy_provider_recovery",
  "20260812130000_legacy_activity_lifecycle_expand",
  "20260812140000_session_diff_manifest",
  MigrationIdentity.Canonical.eventMaintenance,
  "20260813100000_event_snapshot_authority",
  "20260813110000_provider_recovery_authority_bridge",
  "20260813120000_legacy_provider_receipt_supersession",
  "20260813120346_v2_provider_parity_campaign",
  "20260813121129_v2_provider_parity_response_fingerprint",
  "20260813121200_v2_provider_parity_campaign_authority",
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
  "20260813150000_single_authority_snapshot_merge",
])

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export type ApplyOptions = {
  /** Database file path (for the OS migration lock). Omitted for in-memory databases. */
  filename?: string
  readerProtocol?: string
  writerProtocol?: string
  buildIdentity?: string
  packageVersion?: string
  /** OS-lock / lease tuning (bounded timeout into maintenance, never unbounded). */
  timeoutMs?: number
  staleMs?: number
  leaseMs?: number
}

export function apply(db: Database, opts: ApplyOptions = {}) {
  return lock.withPermit(
    Effect.gen(function* () {
      yield* DatabaseUpgradeRun.ensureTables(db)
      yield* MigrationLease.ensureTables(db)
      const { completed } = yield* readCompletedSet(db, migrations, true)
      const pending = migrations.filter((migration) => !completed.has(migration.id))
      if (pending.length === 0) return undefined
      const lease = yield* MigrationLease.acquire(
        db,
        { leaseMs: opts.leaseMs ?? 60_000, staleMs: opts.staleMs ?? 60_000, timeoutMs: opts.timeoutMs ?? 5_000 },
        opts.filename,
      )
      const outcome = yield* Effect.gen(function* () {
        const run = yield* beginOrResumeRun(db, opts, pending)
        if (run.state !== "verifying") {
          yield* DatabaseUpgradeRun.advanceRun(db, run.runId, "applying")
          yield* applyMigrations(db, migrations, true, { run, lease, opts })
          yield* DatabaseUpgradeRun.advanceRun(db, run.runId, "verifying")
        }
        yield* DatabaseUpgradeRun.advanceRun(db, run.runId, "ready")
        return yield* DatabaseUpgradeRun.loadRun(db, run.runId)
      }).pipe(
        // On any failure (including a migration defect), the run goes to recovery_required and
        // the lease is always released below — a failed run must never stay "applying" forever.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const active = yield* DatabaseUpgradeRun.loadActiveRun(db).pipe(Effect.orDie)
            if (active) yield* DatabaseUpgradeRun.failRun(db, active.runId, "migration_apply_failed").pipe(Effect.ignore)
            return yield* Effect.failCause(cause)
          }),
        ),
        Effect.ensuring(lease.release()),
      )
      return outcome
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return applyMigrations(db, input, false)
}

type ReadCompleted = { completed: Set<string>; reconcileMergedHistory: boolean }

function readCompletedSet(db: Database, input: Migration[], requireLinearHistory: boolean) {
  return Effect.gen(function* () {
    const duplicate = input.find(
      (migration, index) => input.findIndex((candidate) => candidate.id === migration.id) !== index,
    )
    if (duplicate) return yield* Effect.die(new Error(`duplicate database migration id: ${duplicate.id}`))
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    let reconcileMergedHistory = false
    if (requireLinearHistory) {
      const known = new Set(input.map((migration) => migration.id))
      for (const [alias, canonical] of historicalAliases) {
        if (completed.has(alias) && known.has(canonical)) completed.add(canonical)
      }
      const unknown = [...completed].filter((id) => !known.has(id) && !historicalAliases.has(id)).sort()
      if (unknown.length > 0)
        return yield* Effect.die(
          new Error(`database migration history belongs to an incompatible lineage: ${unknown.join(", ")}`),
        )
      const firstMissing = input.findIndex((migration) => !completed.has(migration.id))
      const gap =
        firstMissing < 0 ? undefined : input.slice(firstMissing + 1).find((migration) => completed.has(migration.id))
      const lastCompleted = input.findLastIndex((migration) => completed.has(migration.id))
      const insertedGaps = input
        .slice(0, lastCompleted + 1)
        .filter((migration) => !completed.has(migration.id))
        .map((migration) => migration.id)
      reconcileMergedHistory =
        gap !== undefined &&
        completed.has(mergedHistoryAnchor) &&
        insertedGaps.length > 0 &&
        insertedGaps.every((id) => mergedHistoryInsertions.has(id))
      if (gap && !reconcileMergedHistory)
        return yield* Effect.die(
          new Error(`database migration history has a gap before ${gap.id}: ${input[firstMissing]!.id} is missing`),
        )
    }

    return { completed, reconcileMergedHistory }
  })
}

function beginOrResumeRun(db: Database, opts: ApplyOptions, pending: Migration[]) {
  return Effect.gen(function* () {
    const existing = yield* DatabaseUpgradeRun.loadActiveRun(db)
    if (existing) {
      if (existing.state === "planned") yield* DatabaseUpgradeRun.advanceRun(db, existing.runId, "backup_verified")
      return existing
    }
    const reader = opts.readerProtocol ?? DatabaseUpgradeRun.RuntimeReaderProtocol
    const writer = opts.writerProtocol ?? DatabaseUpgradeRun.RuntimeWriterProtocol
    const targetDigest = DatabaseUpgradeRun.registryDigest(migrations)
    const sourceDigest = DatabaseUpgradeRun.registryDigest(migrations.filter((migration) => !pending.some((p) => p.id === migration.id)))
    const sourceProtocol = yield* currentProtocol(db, reader, writer)
    const run = yield* DatabaseUpgradeRun.beginRun(db, {
      sourceRegistryDigest: sourceDigest,
      targetRegistryDigest: targetDigest,
      sourceProtocol,
      targetProtocol: { reader, writer },
      buildIdentity: opts.buildIdentity ?? InstallationCommit ?? "local-build",
      packageVersion: opts.packageVersion ?? InstallationVersion,
      pendingMigrationIds: pending.map((migration) => migration.id),
      totalMigrations: pending.length,
    })
    yield* DatabaseUpgradeRun.advanceRun(db, run.runId, "backup_verified")
    return run
  })
}

function currentProtocol(db: Database, defaultReader: string, defaultWriter: string) {
  return Effect.gen(function* () {
    const exists = yield* db
      .get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_capability'`)
      .pipe(Effect.orDie)
    if (!exists) return { reader: defaultReader, writer: defaultWriter }
    const capability = yield* db
      .get<{ minimum_reader_protocol: number; minimum_writer_protocol: number }>(
        sql`SELECT minimum_reader_protocol, minimum_writer_protocol FROM database_capability LIMIT 1`,
      )
      .pipe(Effect.orDie)
    if (!capability) return { reader: defaultReader, writer: defaultWriter }
    return { reader: String(capability.minimum_reader_protocol), writer: String(capability.minimum_writer_protocol) }
  })
}

function applyMigrations(
  db: Database,
  input: Migration[],
  requireLinearHistory: boolean,
  upgrade?: { run: UpgradeRun; lease: MigrationLeaseHandle; opts: ApplyOptions },
) {
  return Effect.gen(function* () {
    const { completed, reconcileMergedHistory } = yield* readCompletedSet(db, input, requireLinearHistory)
    for (const migration of input) {
      if (completed.has(migration.id)) continue
      if (upgrade) yield* upgrade.lease.refresh()
      const startedAt = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (reconcileMergedHistory && migration.id === "20260812120000_legacy_provider_recovery")
              yield* reconcileLegacyProviderRecovery(tx)
            else yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
            if (upgrade) {
              yield* DatabaseUpgradeRun.recordReceipt(
                tx,
                {
                  runId: upgrade.run.runId,
                  migrationId: migration.id,
                  contentHash: DatabaseUpgradeRun.migrationContentHash(migration),
                  bodyHash: DatabaseUpgradeRun.migrationBodyHash(migration),
                  ordinal: input.indexOf(migration) + 1,
                  buildIdentity: upgrade.opts.buildIdentity ?? InstallationCommit ?? "local-build",
                  packageVersion: upgrade.opts.packageVersion ?? InstallationVersion,
                  result: "applied",
                  startedAt,
                  completedAt: Date.now(),
                },
                upgrade.lease,
              )
            }
          }),
        )
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit)) return Effect.succeed(undefined)
            if (isTransientLockCause(exit.cause)) return Effect.fail(new TransientLock({ detail: migration.id }))
            return Effect.failCause(exit.cause)
          }),
          Effect.retry({ while: (error) => error instanceof TransientLock, schedule: transientLockRetry }),
          Effect.exit,
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit)) return Effect.succeed(undefined)
            if (exit.cause.reasons.some((reason) => reason instanceof TransientLock))
              return Effect.die(
                new Error(
                  `database migration ${migration.id} was blocked by another connection for 60s; close other DeepAgent Code windows and restart`,
                ),
              )
            return Effect.failCause(exit.cause)
          }),
        )
    }
  })
}

function reconcileLegacyProviderRecovery(tx: Transaction) {
  return Effect.gen(function* () {
    const receiptColumns = new Set(
      (yield* tx.all<{ name: string }>("PRAGMA table_info(session_tool_request_receipt)")).map((column) => column.name),
    )
    const requiredReceiptColumns = [
      "owner_token",
      "context_selection_id",
      "prepared_turn_hash",
      "wire_request_hash",
      "tool_result_reference_ids",
    ]
    const missingReceiptColumns = requiredReceiptColumns.filter((column) => !receiptColumns.has(column))
    if (missingReceiptColumns.length > 0)
      return yield* Effect.die(
        new Error(
          `merged migration history cannot reconcile legacy provider authority: missing current receipt columns ${missingReceiptColumns.join(", ")}`,
        ),
      )

    const promptEpochColumns = new Set(
      (yield* tx.all<{ name: string }>("PRAGMA table_info(session_prompt_epoch)")).map((column) => column.name),
    )
    if (!promptEpochColumns.has("recovery_resolution_id"))
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN recovery_resolution_id TEXT")

    const promptEpochMessageExists = yield* tx.get<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'session_prompt_epoch_message'
    `)
    if (!promptEpochMessageExists) {
      yield* tx.run(`
        UPDATE session_prompt_epoch
        SET authority_state = 'recovery_required',
            recovery_reason = COALESCE(recovery_reason, 'merge_lineage_prompt_epoch_membership_missing')
      `)
      yield* tx.run(`
        INSERT INTO session_history_state(session_id, state, reason, time_created, time_updated)
        SELECT session_id, 'recovery_required',
          'merge_lineage_prompt_epoch_membership_missing', ${Date.now()}, ${Date.now()}
        FROM session_prompt_epoch
        GROUP BY session_id
        ON CONFLICT(session_id) DO UPDATE SET
          state = 'recovery_required',
          reason = excluded.reason,
          time_updated = excluded.time_updated
      `)
    }

    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS session_prompt_epoch_message (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        prompt_epoch INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
        PRIMARY KEY (session_id, prompt_epoch, ordinal),
        UNIQUE (session_id, prompt_epoch, message_id),
        FOREIGN KEY (session_id, prompt_epoch)
          REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE
      )
    `)
    yield* tx.run(`
      CREATE INDEX IF NOT EXISTS session_prompt_epoch_message_lookup_idx
      ON session_prompt_epoch_message(session_id, prompt_epoch, message_id)
    `)
    yield* tx.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_prompt_epoch_recovery_resolution_idx
      ON session_prompt_epoch(recovery_resolution_id)
      WHERE recovery_resolution_id IS NOT NULL
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_message_validate_insert
      BEFORE INSERT ON session_prompt_epoch_message
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM session_prompt_epoch
          WHERE session_id = NEW.session_id AND epoch = NEW.prompt_epoch
        ) THEN RAISE(ABORT, 'prompt_epoch_message_epoch_missing') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
        ) THEN RAISE(ABORT, 'prompt_epoch_message_cross_session') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_message_validate_update
      BEFORE UPDATE ON session_prompt_epoch_message
      BEGIN
        SELECT CASE WHEN NEW.session_id IS NOT OLD.session_id OR
          NEW.prompt_epoch IS NOT OLD.prompt_epoch OR NEW.ordinal IS NOT OLD.ordinal OR
          NEW.message_id IS NOT OLD.message_id
        THEN RAISE(ABORT, 'prompt_epoch_message_binding_immutable') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_message_owner_immutable
      BEFORE UPDATE OF session_id ON message
      WHEN EXISTS (
        SELECT 1 FROM session_prompt_epoch
        WHERE checkpoint_user_id = OLD.id OR checkpoint_assistant_id = OLD.id OR
          retained_tail_start_id = OLD.id OR source_end_message_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'prompt_epoch_referenced_message_owner_immutable');
      END
    `)

    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS session_tool_request_resolution_command (
        command_id TEXT NOT NULL PRIMARY KEY,
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        receipt_id TEXT NOT NULL REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
        result_resolution_id TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    yield* tx.run(`
      CREATE INDEX IF NOT EXISTS session_tool_request_resolution_command_session_idx
      ON session_tool_request_resolution_command(session_id, created_at)
    `)
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS session_tool_request_resolution (
        resolution_id TEXT NOT NULL PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        legacy_activity_id TEXT,
        assistant_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
        source_prompt_epoch INTEGER NOT NULL,
        source_window_id TEXT NOT NULL,
        source_effective_history_hash TEXT NOT NULL,
        source_request_hash TEXT NOT NULL,
        source_mutation_epoch INTEGER NOT NULL,
        expected_provider_state TEXT NOT NULL CHECK (expected_provider_state = 'indeterminate_after_crash'),
        decision TEXT NOT NULL CHECK (decision = 'abandoned'),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'administrator', 'system-verifier')),
        actor_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
        risk_acknowledged INTEGER NOT NULL CHECK (risk_acknowledged = 0),
        safe_end_message_id TEXT REFERENCES message(id) ON DELETE RESTRICT,
        safe_history_hash TEXT NOT NULL,
        safe_message_ids TEXT NOT NULL,
        ambiguity_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
        physical_message_high_water TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
        successor_prompt_epoch INTEGER NOT NULL,
        successor_window_id TEXT NOT NULL,
        successor_history_hash TEXT NOT NULL,
        successor_mutation_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id, source_prompt_epoch)
          REFERENCES session_prompt_epoch(session_id, epoch)
      )
    `)
    yield* tx.run(`
      CREATE INDEX IF NOT EXISTS session_tool_request_resolution_session_idx
      ON session_tool_request_resolution(session_id, created_at)
    `)
    yield* tx.run(`
      CREATE TABLE IF NOT EXISTS session_prompt_epoch_recovery (
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        prompt_epoch INTEGER NOT NULL,
        resolution_id TEXT NOT NULL UNIQUE,
        source_prompt_epoch INTEGER NOT NULL,
        source_mutation_epoch INTEGER NOT NULL,
        successor_mutation_epoch INTEGER NOT NULL,
        ambiguity_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
        physical_message_high_water TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, prompt_epoch),
        FOREIGN KEY (session_id, prompt_epoch)
          REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE,
        FOREIGN KEY (session_id, source_prompt_epoch)
          REFERENCES session_prompt_epoch(session_id, epoch),
        FOREIGN KEY (resolution_id)
          REFERENCES session_tool_request_resolution(resolution_id)
      )
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_validate_insert
      BEFORE INSERT ON session_tool_request_resolution
      BEGIN
        SELECT RAISE(ABORT, 'merged provider recovery authority is not installed');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_command_validate_insert
      BEFORE INSERT ON session_tool_request_resolution_command
      BEGIN
        SELECT CASE WHEN NEW.result_resolution_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM session_tool_request_resolution resolution
          WHERE resolution.resolution_id = NEW.result_resolution_id
            AND resolution.session_id = NEW.session_id
            AND resolution.receipt_id = NEW.receipt_id
        ) THEN RAISE(ABORT, 'legacy_provider_resolution_command_result_invalid') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_immutable_update
      BEFORE UPDATE ON session_tool_request_resolution
      BEGIN
        SELECT RAISE(ABORT, 'legacy_provider_resolution_immutable');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_immutable_delete
      BEFORE DELETE ON session_tool_request_resolution
      WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'legacy_provider_resolution_immutable');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_command_immutable_update
      BEFORE UPDATE ON session_tool_request_resolution_command
      BEGIN
        SELECT CASE WHEN OLD.result_resolution_id IS NOT NULL OR
          NEW.command_id IS NOT OLD.command_id OR NEW.request_hash IS NOT OLD.request_hash OR
          NEW.session_id IS NOT OLD.session_id OR NEW.receipt_id IS NOT OLD.receipt_id OR
          NEW.created_at IS NOT OLD.created_at OR NEW.result_resolution_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.result_resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.receipt_id = NEW.receipt_id
          )
        THEN RAISE(ABORT, 'legacy_provider_resolution_command_immutable') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_resolution_command_immutable_delete
      BEFORE DELETE ON session_tool_request_resolution_command
      WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'legacy_provider_resolution_command_immutable');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_recovery_validate_insert
      BEFORE INSERT ON session_prompt_epoch_recovery
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM session_prompt_epoch successor
          WHERE successor.session_id = NEW.session_id
            AND successor.epoch = NEW.prompt_epoch
            AND successor.reason = 'recovery'
            AND successor.authority_state = 'ready'
            AND successor.recovery_resolution_id = NEW.resolution_id
            AND successor.source_end_message_id = NEW.physical_message_high_water
        ) THEN RAISE(ABORT, 'prompt_epoch_recovery_successor_invalid') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM session_prompt_epoch source
          WHERE source.session_id = NEW.session_id
            AND source.epoch = NEW.source_prompt_epoch
            AND source.state = 'retired'
            AND source.authority_state = 'recovery_required'
        ) THEN RAISE(ABORT, 'prompt_epoch_recovery_source_invalid') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM session_tool_request_resolution resolution
          WHERE resolution.resolution_id = NEW.resolution_id
            AND resolution.session_id = NEW.session_id
            AND resolution.source_prompt_epoch = NEW.source_prompt_epoch
            AND resolution.source_mutation_epoch = NEW.source_mutation_epoch
        ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_source_invalid') END;
        SELECT CASE WHEN NEW.successor_mutation_epoch != NEW.source_mutation_epoch + 1
          THEN RAISE(ABORT, 'prompt_epoch_recovery_mutation_epoch_invalid') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_recovery_immutable_update
      BEFORE UPDATE ON session_prompt_epoch_recovery
      BEGIN
        SELECT RAISE(ABORT, 'prompt_epoch_recovery_binding_immutable');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_recovery_immutable_delete
      BEFORE DELETE ON session_prompt_epoch_recovery
      WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
      BEGIN
        SELECT RAISE(ABORT, 'prompt_epoch_recovery_binding_immutable');
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_recovery_binding_guard
      BEFORE INSERT ON session_prompt_epoch
      WHEN NEW.recovery_resolution_id IS NOT NULL OR NEW.reason = 'recovery'
      BEGIN
        SELECT CASE WHEN NEW.authority_state != 'ready' OR NEW.recovery_resolution_id IS NULL OR
          NEW.reason != 'recovery' OR NEW.checkpoint_user_id IS NOT NULL OR
          NEW.checkpoint_assistant_id IS NOT NULL OR NEW.retained_tail_start_id IS NOT NULL
        THEN RAISE(ABORT, 'prompt_epoch_recovery_binding_invalid') END;
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM session_tool_request_resolution resolution
          WHERE resolution.resolution_id = NEW.recovery_resolution_id
            AND resolution.session_id = NEW.session_id
            AND resolution.successor_prompt_epoch = NEW.epoch
        ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_invalid') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_prompt_epoch_recovery_binding_update_guard
      BEFORE UPDATE ON session_prompt_epoch
      WHEN NEW.recovery_resolution_id IS NOT OLD.recovery_resolution_id OR NEW.reason = 'recovery'
      BEGIN
        SELECT CASE WHEN OLD.authority_state = 'ready' AND
          NEW.recovery_resolution_id IS NOT OLD.recovery_resolution_id
        THEN RAISE(ABORT, 'prompt_epoch_ready_binding_immutable') END;
        SELECT CASE WHEN NEW.reason = 'recovery' AND (
          NEW.authority_state != 'ready' OR NEW.recovery_resolution_id IS NULL
        ) THEN RAISE(ABORT, 'prompt_epoch_recovery_binding_invalid') END;
      END
    `)
    yield* tx.run(`
      CREATE TRIGGER IF NOT EXISTS session_tool_request_receipt_parent_cleanup
      AFTER DELETE ON session
      BEGIN
        DELETE FROM session_tool_request_receipt WHERE session_id = OLD.id;
      END
    `)
  })
}
