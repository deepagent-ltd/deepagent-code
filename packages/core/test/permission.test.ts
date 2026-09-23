import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionTable } from "@deepagent-code/core/permission/sql"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionStore } from "@deepagent-code/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const saved = PermissionSaved.layer.pipe(Layer.provide(database))
const layer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(saved),
)
const it = testEffect(layer)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const update = yield* agents.transform()
    yield* update((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function durableNoProgressChallenge() {
  return Effect.gen(function* () {
    yield* setup()
    const { db } = yield* Database.Service
    yield* db.run(
      "INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created) VALUES ('v2-no-progress-input', 'ses_test', '{}', 'queue', 1, 1, 30)",
    )
    yield* db.run(
      "INSERT INTO session_activity (activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at, settled_at) VALUES ('v2-no-progress-activity', 'ses_test', 0, 'v2-no-progress-input', 'queue', 'active', 30, NULL)",
    )
    const ref = { activityKind: "v2" as const, activityID: "v2-no-progress-activity" }
    const configured = yield* DeepAgentActivityAuthority.configure({
      ...ref,
      expectedVersion: 1,
      objectiveText: "finish the task",
      completionCriteria: [{ kind: "plan_complete" }],
      enforcementState: "monitoring",
      stallThreshold: 1,
    })
    const observation = (expectedVersion: number, idempotencyKey: string) =>
      DeepAgentActivityAuthority.observe({
        ...ref,
        expectedVersion,
        idempotencyKey,
        workspaceRevision: "workspace-unchanged",
        evidence: [],
        effectReceipts: [],
        nextAction: "continue",
      })
    const first = yield* observation(configured.version, "v2-no-progress-first")
    const stalled = yield* observation(first.objective.version, "v2-no-progress-stalled")
    expect(stalled.objective.state).toBe("needs_human")
    const requestID = PermissionV2.ID.create("per_v2_no_progress")
    yield* DeepAgentActivityAuthority.requestPermission({
      ...ref,
      requestID,
      requestKind: "no_progress",
      idempotencyKey: "v2-no-progress-request",
      permission: "doom_loop",
      patterns: ["read"],
      alwaysPatterns: ["read"],
      metadata: { revision: stalled.observation.revision },
      ownerID: PermissionV2.noProgressOwnerID,
    })
    return { ref, requestID }
  })
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  for (const reply of ["once", "always", "reject"] as const) {
    it.effect(`reconstructs a V2 no-progress challenge and durably handles ${reply}`, () =>
      Effect.gen(function* () {
        const challenge = yield* durableNoProgressChallenge()
        const service = yield* PermissionV2.Service
        expect((yield* service.forSession(SessionV2.ID.make("ses_test"))).map((request) => request.id)).toContain(
          challenge.requestID,
        )
        expect(yield* service.get(challenge.requestID)).toMatchObject({
          action: "doom_loop",
          resources: ["read"],
          metadata: { kind: "no_progress" },
        })
        yield* service.reply({ requestID: challenge.requestID, reply })
        yield* service.reply({ requestID: challenge.requestID, reply })
        expect(yield* service.forSession(SessionV2.ID.make("ses_test"))).toEqual([])
        expect((yield* DeepAgentActivityAuthority.reconstruct(challenge.ref)).objective.state).toBe(
          reply === "reject" ? "interrupted" : "active",
        )
        const { db } = yield* Database.Service
        const decision = yield* db.get<{ decision: string }>(
          "SELECT decision FROM session_activity_permission_decision WHERE request_id = 'per_v2_no_progress'",
        )
        expect(decision?.decision).toBe(
          reply === "once" ? "approved_once" : reply === "always" ? "approved_always" : "interrupted",
        )
        if (reply === "once")
          expect(
            yield* db.get("SELECT consumer_id FROM session_activity_permission_once_consumption WHERE request_id = 'per_v2_no_progress'"),
          ).toEqual({ consumer_id: "v2-no-progress:v2-no-progress-activity" })
        if (reply === "always") {
          expect(yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all()).toMatchObject([
            { action: "doom_loop", resource: "read" },
          ])
        }
      }),
    )
  }
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      const update = yield* agents.transform()
      yield* update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("intersects Agent and Session rules so neither scope can widen the other", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const db = (yield* Database.Service).db
      const service = yield* PermissionV2.Service
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })

      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "allow" }] })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })

      yield* setRules([{ action: "read", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("fails with typed overload at the pending ceiling and reuses replied capacity", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      for (let index = 0; index < PermissionV2.MAX_PENDING_REQUESTS; index++)
        yield* service.ask(assertion({ id: PermissionV2.ID.create(`per_capacity_${index}`) }))

      expect(
        yield* service
          .ask(assertion({ id: PermissionV2.ID.create("per_capacity_overflow") }))
          .pipe(Effect.flip),
      ).toEqual(new PermissionV2.CapacityError({ limit: PermissionV2.MAX_PENDING_REQUESTS }))

      yield* service.reply({ requestID: PermissionV2.ID.create("per_capacity_0"), reply: "once" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_capacity_reused") })),
      ).toMatchObject({ effect: "ask" })
    }),
  )
})
