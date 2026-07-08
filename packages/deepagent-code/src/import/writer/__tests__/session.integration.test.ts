import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Git } from "@deepagent-code/core/git"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importSession } from "../session"
import { sessionID } from "../../util/ids"
import type { SourceSession } from "../../ir"

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
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const projects = ProjectV2.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )
  const runtime = Layer.mergeAll(database, events, projector, projects)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Effect.runPromise(program.pipe(Effect.provide(runtime as any)) as any)
}

describe("import writer/session (integration)", () => {
  it("replays a session into session + session_message projections", async () => {
    const dbPath = join(tmpdir(), `imp-${Date.now()}.sqlite`)
    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* importSession(sample())
        const target = SessionSchema.ID.make(result.targetId)

        const sessionRow = yield* db.select().from(SessionTable).where(eq(SessionTable.id, target)).get().pipe(Effect.orDie)
        expect(sessionRow).toBeTruthy()
        expect(sessionRow!.title).toBe("集成测试会话")

        const msgs = yield* db
          .select({ id: SessionMessageTable.id, type: SessionMessageTable.type })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, target))
          .all()
          .pipe(Effect.orDie)
        const types = msgs.map((m) => m.type).sort()
        expect(types).toContain("user")
        expect(types).toContain("assistant")
      }),
    )
  })

  it("is idempotent: re-import converges without duplicates", async () => {
    const dbPath = join(tmpdir(), `imp-idem-${Date.now()}.sqlite`)
    const target = SessionSchema.ID.make(sessionID("codex", "integ-019f1b59"))
    await withRuntime(dbPath, importSession(sample()))
    const second = await withRuntime(dbPath, importSession(sample())) as { reimport: boolean; targetId: string }
    expect(second.reimport).toBe(true)
    expect(second.targetId).toBe(target)

    await withRuntime(
      dbPath,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, target)).all().pipe(Effect.orDie)
        expect(sessions.length).toBe(1)
        const msgs = yield* db
          .select({ id: SessionMessageTable.id, type: SessionMessageTable.type })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, target))
          .all()
          .pipe(Effect.orDie)
        // Exactly one user + one assistant after two imports (delete-then-replay converged).
        expect(msgs.length).toBe(2)
        const types = msgs.map((m) => m.type).sort()
        expect(types).toEqual(["assistant", "user"])
      }),
    )
  })
})
