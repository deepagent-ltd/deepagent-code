import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Backup, type BackupManifest } from "@deepagent-code/core/database/backup"
import { BackupVerify, type BackupVerification, type BackupVerificationFailure, type BackupVerificationOk } from "@deepagent-code/core/database/backup-verify"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"
import { makeFixture, run } from "./backup-fixture"

const isOk = (v: BackupVerification): v is BackupVerificationOk => v.ok === true
const isFail = (v: BackupVerification): v is BackupVerificationFailure => v.ok === false

describe("BackupVerify (C1A-07)", () => {
  test("passes verification of a clean backup: integrity, FK, journal/capability, reopen + smoke", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
      const verdict = await run(BackupVerify.verify(manifest))

      expect(isOk(verdict)).toBe(true)
      if (isOk(verdict)) {
        expect(verdict.quickCheck).toBe("ok")
        expect(verdict.foreignKeyCount).toBe(0)
        expect(verdict.journalMode).toBe("delete")
        expect(verdict.capabilityCompatible).toBe(true)
        expect(verdict.capabilityCount).toBeGreaterThan(0)
        expect(verdict.migrationCount).toBeGreaterThan(0)
        expect(verdict.sqliteMasterCount).toBeGreaterThan(0)
        expect(verdict.sessionCount).toBeGreaterThanOrEqual(0)
        expect(verdict.hashMatch).toBe(true)
        expect(verdict.schemaDigestMatch).toBe(true)
      }
    } finally {
      live.close()
    }
  })

  test("fails on a tampered backup (hash mismatch) and keeps the previous known-good", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const good = await run(
        Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x", fileName: "known-good" }),
      )
      const goodBytes = await fs.readFile(good.backup.filePath)

      const tampered = await run(
        Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x", fileName: "tampered" }),
      )
      const bytes = await fs.readFile(tampered.backup.filePath)
      const mid = Math.floor(bytes.length / 2)
      bytes[mid] = (bytes[mid]! ^ 0xff) as number
      await fs.writeFile(tampered.backup.filePath, bytes)

      const badVerdict = await run(BackupVerify.verify(tampered))
      expect(isFail(badVerdict)).toBe(true)
      if (isFail(badVerdict)) expect(badVerdict.reason).toBe("hash_mismatch")

      // The previous known-good backup is untouched and still verifies.
      expect((await fs.readFile(good.backup.filePath)).toString("hex")).toBe(goodBytes.toString("hex"))
      expect(isOk(await run(BackupVerify.verify(good)))).toBe(true)
    } finally {
      live.close()
    }
  })

  test("fails on a foreign-key violation", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "minimal.db")
    const db = new Database(filename, { create: true })
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)")
    db.exec("CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))")
    db.exec("INSERT INTO parent VALUES ('p-1')")
    db.exec("INSERT INTO child VALUES ('c-1', 'missing-parent')")
    db.close()
    const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
    const verdict = await run(BackupVerify.verify(manifest))
    expect(isFail(verdict)).toBe(true)
    if (isFail(verdict)) expect(verdict.reason).toBe("foreign_key_violation")
  })

  test("fails on a capability the runtime cannot satisfy", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "minimal.db")
    const db = new Database(filename, { create: true })
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER, installed_at INTEGER)")
    db.exec("INSERT INTO database_capability VALUES ('future_v1', 5, 5, 1)")
    db.close()
    const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
    const verdict = await run(BackupVerify.verify(manifest))
    expect(isFail(verdict)).toBe(true)
    if (isFail(verdict)) expect(verdict.reason).toBe("capability_mismatch")
  })

  test("fails when the backup file is missing", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
      await fs.rm(manifest.backup.filePath)
      const verdict = await run(BackupVerify.verify(manifest))
      expect(isFail(verdict)).toBe(true)
      if (isFail(verdict)) expect(verdict.reason).toBe("file_missing")
    } finally {
      live.close()
    }
  })

  test("fails on a malformed manifest", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
      const malformed = { ...manifest, backup: { ...manifest.backup, filePath: 5 } } as unknown as BackupManifest
      const verdict = await run(BackupVerify.verify(malformed))
      expect(isFail(verdict)).toBe(true)
      if (isFail(verdict)) expect(verdict.reason).toBe("manifest_invalid")
    } finally {
      live.close()
    }
  })
})