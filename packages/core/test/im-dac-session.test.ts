import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ProjectV2 } from "../src/project"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionStore } from "../src/session/store"
import { SessionProjector } from "../src/session/projector"
import { SessionInputTable } from "../src/session/sql"
import { IMDacSession } from "../src/im/dac-session"
import { IMDacSessionSchema } from "../src/im/dac-session.schema"
import { IMDacCommandTable } from "../src/im/dac-session.sql"
import { MessageTable } from "../src/im/sql"
import { AbsolutePath } from "../src/schema"
import { projectLayer } from "./fixture/project-layer"
import { testEffect } from "./lib/effect"

const root = mkdtempSync(path.join(os.tmpdir(), "dac-personal-session-"))
const database = Layer.suspend(() => Database.layerFromPath(path.join(root, `${crypto.randomUUID()}.sqlite`)))
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = projectLayer(database)
const sessions = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))),
  Layer.provide(events), Layer.provide(database), Layer.provide(projects), Layer.orDie,
)
const it = testEffect(Layer.mergeAll(database, projects, sessions))
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const project = yield* (yield* ProjectV2.Service).resolve(AbsolutePath.make(root))
  const bridge = IMDacSession.make(db, yield* SessionV2.Service)
  return { db, bridge, scope: { ownerID: "server", accountKey: "account-1", executorID: "executor-1", conversationKey: "direct:alice",
    groupID: "img_personal", projectID: project.id, directory: root, workspaceID: null } satisfies IMDacSession.Scope }
})
const submit = (commandID = crypto.randomUUID()) => IMDacSessionSchema.Submit.make({ commandID, text: "Read the project and explain the result.", delivery: "queue" })

describe("personal IM ordinary Session bridge (file SQLite)", () => {
  it.effect("captures the selected IM model once per command and keeps the conversation Session", () => Effect.gen(function* () {
    const f = yield* fixture
    const input = submit()
    const first = yield* f.bridge.submit({ ...f.scope, model: { providerID: "deepseek", id: "deepseek-flash" } }, input, Effect.succeed([]))
    const exact = yield* f.bridge.submit({ ...f.scope, model: { providerID: "another", id: "changed-model" } }, input, Effect.succeed([]))
    const next = yield* f.bridge.submit({ ...f.scope, model: { providerID: "deepseek", id: "another-model" } }, submit(), Effect.succeed([]))
    expect(exact.inputID).toBe(first.inputID)
    expect(next.sessionID).toBe(first.sessionID)
    const rows = yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.prompt.model)).toEqual([
      { providerID: "deepseek", id: "deepseek-flash" }, { providerID: "deepseek", id: "another-model" },
    ])
  }))
  it.effect("admits privately once and adopts the same Session for queue and steer", () => Effect.gen(function* () {
    const f = yield* fixture
    expect((yield* f.bridge.binding(f.scope)).sessionID).toBeNull()
    const input = submit()
    const first = yield* f.bridge.submit(f.scope, input, Effect.succeed([]))
    const exact = yield* f.bridge.submit(f.scope, input, Effect.succeed([]))
    const next = yield* f.bridge.submit(f.scope, { ...submit(), delivery: "steer" }, Effect.succeed([]))
    expect(first.state).toBe("admitted")
    expect(exact.inputID).toBe(first.inputID)
    expect(next.sessionID).toBe(first.sessionID)
    expect(next.inputID).not.toBe(first.inputID)
    const rows = yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.delivery)).toEqual(["queue", "steer"])
    expect(yield* f.db.select().from(MessageTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }))
  it.effect("conflicting exact command ID cannot mutate the input or create another Session", () => Effect.gen(function* () {
    const f = yield* fixture
    const input = submit()
    const first = yield* f.bridge.submit(f.scope, input, Effect.succeed([]))
    const error = yield* Effect.flip(f.bridge.submit(f.scope, { ...input, text: "changed", newSession: true }, Effect.succeed([])))
    expect(error).toMatchObject({ code: "command_conflict" })
    expect((yield* f.bridge.binding(f.scope)).sessionID).toBe(first.sessionID)
    expect(yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }))
  it.effect("new Session is chosen once even for concurrent exact retries; old command history stays bound", () => Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.bridge.submit(f.scope, submit(), Effect.succeed([]))
    const input = { ...submit(), newSession: true }
    const values = yield* Effect.forEach([0, 1, 2, 3], () => f.bridge.submit(f.scope, input, Effect.succeed([])), { concurrency: "unbounded" })
    expect(new Set(values.map((value) => value.inputID)).size).toBe(1)
    expect(values[0]!.sessionID).not.toBe(first.sessionID)
    expect((yield* f.bridge.command(f.scope, first.commandID)).sessionID).toBe(first.sessionID)
    expect(yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(2)
  }))
  it.effect("account and owner are part of the binding, independent of transport token generations", () => Effect.gen(function* () {
    const f = yield* fixture
    const input = submit()
    const first = yield* f.bridge.submit(f.scope, input, Effect.succeed([]))
    const account = yield* f.bridge.submit({ ...f.scope, accountKey: "account-2" }, input, Effect.succeed([]))
    const owner = yield* f.bridge.submit({ ...f.scope, ownerID: "another-owner" }, input, Effect.succeed([]))
    expect(new Set([first.sessionID, account.sessionID, owner.sessionID]).size).toBe(3)
    expect((yield* f.bridge.binding(f.scope)).sessionID).toBe(first.sessionID)
  }))
  it.effect("references are captured once and exact retry preserves their original bytes", () => Effect.gen(function* () {
    const f = yield* fixture
    const input = { ...submit(), referenceMessageIDs: ["imsg_reference"] }
    const first = yield* f.bridge.submit(f.scope, input, Effect.succeed([{ messageID: "imsg_reference", content: "original quoted bytes" }]))
    yield* f.bridge.submit(f.scope, input, Effect.succeed([{ messageID: "imsg_reference", content: "later changed" }]))
    const row = yield* f.db.select().from(IMDacCommandTable).where(eq(IMDacCommandTable.input_id, first.inputID)).get().pipe(Effect.orDie)
    expect(row?.references).toEqual([{ messageID: "imsg_reference", content: "original quoted bytes" }])
    const denied = yield* Effect.flip(f.bridge.submit(f.scope, { ...submit(), referenceMessageIDs: ["absent"] }, Effect.fail(new IMDacSessionSchema.Error({ code: "reference_unavailable" }))))
    expect(denied).toMatchObject({ code: "reference_unavailable" })
    expect(yield* f.db.select().from(IMDacCommandTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }))
  it.effect("repairs a crash after durable admission without duplicating the input or promoting it", () => Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.bridge.submit(f.scope, submit(), Effect.succeed([]))
    yield* f.db.update(IMDacCommandTable).set({ state: "pending", admitted_at: null }).where(eq(IMDacCommandTable.input_id, first.inputID)).run().pipe(Effect.orDie)
    yield* f.bridge.reconcile(f.scope)
    expect((yield* f.bridge.command(f.scope, first.commandID)).state).toBe("admitted")
    const rows = yield* f.db.select().from(SessionInputTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.promoted_seq).toBeNull()
  }))
})
