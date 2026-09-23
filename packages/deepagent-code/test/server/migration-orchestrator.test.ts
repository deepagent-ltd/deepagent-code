import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { MigrationOrchestrator, type DiskAdvisory, type Journal } from "../../src/server/migration-orchestrator"
import { MdExport } from "../../src/server/md-export"
import { tmpdir } from "../fixture/fixture"

// W-02 M-2 acceptance (design §3.4): the full chain runs on a multi-session fixture replica and
// persists a per-phase journal; an interruption (staged stop mid-chain) is visible in the journal
// and resumes without re-running completed phases; a phase failure stops the chain with a
// structured failure + user-readable guidance and leaves NO half-migrated state; the disk advisory
// lists deletion candidates WITHOUT deleting anything, and restore-incidents is never touched.

type DatabaseService = Database.Interface["db"]

const encodeMessage = Schema.encodeSync(SessionMessage.Message)

async function seedSession(db: DatabaseService, input: { id: string; title: string; created: number; text: string; reply: string }) {
  const model = { id: ModelV2.ID.make("mdl-test"), providerID: ProviderV2.ID.make("prv-test") } as const
  const time = { created: DateTime.makeUnsafe(input.created) }
  const user = encodeMessage(
    new SessionMessage.User({ id: SessionMessage.ID.make(`msg_${input.id}_u`), type: "user", text: input.text, time }),
  )
  const assistant = encodeMessage(
    new SessionMessage.Assistant({
      id: SessionMessage.ID.make(`msg_${input.id}_a`),
      type: "assistant",
      agent: "build",
      model,
      content: [new SessionMessage.AssistantText({ type: "text", id: `prt_${input.id}_a_0`, text: input.reply })],
      time,
    }),
  )
  await Effect.runPromise(
    db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(input.id),
        project_id: Project.ID.global,
        slug: input.id,
        directory: "/project",
        title: input.title,
        version: "test",
        agent: "build",
        model: { id: "mdl-test", providerID: "prv-test" },
        time_created: input.created,
        time_updated: input.created + 1,
      })
      .run(),
  )
  for (const [index, message] of [user, assistant].entries()) {
    const { id: _, type, ...data } = message
    await Effect.runPromise(
      db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(message.id),
          session_id: SessionSchema.ID.make(input.id),
          type,
          seq: index + 1,
          time_created: input.created,
          data,
        })
        .run(),
    )
  }
}

async function seedFixture(filename: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => seedSession(db, { id: "ses_one", title: "Orchestrator Drill", created: Date.UTC(2026, 8, 3, 9), text: "migrate me", reply: "chain complete" }))
      yield* Effect.promise(() => seedSession(db, { id: "ses_two", title: "Second Session", created: Date.UTC(2026, 8, 3, 10), text: "also migrate", reply: "ok" }))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

/** Run the whole body inside ONE live database scope (the orchestrator drives the business layer). */
async function withDatabase<A>(filename: string, body: (db: DatabaseService) => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* Effect.promise(() => body(db))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

const countSessions = async (db: DatabaseService) =>
  (await Effect.runPromise(db.select({ id: SessionTable.id }).from(SessionTable).all())).length

const readJournalOnDisk = async (backupDir: string) =>
  (await Bun.file(MigrationOrchestrator.journalPathFor(backupDir)).json()) as Journal

const readAdvisory = async (advisoryPath: string) => (await Bun.file(advisoryPath).json()) as DiskAdvisory

describe("MigrationOrchestrator (W-02 M-2)", () => {
  test("full chain on the fixture replica: all phases complete and persist their records", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "chain.db")
    await seedFixture(filename)
    // Operational residue + an incident copy: the advisory must LIST them, never touch them.
    await Bun.write(path.join(tmp.path, "repro.db"), "repro residue")
    await Bun.write(path.join(tmp.path, "old.bak"), "bak residue")
    await fs.mkdir(path.join(tmp.path, "restore-incidents"), { recursive: true })
    await Bun.write(path.join(tmp.path, "restore-incidents", "incident-1.db"), "incident copy")
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const result = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "chain-drill" }),
      )
      if (result.status !== "completed") throw new Error(`chain drill failed: ${JSON.stringify(result.journal.failure)}`)
      expect(result.diskAdvisoryPath).toBeDefined()

      const journal = await readJournalOnDisk(backupDir)
      expect(journal.status).toBe("completed")
      expect(journal.phases.map((record) => [record.phase, record.state])).toEqual(
        MigrationOrchestrator.Phases.map((phase) => [phase, "completed"]),
      )

      // md_export phase = the M-1 drill: one export per session, reconciled.
      const md = journal.phases[0]!.outcome
      expect(md).toMatchObject({ kind: "md_export", exported: 2, sessionCount: 2, reconciled: true })
      const mdManifest = await Effect.runPromise(MdExport.readManifest(MdExport.manifestPathFor(backupDir)))
      expect(mdManifest?.entries.length).toBe(2)

      // backup_create + backup_verify against the real snapshot.
      expect(journal.phases[1]!.outcome).toMatchObject({ kind: "backup_create", fileName: "chain-drill.db" })
      expect(journal.phases[2]!.outcome).toMatchObject({ kind: "backup_verify", quickCheck: "ok" })
      await fs.access(path.join(backupDir, "chain-drill.db"))

      // migration_apply on an already-current registry is an honest no-op (bootstrap applied it).
      expect(journal.phases[3]!.outcome).toMatchObject({ kind: "migration_apply", receiptCount: 0 })
      expect(journal.phases[4]!.outcome).toMatchObject({ kind: "post_verify", verdict: "passed" })

      // archive record references every artifact phase.
      const archive = journal.phases[5]!.outcome
      expect(archive?.kind).toBe("archive")
      const archiveBody = JSON.parse(await Bun.file((archive as { archivePath: string }).archivePath).text())
      expect(archiveBody.mdExport).toMatchObject({ exported: 2, reconciled: true })
      expect(archiveBody.backup).toMatchObject({ sha256: expect.any(String) })
      expect(archiveBody.postVerify).toMatchObject({ verdict: "passed" })

      // disk advisory: list only — residue reclaimable, incidents never deleted, nothing removed.
      const advisory = await readAdvisory(result.diskAdvisoryPath!)
      expect(advisory.restoreIncidentsNeverDeleted).toBe(true)
      const categories = new Map(advisory.entries.map((entry) => [entry.category, entry]))
      expect(categories.get("main_db")?.path).toBe(path.resolve(filename))
      expect(categories.get("restore_incident")?.note).toContain("NEVER deleted")
      const residue = advisory.entries.filter((entry) => entry.category === "residue_candidate").map((entry) => path.basename(entry.path))
      expect(residue).toEqual(["old.bak", "repro.db"])
      expect(advisory.reclaimableBytes).toBe("repro residue".length + "bak residue".length)
      // Nothing was deleted by the advisory phase.
      await fs.access(path.join(tmp.path, "repro.db"))
      await fs.access(path.join(tmp.path, "old.bak"))
      await fs.access(path.join(tmp.path, "restore-incidents", "incident-1.db"))
      // The live library is untouched by the whole chain.
      expect(await countSessions(db)).toBe(2)
    })
  })

  test("interruption: a staged stop is visible in the journal and resumes without re-running phases", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "staged.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      // Interrupted mid-chain (after backup_create): the journal shows where the chain stopped.
      const staged = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "staged", stopAfter: "backup_create" }),
      )
      expect(staged.status).toBe("in_progress")
      expect(staged.journal.currentPhase).toBe("backup_create")
      expect(staged.journal.phases.map((record) => record.phase)).toEqual(["md_export", "backup_create"])

      const status = await Effect.runPromise(MigrationOrchestrator.readJournal(MigrationOrchestrator.journalPathFor(backupDir)))
      expect(status?.status).toBe("in_progress")
      expect(status?.currentPhase).toBe("backup_create")

      // Resume: completed phases are skipped (one record per phase), the rest of the chain runs.
      const resumed = await Effect.runPromise(MigrationOrchestrator.run({ db, dbPath: filename, backupDir }))
      expect(resumed.status).toBe("completed")
      expect(resumed.journal.phases.map((record) => record.phase)).toEqual([...MigrationOrchestrator.Phases])
      // md_export was NOT re-run: its original record is the one in the journal.
      expect(resumed.journal.phases[0]!.startedAt).toBe(staged.journal.phases[0]!.startedAt)
      // The resumed backup_create kept the staged snapshot (already completed → skipped).
      expect(resumed.journal.phases[1]!.outcome).toMatchObject({ kind: "backup_create", fileName: "staged.db" })
    })
  })

  test("backup failure injection: stops before any migration, records guidance, resumes after the fix", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blocked.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")
    // Crash-window drill: a previous attempt left the exact backup file in place.
    await fs.mkdir(backupDir, { recursive: true })
    await Bun.write(path.join(backupDir, "blocked.db"), "residue of an interrupted attempt")

    await withDatabase(filename, async (db) => {
      const failed = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "blocked" }),
      )
      expect(failed.status).toBe("failed")
      expect(failed.journal.failure).toMatchObject({
        phase: "backup_create",
        code: "backup_backup_exists",
      })
      expect(failed.journal.failure?.recoveryGuidance).toContain("No migration has run")
      // Phases before the failure completed; nothing after it ran — no half-migrated state.
      expect(failed.journal.phases.map((record) => record.phase)).toEqual(["md_export", "backup_create"])
      expect(failed.journal.phases[1]!.state).toBe("failed")
      // The library and the exported transcripts are intact.
      expect(await countSessions(db)).toBe(2)
      const mdManifest = await Effect.runPromise(MdExport.readManifest(MdExport.manifestPathFor(backupDir)))
      expect(mdManifest?.entries.length).toBe(2)

      // Operator clears the residue; the chain resumes and completes. The failed record stays in
      // the journal (append-only history, receipt convention) beside its completed successor.
      await fs.rm(path.join(backupDir, "blocked.db"))
      const resumed = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "blocked" }),
      )
      expect(resumed.status).toBe("completed")
      expect(resumed.journal.phases.filter((record) => record.state === "completed").map((record) => record.phase)).toEqual([
        ...MigrationOrchestrator.Phases,
      ])
      expect(resumed.journal.phases.filter((record) => record.state === "failed").map((record) => record.phase)).toEqual([
        "backup_create",
      ])
    })
  })

  test("md-export failure injection: the chain fails in phase 1, the journal stays resumable", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "mdfail.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      await Effect.runPromise(
        db
          .update(SessionMessageTable)
          .set({ data: {} as typeof SessionMessageTable.$inferInsert.data })
          .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_one")))
          .run(),
      )
      const failed = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "mdfail" }),
      )
      expect(failed.status).toBe("failed")
      expect(failed.journal.failure).toMatchObject({ phase: "md_export", code: "md_export_session_failed" })
      // No backup, no migration, and not even an md/ directory: the export failed on the FIRST
      // session, so only the journal bookkeeping exists under the backup root.
      expect(failed.journal.phases.map((record) => record.phase)).toEqual(["md_export"])
      expect(await fs.readdir(backupDir)).toEqual(["migration-orchestration.json"])

      // Repairing the cause lets the same invocation resume to a full completion.
      await Effect.runPromise(db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_one"))).run())
      const resumed = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "mdfail" }),
      )
      expect(resumed.status).toBe("completed")
      // The failed md_export record is retained; its completed successor carries the outcome.
      const mdCompleted = resumed.journal.phases.find((record) => record.phase === "md_export" && record.state === "completed")
      expect(mdCompleted?.outcome).toMatchObject({ kind: "md_export", reconciled: true })
    })
  })

  test("a completed orchestration starts a fresh chain on the next run (archive keeps history)", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "again.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const first = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "first" }),
      )
      expect(first.status).toBe("completed")
      const second = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "second" }),
      )
      expect(second.status).toBe("completed")
      expect(second.journal.orchestrationId).not.toBe(first.journal.orchestrationId)
      // Both archive records survive; the journal tracks only the latest chain.
      const archiveDir = await fs.readdir(path.join(backupDir, "migration-archive"))
      expect(archiveDir.filter((name) => name.endsWith(".json") && !name.includes("disk-advisory")).length).toBe(2)
      // md exports are idempotent: the second chain skipped both sessions.
      expect(second.journal.phases[0]!.outcome).toMatchObject({ kind: "md_export", exported: 0, skipped: 2 })
    })
  })
})
