import { describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Git } from "@deepagent-code/core/git"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { DeepAgentEventOutboxTable } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertReplaceableSession, importSession } from "../session"
import { blockID, messageID, sessionID } from "../../util/ids"
import type { SourceSession } from "../../ir"
import { ImportBatchReceiptTable } from "@deepagent-code/core/import-job.sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { Exit, Deferred, Fiber } from "effect"
import { ImportJob } from "@deepagent-code/core/import-job"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { mapSession } from "../../map/events"

function sample(): SourceSession {
  return {
    source: "codex",
    sourceId: "integ-019f1b59",
    cwd: "/tmp/integ-proj",
    title: "集成测试会话",
    startedMs: 1_782_870_400_000,
    updatedMs: 1_782_870_410_000,
    model: { id: "gpt-5", providerID: "openai" },
    turns: [
      { kind: "user", text: "写一个 hello world", timestampMs: 1_782_870_401_000 },
      {
        kind: "assistant",
        timestampMs: 1_782_870_402_000,
        completedMs: 1_782_870_405_000,
        blocks: [
          { type: "reasoning", text: "用 python" },
          { type: "text", text: "print('hello')" },
          { type: "tool", callID: "c1", name: "bash", input: { command: "echo hi" }, output: "hi" },
          { type: "tool", callID: "c2", name: "bash", input: { command: "exit 1" }, error: "imported failure" },
          { type: "text", text: "" },
        ],
        finish: "stop",
        cost: 0.002,
        tokens: { input: 10, output: 5 },
      },
    ],
  }
}

function withRuntime(dbPath: string, program: Effect.Effect<any, any, any>): Promise<any> {
  const database = Database.layerFromPath(dbPath)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(events), Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const projects = ProjectV2.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(Layer.provide([events, database, store, projects, SessionExecution.noopLayer]))
  const runtime = Layer.mergeAll(database, events, bridge, projector, projects, sessions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Effect.runPromise(program.pipe(Effect.provide(runtime as any)) as any)
}

function fixtureProgress(test: string) {
  const started = performance.now()
  return (stage: string) => {
    // A Windows timeout must identify whether fixture setup, the writer, or scope cleanup was last active.
    console.info(
      "[import-session-fixture]",
      JSON.stringify({ test, stage, elapsedMs: Math.round(performance.now() - started) }),
    )
  }
}

describe("import writer/session (integration)", () => {
  it("rolls back prior history, event/outbox replacement and receipt when a replay batch fails", async () => {
    const dbPath = join(tmpdir(), `imp-atomic-${crypto.randomUUID()}.sqlite`)
    const progress = fixtureProgress("rollback-replay")
    progress("runtime-open")
    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        progress("runtime-ready")
        const original = yield* importSession(sample())
        progress("initial-imported")
        const before = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, original.targetId))
          .all()
          .pipe(Effect.orDie)
        yield* db
          .run(
            "CREATE TRIGGER import_fail_replay BEFORE INSERT ON event WHEN NEW.seq = 1 BEGIN SELECT RAISE(ABORT, 'fixture batch failure'); END",
          )
          .pipe(Effect.orDie)
        progress("rollback-import-start")
        const failed = yield* importSession(
          { ...sample(), title: "must roll back" },
          { jobID: "fixture-atomic", batchID: "0", sourceDigest: "a".repeat(64) },
        ).pipe(Effect.exit)
        progress("rollback-import-settled")
        expect(Exit.isFailure(failed)).toBe(true)
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, original.targetId))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(before)
        expect(
          (yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make(original.targetId)))
            .get()
            .pipe(Effect.orDie))?.title,
        ).toBe(sample().title)
        expect(yield* db.select().from(ImportBatchReceiptTable).all().pipe(Effect.orDie)).toEqual([])
        yield* db.run("DROP TRIGGER import_fail_replay").pipe(Effect.orDie)
        progress("replacement-import-start")
        const completed = yield* importSession(
          { ...sample(), title: "committed replacement" },
          { jobID: "fixture-atomic", batchID: "0", sourceDigest: "a".repeat(64) },
        )
        progress("replacement-imported")
        expect("kind" in completed).toBe(false)
        if ("kind" in completed) throw new Error("Session import returned a file receipt")
        expect(completed.reimport).toBe(true)
        expect(yield* db.select().from(ImportBatchReceiptTable).all().pipe(Effect.orDie)).toMatchObject([
          { job_id: "fixture-atomic", batch_id: "0", target_id: original.targetId },
        ])
        const stable = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, original.targetId))
          .all()
          .pipe(Effect.orDie)
        progress("receipt-replay-start")
        yield* importSession(sample(), { jobID: "fixture-atomic", batchID: "0", sourceDigest: "a".repeat(64) })
        progress("receipt-replayed")
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, original.targetId))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(stable)
        progress("assertions-complete")
      }).pipe(Effect.onExit((exit) => Effect.sync(() => progress(`program-${exit._tag.toLowerCase()}`)))),
    ).finally(() => progress("runtime-settled"))
  })
  it("a paused old batch cannot write after an explicit cold stop was confirmed", async () => {
    const root = join(tmpdir(), `imp-late-${crypto.randomUUID()}`)
    const progress = fixtureProgress("cold-stop")
    progress("target-runtime-open")
    await withRuntime(
      `${root}-target.sqlite`,
      Effect.gen(function* () {
        const target = (yield* Database.Service).db
        progress("target-runtime-ready")
        progress("control-runtime-open")
        yield* Effect.gen(function* () {
          const control = yield* Database.Service
          progress("control-runtime-ready")
          const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
            Effect.runPromise(effect.pipe(Effect.provideService(Database.Service, control)))
          const admitted = yield* ImportJob.create({
            id: "late-job",
            request: { requestID: "late-request", source: "codex" },
            digest: "a".repeat(64),
            targetKey: `${root}-target.sqlite`,
            migrationDigest: "fixture",
            ownerID: "paused-owner",
          })
          const running = (yield* ImportJob.update({
            id: "late-job",
            ownerID: "paused-owner",
            revision: admitted.row.revision,
            patch: { state: "running" },
          }))!
          yield* ImportJob.beginBatch({
            id: "late-job",
            ownerID: "paused-owner",
            revision: running.revision,
            batchID: "0",
          })
          progress("batch-admitted")
          const paused = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          // Pause the admitted producer before calling the actual destination writer.
          // The gate changes timing only; admission, expiry, stop and write fencing are real.
          const old = yield* Effect.gen(function* () {
            yield* Deferred.succeed(paused, undefined)
            yield* Deferred.await(resume)
            return yield* importSession(sample(), {
              jobID: "late-job",
              batchID: "0",
              sourceDigest: "a".repeat(64),
              assertAuthority: ImportJob.assertBatchAuthority({
                id: "late-job",
                ownerID: "paused-owner",
                batchID: "0",
              }).pipe(Effect.provideService(Database.Service, control)),
            }).pipe(Effect.provideService(Database.Service, { db: target }), Effect.exit)
          }).pipe(Effect.forkChild)
          yield* Deferred.await(paused)
          progress("producer-paused")
          yield* control.db.run("UPDATE import_job SET owner_lease_expires_at = 1").pipe(Effect.orDie)
          const cancelled = yield* ImportJob.requestCancel("late-job")
          progress("cancel-requested")
          progress("destination-fence-start")
          const stopped = yield* ImportJob.withDestinationFence(`${root}-target.sqlite`, () =>
            run(ImportJob.confirmStopped({ id: "late-job", revision: cancelled.revision, count: 0, known: true })),
          )
          progress("destination-fence-settled")
          expect(stopped?.state).toBe("cancelled")
          expect(stopped?.stop_confirmed_at).toBeGreaterThan(0)
          yield* Deferred.succeed(resume, undefined)
          progress("producer-resumed")
          expect(Exit.isFailure(yield* Fiber.join(old))).toBe(true)
          progress("producer-denied")
          expect(yield* target.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
          expect(yield* target.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
          expect(yield* target.select().from(ImportBatchReceiptTable).all().pipe(Effect.orDie)).toEqual([])
          progress("assertions-complete")
        }).pipe(Effect.provide(Layer.fresh(Database.layerFromPath(`${root}-control.sqlite`))))
        progress("control-runtime-closed")
      }).pipe(Effect.onExit((exit) => Effect.sync(() => progress(`program-${exit._tag.toLowerCase()}`)))),
    ).finally(() => progress("target-runtime-settled"))
  })

  it("preserves a real native V2 Session and admit-only input at an imported stable ID", async () => {
    const dbPath = join(tmpdir(), `imp-native-${crypto.randomUUID()}.sqlite`)
    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const db = (yield* Database.Service).db
        const native = yield* sessions.create({
          id: SessionSchema.ID.make(sessionID(sample().source, sample().sourceId)),
          title: "native user work",
          location: Location.Ref.make({ directory: AbsolutePath.make(sample().cwd) }),
        })
        yield* sessions.prompt({
          sessionID: native.id,
          prompt: new Prompt({ text: "preserve my queued work" }),
          resume: false,
        })
        const before = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, native.id))
          .all()
          .pipe(Effect.orDie)
        expect(Exit.isFailure(yield* importSession(sample()).pipe(Effect.exit))).toBe(true)
        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, native.id)).all().pipe(Effect.orDie),
        ).toEqual(before)
        expect((yield* db.select().from(SessionTable).get().pipe(Effect.orDie))?.title).toBe("native user work")
        expect(yield* db.all("SELECT prompt, promoted_seq FROM session_input").pipe(Effect.orDie)).toEqual([
          { prompt: JSON.stringify({ text: "preserve my queued work" }), promoted_seq: null },
        ])
      }),
    )
  })

  it.each(["adopted", "claimed", "mutated", "pending", "local-history"])(
    "refuses %s history in the same replacement transaction",
    async (kind) => {
      const dbPath = join(tmpdir(), `imp-protected-${crypto.randomUUID()}.sqlite`)
      await withRuntime(
        dbPath,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const original = yield* importSession(sample())
          expect(yield* assertReplaceableSession(sample())).toBe(true)
          // These durable rows represent a different owner arriving AFTER the read-only
          // preflight. No importer lock is involved: the replacement must re-read under
          // SQLite's writer transaction and preserve all authority and local history.
          if (kind === "adopted")
            yield* db.run("UPDATE session SET v2_authority = 1, title = 'adopted local work'").pipe(Effect.orDie)
          if (kind === "claimed") yield* db.run("UPDATE session SET execution_claim_token = 42").pipe(Effect.orDie)
          if (kind === "mutated") yield* db.run("UPDATE session SET mutation_epoch = 1").pipe(Effect.orDie)
          if (kind === "pending")
            yield* db
              .run(
                "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('msg_pending', '" +
                  original.targetId +
                  "', '{\"text\":\"new work\"}', 'steer', 999, 1)",
              )
              .pipe(Effect.orDie)
          if (kind === "local-history") {
            const history = yield* db
              .select()
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, original.targetId))
              .all()
              .pipe(Effect.orDie)
            const changed = mapSession({ ...sample(), title: "locally changed title" }, { projectID: "global" })[0]!
            yield* (yield* EventV2Bridge.Service)
              .replayAll([{ ...changed, id: EventV2.ID.create(), seq: history.length, type: "session.updated.1" }], {
                strictOwner: true,
              })
              .pipe(Effect.orDie)
          }
          const before = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, original.targetId))
            .all()
            .pipe(Effect.orDie)
          const session = yield* db.select().from(SessionTable).get().pipe(Effect.orDie)
          expect(Exit.isFailure(yield* assertReplaceableSession(sample()).pipe(Effect.exit))).toBe(true)
          expect(
            Exit.isFailure(
              yield* importSession(
                { ...sample(), title: "must never replace" },
                { jobID: "protected", batchID: "0", sourceDigest: "b".repeat(64) },
              ).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* db.select().from(SessionTable).get().pipe(Effect.orDie)).toEqual(session)
          expect(
            yield* db
              .select()
              .from(EventTable)
              .where(eq(EventTable.aggregate_id, original.targetId))
              .all()
              .pipe(Effect.orDie),
          ).toEqual(before)
          expect(yield* db.select().from(ImportBatchReceiptTable).all().pipe(Effect.orDie)).toEqual([])
        }),
      )
    },
  )

  it("replays a session into session + session_message projections", async () => {
    const dbPath = join(tmpdir(), `imp-${Date.now()}.sqlite`)
    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* importSession(sample())
        const target = SessionSchema.ID.make(result.targetId)

        const sessionRow = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, target))
          .get()
          .pipe(Effect.orDie)
        expect(sessionRow).toBeTruthy()
        expect(sessionRow!.title).toBe("集成测试会话")

        // Import replay uses the same bridge as live publishes: the session.created
        // fact lands in the C5 outbox in the event transaction.
        const outbox = yield* db.select().from(DeepAgentEventOutboxTable).all().pipe(Effect.orDie)
        expect(outbox.map((row) => row.event_type)).toContain("session.created")

        const msgs = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, target))
          .all()
          .pipe(Effect.orDie)
        const types = msgs.map((m) => m.type).sort()
        expect(types).toContain("user")
        expect(types).toContain("assistant")
        const assistant = msgs.find((message) => message.type === "assistant")!
        expect(assistant.id).toBe(SessionMessage.ID.make(messageID(sample().sourceId, 1, "assistant")))
        expect(
          Schema.decodeUnknownSync(SessionMessage.Message)({
            ...assistant.data,
            id: assistant.id,
            type: assistant.type,
          }),
        ).toMatchObject({
          finish: "stop",
          cost: 0.002,
          content: [
            { type: "reasoning", id: blockID(sample().sourceId, 1, 0), text: "用 python" },
            { type: "text", id: blockID(sample().sourceId, 1, 1), text: "print('hello')" },
            {
              type: "tool",
              id: "c1",
              name: "bash",
              provider: { executed: true },
              state: {
                status: "completed",
                input: { command: "echo hi" },
                structured: { output: "hi" },
                content: [{ type: "text", text: "hi" }],
              },
            },
            {
              type: "tool",
              id: "c2",
              name: "bash",
              provider: { executed: true },
              state: {
                status: "error",
                input: { command: "exit 1" },
                error: { type: "unknown", message: "imported failure" },
              },
            },
            { type: "text", id: blockID(sample().sourceId, 1, 4), text: "" },
          ],
        })
      }),
    )
  })

  it("is idempotent: re-import converges without duplicates", async () => {
    const dbPath = join(tmpdir(), `imp-idem-${Date.now()}.sqlite`)
    const target = SessionSchema.ID.make(sessionID("codex", "integ-019f1b59"))
    await withRuntime(dbPath, importSession(sample()))
    const second = (await withRuntime(dbPath, importSession(sample()))) as { reimport: boolean; targetId: string }
    expect(second.reimport).toBe(true)
    expect(second.targetId).toBe(target)

    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessions = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, target))
          .all()
          .pipe(Effect.orDie)
        expect(sessions.length).toBe(1)
        const outbox = yield* db.select().from(DeepAgentEventOutboxTable).all().pipe(Effect.orDie)
        expect(outbox.filter((row) => row.event_type === "session.created")).toHaveLength(1)
        const msgs = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, target))
          .all()
          .pipe(Effect.orDie)
        // Exactly one user + one assistant after two imports (delete-then-replay converged).
        expect(msgs.length).toBe(2)
        const types = msgs.map((m) => m.type).sort()
        expect(types).toEqual(["assistant", "user"])
        const assistant = msgs.find((message) => message.type === "assistant")!
        const message = Schema.decodeUnknownSync(SessionMessage.Message)({
          ...assistant.data,
          id: assistant.id,
          type: assistant.type,
        })
        if (message.type !== "assistant") throw new Error("Imported assistant projection has the wrong type")
        expect(message.content).toHaveLength(5)
        expect(message.content).toMatchObject([
          { type: "reasoning", text: "用 python" },
          { type: "text", text: "print('hello')" },
          { type: "tool", id: "c1", state: { status: "completed" } },
          { type: "tool", id: "c2", state: { status: "error" } },
          { type: "text", text: "" },
        ])
      }),
    )
  })

  it("refuses a session whose cwd resolves to the filesystem root", async () => {
    // A "/"-rooted session can never be opened later (the instance boot guard rejects it), so the
    // importer must fail this session rather than persist a permanently-unopenable conversation.
    const dbPath = join(tmpdir(), `imp-root-${Date.now()}.sqlite`)
    const rootSession: SourceSession = { ...sample(), sourceId: "integ-root", cwd: "/" }
    let threw = false
    try {
      await withRuntime(dbPath, importSession(rootSession))
    } catch (err) {
      threw = true
      expect(String(err)).toContain("filesystem root")
    }
    expect(threw).toBe(true)

    // Nothing was persisted for the refused session.
    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const target = SessionSchema.ID.make(sessionID("codex", "integ-root"))
        const rows = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, target))
          .all()
          .pipe(Effect.orDie)
        expect(rows.length).toBe(0)
      }),
    )
  })
})
