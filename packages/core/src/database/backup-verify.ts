export * as BackupVerify from "./backup-verify"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Data, Effect } from "effect"
import { Database } from "#sqlite-native"
import { SupportedReaderProtocol, SupportedWriterProtocol } from "./database"
import type { BackupManifest } from "./backup"

// §10.4 / §10.9 Automatic backup verification. A backup must be proven recoverable BEFORE any
// pending migration is applied: physical integrity, foreign-key integrity, journal/capability
// compatibility, and a reopen + application smoke. Any failure here means "do not migrate";
// the previous known-good backup is retained and the application stays in the maintenance shell.
// The backup is opened read-only on a fresh, independent connection — the live authority and the
// backup are never the same connection, so verification cannot perturb the live database.

export type VerifyErrorCode =
  | "manifest_invalid"
  | "file_missing"
  | "hash_mismatch"
  | "reopen_failed"
  | "integrity_check_failed"
  | "foreign_key_violation"
  | "app_smoke_failed"
  | "capability_mismatch"

export class BackupVerifyError extends Data.TaggedError("BackupVerify.BackupVerifyError")<{
  readonly code: VerifyErrorCode
  readonly detail: string
  readonly rows?: readonly Record<string, unknown>[]
}> {}

export interface BackupVerificationOk {
  readonly ok: true
  readonly quickCheck: string
  readonly foreignKeyCount: number
  readonly journalMode: string
  readonly synchronous: number
  readonly capabilityCompatible: true
  readonly capabilityCount: number
  readonly migrationCount: number
  readonly sqliteMasterCount: number
  readonly sessionCount: number | null
  readonly hashMatch: true
  readonly schemaDigestMatch: true
}

export interface BackupVerificationFailure {
  readonly ok: false
  readonly reason: VerifyErrorCode
  readonly detail: string
  readonly rows?: readonly Record<string, unknown>[]
}

export type BackupVerification = BackupVerificationOk | BackupVerificationFailure

const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

const fail = (
  reason: VerifyErrorCode,
  detail: string,
): BackupVerificationFailure => ({ ok: false, reason, detail })

export const verify = Effect.fn("BackupVerify.verify")(function* (manifest: BackupManifest) {
  if (
    typeof manifest?.backup?.filePath !== "string" ||
    typeof manifest?.backup?.sha256 !== "string" ||
    typeof manifest?.backup?.fileName !== "string" ||
    typeof manifest?.source?.schemaDigest !== "string"
  ) {
    return fail("manifest_invalid", "backup manifest is missing required identity fields")
  }

  const backupPath = path.resolve(manifest.backup.filePath)

  const fileStat = yield* Effect.tryPromise(() => fs.stat(backupPath)).pipe(Effect.orElseSucceed(() => null))
  if (fileStat === null || !fileStat.isFile()) {
    return fail("file_missing", `backup file does not exist: ${backupPath}`)
  }

  const bytes = yield* Effect.tryPromise(() => fs.readFile(backupPath)).pipe(Effect.orElseSucceed(() => null))
  if (bytes === null) {
    return fail("file_missing", `backup file cannot be read: ${backupPath}`)
  }
  const actualHash = sha256(bytes)
  if (actualHash !== manifest.backup.sha256) {
    return fail(
      "hash_mismatch",
      `backup content hash ${actualHash.slice(0, 16)}… does not match manifest ${manifest.backup.sha256.slice(0, 16)}…`,
    )
  }

  // Reopen the backup read-only on an independent connection; proof the snapshot is a valid,
  // openable SQLite database rather than a copied byte stream. This connection is READ-ONLY and
  // never writes the authority DB, so it keeps SQLite's default synchronous=FULL — a legitimate
  // read-only exemption from design §10.6 (it is at FULL, never NORMAL).
  const reload = yield* Effect.tryPromise(
    async () => new Database(backupPath, { create: false, readonly: true }),
  ).pipe(Effect.orElseSucceed(() => null))
  if (reload === null) {
    return fail("reopen_failed", `backup cannot be reopened read-only: ${backupPath}`)
  }

  try {
    // Design §10.6: verification/recovery connections must never be at NORMAL. bun:sqlite defaults a
    // fresh connection to synchronous=NORMAL, so force FULL (read-only here — no authority writes).
    reload.exec("PRAGMA synchronous = FULL")
    const quick = (reload.query("PRAGMA integrity_check").get() as { integrity_check: string } | undefined)?.integrity_check
    if (quick !== "ok") {
      return fail("integrity_check_failed", `PRAGMA integrity_check returned ${String(quick)}`)
    }

    const orphans = reload.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[]
    if (orphans.length > 0) {
      return fail("foreign_key_violation", `${orphans.length} orphaned foreign-key reference(s)`)
    }

    const journalMode = (reload.query("PRAGMA journal_mode").get() as { journal_mode: string } | undefined)?.journal_mode ?? "delete"
    const synchronous = (reload.query("PRAGMA synchronous").get() as { synchronous: number } | undefined)?.synchronous ?? 0
    if (journalMode === "off") {
      return fail("app_smoke_failed", `backup journal_mode is 'off'`)
    }

    // Capability check: every capability recorded in the backup must be readable by this runtime.
    const capabilityTable = reload
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_capability'")
      .get()
    let capabilityCount = 0
    if (capabilityTable) {
      const capabilities = reload
        .query("SELECT capability, minimum_reader_protocol, minimum_writer_protocol FROM database_capability")
        .all() as { capability: string; minimum_reader_protocol: number; minimum_writer_protocol: number }[]
      capabilityCount = capabilities.length
      const incompatible = capabilities.find(
        (cap) =>
          cap.minimum_reader_protocol > SupportedReaderProtocol ||
          cap.minimum_writer_protocol > SupportedWriterProtocol,
      )
      if (incompatible) {
        return fail(
          "capability_mismatch",
          `backup capability ${incompatible.capability} requires reader ${incompatible.minimum_reader_protocol} / writer ${incompatible.minimum_writer_protocol}; this runtime supports ${SupportedReaderProtocol}/${SupportedWriterProtocol}`,
        )
      }
    }

    // Application smoke: a real read through sqlite_master plus the core authority tables.
    const sqliteMasterCount = (reload.query("SELECT count(*) as c FROM sqlite_master").get() as { c: number }).c

    const migrationTable = reload
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
      .get()
    const migrationCount = migrationTable
      ? (reload.query("SELECT count(*) as c FROM migration").get() as { c: number }).c
      : 0
    // Identity: the digest of the applied migration ids in the backup must match the manifest.
    const migrationIds: string[] = migrationTable
      ? (reload.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]).map((row) => row.id)
      : []
    const schemaDigestMatch = migrationIds.length === manifest.source.appliedMigrationIds.length &&
      sha256(JSON.stringify(migrationIds)) === manifest.source.schemaDigest
    if (!schemaDigestMatch) {
      return fail("app_smoke_failed", `backup applied-migration digest does not match manifest schemaDigest`)
    }

    const sessionTable = reload
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
      .get()
    const sessionCount = sessionTable
      ? (reload.query("SELECT count(*) as c FROM session").get() as { c: number }).c
      : null

    return {
      ok: true,
      quickCheck: "ok",
      foreignKeyCount: orphans.length,
      journalMode,
      synchronous,
      capabilityCompatible: true,
      capabilityCount,
      migrationCount,
      sqliteMasterCount,
      sessionCount,
      hashMatch: true,
      schemaDigestMatch: true,
    } satisfies BackupVerificationOk
  } finally {
    reload.close()
  }
})