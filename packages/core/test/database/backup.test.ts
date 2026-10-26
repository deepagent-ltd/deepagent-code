import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { Database } from "bun:sqlite"
import { Backup } from "@deepagent-code/core/database/backup"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"
import { makeFixture, run, sha256 } from "./backup-fixture"

describe("Backup (C1A-06)", () => {
  test("creates a consistent, WAL-active recoverable snapshot with a complete manifest", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      // Live connection is open in WAL mode; VACUUM INTO runs on a separate read-only connection.
      const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))

      expect(manifest.version).toBe(1)
      expect(manifest.build.buildId).toBe("build-x")
      expect(manifest.backup.fileName.startsWith("backup-build-x-")).toBe(true)
      expect(manifest.backup.fileName.endsWith(".db")).toBe(true)
      expect(manifest.backup.filePath).toBe(path.join(tmp.path, manifest.backup.fileName))
      expect(manifest.backup.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.source.filePath).toBe(filename)
      expect(manifest.source.pageCount * manifest.source.pageSize).toBe(manifest.source.dbLogicalSizeBytes)
      expect(manifest.source.capability).toEqual([
        { capability: "bounded_event_snapshot_v1", minimum_reader_protocol: 2, minimum_writer_protocol: 2 },
      ])
      expect(manifest.source.appliedMigrationIds).toEqual(["20260813134000_database_capability"])

      const onDisk = await fs.readFile(manifest.backup.filePath)
      expect(manifest.backup.sha256).toBe(sha256(onDisk))
      expect(manifest.backup.sizeBytes).toBe(onDisk.length)

      // The snapshot is a valid, WAL-free single-file DB that captured the committed WAL row.
      const probe = new Database(manifest.backup.filePath, { create: false, readonly: true })
      const rows = probe.query("SELECT value FROM test_backup_probe").all()
      const journalMode = (probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode
      probe.close()
      expect(rows).toEqual([{ value: "captured-from-wal" }])
      expect(journalMode).toBe("delete")
      // No temp backup remnants after the atomic rename.
      expect((await fs.readdir(tmp.path)).some((entry) => entry.includes(".tmp-"))).toBe(false)
    } finally {
      live.close()
    }
  })

  test("writes the backup with private platform permissions alongside a readable manifest", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const manifest = await run(Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x" }))
      if (process.platform !== "win32") expect((await fs.stat(manifest.backup.filePath)).mode & 0o777).toBe(0o600)
      if (process.platform === "win32") {
        // Windows chmod/stat expose DOS read-only bits, not the NTFS access policy. Inspect
        // actual ACLs for both published files; administrators/System retain OS-level access.
        const script = `[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$inputValue=[Console]::In.ReadToEnd() | ConvertFrom-Json
@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;files=@($inputValue.paths | ForEach-Object {
  $acl=Get-Acl -LiteralPath $_
  @{rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;allow=($_.AccessControlType -eq 'Allow')}
  })}
})} | ConvertTo-Json -Depth 5 -Compress`
        const text = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            { timeout: 10_000, maxBuffer: 8_192, windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          )
          child.stdin?.end(
            JSON.stringify({ paths: [manifest.backup.filePath, `${manifest.backup.filePath}.manifest.json`] }),
          )
        })
        const acl: { sid: string; files: { rules: { sid: string; rights: number; allow: boolean }[] }[] } =
          JSON.parse(text)
        expect(acl.files).toHaveLength(2)
        for (const file of acl.files) {
          const allowed = file.rules.filter((rule) => rule.allow)
          expect(allowed.every((rule) => [acl.sid, "S-1-5-18", "S-1-5-32-544"].includes(rule.sid))).toBe(true)
          expect(allowed.some((rule) => rule.sid === acl.sid && (rule.rights & 3) === 3)).toBe(true)
        }
      }
      const manifestText = await fs.readFile(manifest.backup.filePath + ".manifest.json", "utf8")
      expect(JSON.parse(manifestText)).toEqual(manifest)
    } finally {
      live.close()
    }
  })

  test("refuses to overwrite an existing backup file, keeping the known-good intact", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const live = makeFixture(filename)
    try {
      const first = await run(
        Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x", fileName: "unique" }),
      )
      const second = await Effect.runPromise(
        Backup.create({ sourcePath: filename, destDir: tmp.path, buildId: "build-x", fileName: "unique" }).pipe(
          Effect.exit,
        ),
      )
      expect(second._tag).toBe("Failure")
      // The known-good copy is untouched and still present.
      expect((await fs.stat(first.backup.filePath)).isFile()).toBe(true)
    } finally {
      live.close()
    }
  })
})
