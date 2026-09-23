import { describe, expect, test } from "bun:test"
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
import { MigrationOrchestrator } from "../../src/server/migration-orchestrator"
import { MigrationReport } from "../../src/server/migration-report"
import { tmpdir } from "../fixture/fixture"

// W-02 M-3 acceptance (design §3.4): after a full-chain run on a fixture replica the compliance
// report shows a zero-diff reconciliation with overall success; the three states render correctly
// (a missing chain → warning, a post-export library drift → failure); the report persists under
// the backups root and reads back through the same module.

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
        model: { id: model.id, providerID: model.providerID },
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
      yield* Effect.promise(() => seedSession(db, { id: "ses_one", title: "Report Drill", created: Date.UTC(2026, 8, 4, 9), text: "migrate me", reply: "chain complete" }))
      yield* Effect.promise(() => seedSession(db, { id: "ses_two", title: "Second Session", created: Date.UTC(2026, 8, 4, 10), text: "also migrate", reply: "ok" }))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

async function withDatabase<A>(filename: string, body: (db: DatabaseService) => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* Effect.promise(() => body(db))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

describe("MigrationReport (W-02 M-3)", () => {
  test("replica drill: full chain then a success report with zero-diff reconciliations", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "report.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const chain = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "report-drill" }),
      )
      if (chain.status !== "completed") throw new Error(`chain drill failed: ${JSON.stringify(chain.journal.failure)}`)

      const report = await Effect.runPromise(MigrationReport.generate({ db, dbPath: filename, backupDir }))
      // The full-chain drill is a clean success: every oracle passed, nothing is merely missing.
      expect(report.overall).toBe("success")
      expect(report.entries.filter((entry) => entry.status !== "success")).toEqual([])
      const checks = report.entries.map((entry) => entry.check)
      expect(checks).toContain("preflight")
      expect(checks).toContain("data_integrity")
      expect(checks).toContain("post_verify")
      expect(checks).toContain("backup_verify")
      for (const phase of MigrationOrchestrator.Phases) expect(checks).toContain(`journal:${phase}`)
      // Zero-diff oracles: manifest↔library and export-time↔now row counts.
      expect(report.mdReconciliation).toEqual({
        reconciled: true,
        exportedCount: 2,
        sessionCount: 2,
        missing: [],
        extra: [],
      })
      expect(report.rowReconciliation).toEqual({
        sessionsInLibrary: 2,
        sessionsInManifest: 2,
        messagesInLibrary: 4,
        messagesInManifest: 4,
        reconciled: true,
      })
      expect(report.orchestrationId).toBe(chain.journal.orchestrationId)

      // Persisted (schema version 1) and readable back.
      const stored = await Effect.runPromise(MigrationReport.read(MigrationReport.reportPathFor(backupDir)))
      expect(stored?.version).toBe(1)
      expect(stored?.kind).toBe("migration-compliance-report")
      expect(stored?.overall).toBe("success")
      expect(stored?.entries.length).toBe(report.entries.length)
    })
  })

  test("no chain yet: the report is an honest warning, not a fabricated success", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "bare.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const report = await Effect.runPromise(MigrationReport.generate({ db, dbPath: filename, backupDir }))
      expect(report.overall).toBe("warning")
      const byCheck = new Map(report.entries.map((entry) => [entry.check, entry]))
      expect(byCheck.get("journal")?.status).toBe("warning")
      expect(byCheck.get("md_reconcile")?.status).toBe("warning")
      expect(byCheck.get("row_reconcile")?.status).toBe("warning")
      expect(byCheck.get("post_verify")?.status).toBe("warning")
      // The fresh oracles still pass on a healthy store: no failure entries at all.
      expect(report.entries.filter((entry) => entry.status === "failure")).toEqual([])
    })
  })

  test("post-export drift: a deleted session turns both reconciliation oracles into failures", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "drift.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const chain = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "drill" }),
      )
      expect(chain.status).toBe("completed")

      // The library changes AFTER the export: one session (and its messages) disappears.
      await Effect.runPromise(db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_two"))).run())
      await Effect.runPromise(db.delete(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make("ses_two"))).run())

      const report = await Effect.runPromise(MigrationReport.generate({ db, dbPath: filename, backupDir }))
      expect(report.overall).toBe("failure")
      const byCheck = new Map(report.entries.map((entry) => [entry.check, entry]))
      // md manifest↔library: the manifest still lists the deleted session → extra.
      expect(byCheck.get("md_reconcile")?.status).toBe("failure")
      expect(report.mdReconciliation.extra).toEqual(["ses_two"])
      // row reconciliation: export-time counts no longer match the library.
      expect(byCheck.get("row_reconcile")?.status).toBe("failure")
      expect(report.rowReconciliation).toMatchObject({ sessionsInLibrary: 1, sessionsInManifest: 2, reconciled: false })
    })
  })

  test("failed chain: the failing journal phase surfaces as a failure entry with guidance", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "failed.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")
    // Crash-window residue: backup_create fails with backup_exists.
    await Bun.write(path.join(backupDir, "failed.db"), "residue of an interrupted attempt")

    await withDatabase(filename, async (db) => {
      const chain = await Effect.runPromise(
        MigrationOrchestrator.run({ db, dbPath: filename, backupDir, backupFileName: "failed" }),
      )
      expect(chain.status).toBe("failed")

      const report = await Effect.runPromise(MigrationReport.generate({ db, dbPath: filename, backupDir }))
      expect(report.overall).toBe("failure")
      const journalEntry = report.entries.find((entry) => entry.check === "journal:backup_create")
      expect(journalEntry?.status).toBe("failure")
      expect(journalEntry?.summary).toContain("backup_")
      // post_verify never ran under this chain → warning, not a fabricated pass.
      expect(report.entries.find((entry) => entry.check === "post_verify")?.status).toBe("warning")
    })
  })

  test("read: a missing report is exists:false, never an error", async () => {
    await using tmp = await tmpdir()
    const stored = await Effect.runPromise(MigrationReport.read(MigrationReport.reportPathFor(tmp.path)))
    expect(stored).toBeUndefined()
  })
})
