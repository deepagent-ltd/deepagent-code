export * as MdExport from "./md-export"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { asc, gt } from "drizzle-orm"
import { Cause, Data, DateTime, Effect } from "effect"
import { sha256File } from "@deepagent-code/core/database/file-sha256"
import { Database } from "@deepagent-code/core/database/database"
import { SessionHistory } from "@deepagent-code/core/session/history"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { formatTranscript, transcriptFilename } from "@deepagent-code/sdk/transcript"

// W-02 M-1 (design §3.3) — batch full-transcript Markdown exporter. Paginates over EVERY durable
// session, reads each one through the V2 history loader (SessionHistory.loadAll — the full-history
// variant, not the GUI rendering path), projects the rows with the canonical wire converters
// (SessionV2.legacyUser / legacyAssistant), and formats them with the SAME canonical formatter as
// the TUI /export, the GUI session.export, and the CLI `deepagent export --format md`
// (@deepagent-code/sdk/transcript). Output lands under `<backupDir>/md/<slug>-<date>.md` with a
// per-file sha256 manifest so a later phase (M-3) can reconcile the manifest against the library.
//
// Interruption semantics: the manifest is the resume source of truth. It is rewritten atomically
// (tmp + rename) after every session, so a crash at any point leaves it valid for the sessions
// that completed. Re-running skips a session when its manifest entry exists AND the file on disk
// still hashes to the recorded sha256; a torn or mutated file is re-exported. File-name collisions
// between sessions (same slugified title + day) resolve deterministically by suffixing the short
// session id, so pagination order (session id asc) keeps names stable across resumes.

type DatabaseService = Database.Interface["db"]

export class MdExportError extends Data.TaggedError("MdExport.MdExportError")<{
  readonly code: "manifest_unreadable" | "write_failed" | "session_failed"
  readonly detail: string
  readonly sessionId?: string
}> {}

export interface ManifestEntry {
  readonly sessionId: string
  readonly fileName: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly messageCount: number
  readonly exportedAt: number
}

export interface Manifest {
  readonly version: 1
  readonly kind: "md-export-manifest"
  readonly sourceDatabase: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly entries: readonly ManifestEntry[]
}

export type Reconciliation = {
  readonly reconciled: boolean
  readonly exportedCount: number
  readonly sessionCount: number
  readonly missing: readonly string[]
  readonly extra: readonly string[]
}

export interface RunInput {
  /** The business database (live or read-only maintenance connection). */
  readonly db: DatabaseService
  /** Directory holding the export; files land in `<backupDir>/md/`. Created when missing. */
  readonly backupDir: string
  /** Identity of the exported database, recorded in the manifest (audit/reconciliation). */
  readonly sourcePath: string
  /**
   * Export at most this many NEW sessions this invocation. Omit for "all". A client chunking a
   * huge library (or an interrupted run) re-invokes and already-exported sessions are skipped.
   */
  readonly limit?: number
  /** Keyset page size for the session traversal. */
  readonly pageSize?: number
}

export interface RunResult {
  readonly exported: number
  readonly skipped: number
  readonly sessionCount: number
  readonly manifestPath: string
  readonly reconciliation: Reconciliation
}

export const DefaultPageSize = 100

export const manifestPathFor = (backupDir: string) => path.join(backupDir, "md", "manifest.json")

const sha256Text = (input: string) => createHash("sha256").update(input).digest("hex")

const causeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

/** Read + structurally validate the manifest, treating a missing file as "nothing exported yet". */
export const readManifest = Effect.fn("MdExport.readManifest")(function* (manifestPath: string) {
  const text = yield* Effect.promise(() => Bun.file(manifestPath).text()).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (text === undefined) return undefined
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as Partial<Manifest>
      if (parsed?.version !== 1 || parsed?.kind !== "md-export-manifest" || !Array.isArray(parsed.entries))
        throw new Error("not an md-export manifest")
      return parsed as Manifest
    },
    catch: () => new MdExportError({ code: "manifest_unreadable", detail: manifestPath }),
  })
})

const writeManifestAtomic = (manifestPath: string, manifest: Manifest) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    const tmp = `${manifestPath}.tmp-${Math.random().toString(36).slice(2)}`
    await Bun.write(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.rename(tmp, manifestPath)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new MdExportError({
          code: "write_failed",
          detail: `cannot write manifest ${manifestPath}: ${causeMessage(Cause.squash(cause))}`,
        }),
      ),
    ),
  )

type SessionRow = {
  readonly id: string
  readonly title: string
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly directory: string
  readonly path: string | null
  readonly agent: string | null
  readonly model: { id: string; providerID: string; variant?: string } | null
}

/** One keyset page of durable sessions in id-asc order (the deterministic traversal order). */
const sessionPage = (db: DatabaseService, afterId: string | undefined, pageSize: number) =>
  db
    .select({
      id: SessionTable.id,
      title: SessionTable.title,
      timeCreated: SessionTable.time_created,
      timeUpdated: SessionTable.time_updated,
      directory: SessionTable.directory,
      path: SessionTable.path,
      agent: SessionTable.agent,
      model: SessionTable.model,
    })
    .from(SessionTable)
    .where(afterId === undefined ? undefined : gt(SessionTable.id, SessionSchema.ID.make(afterId)))
    .orderBy(asc(SessionTable.id))
    .limit(pageSize)
    .all()
    .pipe(Effect.orDie)

const countSessions = (db: DatabaseService) =>
  db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(
    Effect.orDie,
    Effect.map((rows) => rows.length),
  )

/**
 * Project one session's V2 messages onto the transcript formatter's input contract using the
 * canonical wire converters. Control-plane rows (agent/model switches, system, shell) carry no
 * conversational content and are skipped; a V2 compaction checkpoint renders per the V1 marker
 * convention (compaction part + the summary as the checkpoint assistant text).
 */
const transcriptFor = (row: SessionRow, messages: readonly SessionMessage.Message[]) => {
  const sessionID = SessionSchema.ID.make(row.id)
  const firstUser = messages.find((message) => message.type === "user")
  const withParts = messages.flatMap((message): SessionV1.WithParts[] => {
    if (message.type === "user" || message.type === "synthetic")
      return [
        SessionV2.legacyUser({
          sessionID,
          message,
          agent: row.agent,
          model: row.model,
          synthetic: message.type === "synthetic",
        }),
      ]
    if (message.type === "assistant")
      return [
        SessionV2.legacyAssistant({
          sessionID,
          parentMessageID: SessionV1.MessageID.ascending(firstUser ? firstUser.id : message.id),
          directory: row.directory,
          root: row.path ?? "",
          message,
        }),
      ]
    if (message.type === "compaction") return [compactionCheckpoint({ sessionID, message, row })]
    return []
  })
  return {
    session: {
      id: row.id,
      title: row.title,
      time: { created: row.timeCreated, updated: row.timeUpdated },
    },
    messages: withParts,
  }
}

/** V2 compaction row → the V1 marker convention: compaction part + summary as assistant text. */
function compactionCheckpoint(input: {
  readonly sessionID: SessionSchema.ID
  readonly message: SessionMessage.Compaction
  readonly row: SessionRow
}): SessionV1.WithParts {
  const sessionID = input.sessionID
  const message = input.message
  const created = DateTime.toEpochMillis(message.time.created)
  const messageID = SessionV1.MessageID.ascending(message.id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created },
      parentID: messageID,
      modelID: (input.row.model?.id ?? "") as ModelV2.ID,
      providerID: (input.row.model?.providerID ?? "") as ProviderV2.ID,
      mode: "compaction",
      agent: "compaction",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: SessionV1.PartID.ascending(`prt_${message.id.slice("msg_".length)}_c0`),
        sessionID,
        messageID,
        type: "compaction",
        auto: message.reason === "auto",
      } as SessionV1.Part,
      {
        id: SessionV1.PartID.ascending(`prt_${message.id.slice("msg_".length)}_c1`),
        sessionID,
        messageID,
        type: "text",
        text: message.summary,
        time: { start: created, end: created },
      },
    ],
  }
}

/** Manifest ↔ library oracle: zero-diff means every session id has exactly one entry. */
export const reconcile = Effect.fn("MdExport.reconcile")(function* (db: DatabaseService, manifest: Manifest) {
  const ids = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
  const exported = new Set(manifest.entries.map((entry) => entry.sessionId))
  const missing = ids.map((row) => row.id as string).filter((id) => !exported.has(id))
  const library = new Set(ids.map((row) => row.id as string))
  const extra = [...exported].filter((id) => !library.has(id))
  return {
    reconciled: missing.length === 0 && extra.length === 0,
    exportedCount: manifest.entries.length,
    sessionCount: ids.length,
    missing,
    extra,
  }
})

const fileMatches = (entry: ManifestEntry, filePath: string) =>
  Effect.promise(async () => {
    const stat = await fs.stat(filePath).catch(() => null)
    if (stat === null || stat.size !== entry.sizeBytes) return false
    return (await sha256File(filePath)) === entry.sha256
  })

/** Deterministic collision policy: same title+day across sessions → suffix the short session id. */
function resolveFileName(base: string, sessionId: string, claimed: Set<string>): string {
  if (!claimed.has(base)) return base
  const suffix = `-${sessionId.slice(-8)}`
  const dot = base.lastIndexOf(".")
  const candidate = dot === -1 ? `${base}${suffix}` : `${base.slice(0, dot)}${suffix}${base.slice(dot)}`
  return claimed.has(candidate) ? `${candidate}-${claimed.size + 1}` : candidate
}

const writeSessionFile = (filePath: string, markdown: string) =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      // Write + rename so a crash mid-write can never leave a half file under the final name.
      const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`
      await Bun.write(tmp, markdown)
      await fs.rename(tmp, filePath)
    },
    catch: (cause) => `cannot write export file ${filePath}: ${causeMessage(cause)}`,
  })

export const run = Effect.fn("MdExport.run")(function* (input: RunInput) {
  const manifestPath = manifestPathFor(input.backupDir)
  const previous = yield* readManifest(manifestPath)
  const createdAt = previous?.createdAt ?? Date.now()
  const doneBySession = new Map((previous?.entries ?? []).map((entry) => [entry.sessionId, entry]))
  const claimedFiles = new Set(doneBySession.values().map((entry) => entry.fileName))
  const pageSize = input.pageSize ?? DefaultPageSize
  let exported = 0
  let skipped = 0
  let afterId: string | undefined
  let budget = input.limit

  const manifestOf = (): Manifest => ({
    version: 1,
    kind: "md-export-manifest",
    sourceDatabase: input.sourcePath,
    createdAt,
    updatedAt: Date.now(),
    entries: [...doneBySession.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)),
  })

  // Keyset traversal in one pass; each page is fully processed before the next is fetched.
  while (true) {
    const page = yield* sessionPage(input.db, afterId, pageSize)
    if (page.length === 0) break
    for (const row of page) {
      afterId = row.id
      const existing = doneBySession.get(row.id)
      const fileName = existing
        ? existing.fileName
        : resolveFileName(
            transcriptFilename({ id: row.id, title: row.title, time: { created: row.timeCreated } }),
            row.id,
            claimedFiles,
          )
      const filePath = path.join(path.dirname(manifestPath), fileName)
      if (existing && (yield* fileMatches(existing, filePath))) {
        skipped += 1
        continue
      }
      // The budget only gates NEW exports; a stale entry (torn file) is repaired regardless.
      if (budget !== undefined && budget <= 0) continue
      const messages = yield* SessionHistory.loadAll(input.db, SessionSchema.ID.make(row.id)).pipe(
        Effect.mapError(
          (error) =>
            new MdExportError({
              code: "session_failed",
              detail: `cannot read history for session ${row.id}: ${causeMessage(error)}`,
              sessionId: row.id,
            }),
        ),
      )
      const transcript = transcriptFor(row, messages)
      const markdown = formatTranscript(transcript.session, transcript.messages, {
        thinking: true,
        toolDetails: true,
        assistantMetadata: true,
      })
      yield* writeSessionFile(filePath, markdown).pipe(
        Effect.mapError(
          (detail) => new MdExportError({ code: "write_failed", detail, sessionId: row.id }),
        ),
      )
      const entry: ManifestEntry = {
        sessionId: row.id,
        fileName,
        sizeBytes: Buffer.byteLength(markdown),
        sha256: sha256Text(markdown),
        messageCount: messages.length,
        exportedAt: Date.now(),
      }
      doneBySession.set(row.id, entry)
      claimedFiles.add(fileName)
      // Persist after EVERY session so an interruption at any point keeps the manifest a valid
      // resume point (the acceptance drill re-runs and expects already-exported sessions skipped).
      yield* writeManifestAtomic(manifestPath, manifestOf())
      exported += 1
      if (budget !== undefined) budget -= 1
    }
    if (page.length < pageSize) break
  }

  const finalManifest = manifestOf()
  yield* writeManifestAtomic(manifestPath, finalManifest)
  return {
    exported,
    skipped,
    sessionCount: yield* countSessions(input.db),
    manifestPath,
    reconciliation: yield* reconcile(input.db, finalManifest),
  }
})
