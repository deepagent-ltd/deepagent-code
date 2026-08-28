export * as DatabaseUpgradeRun from "./upgrade-run"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import type { Migration } from "./migration"
import { contentDigest } from "../contract/digest"
import {
  UpgradeRun,
  MigrationReceipt,
  UpgradeRunVersion,
  MigrationCompletion,
  type UpgradeRunState,
  type SchemaProtocolVersion,
  canTransition,
  migrationReceiptContentAddress,
  InvalidTransitionError,
  SkipMigrationError,
} from "../contract/upgrade-run"
import { DatabaseMigrationLease as MigrationLease, type MigrationLease as MigrationLeaseHandle } from "./migration-lease"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

// Runtime protocol this migration path upgrades toward. Kept literal here to avoid a
// circular import with database.ts (database.ts -> migration.ts -> upgrade-run.ts); the
// database.ts SupportedReaderProtocol / SupportedWriterProtocol are the source of truth and
// are passed down through apply() options for the running process.
export const RuntimeReaderProtocol = "3"
export const RuntimeWriterProtocol = "3"

export class RunNotFound extends Error {
  readonly _tag = "UpgradeRun.RunNotFound"
  constructor(readonly runId: string) {
    super(`database upgrade run not found: ${runId}`)
  }
}

/**
 * Deterministic failure reasons for a resume that cannot be proven safe (design §10.5:
 * "重启读取 upgrade run，从最后一个已验证 receipt forward resume"). Each divergence is typed and
 * routes the run to recovery_required rather than silently skipping it. `old_binary_protocol_unsupported`
 * is intentionally NOT in this set: the old-binary fence is a non-mutating refusal, not a recovery.
 */
export type ResumeFailureCode =
  | "stale_run_target_digest"
  | "resume_receipt_without_journal"
  | "resume_journal_without_receipt"
  | "resume_receipt_content_mismatch"
  | "resume_receipt_ordinal_mismatch"
  | "resume_receipt_unknown_migration"
  | "resume_receipt_failed_result"

/** Typed, deterministic failure used to route a divergent active run to recovery_required. */
export class ResumeValidationError extends Error {
  readonly _tag = "UpgradeRun.ResumeValidationError"
  readonly code: ResumeFailureCode
  readonly detail: string
  constructor(input: { code: ResumeFailureCode; detail: string }) {
    super(`database upgrade run resume validation failed (${input.code}): ${input.detail}`)
    this.code = input.code
    this.detail = input.detail
  }
}

/**
 * Non-mutating refusal when the active run targets a reader/writer protocol the running binary
 * does not support. Distinct from {@link ResumeValidationError}: the run is left untouched (no
 * recovery_required write) because the binary simply cannot proceed; a capable binary must resume it.
 */
export class OldBinaryFenceError extends Error {
  readonly _tag = "UpgradeRun.OldBinaryFence"
  constructor(readonly detail: string) {
    super(`database upgrade run requires a newer binary: ${detail}`)
  }
}

export class RunAlreadyTerminal extends Error {
  readonly _tag = "UpgradeRun.RunAlreadyTerminal"
  constructor(readonly runId: string, readonly state: UpgradeRunState) {
    super(`database upgrade run ${runId} is already terminal in state ${state}`)
  }
}

export type BeginRunInput = {
  sourceRegistryDigest: string
  targetRegistryDigest: string
  sourceProtocol: SchemaProtocolVersion
  targetProtocol: SchemaProtocolVersion
  buildIdentity: string
  packageVersion: string
  backupManifestRef?: string
  pendingMigrationIds: string[]
  totalMigrations: number
}

export type ReceiptInput = {
  runId: string
  migrationId: string
  contentHash: string
  bodyHash: string
  ordinal: number
  buildIdentity: string
  packageVersion: string
  result: MigrationCompletion
  startedAt: number
  completedAt: number
}

type RunRow = {
  run_id: string
  schema_version: string
  source_registry_digest: string
  target_registry_digest: string
  source_reader_protocol: string
  source_writer_protocol: string
  target_reader_protocol: string
  target_writer_protocol: string
  build_identity: string
  package_version: string
  backup_manifest_ref: string | null
  pending_migration_ids: string
  state: string
  failure_code: string | null
  applied_ordinal: number
  total_migrations: number
  started_at: number
  completed_at: number
}

/** Shape of a `database_migration_receipt` row (the resume source of truth, design §10.5). */
export type ReceiptRow = {
  receipt_id: string
  migration_id: string
  content_hash: string
  ordinal: number
  run_id: string
  result: string
  started_at: number
  completed_at: number
}

/** Byte-stable content/body hash of a migration, computed from its body source. */
export function migrationBodyHash(migration: Migration): string {
  return contentDigest({ kind: "migration-body", id: migration.id, source: migration.up.toString() })
}

/** Byte-stable content hash of a migration (id + body hash). */
export function migrationContentHash(migration: Migration): string {
  return contentDigest({ kind: "migration-content", id: migration.id, bodyHash: migrationBodyHash(migration) })
}

/** Byte-stable digest of an ordered migration registry (ids + content hashes). */
export function registryDigest(input: Migration[]): string {
  return contentDigest(input.map((migration) => ({ id: migration.id, contentHash: migrationContentHash(migration) })))
}

/** Ensure the upgrade-run + receipt tables and their invariants exist. */
export function ensureTables(db: Database) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS database_upgrade_run (
        run_id TEXT NOT NULL PRIMARY KEY,
        schema_version TEXT NOT NULL,
        source_registry_digest TEXT NOT NULL,
        target_registry_digest TEXT NOT NULL,
        source_reader_protocol TEXT NOT NULL,
        source_writer_protocol TEXT NOT NULL,
        target_reader_protocol TEXT NOT NULL,
        target_writer_protocol TEXT NOT NULL,
        build_identity TEXT NOT NULL,
        package_version TEXT NOT NULL,
        backup_manifest_ref TEXT,
        pending_migration_ids TEXT NOT NULL,
        state TEXT NOT NULL,
        failure_code TEXT,
        applied_ordinal INTEGER NOT NULL,
        total_migrations INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        CHECK (state IN ('planned', 'backup_verified', 'applying', 'verifying', 'ready', 'recovery_required'))
      )
    `)
    yield* db.run(sql`
      CREATE TABLE IF NOT EXISTS database_migration_receipt (
        receipt_id TEXT NOT NULL PRIMARY KEY,
        schema_version TEXT NOT NULL,
        migration_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        build_identity TEXT NOT NULL,
        package_version TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        run_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('applied', 'backfilled', 'verify_failed', 'rolled_back')),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
        FOREIGN KEY (run_id) REFERENCES database_upgrade_run(run_id),
        UNIQUE (run_id, migration_id, ordinal),
        UNIQUE (run_id, content_hash)
      )
    `)
    yield* db.run(sql`
      CREATE INDEX IF NOT EXISTS database_migration_receipt_run_idx
      ON database_migration_receipt(run_id)
    `)
    // Statically enforce the frozen ALLOWED_TRANSITIONS at the storage layer (design §10.5):
    // a transition that is not permitted, or a write to a terminal state, aborts.
    yield* db.run(sql`
      CREATE TRIGGER IF NOT EXISTS database_upgrade_run_transition_guard
      BEFORE UPDATE OF state ON database_upgrade_run
      WHEN OLD.state <> NEW.state
      BEGIN
        SELECT CASE
          WHEN OLD.state = 'planned' AND NEW.state <> 'backup_verified'
            THEN RAISE(ABORT, 'upgrade_run_illegal_transition')
          WHEN OLD.state = 'backup_verified' AND NEW.state NOT IN ('applying', 'recovery_required')
            THEN RAISE(ABORT, 'upgrade_run_illegal_transition')
          WHEN OLD.state = 'applying' AND NEW.state NOT IN ('verifying', 'recovery_required')
            THEN RAISE(ABORT, 'upgrade_run_illegal_transition')
          WHEN OLD.state = 'verifying' AND NEW.state NOT IN ('ready', 'recovery_required')
            THEN RAISE(ABORT, 'upgrade_run_illegal_transition')
          WHEN OLD.state IN ('ready', 'recovery_required')
            THEN RAISE(ABORT, 'upgrade_run_terminal_state_immutable')
        END;
      END
    `)
    // Receipts are append-only once written (content-addressed identity is immutable).
    yield* db.run(sql`
      CREATE TRIGGER IF NOT EXISTS database_migration_receipt_immutable
      BEFORE UPDATE ON database_migration_receipt
      BEGIN
        SELECT RAISE(ABORT, 'database_migration_receipt_immutable');
      END
    `)
  })
}

function toContract(row: RunRow): UpgradeRun {
  return new UpgradeRun({
    schemaVersion: row.schema_version as typeof UpgradeRunVersion.run,
    runId: row.run_id,
    sourceRegistryDigest: row.source_registry_digest,
    targetRegistryDigest: row.target_registry_digest,
    sourceProtocol: { reader: row.source_reader_protocol, writer: row.source_writer_protocol },
    targetProtocol: { reader: row.target_reader_protocol, writer: row.target_writer_protocol },
    buildIdentity: row.build_identity,
    packageVersion: row.package_version,
    backupManifestRef: row.backup_manifest_ref ?? undefined,
    pendingMigrationIds: JSON.parse(row.pending_migration_ids) as string[],
    state: row.state as UpgradeRunState,
    failureCode: row.failure_code ?? undefined,
    appliedOrdinal: row.applied_ordinal,
    totalMigrations: row.total_migrations,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  })
}

/** Begin a new upgrade run in the `planned` state. */
export function beginRun(db: Database, input: BeginRunInput): Effect.Effect<UpgradeRun> {
  return Effect.gen(function* () {
    const runId = crypto.randomUUID()
    const now = Date.now()
    yield* db.run(sql`
      INSERT INTO database_upgrade_run (
        run_id, schema_version, source_registry_digest, target_registry_digest,
        source_reader_protocol, source_writer_protocol, target_reader_protocol, target_writer_protocol,
        build_identity, package_version, backup_manifest_ref, pending_migration_ids, state,
        failure_code, applied_ordinal, total_migrations, started_at, completed_at
      ) VALUES (
        ${runId}, ${UpgradeRunVersion.run}, ${input.sourceRegistryDigest}, ${input.targetRegistryDigest},
        ${input.sourceProtocol.reader}, ${input.sourceProtocol.writer}, ${input.targetProtocol.reader}, ${input.targetProtocol.writer},
        ${input.buildIdentity}, ${input.packageVersion}, ${input.backupManifestRef ?? null},
        ${JSON.stringify(input.pendingMigrationIds)}, 'planned', NULL, 0, ${input.totalMigrations}, ${now}, 0
      )
    `).pipe(Effect.orDie)
    const row = yield* db.get<RunRow>(sql`SELECT * FROM database_upgrade_run WHERE run_id = ${runId}`).pipe(Effect.orDie)
    if (!row) return yield* Effect.die(new Error(`failed to read upgrade run ${runId}`))
    return toContract(row)
  })
}

/** Load an upgrade run by id. */
export function loadRun(db: Database, runId: string): Effect.Effect<UpgradeRun | undefined> {
  return Effect.gen(function* () {
    const row = yield* db.get<RunRow>(sql`SELECT * FROM database_upgrade_run WHERE run_id = ${runId}`).pipe(Effect.orDie)
    return row === undefined ? undefined : toContract(row)
  })
}

/** The most recent (highest started_at) active run, or undefined if none is active. */
export function loadActiveRun(db: Database): Effect.Effect<UpgradeRun | undefined> {
  return Effect.gen(function* () {
    const row = yield* db.get<RunRow>(sql`
      SELECT * FROM database_upgrade_run
      WHERE state IN ('planned', 'backup_verified', 'applying', 'verifying')
      ORDER BY started_at DESC LIMIT 1
    `).pipe(Effect.orDie)
    return row === undefined ? undefined : toContract(row)
  })
}

/**
 * All receipts recorded under a run, ordered by ordinal. The resume source of truth (design §10.5):
 * a prior crash must resume from the last VERIFIED receipt, not the legacy `migration` journal alone.
 */
export function loadReceiptsForRun(db: Database, runId: string): Effect.Effect<ReceiptRow[]> {
  return Effect.gen(function* () {
    return yield* db.all<ReceiptRow>(sql`
      SELECT receipt_id, migration_id, content_hash, ordinal, run_id, result, started_at, completed_at
      FROM database_migration_receipt
      WHERE run_id = ${runId}
      ORDER BY ordinal ASC
    `).pipe(Effect.orDie)
  })
}

/**
 * Advance a run to `to`, enforcing the frozen ALLOWED_TRANSITIONS (code + storage trigger).
 * Idempotent: advancing to the state the run is already in is a no-op. A terminal run cannot
 * be advanced (RunAlreadyTerminal).
 */
export function advanceRun(db: Database, runId: string, to: UpgradeRunState) {
  return Effect.gen(function* () {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx.get<RunRow>(sql`SELECT * FROM database_upgrade_run WHERE run_id = ${runId}`).pipe(Effect.orDie)
        if (!row) return yield* Effect.fail(new RunNotFound(runId))
        const from = row.state as UpgradeRunState
        if (from === to) return yield* Effect.void
        if (from === "ready" || from === "recovery_required")
          return yield* Effect.fail(new RunAlreadyTerminal(runId, from))
        if (!canTransition(from, to)) return yield* Effect.fail(new InvalidTransitionError({ from, to }))
        const now = Date.now()
        yield* tx.run(sql`
          UPDATE database_upgrade_run
          SET state = ${to},
              completed_at = CASE WHEN ${to} = 'ready' THEN ${now} ELSE completed_at END,
              failure_code = CASE WHEN ${to} = 'recovery_required' THEN COALESCE(failure_code, 'upgrade_run_explicit_recovery') ELSE failure_code END
          WHERE run_id = ${runId}
        `).pipe(Effect.orDie)
      }),
    )
  })
}

/** Mark a run as recovery_required with a stable failure code (idempotent for terminal runs). */
export function failRun(db: Database, runId: string, failureCode: string) {
  return Effect.gen(function* () {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx.get<RunRow>(sql`SELECT * FROM database_upgrade_run WHERE run_id = ${runId}`).pipe(Effect.orDie)
        if (!row) return yield* Effect.fail(new RunNotFound(runId))
        const from = row.state as UpgradeRunState
        if (from === "recovery_required") return yield* Effect.void
        if (from === "ready") {
          // A completed run is immutable; do not rewrite a successful run into recovery.
          return yield* Effect.fail(new RunAlreadyTerminal(runId, from))
        }
        if (!canTransition(from, "recovery_required"))
          return yield* Effect.fail(new InvalidTransitionError({ from, to: "recovery_required" }))
        yield* tx.run(sql`
          UPDATE database_upgrade_run
          SET state = 'recovery_required', failure_code = ${failureCode}
          WHERE run_id = ${runId}
        `).pipe(Effect.orDie)
      }),
    )
  })
}

/**
 * Record a content-addressed receipt for a migration. Must run inside the SAME transaction that
 * applied the migration body, so a migration is either fully applied with its receipt or neither
 * (design §10.5 "每个 migration body 与 receipt 同事务"). Validates the migration lease within the
 * transaction, so a stale lease token cannot commit a receipt.
 */
export function recordReceipt(
  tx: Transaction,
  input: ReceiptInput,
  lease?: MigrationLeaseHandle,
): Effect.Effect<void, SkipMigrationError | InvalidTransitionError | MigrationLease.LeaseLost> {
  return Effect.gen(function* () {
    const receipt = new MigrationReceipt({
      schemaVersion: UpgradeRunVersion.receipt,
      receiptId: "", // filled below by content addressing
      migrationId: input.migrationId,
      contentHash: input.contentHash,
      ordinal: input.ordinal,
      buildIdentity: input.buildIdentity,
      packageVersion: input.packageVersion,
      bodyHash: input.bodyHash,
      runId: input.runId,
      result: input.result,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    })
    const skipped =
      receipt.result !== "verify_failed" &&
      receipt.result !== "rolled_back" &&
      (receipt.contentHash.trim() === "" ||
        receipt.bodyHash.trim() === "" ||
        receipt.migrationId.trim() === "" ||
        receipt.runId.trim() === "" ||
        receipt.ordinal < 1)
    if (skipped)
      return yield* Effect.fail(new SkipMigrationError({ reason: "migration_receipt_missing_content_identity" }))
    if (lease) yield* MigrationLease.assertCurrent(tx, lease)
    const receiptId = migrationReceiptContentAddress(receipt)
    yield* tx.run(sql`
      INSERT INTO database_migration_receipt (
        receipt_id, schema_version, migration_id, content_hash, ordinal, build_identity,
        package_version, body_hash, run_id, result, started_at, completed_at
      ) VALUES (
        ${receiptId}, ${receipt.schemaVersion}, ${receipt.migrationId}, ${receipt.contentHash},
        ${receipt.ordinal}, ${receipt.buildIdentity}, ${receipt.packageVersion}, ${receipt.bodyHash},
        ${receipt.runId}, ${receipt.result}, ${receipt.startedAt}, ${receipt.completedAt}
      )
    `).pipe(Effect.orDie)
    yield* tx.run(sql`
      UPDATE database_upgrade_run
      SET applied_ordinal = MAX(applied_ordinal, ${input.ordinal})
      WHERE run_id = ${input.runId}
    `).pipe(Effect.orDie)
  })
}

/** Build the canonical content-address for a receipt (exposed for tests). */
export function receiptContentAddress(input: Omit<ReceiptInput, "startedAt" | "completedAt" | "result"> & {
  result: MigrationCompletion
  startedAt: number
  completedAt: number
}): string {
  const receipt = new MigrationReceipt({
    schemaVersion: UpgradeRunVersion.receipt,
    receiptId: "",
    migrationId: input.migrationId,
    contentHash: input.contentHash,
    ordinal: input.ordinal,
    buildIdentity: input.buildIdentity,
    packageVersion: input.packageVersion,
    bodyHash: input.bodyHash,
    runId: input.runId,
    result: input.result,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  })
  return migrationReceiptContentAddress(receipt)
}
