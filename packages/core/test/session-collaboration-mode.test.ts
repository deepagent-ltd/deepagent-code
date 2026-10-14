import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Hash } from "../src/util/hash"
import { SessionActivityTable } from "../src/context-federation/session-sql"
import { DeepAgentPlanStore } from "../src/deepagent/plan-store"
import { DocumentStore } from "../src/deepagent/document-store"
import { GoalControl } from "../src/deepagent/goal-control"
import { PermissionV2 } from "../src/permission"
import { PermissionSaved } from "../src/permission/saved"
import { Location } from "../src/location"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionContextEpoch } from "../src/session/context-epoch"
import { SystemContext } from "../src/system-context"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionEvent } from "../src/session/event"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionProjector } from "../src/session/projector"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { Prompt } from "../src/session/prompt"
import { CollaborationMode } from "../src/session/collaboration-mode"
import { PlanningPermissions } from "../src/session/planning-permissions"
import { QuestionV2 } from "../src/question"
import { ApplicationTools } from "../src/tool/application-tools"
import { Delegation } from "../src/tool/delegation"
import { PlanExitTool } from "../src/tool/plan-exit"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { GoalControlFixture } from "./fixture/goal-control"
import { location } from "./fixture/location"
import { projectLayer } from "./fixture/project-layer"
import { testEffect } from "./lib/effect"

const sid = SessionV2.ID.make("ses_collaboration")
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(projectLayer(database)),
  Layer.provide(SessionExecution.noopLayer),
)
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const permission = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provide(PermissionSaved.layer.pipe(Layer.provide(database))),
)
const question = QuestionV2.layer.pipe(Layer.provide(events))
const slot = Layer.effect(
  Delegation.DelegationSlot,
  SessionV2.Service.use((service) => Effect.succeed({ service })),
).pipe(Layer.provide(sessions))
// Retention is orthogonal to admission. The production registry, PermissionV2, QuestionV2,
// EventV2/projectors and SessionV2 are real; this bounded output carrier creates no files.
const output = Layer.succeed(
  ToolOutputStore.Service,
  ToolOutputStore.Service.of({
    bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
    limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 51200 }),
    rehydrate: () => Effect.die("No artifacts in collaboration tests"),
    cleanup: () => Effect.void,
  }),
)
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(output))
const planExit = PlanExitTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(question),
  Layer.provide(database),
)
const it = testEffect(
  Layer.mergeAll(database, events, store, projector, sessions, permission, question, slot, registry, planExit),
)
let stateDir: string
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "dac-collaboration-"))
  DeepAgentPlanStore.configureRoot(stateDir)
})
afterEach(() => {
  DocumentStore.__resetSharedRegistryForTests()
  rmSync(stateDir, { recursive: true, force: true })
})
const allow: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sid,
      project_id: Project.ID.global,
      slug: "collaboration",
      directory: "/project",
      title: "Collaboration",
      version: "test",
      v2_authority: true,
      agent: "plan",
      permission: allow,
    })
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.update((editor) => {
    for (const name of ["auto", "plan", "loop", "design"])
      editor.update(AgentV2.ID.make(name), (agent) => {
        agent.mode = "primary"
        agent.hidden = false
        agent.permissions = [...allow]
      })
  })
})
const context = (callID = "call-plan-approval"): Tool.Context => ({
  sessionID: sid,
  agent: AgentV2.ID.make("plan"),
  assistantMessageID: SessionMessage.ID.make("msg_planning"),
  toolCallID: callID,
})
const plan = (goal = "Inspect and implement one approved change") => ({
  plan_id: "approved-plan",
  session_id: sid,
  goal,
  active_step_id: "one",
  assumptions: [],
  created_at: "2026-10-14T00:00:00Z",
  steps: [{ step_id: "one", title: "Implement the approved scope", status: "active" as const }],
})
const waitApproval = Effect.fn("ModeTest.waitApproval")(function* (callID = "call-plan-approval") {
  const events = yield* EventV2.Service
  const ready = yield* Deferred.make<QuestionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Asked.type
      ? Deferred.succeed(ready, Schema.decodeUnknownSync(QuestionV2.Request)(event.data)).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* PlanExitTool.approve(context(callID)).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(ready) }
})
const inputs = Database.Service.use(({ db }) => db.select().from(SessionInputTable).all().pipe(Effect.orDie))

describe("collaboration mode authority", () => {
  test("pure mode labels preserve old design and build aliases", () => {
    expect(CollaborationMode.collaborationModeNames).toEqual(["auto", "plan", "loop", "design"])
    expect(CollaborationMode.configuredCollaborationMode("build")).toBe("auto")
    expect(CollaborationMode.configuredCollaborationMode("design")).toBe("design")
    expect(CollaborationMode.isSelectableCollaborationMode({ name: "plan", mode: "primary" })).toBe(true)
    expect(CollaborationMode.isSelectableCollaborationMode({ name: "plan", mode: "primary", hidden: true })).toBe(false)
  })
  it.effect("plan ceiling defeats configured wildcards and keeps only the audited tool catalog", () =>
    Effect.gen(function* () {
      yield* setup
      const permission = yield* PermissionV2.Service
      const registry = yield* ToolRegistry.Service
      const executed: string[] = []
      const names = [
        "read",
        "grep",
        "glob",
        "git_read",
        "plan",
        "question",
        "bash",
        "task",
        "browser",
        "edit",
        "write",
        "im_send",
        "mcp_server__tool",
        "custom",
      ]
      yield* registry.register(
        Object.fromEntries(
          names.map((name) => [
            name,
            Tool.withPermission(
              Tool.make({
                description: name,
                input: Schema.Struct({}),
                output: Schema.String,
                execute: () =>
                  Effect.sync(() => {
                    executed.push(name)
                    return name
                  }),
                toModelOutput: ({ output }) => [{ type: "text", text: output }],
              }),
              name === "custom" || name === "browser" ? "read" : name,
            ),
          ]),
        ),
      )
      const materialized = yield* registry.materialize({
        rulesets: [allow, allow, PlanningPermissions.forAgent("plan")],
        allowedToolIDs: PlanningPermissions.allowedTools,
      })
      expect(materialized.definitions.map((tool) => tool.name).sort()).toEqual(
        ["read", "grep", "glob", "git_read", "plan", "question", "plan_exit"].sort(),
      )
      for (const action of names.filter(
        (name) => !["read", "grep", "glob", "git_read", "plan", "question"].includes(name),
      )) {
        expect(
          yield* permission
            .assert({ sessionID: sid, agent: AgentV2.ID.make("plan"), action, resources: ["*"] })
            .pipe(Effect.flip),
        ).toBeInstanceOf(PermissionV2.DeniedError)
        expect(
          (yield* materialized.settle({
            ...context(),
            call: { type: "tool-call", id: `call-${action}`, name: action, input: {} },
          })).result.type,
        ).toBe("error")
      }
      yield* permission.assert({
        sessionID: sid,
        agent: AgentV2.ID.make("plan"),
        action: "read",
        resources: ["source.ts"],
      })
      expect(
        (yield* materialized.settle({
          ...context(),
          call: { type: "tool-call", id: "read-source", name: "read", input: {} },
        })).result.type,
      ).toBe("text")
      expect(executed).toEqual(["read"])
    }),
  )
  it.effect("busy cross-agent steer and direct switch roll back, while same-agent steer and future queue admit", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const first = yield* sessions.prompt({
        sessionID: sid,
        prompt: new Prompt({ text: "Design the change", agent: "plan" }),
        resume: false,
      })
      yield* db
        .insert(SessionActivityTable)
        .values({
          activity_id: "activity-plan",
          session_id: sid,
          ordinal: 0,
          trigger_input_id: first.id,
          delivery: "steer",
          state: "active",
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const before = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(
        yield* sessions
          .prompt({ sessionID: sid, prompt: new Prompt({ text: "Implement now", agent: "auto" }), resume: false })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "MODE_CHANGE_REQUIRES_QUEUE" })
      expect(yield* inputs).toHaveLength(1)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(before.length)
      expect(yield* sessions.switchAgent({ sessionID: sid, agent: "auto" }).pipe(Effect.flip)).toMatchObject({
        code: "MODE_CHANGE_REQUIRES_QUEUE",
      })
      expect((yield* sessions.get(sid)).agent).toBe(AgentV2.ID.make("plan"))
      yield* sessions.prompt({
        sessionID: sid,
        prompt: new Prompt({ text: "Clarify the design", agent: "plan" }),
        resume: false,
      })
      const queued = yield* sessions.prompt({
        sessionID: sid,
        delivery: "queue",
        prompt: new Prompt({ text: "Approved implementation", agent: "auto" }),
        resume: false,
      })
      expect((yield* SessionInput.find(db, queued.id))?.delivery).toBe("queue")
      expect((yield* sessions.get(sid)).agent).toBe(AgentV2.ID.make("plan"))
      yield* db
        .update(SessionActivityTable)
        .set({ state: "settled", settled_at: 2 })
        .where(eq(SessionActivityTable.activity_id, "activity-plan"))
        .run()
        .pipe(Effect.orDie)
      yield* sessions.switchAgent({ sessionID: sid, agent: "auto" })
      expect((yield* sessions.get(sid)).agent).toBe(AgentV2.ID.make("auto"))
    }),
  )
  it.effect("a changed config default cannot switch an active activity with an omitted Session selector", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* db.update(SessionTable).set({ agent: null }).where(eq(SessionTable.id, sid)).run().pipe(Effect.orDie)
      const first = yield* sessions.prompt({
        sessionID: sid,
        prompt: new Prompt({ text: "Continue current mode" }),
        resume: false,
      })
      yield* SessionContextEpoch.initialize(
        db,
        Effect.succeed(SystemContext.empty),
        sid,
        { directory: AbsolutePath.make("/project") },
        AgentV2.ID.make("auto"),
        { select: agents.select },
      )
      yield* db
        .insert(SessionActivityTable)
        .values({
          activity_id: "activity-default",
          session_id: sid,
          ordinal: 0,
          trigger_input_id: first.id,
          delivery: "steer",
          state: "active",
          created_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => editor.default(AgentV2.ID.make("plan")))
      expect(
        yield* sessions
          .prompt({
            sessionID: sid,
            prompt: new Prompt({ text: "Apply the new default", agent: "plan" }),
            resume: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "MODE_CHANGE_REQUIRES_QUEUE", currentAgent: "auto" })
      yield* sessions.prompt({
        sessionID: sid,
        prompt: new Prompt({ text: "Clarify the active task", agent: "auto" }),
        resume: false,
      })
      expect(yield* inputs).toHaveLength(2)
    }),
  )

  it.live("Goal pause and stop still refuse mode changes until the issued tick settles", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const goal = yield* GoalControlFixture.activate(db, "mode-switch")
      const sessionID = SessionV2.ID.make(goal.input.sessionID)
      const refuse = () =>
        sessions
          .prompt({
            sessionID,
            delivery: "queue",
            prompt: new Prompt({ text: "Switch to planning", agent: "plan" }),
            resume: false,
          })
          .pipe(Effect.flip)
      expect(yield* refuse()).toMatchObject({ code: "GOAL_MODE_CHANGE_BUSY" })
      const permit = yield* GoalControl.beginTick(db, goal.tick)
      const control = {
        sessionID,
        goalId: goal.row.goal_id,
        expectedRevision: 1,
        requestID: "pause-mode",
        action: "pause" as const,
      }
      yield* GoalControl.control(db, control)
      expect(yield* refuse()).toMatchObject({ code: "GOAL_MODE_CHANGE_BUSY" })
      yield* GoalControl.control(db, { ...control, expectedRevision: 2, requestID: "stop-mode", action: "stop" })
      expect(yield* refuse()).toMatchObject({ code: "GOAL_MODE_CHANGE_BUSY" })
      expect(yield* inputs).toHaveLength(0)
      yield* GoalControl.settleTick(db, { permit: permit.permit, nextSeq: 1, planVersion: 1, phase: "stopped" })
      expect(
        (yield* sessions.prompt({
          sessionID,
          delivery: "queue",
          prompt: new Prompt({ text: "Switch to planning", agent: "plan" }),
          resume: false,
        })).delivery,
      ).toBe("queue")
    }),
  )
})

describe("V2 plan_exit approval", () => {
  it.effect("the production canonical leaf is registered and fails without a committed plan", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize({ rulesets: [PlanningPermissions.forAgent("plan")] })
      expect(materialized.definitions.map((tool) => tool.name)).toContain("plan_exit")
      const settled = yield* materialized.settle({
        ...context(),
        call: { type: "tool-call", id: "missing-plan", name: "plan_exit", input: {} },
      })
      expect(settled.result).toMatchObject({ type: "error" })
      expect(JSON.stringify(settled)).toContain("Create a valid plan")
      expect(yield* inputs).toHaveLength(0)
    }),
  )
  it.effect("approval queues only the displayed snapshot once despite a late plan change and cold retry", () =>
    Effect.gen(function* () {
      yield* setup
      DeepAgentPlanStore.setPlanDoc(sid, plan())
      const displayed = DeepAgentPlanStore.approvalSnapshot(sid)!
      const model = {
        providerID: ProviderV2.ID.make("planning-provider"),
        id: ModelV2.ID.make("planning-model"),
        variant: ModelV2.VariantID.make("high"),
      }
      yield* (yield* EventV2.Service).publish(SessionEvent.Step.Started, {
        sessionID: sid,
        assistantMessageID: context().assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "plan",
        model,
      })
      const question = yield* QuestionV2.Service
      const waiting = yield* waitApproval()
      expect(waiting.request.questions[0]?.question).toContain(displayed.body)
      DeepAgentPlanStore.setPlanDoc(sid, plan("Unapproved later scope"))
      yield* question.reply({ requestID: waiting.request.id, answers: [["Execute this version"]] })
      const approved = yield* Fiber.join(waiting.fiber)
      expect(approved).toMatchObject({ queued: true, version: displayed.version, hash: displayed.hash })
      const rows = yield* inputs
      expect(rows).toHaveLength(1)
      expect(rows[0]?.session_id).toBe(sid)
      expect(rows[0]?.delivery).toBe("queue")
      expect(rows[0]?.prompt.agent).toBe("auto")
      expect(rows[0]?.prompt.model).toEqual(model)
      expect(rows[0]?.prompt.text).toContain(displayed.body)
      expect(rows[0]?.prompt.text).not.toContain("Unapproved later scope")
      DocumentStore.__resetSharedRegistryForTests()
      expect(yield* PlanExitTool.approve(context())).toEqual(approved)
      expect(yield* question.list()).toEqual([])
      expect(yield* inputs).toHaveLength(1)
    }),
  )

  it.effect("a cold retry before admission re-displays its original immutable version", () =>
    Effect.gen(function* () {
      yield* setup
      DeepAgentPlanStore.setPlanDoc(sid, plan())
      const displayed = DeepAgentPlanStore.approvalSnapshot(sid)!
      const first = yield* waitApproval("call-cold-pending")
      yield* Fiber.interrupt(first.fiber)
      expect(yield* (yield* QuestionV2.Service).list()).toEqual([])
      expect(yield* inputs).toHaveLength(0)
      DeepAgentPlanStore.setPlanDoc(sid, plan("Unapproved cold-change scope"))
      DocumentStore.__resetSharedRegistryForTests()
      const second = yield* waitApproval("call-cold-pending")
      expect(second.request.questions[0]?.question).toContain(displayed.body)
      expect(second.request.questions[0]?.question).not.toContain("Unapproved cold-change scope")
      yield* (yield* QuestionV2.Service).reply({ requestID: second.request.id, answers: [["Execute this version"]] })
      expect(yield* Fiber.join(second.fiber)).toMatchObject({
        queued: true,
        hash: displayed.hash,
        version: displayed.version,
      })
      expect(yield* inputs).toHaveLength(1)
    }),
  )

  it.effect("an existing conflicting durable ID cannot be treated as approved execution", () =>
    Effect.gen(function* () {
      yield* setup
      DeepAgentPlanStore.setPlanDoc(sid, plan())
      const snapshot = yield* PlanExitTool.capture(context("call-conflict"))
      const id = SessionMessage.ID.make(
        `msg_${Hash.sha256(JSON.stringify([sid, "call-conflict", snapshot.hash])).slice(0, 40)}`,
      )
      yield* (yield* SessionV2.Service).prompt({
        sessionID: sid,
        id,
        delivery: "queue",
        prompt: new Prompt({ text: "A different unapproved request" }),
        resume: false,
      })
      expect(yield* PlanExitTool.approve(context("call-conflict")).pipe(Effect.flip)).toMatchObject({
        message: "The approved plan input conflicts with an existing durable request",
      })
      expect(yield* (yield* QuestionV2.Service).list()).toEqual([])
      expect(yield* inputs).toHaveLength(1)
    }),
  )

  it.effect("rejection and closing the approval create no execution input", () =>
    Effect.gen(function* () {
      yield* setup
      DeepAgentPlanStore.setPlanDoc(sid, plan())
      const question = yield* QuestionV2.Service
      const kept = yield* waitApproval("call-keep-designing")
      yield* question.reply({ requestID: kept.request.id, answers: [["Keep designing"]] })
      expect(yield* Fiber.join(kept.fiber)).toMatchObject({ queued: false })
      const closed = yield* waitApproval("call-close-approval")
      yield* question.reject(closed.request.id)
      expect(yield* Fiber.join(closed.fiber).pipe(Effect.flip)).toMatchObject({
        message: "Plan approval was dismissed; no execution was admitted",
      })
      expect(yield* inputs).toHaveLength(0)
    }),
  )
  it.effect("a missing root execution service fails safely without asking or admitting", () =>
    Effect.gen(function* () {
      yield* setup
      DeepAgentPlanStore.setPlanDoc(sid, plan())
      expect(
        yield* PlanExitTool.approve(context()).pipe(Effect.provideService(Delegation.DelegationSlot, {}), Effect.flip),
      ).toMatchObject({ message: "Plan execution admission is unavailable in this runtime" })
      expect(yield* (yield* QuestionV2.Service).list()).toEqual([])
      expect(yield* inputs).toHaveLength(0)
    }),
  )
})
