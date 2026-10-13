import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { ALL_SCOPES, type ImportScope, type ImportSource } from "./types"

export type ImportTarget = {
  id: string
  mode: "copy_to_new_db" | "merge_into_live"
  sourcePath: string
  dbPath: string
  dataRoot: string
  configDir: string
  dryRun: boolean
  backup?: { path: string; manifestPath: string; sha256: string }
}

export async function prepareImportTarget(input: {
  /** Internal durable job identity; HTTP clients cannot choose filesystem targets. */
  id?: string
  source: ImportSource
  sourcePath?: string
  mode?: ImportTarget["mode"]
  copyLiveDb?: boolean
  confirmLiveMerge?: boolean
  dryRun?: boolean
  scopes?: readonly ImportScope[]
  liveDbPath: string
  dataRoot: string
  configDir: string
}): Promise<ImportTarget> {
  const mode = input.mode ?? (input.copyLiveDb === false ? "merge_into_live" : "copy_to_new_db")
  if (input.copyLiveDb !== undefined && input.copyLiveDb !== (mode === "copy_to_new_db"))
    throw new Error("IMPORT_MODE_CONFLICT: mode and copyLiveDb must select the same target")
  if (!input.dryRun && mode === "merge_into_live" && input.confirmLiveMerge !== true)
    throw new Error("IMPORT_LIVE_CONFIRMATION_REQUIRED: explicitly confirm merging into the current database")
  if (mode === "merge_into_live" && (input.scopes ?? ALL_SCOPES).some((scope) => scope !== "session"))
    throw new Error(
      "IMPORT_LIVE_SCOPE_UNSUPPORTED: live merge currently supports sessions only; use a copy for memory and skills",
    )
  if (input.scopes?.length === 0) throw new Error("IMPORT_SCOPE_REQUIRED: select at least one import category")

  const sourcePath = path.resolve(
    input.sourcePath ?? path.join(homedir(), input.source === "codex" ? ".codex" : ".claude"),
  )
  if (!(await fs.stat(sourcePath)).isDirectory())
    throw new Error("IMPORT_SOURCE_UNAVAILABLE: source must be a directory")
  const id = input.id ?? crypto.randomUUID()
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("IMPORT_TARGET_ID_INVALID: invalid internal job identity")
  const root = path.join(input.dataRoot, "imports", id)
  const target: ImportTarget = {
    id,
    mode,
    sourcePath,
    dbPath: mode === "copy_to_new_db" ? path.join(root, "data", "import.db") : input.liveDbPath,
    dataRoot: mode === "copy_to_new_db" ? path.join(root, "data") : input.dataRoot,
    configDir: mode === "copy_to_new_db" ? path.join(root, "config") : input.configDir,
    dryRun: input.dryRun ?? false,
  }
  if (input.dryRun) return target
  if (input.liveDbPath === ":memory:" || !(await fs.stat(input.liveDbPath)).isFile())
    throw new Error("IMPORT_BACKUP_UNAVAILABLE: a persistent current database is required")

  await fs.mkdir(path.join(root, "backup"), { recursive: true, mode: 0o700 })
  const backup = await Effect.runPromise(
    Backup.create({
      sourcePath: input.liveDbPath,
      destDir: path.join(root, "backup"),
      buildId: InstallationVersion,
      fileName: "before-import",
    }),
  )
  const verified = await Effect.runPromise(BackupVerify.verify(backup))
  if (!verified.ok) throw new Error(`IMPORT_BACKUP_INVALID: ${verified.reason}: ${verified.detail}`)

  // Keep the verified backup immutable: the working copy will acquire WAL and imported rows.
  if (mode === "copy_to_new_db") {
    await fs.mkdir(target.dataRoot, { recursive: true, mode: 0o700 })
    await fs.mkdir(target.configDir, { recursive: true, mode: 0o700 })
    await fs.copyFile(backup.backup.filePath, target.dbPath, fs.constants.COPYFILE_EXCL)
    await fs.chmod(target.dbPath, 0o600)
  }
  return {
    ...target,
    ...(mode === "copy_to_new_db"
      ? {
          dataRoot: await fs.realpath(target.dataRoot),
          configDir: await fs.realpath(target.configDir),
          dbPath: await fs.realpath(target.dbPath),
        }
      : {}),
    backup: {
      path: backup.backup.filePath,
      manifestPath: Backup.manifestPathFor(backup.backup.filePath),
      sha256: backup.backup.sha256,
    },
  }
}
