/**
 * BUG-405-003 residual P1: fold `awaiting_confirmation` and `selected` into the durable
 * session_intent state contract (docs/bug-405-003.md §12.1).
 *
 * state = preparing | awaiting_confirmation | selected | admitting |
 *         admitted | canceled | superseded | failed
 *
 * SQLite cannot alter a CHECK constraint in place, so session_intent must be rebuilt.
 * session_activity_admission.legacy_intent_id references session_intent, and with
 * PRAGMA foreign_keys enabled (runtime connection) dropping the parent table performs an
 * implicit DELETE that fails on the referencing admission rows. The whole legacy activity
 * chain (admission -> legacy_activity -> {admission membership, progress, run, terminal,
 * migration receipt}) is therefore detached into temp backups first — the same strategy
 * used by 20260812120000_legacy_provider_recovery — then rebuilt and restored verbatim.
 *
 * The detached tables are recreated from their captured sqlite_master definitions (not
 * hardcoded final shapes) because merged-lineage histories can reach this migration before
 * 20260812120000/20260812130000 are applied; later authorities must still find the exact
 * shapes they expect to ALTER or rebuild. Triggers are recreated after the data restore so
 * restore statements cannot fire validation or projection side effects (e.g. duplicate
 * session_activity_objective rows).
 */

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const LEGACY_STATE_CHECK =
  "CHECK (state IN ('preparing', 'admitting', 'admitted', 'canceled', 'superseded', 'failed'))"
const WIDENED_STATE_CHECK =
  "CHECK (state IN ('preparing', 'awaiting_confirmation', 'selected', 'admitting', 'admitted', 'canceled', 'superseded', 'failed'))"

export default {
  id: "20260819120000_session_intent_confirmation_state",
  up(tx) {
    return Effect.gen(function* () {
      const has = (table: string) =>
        Effect.gen(function* () {
          return Boolean(
            yield* tx.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`),
          )
        })
      const ddlOf = (type: string, name: string) =>
        Effect.gen(function* () {
          const row = yield* tx.get<{ sql: string }>(
            `SELECT sql FROM sqlite_master WHERE type = '${type}' AND name = '${name}'`,
          )
          return row!.sql
        })

      const hasAdmission = yield* has("session_activity_admission")
      const hasLegacyActivity = yield* has("session_legacy_activity")
      const hasAdmissionJoin = yield* has("session_legacy_activity_admission")
      const hasProgress = yield* has("session_activity_progress")
      const hasRun = yield* has("session_legacy_activity_run")
      const hasTerminal = yield* has("session_legacy_activity_terminal")
      const hasMigrationReceipt = yield* has("session_legacy_activity_migration_receipt")

      // Merged-lineage histories may not have applied the execution-identity expansion yet.
      const intentColumns = yield* tx.all<{ name: string }>(`PRAGMA table_info(session_intent)`)
      const hasExecutionColumns = intentColumns.some((column) => column.name === "execution_mode")
      const intentDDL = yield* ddlOf("table", "session_intent")
      const intentIndexes = yield* tx.all<{ sql: string }>(`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'session_intent'
          AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      `)

      // Captured current shapes of the detached chain (recreated verbatim later).
      const chainTables: Array<{ name: string; sql: string }> = []
      if (hasAdmission) chainTables.push({ name: "session_activity_admission", sql: yield* ddlOf("table", "session_activity_admission") })
      if (hasLegacyActivity) chainTables.push({ name: "session_legacy_activity", sql: yield* ddlOf("table", "session_legacy_activity") })
      if (hasAdmissionJoin) chainTables.push({ name: "session_legacy_activity_admission", sql: yield* ddlOf("table", "session_legacy_activity_admission") })
      if (hasProgress) chainTables.push({ name: "session_activity_progress", sql: yield* ddlOf("table", "session_activity_progress") })
      if (hasRun) chainTables.push({ name: "session_legacy_activity_run", sql: yield* ddlOf("table", "session_legacy_activity_run") })
      if (hasTerminal) chainTables.push({ name: "session_legacy_activity_terminal", sql: yield* ddlOf("table", "session_legacy_activity_terminal") })
      if (hasMigrationReceipt) chainTables.push({ name: "session_legacy_activity_migration_receipt", sql: yield* ddlOf("table", "session_legacy_activity_migration_receipt") })
      const chainTableNames = chainTables.map((table) => `'${table.name}'`).join(", ")
      const chainIndexes = chainTableNames.length
        ? yield* tx.all<{ tbl_name: string; sql: string }>(`
            SELECT tbl_name, sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name IN (${chainTableNames})
              AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          `)
        : []
      const chainTriggers = chainTableNames.length
        ? yield* tx.all<{ sql: string }>(`
            SELECT sql FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name IN (${chainTableNames}) AND sql IS NOT NULL
          `)
        : []

      // ── Detach the FK children of session_intent into transaction-local backups ──
      if (hasMigrationReceipt)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_migration_receipt AS
          SELECT * FROM session_legacy_activity_migration_receipt
        `)
      if (hasTerminal)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_terminal AS
          SELECT * FROM session_legacy_activity_terminal
        `)
      if (hasRun)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_run AS
          SELECT * FROM session_legacy_activity_run
        `)
      if (hasAdmissionJoin)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_admission_join AS
          SELECT * FROM session_legacy_activity_admission
        `)
      if (hasProgress)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_progress AS
          SELECT * FROM session_activity_progress
        `)
      if (hasLegacyActivity)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_activity AS
          SELECT * FROM session_legacy_activity
        `)
      if (hasAdmission)
        yield* tx.run(`
          CREATE TEMP TABLE intent_state_backup_admission AS
          SELECT * FROM session_activity_admission
        `)

      // Children first so each drop only removes rows of the table itself.
      if (hasMigrationReceipt) yield* tx.run(`DROP TABLE session_legacy_activity_migration_receipt`)
      if (hasTerminal) yield* tx.run(`DROP TABLE session_legacy_activity_terminal`)
      if (hasRun) yield* tx.run(`DROP TABLE session_legacy_activity_run`)
      if (hasAdmissionJoin) yield* tx.run(`DROP TABLE session_legacy_activity_admission`)
      if (hasProgress) yield* tx.run(`DROP TABLE session_activity_progress`)
      if (hasLegacyActivity) yield* tx.run(`DROP TABLE session_legacy_activity`)
      if (hasAdmission) yield* tx.run(`DROP TABLE session_activity_admission`)

      // ── Rebuild session_intent with the BUG-405-003 §12.1 state contract ──
      // Only the state CHECK changes; every other column definition is preserved verbatim so
      // histories lacking the execution-identity columns can still receive them later.
      const rebuiltDDL = intentDDL
        .replace("CREATE TABLE session_intent", "CREATE TABLE session_intent_rebuilt")
        .replace(LEGACY_STATE_CHECK, WIDENED_STATE_CHECK)
      yield* tx.run(rebuiltDDL)
      const columnNames = intentColumns.map((column) => column.name).join(", ")
      yield* tx.run(`
        INSERT INTO session_intent_rebuilt (${columnNames})
        SELECT ${columnNames} FROM session_intent
      `)
      yield* tx.run(`DROP TABLE session_intent`)
      // SQLite >= 3.25 rewrites referencing trigger/view bodies during RENAME when foreign_keys
      // is ON; triggers on OTHER tables (e.g. session_tool_request_resolution_validate_insert)
      // reference the still-dropped legacy chain at this point and make the rewrite fail
      // ("no such table: main.session_activity_progress"). The rename target is the same name as
      // the original table, so no reference rewrite is needed — use the legacy behavior for this
      // single statement. The desktop runtime (node:sqlite, SQLite 3.51) hits this; bun:sqlite's
      // older engine does not, which is why tests and bun-driven drills were green.
      yield* tx.run(`PRAGMA legacy_alter_table = ON`)
      yield* tx.run(`ALTER TABLE session_intent_rebuilt RENAME TO session_intent`)
      yield* tx.run(`PRAGMA legacy_alter_table = OFF`)
      for (const index of intentIndexes) yield* tx.run(index.sql)
      if (hasExecutionColumns) {
        yield* tx.run(`
          CREATE TRIGGER session_intent_execution_validate_insert
          BEFORE INSERT ON session_intent
          WHEN NOT (
            (NEW.execution_mode = 'legacy' AND NEW.execution_state = 'legacy'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'pending'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'claimed'
              AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
            (NEW.execution_mode = 'deferred' AND NEW.execution_state = 'absorbed'
              AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'canceled'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL)
          )
          BEGIN
            SELECT RAISE(ABORT, 'invalid session intent execution identity');
          END
        `)
        yield* tx.run(`
          CREATE TRIGGER session_intent_execution_validate_update
          BEFORE UPDATE ON session_intent
          WHEN NOT (
            (NEW.execution_mode = 'legacy' AND NEW.execution_state = 'legacy'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'pending'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'claimed'
              AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
            (NEW.execution_mode = 'deferred' AND NEW.execution_state = 'absorbed'
              AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
            (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'canceled'
              AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL)
          ) OR NOT (
            (NEW.execution_mode = OLD.execution_mode AND NEW.execution_state = OLD.execution_state
              AND NEW.execution_claim_id IS OLD.execution_claim_id
              AND NEW.execution_claimed_at IS OLD.execution_claimed_at) OR
            (OLD.execution_state = 'pending' AND NEW.execution_mode = OLD.execution_mode
              AND NEW.execution_state IN ('claimed','absorbed','canceled')) OR
            (OLD.execution_mode = 'legacy' AND OLD.execution_state = 'legacy'
              AND NEW.execution_mode IN ('run_now','deferred')
              AND NEW.execution_state IN ('pending','claimed','absorbed','canceled'))
          )
          BEGIN
            SELECT RAISE(ABORT, 'illegal session intent execution transition');
          END
        `)
      }

      // ── Recreate the detached chain with its captured definitions, then restore data ──
      // Each table's indexes are recreated immediately after the table itself: child tables
      // resolve FK parents through explicit unique indexes (e.g. terminal.operation_id), so
      // those indexes must exist before the referencing child CREATE TABLE is prepared.
      // Restores are positional (SELECT *) because the captured shapes may differ between
      // merged-lineage and full histories (e.g. execution_mode may not exist yet).
      for (const table of chainTables) {
        yield* tx.run(table.sql)
        for (const index of chainIndexes) if (index.tbl_name === table.name) yield* tx.run(index.sql)
      }
      if (hasAdmission)
        yield* tx.run(`INSERT INTO session_activity_admission SELECT * FROM intent_state_backup_admission`)
      if (hasLegacyActivity)
        yield* tx.run(`INSERT INTO session_legacy_activity SELECT * FROM intent_state_backup_activity`)
      if (hasAdmissionJoin)
        yield* tx.run(`INSERT INTO session_legacy_activity_admission SELECT * FROM intent_state_backup_admission_join`)
      if (hasProgress)
        yield* tx.run(`INSERT INTO session_activity_progress SELECT * FROM intent_state_backup_progress`)
      if (hasRun)
        yield* tx.run(`INSERT INTO session_legacy_activity_run SELECT * FROM intent_state_backup_run`)
      if (hasTerminal)
        yield* tx.run(`INSERT INTO session_legacy_activity_terminal SELECT * FROM intent_state_backup_terminal`)
      if (hasMigrationReceipt)
        yield* tx.run(
          `INSERT INTO session_legacy_activity_migration_receipt SELECT * FROM intent_state_backup_migration_receipt`,
        )

      // ── Recreate triggers only after the data restore so no validation or projection
      //    side effects fire for rows that already existed before this migration ──
      for (const trigger of chainTriggers) yield* tx.run(trigger.sql)

      // ── Drop the transaction-local backups ──
      if (hasMigrationReceipt) yield* tx.run(`DROP TABLE intent_state_backup_migration_receipt`)
      if (hasTerminal) yield* tx.run(`DROP TABLE intent_state_backup_terminal`)
      if (hasRun) yield* tx.run(`DROP TABLE intent_state_backup_run`)
      if (hasAdmissionJoin) yield* tx.run(`DROP TABLE intent_state_backup_admission_join`)
      if (hasProgress) yield* tx.run(`DROP TABLE intent_state_backup_progress`)
      if (hasLegacyActivity) yield* tx.run(`DROP TABLE intent_state_backup_activity`)
      if (hasAdmission) yield* tx.run(`DROP TABLE intent_state_backup_admission`)
    })
  },
} satisfies DatabaseMigration.Migration
