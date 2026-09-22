export * as BackupGovernor from "./backup-governor"

import fs from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import path from "node:path"
import { createGzip } from "node:zlib"
import { Data, Effect } from "effect"
import { Backup } from "@deepagent-code/core/database/backup"
import { MdExport } from "./md-export"

// W-02 M-4 (design §3.3) — backups governance. The backups root currently only ever grows; this
// module implements the retention policy and the explicit govern action:
//
//   keep      the newest N consistency backups (default 3) are always retained;
//   milestone every backup referenced by a migration archive record (M-2's
//             <backupDir>/migration-archive/*.json) is a milestone and is always retained —
//             one per completed migration, the pre-migration restore point;
//   archive   everything older that is neither kept nor a milestone is MOVED (never silently
//             deleted) into <backupDir>/archive/: the snapshot is gzip-compressed to
//             <fileName>.gz and its manifest is moved beside it, so the archive stays auditable
//             and recoverable (gunzip + restore path is unchanged).
//
// Every retained manifest is stamped with `mdExports` — the md-export manifest path(s) (M-1)
// this backup pairs with — extending BackupManifest (packages/core database/backup.ts).
//
// Governance is an EXPLICIT endpoint (POST /maintenance/backups/govern); nothing here runs in the
// background and nothing is ever deleted — the report records every action taken.

export const DefaultKeep = 3

export class BackupGovernorError extends Data.TaggedError("BackupGovernor.BackupGovernorError")<{
  readonly code: "archive_failed" | "write_failed" | "invalid_policy"
  readonly detail: string
}> {}

export interface GovernedBackup {
  readonly fileName: string
  readonly manifestPath: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly milestone: boolean
  readonly action: "kept" | "archived"
}

export interface GovernanceReport {
  readonly version: 1
  readonly kind: "backup-governance-report"
  readonly backupDir: string
  readonly generatedAt: number
  readonly policy: { readonly keep: number; readonly milestoneRule: "migration-archive" }
  readonly backups: readonly GovernedBackup[]
  readonly archivedCount: number
  readonly archivedBytes: number
  readonly mdExports: readonly string[]
  readonly skipped: readonly { readonly manifestPath: string; readonly reason: string }[]
}

export interface GovernInput {
  /** Backups root (the same root Backup.create writes to). */
  readonly backupDir: string
  /** How many of the newest non-milestone backups to retain. Default 3. */
  readonly keep?: number
}

export const reportPathFor = (backupDir: string) => path.join(backupDir, "backup-governance.json")

const writeJsonAtomic = (filePath: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`
    await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  }).pipe(
    Effect.catchCause(
      (cause) =>
        new BackupGovernorError({
          code: "write_failed",
          detail: `cannot write ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  )

/** Streaming gzip so a multi-GiB snapshot is never fully resident in memory. */
const gzipInto = (source: string, destination: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        createReadStream(source)
          .pipe(createGzip())
          .pipe(createWriteStream(destination))
          .on("finish", () => resolve())
          .on("error", reject)
      }),
  ).pipe(
    Effect.catchCause(
      (cause) =>
        new BackupGovernorError({
          code: "archive_failed",
          detail: `cannot archive ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  )

/** The md-export manifest path(s) that currently pair with backups under this root, if any. */
const mdExportsFor = Effect.fn("BackupGovernor.mdExportsFor")(function* (backupDir: string) {
  const manifest = yield* MdExport.readManifest(MdExport.manifestPathFor(backupDir))
  return manifest === undefined ? [] : [MdExport.manifestPathFor(backupDir)]
})

/** Manifest file names recorded as milestones by migration archive records (M-2). */
const milestoneFileNames = Effect.fn("BackupGovernor.milestoneFileNames")(function* (backupDir: string) {
  const archiveDir = path.join(backupDir, "migration-archive")
  const names = yield* Effect.promise(() => fs.readdir(archiveDir).catch(() => [] as string[]))
  const milestones = new Set<string>()
  for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.includes("disk-advisory"))) {
    const record = yield* Effect.promise(() => Bun.file(path.join(archiveDir, name)).json()).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    const backup = (record as { backup?: { manifestPath?: string; sha256?: string } } | undefined)?.backup
    if (backup?.manifestPath !== undefined) milestones.add(path.basename(backup.manifestPath))
  }
  return milestones
})

/** Rewrite a manifest with the mdExports pairing (idempotent; other fields untouched). */
const stampMdExports = (manifestPath: string, mdExports: readonly string[]) =>
  Effect.promise(async () => {
    const manifest = (await Bun.file(manifestPath).json()) as Backup.BackupManifest
    const stamped = { ...manifest, mdExports }
    const tmp = `${manifestPath}.tmp-${Math.random().toString(36).slice(2)}`
    await Bun.write(tmp, `${JSON.stringify(stamped, null, 2)}\n`)
    await fs.rename(tmp, manifestPath)
  }).pipe(
    Effect.catchCause(
      (cause) =>
        new BackupGovernorError({
          code: "write_failed",
          detail: `cannot stamp mdExports into ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  )

export const govern = Effect.fn("BackupGovernor.govern")(function* (input: GovernInput) {
  const keep = input.keep ?? DefaultKeep
  if (!Number.isInteger(keep) || keep < 1)
    return yield* new BackupGovernorError({ code: "invalid_policy", detail: `keep must be an integer >= 1, got ${keep}` })
  const backupDir = path.resolve(input.backupDir)
  const archiveDir = path.join(backupDir, "archive")

  const entries = yield* Effect.promise(() => fs.readdir(backupDir)).pipe(Effect.orElseSucceed(() => [] as string[]))
  const manifestPaths = entries.filter((entry) => entry.endsWith(".manifest.json")).map((entry) => path.join(backupDir, entry))
  const milestones = yield* milestoneFileNames(backupDir)
  const mdExports = yield* mdExportsFor(backupDir)

  const read = yield* Effect.forEach(manifestPaths, (manifestPath) =>
    Backup.readManifest(manifestPath).pipe(
      Effect.map((manifest) => ({ ok: true as const, manifestPath, manifest })),
      Effect.catchCause(() => Effect.succeed({ ok: false as const, manifestPath })),
    ),
  )
  const skipped = read
    .filter((item): item is Extract<typeof item, { ok: false }> => !item.ok)
    .map((item) => ({ manifestPath: item.manifestPath, reason: "manifest unreadable — left untouched" }))
  const manifests = read.filter((item): item is Extract<typeof item, { ok: true }> => item.ok)

  // Newest-first retention over the non-milestone set; milestones bypass the count entirely.
  const newestFirst = manifests.sort((a, b) => b.manifest.backup.createdAt - a.manifest.backup.createdAt)
  const retained: typeof newestFirst = []
  const overAged: typeof newestFirst = []
  let keptNew = 0
  for (const item of newestFirst) {
    const milestone = milestones.has(path.basename(item.manifestPath))
    if (milestone || keptNew < keep) {
      if (!milestone) keptNew += 1
      retained.push(item)
    } else overAged.push(item)
  }

  const governed: GovernedBackup[] = []
  let archivedBytes = 0
  // Stamp the md-export pairing only when an md manifest actually exists (no empty noise).
  const stamp = (manifestPath: string) => (mdExports.length > 0 ? stampMdExports(manifestPath, mdExports) : Effect.void)
  for (const item of retained) {
    yield* stamp(item.manifestPath)
    governed.push({
      fileName: item.manifest.backup.fileName,
      manifestPath: item.manifestPath,
      createdAt: item.manifest.backup.createdAt,
      sizeBytes: item.manifest.backup.sizeBytes,
      milestone: milestones.has(path.basename(item.manifestPath)),
      action: "kept",
    })
  }
  for (const item of overAged) {
    // Compress-then-move: the gzip is written and confirmed BEFORE the original is removed, so
    // an interruption mid-archive leaves the original in place (never a lost backup).
    yield* Effect.promise(() => fs.mkdir(archiveDir, { recursive: true }))
    const target = path.join(archiveDir, `${item.manifest.backup.fileName}.gz`)
    yield* gzipInto(item.manifest.backup.filePath, target)
    yield* stampMdExports(item.manifestPath, mdExports)
    yield* Effect.promise(() => fs.rename(item.manifestPath, path.join(archiveDir, path.basename(item.manifestPath))))
    yield* Effect.promise(() => fs.rm(item.manifest.backup.filePath))
    archivedBytes += item.manifest.backup.sizeBytes
    governed.push({
      fileName: item.manifest.backup.fileName,
      manifestPath: item.manifestPath,
      createdAt: item.manifest.backup.createdAt,
      sizeBytes: item.manifest.backup.sizeBytes,
      milestone: false,
      action: "archived",
    })
  }

  const report: GovernanceReport = {
    version: 1,
    kind: "backup-governance-report",
    backupDir,
    generatedAt: Date.now(),
    policy: { keep, milestoneRule: "migration-archive" },
    backups: governed,
    archivedCount: overAged.length,
    archivedBytes,
    mdExports,
    skipped,
  }
  yield* writeJsonAtomic(reportPathFor(backupDir), report)
  return report
})
