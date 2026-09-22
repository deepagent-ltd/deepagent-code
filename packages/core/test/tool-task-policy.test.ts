import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Project } from "@deepagent-code/core/project"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_FANOUT,
  admitTaskCall,
  canRunInSharedWorkspace,
  inheritedTaskPermissions,
  resolveOutputSchema,
  resolveWorkspaceMode,
  taskLaunchRestriction,
  withTaskConcurrency,
} from "../src/tool/task-policy"
import { tmpRoot } from "./fixture/tmpdir"

describe("Core V2 task policy", () => {
  test("resolves named and automatic orchestration schemas", () => {
    const review = resolveOutputSchema("ReviewResult", "reviewer")
    const automatic = resolveOutputSchema(undefined, "reviewer")
    const research = resolveOutputSchema(undefined, "researcher")

    expect(automatic).toEqual(review)
    expect(JSON.stringify(review)).toContain("findings")
    expect(JSON.stringify(review)).toContain("verdict")
    expect(JSON.stringify(research)).toContain("keyFiles")
    expect(resolveOutputSchema("missing", "reviewer")).toBeUndefined()
    expect(resolveOutputSchema(undefined, "explore")).toBeUndefined()
  })

  test("compiles and validates the named review contract with Ajv", () => {
    const schema = resolveOutputSchema("ReviewResult", "reviewer")
    expect(schema).toBeDefined()
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema!)
    expect(
      validate({
        findings: [
          {
            severity: "high",
            category: "correctness",
            file: "src/example.ts",
            line: 12,
            summary: "Incorrect result",
            failureScenario: "Given x, returns y instead of z",
            confidence: 0.9,
          },
        ],
        verdict: "revise",
      }),
    ).toBeTrue()
    expect(validate({ findings: [], verdict: "unknown" })).toBeFalse()
  })

  test("inherits only parent restrictions and makes approvals fail closed", () => {
    expect(
      inheritedTaskPermissions(
        [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
        ],
        [{ action: "read", resource: "*.env", effect: "ask" }],
      ),
    ).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*.env", effect: "deny" },
    ])
  })

  test("permits read-only children and rejects shared-workspace writers", () => {
    expect(
      canRunInSharedWorkspace([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
      ]),
    ).toBeTrue()
    expect(canRunInSharedWorkspace([{ action: "*", resource: "*", effect: "allow" }])).toBeFalse()
    expect(
      canRunInSharedWorkspace([
        { action: "*", resource: "*", effect: "deny" },
        { action: "custom_write", resource: "*", effect: "allow" },
      ]),
    ).toBeFalse()
  })

  test("classifies write-capable agents into isolated worktree mode instead of refusing them", () => {
    const readOnly = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
    ]
    expect(resolveWorkspaceMode({ permissions: readOnly })).toBe("shared")
    // The old `shared_workspace_write` fail-closed refusal: mutation-capable agents now isolate.
    expect(resolveWorkspaceMode({ permissions: [{ action: "*", resource: "*", effect: "allow" as const }] })).toBe(
      "worktree",
    )
    expect(
      resolveWorkspaceMode({
        permissions: [
          { action: "*", resource: "*", effect: "deny" as const },
          { action: "bash", resource: "*", effect: "allow" as const },
        ],
      }),
    ).toBe("worktree")
  })

  test("rejects hidden and primary agents before launch", () => {
    expect(taskLaunchRestriction({ hidden: true, mode: "subagent", permissions: [] })).toBe("hidden")
    expect(taskLaunchRestriction({ hidden: false, mode: "primary", permissions: [] })).toBe("primary")
    expect(
      taskLaunchRestriction({
        hidden: false,
        mode: "subagent",
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
    ).toBeUndefined()
  })

  test("limits concurrent child drains per parent session", async () => {
    let active = 0
    let peak = 0
    const work = Effect.acquireUseRelease(
      Effect.sync(() => {
        active++
        peak = Math.max(peak, active)
      }),
      () => Effect.sleep("10 millis"),
      () =>
        Effect.sync(() => {
          active--
        }),
    )
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: MAX_SUBAGENT_CONCURRENCY * 3 }, () => withTaskConcurrency("concurrency-test", work)),
        { concurrency: "unbounded" },
      ),
    )
    expect(peak).toBe(MAX_SUBAGENT_CONCURRENCY)
  })
})

// ── C-P2-08 durable fan-out admission ────────────────────────────────────────────────────────

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, sessions, SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)))
}

const admissionTest = <A, E>(
  effect: (services: { db: Database.Interface["db"]; sessions: SessionV2.Interface }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    return yield* effect({ db: database.db, sessions })
  }).pipe(
    Effect.provide(stackOver(Database.layerFromPath(":memory:"))),
    Effect.scoped,
    Effect.runPromise,
  )

describe("Core V2 durable fan-out admission (C-P2-08)", () => {
  test("enforces per-message fan-out while admitting exact retries", async () => {
    await admissionTest(({ db, sessions }) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
        const messageID = SessionMessage.ID.make(`msg_${crypto.randomUUID()}`)
        const messageID2 = SessionMessage.ID.make(`msg_${crypto.randomUUID()}`)
        for (let index = 0; index < MAX_SUBAGENT_FANOUT; index++)
          expect(
            yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID: `call-${index}` }),
          ).toBeTrue()
        // Exact retry of an admitted call passes without a new slot, even at the cap.
        expect(
          yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID: "call-0" }),
        ).toBeTrue()
        expect(
          yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID: "overflow" }),
        ).toBeFalse()
        // A different batch starts from zero; a different session too.
        expect(
          yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID2, toolCallID: "fresh-batch" }),
        ).toBeTrue()
      }),
    )
  })

  test("refuses a tool call id reused against a different batch (conflicting reuse)", async () => {
    await admissionTest(({ db, sessions }) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
        expect(
          yield* admitTaskCall(db, {
            sessionID: session.id,
            assistantMessageID: SessionMessage.ID.make("msg_reuse_1"),
            toolCallID: "call-reuse",
          }),
        ).toBeTrue()
        expect(
          yield* admitTaskCall(db, {
            sessionID: session.id,
            assistantMessageID: SessionMessage.ID.make("msg_reuse_2"),
            toolCallID: "call-reuse",
          }),
        ).toBeFalse()
      }),
    )
  })

  test("the admitted count survives a process restart (database reopen)", async () => {
    const file = path.join(tmpRoot(), "task-call-admission.db")
    const messageID = SessionMessage.ID.make("msg_restart")
    const sessionID = await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
      for (let index = 0; index < MAX_SUBAGENT_FANOUT; index++)
        expect(yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID: `call-${index}` })).toBeTrue()
      return session.id
    }).pipe(Effect.provide(stackOver(Database.layerFromPath(file))), Effect.scoped, Effect.runPromise)
    // A "new process": the connection is closed and the file reopened BARE (a second session-stack
    // build in one process re-resolves the process-global Database node, which is a different file).
    await Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(
        yield* admitTaskCall(db, { sessionID, assistantMessageID: messageID, toolCallID: "call-after-restart" }),
      ).toBeFalse()
      expect(yield* admitTaskCall(db, { sessionID, assistantMessageID: messageID, toolCallID: "call-0" })).toBeTrue()
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped, Effect.runPromise)
  })

  test("two racing admissions at the cap boundary admit at most one", async () => {
    await admissionTest(({ db, sessions }) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/tmp") } })
        const messageID = SessionMessage.ID.make("msg_race")
        for (let index = 0; index < MAX_SUBAGENT_FANOUT - 1; index++)
          yield* admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID: `call-${index}` })
        const outcomes = yield* Effect.all(
          ["call-race-a", "call-race-b"].map((toolCallID) =>
            admitTaskCall(db, { sessionID: session.id, assistantMessageID: messageID, toolCallID }),
          ),
          { concurrency: 2 },
        )
        expect(outcomes.filter(Boolean)).toHaveLength(1)
      }),
    )
  })
})
