import { describe, expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { sha256File } from "@deepagent-code/core/database/file-sha256"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { MdExport } from "../../src/server/md-export"
import { tmpdir } from "../fixture/fixture"

// W-02 M-1 acceptance (design §3.4): a fixture library with several sessions exports one MD per
// session with a zero-diff manifest reconciliation; an interrupted run resumes by skipping the
// sessions the manifest already covers; a torn file is repaired; a corrupt session stops the
// export honestly without corrupting the manifest.

type DatabaseService = Database.Interface["db"]

const encodeMessage = Schema.encodeSync(SessionMessage.Message)

/** A user + assistant turn (and optionally a compaction checkpoint) as durable session_message rows. */
async function seedSession(db: DatabaseService, input: {
  id: string
  title: string
  created: number
  text: string
  reply: string
  compaction?: string
}) {
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
      content: [
        new SessionMessage.AssistantText({ type: "text", id: `prt_${input.id}_a_0`, text: input.reply }),
      ],
      time,
    }),
  )
  const compaction = input.compaction
    ? [
        encodeMessage(
          new SessionMessage.Compaction({
            id: SessionMessage.ID.make(`msg_${input.id}_c`),
            type: "compaction",
            reason: "auto",
            summary: input.compaction,
            recent: "",
            time,
          }),
        ),
      ]
    : []
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
  let seq = 0
  for (const message of [...compaction, user, assistant]) {
    seq += 1
    const { id: _, type, ...data } = message
    await Effect.runPromise(
      db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(message.id),
          session_id: SessionSchema.ID.make(input.id),
          type,
          seq,
          time_created: input.created,
          data,
        })
        .run(),
    )
  }
}

/** Seed a three-session fixture: two share title+day (collision drill), one carries a compaction row. */
async function seedFixture(filename: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => seedSession(db, { id: "ses_aaa", title: "Refactor Parser", created: Date.UTC(2026, 8, 1, 10), text: "please refactor", reply: "done, 3 files changed" }))
      yield* Effect.promise(() => seedSession(db, { id: "ses_bbb", title: "Refactor Parser", created: Date.UTC(2026, 8, 1, 11), text: "second session same day", reply: "ok", compaction: "earlier turns were summarized" }))
      yield* Effect.promise(() => seedSession(db, { id: "ses_ccc", title: "Untitled", created: Date.UTC(2026, 8, 2, 9), text: "hello", reply: "hi there" }))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

/**
 * Run the whole test body inside ONE database layer scope: the exporter holds no connection of its
 * own, so the scope must stay open until every assertion (and re-invocation) has finished.
 */
async function withDatabase<A>(filename: string, body: (db: DatabaseService) => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return yield* Effect.promise(() => body(db))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

describe("MdExport (W-02 M-1)", () => {
  test("replica drill: exports one MD per session with zero-diff reconciliation", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "drill.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      const result = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      expect(result.exported).toBe(3)
      expect(result.skipped).toBe(0)
      expect(result.sessionCount).toBe(3)
      expect(result.reconciliation).toEqual({
        reconciled: true,
        exportedCount: 3,
        sessionCount: 3,
        missing: [],
        extra: [],
      })

      // Every manifest entry matches the file on disk (sha256 + content spot checks).
      const manifest = await Effect.runPromise(MdExport.readManifest(MdExport.manifestPathFor(backupDir)))
      expect(manifest?.entries.length).toBe(3)
      for (const entry of manifest!.entries) {
        const filePath = path.join(backupDir, "md", entry.fileName)
        expect(entry.sha256).toBe(await sha256File(filePath))
        expect(await Bun.file(filePath).text()).toContain(`**Session ID:** ${entry.sessionId}`)
      }
      // Collision drill: the two same-title-same-day sessions produce distinct file names.
      expect(new Set(manifest!.entries.map((entry) => entry.fileName)).size).toBe(3)
      // Compaction checkpoint renders through the V1 marker convention.
      const compactionFile = manifest!.entries.find((entry) => entry.sessionId === "ses_bbb")!
      const body = await Bun.file(path.join(backupDir, "md", compactionFile.fileName)).text()
      expect(body).toContain("Context compaction checkpoint")
      expect(body).toContain("earlier turns were summarized")
      // The canonical formatter renders the conversation itself.
      const plain = manifest!.entries.find((entry) => entry.sessionId === "ses_ccc")!
      const plainBody = await Bun.file(path.join(backupDir, "md", plain.fileName)).text()
      expect(plainBody).toContain("hello")
      expect(plainBody).toContain("hi there")
    })
  })

  test("interruption: a limited run resumes and skips already-exported sessions", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "resume.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      // Interrupted after one session (limit=1): the manifest is a valid partial resume point.
      const partial = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename, limit: 1 }))
      expect(partial.exported).toBe(1)
      expect(partial.skipped).toBe(0)
      expect(partial.reconciliation.reconciled).toBe(false)
      expect(partial.reconciliation.missing.length).toBe(2)

      // Resume: the first session is skipped (manifest entry + matching file), the rest export.
      const resumed = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      expect(resumed.exported).toBe(2)
      expect(resumed.skipped).toBe(1)
      expect(resumed.reconciliation).toMatchObject({ reconciled: true, exportedCount: 3, sessionCount: 3 })

      // A no-op third invocation skips everything.
      const again = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      expect(again.exported).toBe(0)
      expect(again.skipped).toBe(3)
    })
  })

  test("interruption: a torn export file is detected and repaired on resume", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "torn.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      const manifest = await Effect.runPromise(MdExport.readManifest(MdExport.manifestPathFor(backupDir)))
      const victim = manifest!.entries[0]!
      await Bun.write(path.join(backupDir, "md", victim.fileName), "# torn half-written file")

      const repaired = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      expect(repaired.exported).toBe(1)
      expect(repaired.skipped).toBe(2)
      expect(repaired.reconciliation.reconciled).toBe(true)
      const healed = await Bun.file(path.join(backupDir, "md", victim.fileName)).text()
      expect(healed).toContain(`**Session ID:** ${victim.sessionId}`)
    })
  })

  test("failure honesty: a corrupt session stops the export and the manifest stays resumable", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "corrupt.db")
    await seedFixture(filename)
    const backupDir = path.join(tmp.path, "backups")

    await withDatabase(filename, async (db) => {
      // One session's durable rows no longer decode (schema divergence); it sorts AFTER ses_aaa.
      await Effect.runPromise(
        db
          .update(SessionMessageTable)
          .set({ data: {} as typeof SessionMessageTable.$inferInsert.data })
          .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_bbb")))
          .run(),
      )

      const failure = await Effect.runPromise(Effect.flip(MdExport.run({ db, backupDir, sourcePath: filename })))
      expect(failure.code).toBe("session_failed")
      expect(failure.sessionId).toBe("ses_bbb")
      // ses_aaa completed and is a valid resume point; the corrupt session has no entry.
      const partial = await Effect.runPromise(MdExport.readManifest(MdExport.manifestPathFor(backupDir)))
      expect(partial?.entries.map((entry) => entry.sessionId)).toEqual(["ses_aaa"])

      // Removing the corrupt rows lets the run complete — no half-exported state remains.
      await Effect.runPromise(
        db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_bbb"))).run(),
      )
      const recovered = await Effect.runPromise(MdExport.run({ db, backupDir, sourcePath: filename }))
      expect(recovered.exported).toBe(2)
      expect(recovered.skipped).toBe(1)
      expect(recovered.reconciliation).toMatchObject({ reconciled: true, exportedCount: 3 })
    })
  })
})
