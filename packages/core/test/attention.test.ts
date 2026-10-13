import { describe, expect } from "bun:test"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Attention } from "../src/attention"
import { AttentionSchema } from "../src/attention/schema"
import { AttentionSeenTable } from "../src/attention/sql"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { SessionContext } from "../src/context-federation/session-context"
import { ContextArtifactStore } from "../src/context-federation/artifact-store"
import { ContextTokenCodec } from "../src/context-federation/token-codec"
import { SecurityNamespaceID } from "../src/context-federation/reference"
import { EventTable } from "../src/event/sql"
import { SessionExecution } from "../src/session/execution"
import { SessionTable, TaskRunTable } from "../src/session/sql"
import { SessionSchema } from "../src/session/schema"
import { MessageID } from "../src/v1/session"
import { SessionStore } from "../src/session/store"
import { Project } from "../src/project"
import { testEffect } from "./lib/effect"
import { capability, seedActivity, seedRecovery, seedSession, services, temporary } from "./fixture/attention"

const it = testEffect(Layer.empty)
const changes = (database: Database.Interface) =>
  database.db.get<{ value: number }>(sql`SELECT total_changes() AS value`).pipe(Effect.orDie)

describe("durable attention", () => {
  it.live("upgrades a previous file schema without rewriting durable source history", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      const filename = path.join(directory, "upgrade.db")
      yield* Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* DatabaseMigration.applyOnly(
          db,
          migrations.slice(
            0,
            migrations.findIndex((migration) => migration.id === "20261006073407_attention_seen"),
          ),
        )
        const session = yield* seedSession({ db }, "upgrade")
        yield* seedActivity({ db }, session, "upgrade")
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'attention_seen'`)).toBeUndefined()
      }).pipe(Effect.provide(SqliteClient.layer({ filename })))
      yield* Effect.gen(function* () {
        const attention = yield* Attention.Service
        const database = yield* Database.Service
        expect((yield* attention.list()).data).toMatchObject([
          { source: { activityID: "activity_upgrade" }, seen: false },
        ])
        expect(
          yield* database.db
            .get(sql`SELECT name FROM sqlite_master WHERE name = 'session_activity_attention_failed_idx'`)
            .pipe(Effect.orDie),
        ).toEqual({ name: "session_activity_attention_failed_idx" })
        const item = (yield* attention.list()).data[0]!
        expect(yield* attention.seen(item.id, item.revision)).toMatchObject({ seen: true })
      }).pipe(Effect.provide(services(filename)))
    }),
  )

  it.live("scans both projects, preserves six recovery dispositions and reads without writes or wakes", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        const dispositions = [
          "claim_only",
          "safe_before_dispatch",
          "recovery_required",
          "terminal_consistent",
          "authority_conflict",
          "owned_elsewhere",
        ] as const
        yield* Effect.forEach(dispositions, (disposition, index) =>
          seedRecovery(database, disposition, disposition, { project: index % 2 ? "project-b" : "project-a" }),
        )
        const session = yield* seedSession(database, "failed", { project: "project-b" })
        yield* seedActivity(database, session, "failure-a", "failed", 200)
        yield* seedActivity(database, session, "failure-b", "failed", 300)
        yield* seedActivity(database, session, "interrupted", "interrupted", 400)
        yield* seedActivity(database, session, "settled", "settled", 500)
        const remote = yield* seedRecovery(database, "remote", "recovery_required", { workspace: "wrk_private" })
        yield* seedActivity(database, remote, "remote", "failed", 600)
        const legacy = yield* seedSession(database, "legacy", { native: false })
        yield* seedActivity(database, legacy, "legacy", "failed", 700)
        const before = yield* changes(database)
        const first = yield* attention.list({ limit: 2 })
        expect(first.unseenCount).toBe(8)
        expect(first.data).toHaveLength(2)
        const pages: AttentionSchema.Item[] = []
        const read = (cursor?: string): Effect.Effect<void, Attention.Unavailable | Attention.Invalid> =>
          attention.list({ limit: 2, cursor }).pipe(
            Effect.flatMap((page) => {
              expect(page.unseenCount).toBe(8)
              pages.push(...page.data)
              return page.nextCursor ? read(page.nextCursor) : Effect.void
            }),
          )
        yield* read()
        expect(pages).toHaveLength(8)
        expect(new Set(pages.map((item) => item.id)).size).toBe(8)
        expect(
          pages
            .filter((item) => item.kind === "execution_recovery")
            .map((item) => item.reasonCode)
            .sort(),
        ).toEqual([...dispositions].sort())
        expect(
          pages
            .filter((item) => ["claim_only", "safe_before_dispatch", "terminal_consistent"].includes(item.reasonCode))
            .every((item) => item.state === "execution_claim_pending"),
        ).toBe(true)
        expect(new Set(pages.map((item) => item.session.projectID)).size).toBe(2)
        expect(pages.filter((item) => item.kind === "activity_failed").map((item) => item.source.activityID)).toEqual([
          "activity_failure-b",
          "activity_failure-a",
        ])
        expect(JSON.stringify(pages)).not.toContain("claimToken")
        expect(JSON.stringify(pages)).not.toContain("12345")
        yield* Effect.forEach(pages, (item) => attention.get(item.id))
        expect(yield* changes(database)).toEqual(before)
        expect(yield* attention.get("activity:activity_remote").pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        expect(
          yield* attention.list({ cursor: first.nextCursor, project: "project-b", limit: 2 }).pipe(Effect.flip),
        ).toBeInstanceOf(Attention.Invalid)
        expect(yield* attention.list({ cursor: first.nextCursor, view: "unseen" }).pipe(Effect.flip)).toBeInstanceOf(
          Attention.Invalid,
        )
        expect(yield* attention.list({ cursor: "bad" }).pipe(Effect.flip)).toBeInstanceOf(Attention.Invalid)
        expect(yield* attention.list({ kind: "activity_failed" })).toMatchObject({ unseenCount: 2 })
        expect(yield* attention.list({ project: "project-b" })).toMatchObject({ unseenCount: 5 })
      }).pipe(Effect.provide(services(path.join(directory, "attention.db"))))
    }),
  )

  it.live("seen survives a file database reopen and a recovery source change becomes unseen", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      const filename = path.join(directory, "attention.db")
      const marked = yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        yield* seedRecovery(database, "changing", "claim_only")
        const source = (yield* attention.list()).data[0]!
        const before = yield* changes(database)
        const seen = yield* attention.seen(source.id, source.revision)
        expect(seen.seen).toBe(true)
        expect((yield* changes(database))!.value - before!.value).toBe(1)
        expect(yield* attention.seen(source.id, source.revision)).toMatchObject({
          seen: true,
          seenAt: seen.seenAt,
          revision: seen.revision,
        })
        expect((yield* changes(database))!.value - before!.value).toBe(1)
        expect(yield* attention.list({ view: "unseen" })).toMatchObject({ data: [], unseenCount: 0 })
        expect(yield* attention.seen(source.id, "stale").pipe(Effect.flip)).toBeInstanceOf(Attention.Stale)
        expect(yield* attention.seen("activity:missing", "revision").pipe(Effect.flip)).toBeInstanceOf(
          Attention.NotFound,
        )
        return seen
      }).pipe(Effect.provide(services(filename)))
      const reopened = yield* Effect.promise(async () => {
        const child = Bun.spawn(
          [process.execPath, "run", new URL("./fixture/attention-reopen.ts", import.meta.url).pathname, filename],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, TMPDIR: "/tmp" },
          },
        )
        const [output, error, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect({ status, error }).toEqual({ status: 0, error: "" })
        return JSON.parse(output) as AttentionSchema.List
      })
      expect(reopened.data).toMatchObject([
        { id: marked.id, revision: marked.revision, seen: true, seenAt: marked.seenAt },
      ])
      expect(reopened.unseenCount).toBe(0)
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        expect(yield* attention.get(marked.id)).toMatchObject({
          seen: true,
          seenAt: marked.seenAt,
          revision: marked.revision,
        })
        // fixture-exempt: a new durable task changes the evidence behind the same suspended claim.
        yield* database.db
          .insert(TaskRunTable)
          .values({
            run_id: "task_changed",
            request_hash: "a".repeat(64),
            parent_session_id: SessionSchema.ID.make(marked.session.id),
            parent_message_id: MessageID.make("msg_change"),
            tool_call_id: "call_change",
            child_session_id: SessionSchema.ID.make("ses_changed_child"),
            generation: 1,
            delivery_mode: "background",
            phase: "research",
            state: "running",
            time_created: 1,
            time_updated: 1,
          } satisfies typeof TaskRunTable.$inferInsert)
          .run()
          .pipe(Effect.orDie)
        const changed = yield* attention.get(marked.id)
        expect(changed).toMatchObject({ id: marked.id, seen: false, reasonCode: "recovery_required" })
        expect(changed.revision).not.toBe(marked.revision)
        expect(yield* attention.seen(marked.id, marked.revision).pipe(Effect.flip)).toBeInstanceOf(Attention.Stale)
        expect(yield* database.db.select().from(AttentionSeenTable).all().pipe(Effect.orDie)).toHaveLength(1)
        expect(yield* attention.list({ limit: 1 })).toMatchObject({ unseenCount: 1 })
        yield* (yield* SessionStore.Service).release(SessionSchema.ID.make(marked.session.id), 12345)
        expect(yield* attention.get(marked.id).pipe(Effect.flip)).toBeInstanceOf(Attention.NotFound)
        expect((yield* attention.list()).data).toEqual([])
        yield* (yield* SessionStore.Service).claim(SessionSchema.ID.make(marked.session.id))
        const successor = (yield* attention.list()).data[0]!
        expect(successor.id).not.toBe(marked.id)
        expect(successor.seen).toBe(false)
      }).pipe(Effect.provide(services(filename)))
    }),
  )

  it.live("batches recovery inventory without truncating unseen totals and paginates equal timestamps", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        const session = yield* seedSession(database, "bulk")
        yield* database.db
          .insert(SessionTable)
          .values(
            Array.from({ length: 520 }, (_, index) => ({
              id: SessionSchema.ID.make(`ses_bulk_${String(index).padStart(4, "0")}`),
              project_id: Project.ID.make("project-a"),
              slug: `bulk-${index}`,
              title: `bulk-${index}`,
              directory: "/tmp/project-a",
              version: "test",
              v2_authority: true,
              execution_claim_token: index + 1,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* seedActivity(database, session, "same-time-a", "failed", 100)
        const other = yield* seedSession(database, "same-time")
        yield* seedActivity(database, other, "same-time-b", "failed", 100)
        const first = yield* attention.list({ limit: 100 })
        expect(first.unseenCount).toBe(522)
        expect(first.data).toHaveLength(100)
        const pages: AttentionSchema.Item[] = [...first.data]
        const read = (cursor?: string): Effect.Effect<void, Attention.Unavailable | Attention.Invalid> =>
          attention.list({ limit: 100, cursor }).pipe(
            Effect.flatMap((page) => {
              pages.push(...page.data)
              return page.nextCursor ? read(page.nextCursor) : Effect.void
            }),
          )
        yield* read(first.nextCursor)
        expect(new Set(pages.map((item) => item.id)).size).toBe(522)
        expect(pages.slice(-2).map((item) => item.id)).toEqual([
          "activity:activity_same-time-a",
          "activity:activity_same-time-b",
        ])
        yield* attention.seen(pages[519]!.id, pages[519]!.revision)
        expect(yield* attention.list({ view: "unseen", kind: "execution_recovery", limit: 1 })).toMatchObject({
          unseenCount: 519,
        })
      }).pipe(Effect.provide(services(path.join(directory, "attention.db"))))
    }),
  )

  it.live("a real successful drain does not clear its failed activity", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      const filename = path.join(directory, "attention.db")
      const databaseLayer = Database.layerFromPath(filename)
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const session = yield* seedSession(database, "drain")
        yield* seedActivity(database, session, "drain", "active")
        const secret = new Uint8Array(32).fill(1)
        const context = SessionContext.layer.pipe(
          Layer.provide(
            ContextArtifactStore.layer({
              securityNamespaceId: SecurityNamespaceID.make("sec_attention"),
              policy: "best_effort",
              keyId: "test",
              encryptionKey: secret,
              tokenCodec: ContextTokenCodec.make({ activeKeyId: "test", keys: [{ id: "test", secret }] }),
              limits: {
                maxItemBytes: 1000,
                maxSessionBytes: 1000,
                maxGlobalBytes: 1000,
                retentionMs: 60000,
                tokenLifetimeMs: 120000,
              },
            }),
          ),
          Layer.provide(Layer.succeed(Database.Service, database)),
        )
        yield* Effect.gen(function* () {
          const execution = yield* SessionExecution.Service
          yield* execution.resume(session)
          const events = yield* database.db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, session))
            .all()
            .pipe(Effect.orDie)
          expect(events.map((item) => item.type)).toContain("session.execution.succeeded.1")
          expect(events.map((item) => item.type)).not.toContain("session.execution.failed.1")
          expect(yield* (yield* SessionStore.Service).claimToken(session)).toBeUndefined()
          expect((yield* (yield* Attention.Service).list()).data).toMatchObject([
            { kind: "activity_failed", source: { activityID: "activity_drain" } },
          ])
        }).pipe(
          Effect.provide(
            services(
              filename,
              () =>
                SessionContext.Service.use((service) =>
                  service.settleActivity({ activityId: "activity_drain", state: "failed", now: 101 }),
                ).pipe(Effect.provide(context), Effect.orDie, Effect.asVoid),
              capability,
              Layer.succeed(Database.Service, database),
            ),
          ),
        )
      }).pipe(Effect.provide(databaseLayer))
    }),
  )

  it.live("lease renewal keeps a viewed revision stable while owner replacement invalidates it", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const attention = yield* Attention.Service
        yield* seedRecovery(database, "renewal", "owned_elsewhere")
        const item = (yield* attention.list()).data[0]!
        yield* attention.seen(item.id, item.revision)
        yield* database.db
          .update(TaskRunTable)
          .set({ lease_expires_at: Date.now() + 7_200_000, time_updated: Date.now() })
          .where(eq(TaskRunTable.run_id, "task_renewal"))
          .run()
          .pipe(Effect.orDie)
        expect(yield* attention.get(item.id)).toMatchObject({
          revision: item.revision,
          seen: true,
          reasonCode: "owned_elsewhere",
        })
        yield* database.db
          .update(TaskRunTable)
          .set({ execution_owner: "successor_owner" })
          .where(eq(TaskRunTable.run_id, "task_renewal"))
          .run()
          .pipe(Effect.orDie)
        const changed = yield* attention.get(item.id)
        expect(changed).toMatchObject({ seen: false, reasonCode: "owned_elsewhere" })
        expect(changed.revision).not.toBe(item.revision)
      }).pipe(Effect.provide(services(path.join(directory, "attention.db"))))
    }),
  )

  it.live("default, gateway and explicit workspace profiles stay disabled without disclosing scope data", () =>
    Effect.gen(function* () {
      const directory = yield* temporary
      expect(Attention.localCapability({ gateway: false })).toMatchObject({
        enabled: false,
        reason: "profile_disabled",
      })
      expect(Attention.localCapability({ gateway: true, profile: "implicit-local" })).toMatchObject({
        enabled: false,
        reason: "unsupported_host",
      })
      expect(
        Attention.localCapability({ gateway: false, profile: "implicit-local", workspaceID: "wrk_secret" }),
      ).toEqual({ ...capability, enabled: false, reason: "unsupported_host" })
      yield* Effect.gen(function* () {
        const attention = yield* Attention.Service
        expect(attention.capability).toMatchObject({ enabled: false })
        expect(yield* attention.list().pipe(Effect.flip)).toBeInstanceOf(Attention.Unavailable)
        expect(yield* attention.get("activity:any").pipe(Effect.flip)).toBeInstanceOf(Attention.Unavailable)
        expect(yield* attention.seen("activity:any", "revision").pipe(Effect.flip)).toBeInstanceOf(
          Attention.Unavailable,
        )
      }).pipe(
        Effect.provide(
          services(path.join(directory, "attention.db"), undefined, Attention.localCapability({ gateway: false })),
        ),
      )
    }),
  )
})
