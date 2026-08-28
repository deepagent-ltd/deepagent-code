import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { Effect } from "effect"

// Shared test fixture for the backup/restore surface. All fixtures are isolated temp databases;
// no production DB, no real data directory, no provider keys, no network.

export const sha256 = (input: Uint8Array) => createHash("sha256").update(input).digest("hex")

export const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

// Builds a fixture that mirrors the production authority tables: migration journal, capability
// table, session table, and a scratch table used to prove WAL content is captured. The returned
// live connection is left open in WAL mode so a backup runs against a WAL-active database.
export const makeFixture = (filename: string) => {
  const db = new Database(filename, { create: true })
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  db.exec("INSERT INTO migration VALUES ('20260813134000_database_capability', 1)")
  db.exec("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER, installed_at INTEGER)")
  db.exec("INSERT INTO database_capability VALUES ('bounded_event_snapshot_v1', 2, 2, 1)")
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, name TEXT)")
  db.exec("INSERT INTO session VALUES ('s-1', 'hello')")
  db.exec("CREATE TABLE test_backup_probe (value TEXT)")
  db.exec("INSERT INTO test_backup_probe VALUES ('captured-from-wal')")
  return db
}