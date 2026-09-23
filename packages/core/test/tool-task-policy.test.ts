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
import { PermissionV2 } from "@deepagent-code/core/permission"
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
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
        ],
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

  // V1 parity (deepagent-code #26514, plan-mode-subagent-bypass.test.ts): a deny-all parent
  // SESSION with a narrow allowlist must leave the child a usable tool face instead of a bare
  // `deny *`.
  test("preserves a deny-all parent session's narrow allowlist as the child's usable tool face", () => {
    const researcher = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
      { action: "grep", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(
      researcher,
      [],
      [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    )
    expect(derived).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
    // The read chain survives at the definition-visibility gate (isActionWhollyDenied is the exact
    // registry filter that produced the "0 tool" child) and evaluates allow end to end.
    expect(PermissionV2.isActionWhollyDenied("read", researcher, derived)).toBeFalse()
    expect(PermissionV2.evaluate("read", "fixtures/research.txt", derived).effect).toBe("allow")
    // The parent session denied everything else, and the child's own face denies task.
    expect(PermissionV2.isActionWhollyDenied("grep", researcher, derived)).toBeTrue()
    expect(PermissionV2.isActionWhollyDenied("task", researcher, derived)).toBeTrue()
  })

  // The live-suite posture: the deny-all + narrow task-tool allows live on the PARENT AGENT as its
  // own working posture. V1 semantics forward only the parent agent's edit rules, so this posture
  // must not strip the delegated agent's built-in read face (the "0 tool" child).
  test("a parent agent's deny-all working posture does not strip the child's built-in face", () => {
    const researcher = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
      { action: "grep", resource: "*", effect: "allow" as const },
    ]
    const parentAgent = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "task", resource: "*", effect: "allow" as const },
      { action: "task_status", resource: "*", effect: "allow" as const },
      { action: "task_read", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(researcher, parentAgent, [])
    expect(derived).toEqual([])
    expect(PermissionV2.isActionWhollyDenied("read", researcher, derived)).toBeFalse()
    expect(PermissionV2.isActionWhollyDenied("grep", researcher, derived)).toBeFalse()
    expect(PermissionV2.isActionWhollyDenied("task", researcher, derived)).toBeTrue()
  })

  // V1 parity: parent session deny rules forward as hard runtime ceilings.
  test("keeps parent deny rules as hard runtime ceilings", () => {
    const executor = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "bash", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(executor, [], [{ action: "bash", resource: "*", effect: "deny" }])
    expect(PermissionV2.isActionWhollyDenied("bash", executor, derived)).toBeTrue()
    expect(PermissionV2.evaluate("bash", "git status", derived).effect).toBe("deny")
  })

  // Core red line (stricter than V1, which drops parent asks): a parent ask can never become a
  // child allow — it forwards as deny.
  test("maps a parent ask to a child deny, never an allow", () => {
    const child = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "edit", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(child, [{ action: "edit", resource: "*", effect: "ask" }], [])
    expect(derived).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    expect(PermissionV2.evaluate("edit", "src/a.ts", derived).effect).toBe("deny")
  })

  // V1 parity (plan-mode-subagent-bypass "preserves parent session allowlist entries only within
  // its own capabilities"): a parent allow forwards only inside the delegated agent's own face.
  test("forwards parent allows only within the delegated agent's own capabilities", () => {
    const reviewer = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(
      reviewer,
      [],
      [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "deny" },
        { action: "read", resource: "/fixtures/seed.txt", effect: "allow" },
        { action: "task", resource: "worker", effect: "allow" },
        { action: "edit", resource: "/fixtures/result.txt", effect: "allow" },
      ],
    )
    expect(derived).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "deny" },
      { action: "read", resource: "/fixtures/seed.txt", effect: "allow" },
    ])
    expect(PermissionV2.evaluate("read", "/fixtures/seed.txt", derived).effect).toBe("allow")
    expect(PermissionV2.evaluate("read", "/fixtures/other.txt", derived).effect).toBe("deny")
    expect(PermissionV2.evaluate("task", "worker", derived).effect).toBe("deny")
    expect(PermissionV2.evaluate("edit", "/fixtures/result.txt", derived).effect).toBe("deny")
  })

  // V1 parity (plan-mode-subagent-bypass "preserves a parent edit allowlist after its deny-all"):
  // ordered rules keep parent exceptions that follow a deny-all.
  test("preserves a parent edit allowlist after its deny-all rule", () => {
    const executor = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "edit", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(
      executor,
      [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "result.txt", effect: "allow" },
      ],
      [],
    )
    expect(derived).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "result.txt", effect: "allow" },
    ])
    expect(PermissionV2.evaluate("edit", "result.txt", derived).effect).toBe("allow")
    expect(PermissionV2.evaluate("edit", "other.txt", derived).effect).toBe("deny")
  })

  // A parent allow followed by a later deny still ends denied: order preservation keeps the
  // parent's final verdict.
  test("a parent allow followed by a later deny stays denied", () => {
    const child = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
    ]
    const derived = inheritedTaskPermissions(
      child,
      [],
      [
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "deny" },
      ],
    )
    expect(derived).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "deny" },
    ])
    expect(PermissionV2.evaluate("read", "a.ts", derived).effect).toBe("deny")
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
