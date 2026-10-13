import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { MultiAgentRuntime } from "../../src/session/multi-agent-runtime"
import { parentSessionIDFor } from "../../src/session/multi-agent-runtime"
import {
  makeSessionV2Adapter,
  makeV2AdmissionBridge,
  toEventEnvelope,
  V4_EVENT_REGISTRY,
} from "../../src/session/v2-admission-bridge"
import type { SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { AgentExecution } from "@deepagent-code/core/deepagent/agent-execution"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { Database } from "@deepagent-code/core/database/database"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { EventAdmissionWiring } from "@deepagent-code/core/deepagent/event-admission-wiring"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { EventV2 } from "@deepagent-code/core/event"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { EventRegistry } from "@deepagent-code/core/deepagent/event-registry"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import type { EventDispatcher } from "../../src/session/event-dispatcher"

// The adapter retains exact prompt retry semantics, and DAG receipt-only ingress remains observable.
// Routing flags and legacy V4 records cannot grant execution: the production bridge requires the
// reviewed EventWork source/controller port before admitting model work. These refusal cases do not
// replace the installed EventWork/DAG production qualification tests.

let clock = 0
const now = () => clock

let runnerRan: string[] = []
const resetRunner = () => {
  runnerRan = []
}
let turnCounter = 0
const fakeRunner: SubagentTurnRunner = (input) =>
  Effect.sync(() => {
    runnerRan.push(input.agentType)
    const turn = ++turnCounter
    const continuationRef = input.requiresWriteIsolation ? `agent/fake-${turn}` : undefined
    return {
      ok: true,
      structured: undefined,
      text: "done",
      tokensUsed: 0,
      cost: 0,
      sessionID: `ses_fake_${turn}`,
      ...(continuationRef ? { continuationRef, artifacts: [`git-ref:${continuationRef}`] } : {}),
    }
  })

let registry: AgentDescriptor[] = []
const setRegistry = (agents: AgentDescriptor[]) => {
  registry = agents
}
const fakeAgentList = Layer.succeed(AgentListProviderService, {
  listAgents: () => Effect.succeed(registry),
  findByTrigger: () => Effect.succeed([]),
  findByCapability: () => Effect.succeed([]),
})

const agent = (id: string, caps: string[], autonomy?: AgentDescriptor["autonomy"]): AgentDescriptor => ({
  id,
  name: id,
  displayName: id,
  visible: true,
  capabilities: caps,
  ...(autonomy ? { autonomy } : {}),
})

const event = (over?: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: "ci.failure",
  source: "ci",
  workspaceID: "acme/app",
  projectID: "proj_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: { repo: "acme/app", branch: "main" },
  ...over,
})

const request = (): EventDispatcher.DispatchRequest => ({
  event: event(),
  priority: "normal",
  targets: [],
})

/** A normalized record of the SessionV2.prompt call the adapter issues. */
type V2PromptCall = {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
  readonly delivery: string
  readonly resume?: boolean
}

/** A fake SessionV2 whose `prompt` records each admission and returns a minimal `Admitted`. Verifies the
 * adapter really drives SessionV2.prompt without needing a live session stack. */
const fakeV2Session = (calls: V2PromptCall[], options: { readonly exists?: boolean } = {}): SessionV2.Interface =>
  ({
    get: (_sessionID: unknown) =>
      options.exists
        ? Effect.sync(() => ({ id: _sessionID as never, location: undefined as never }))
        : Effect.fail(new Error("not found")),
    create: () => Effect.sync(() => ({}) as never),
    prompt: (input: Parameters<SessionV2.Interface["prompt"]>[0]) =>
      Effect.sync(() => {
        calls.push({
          sessionID: input.sessionID,
          prompt: { text: input.prompt.text },
          delivery: input.delivery ?? "steer",
          ...(input.resume === undefined ? {} : { resume: input.resume }),
        })
        return { id: SessionMessage.ID.make("msg_fake") }
      }),
  }) as unknown as SessionV2.Interface

/** Run `body` against a LIVE in-memory Database (the `Layer.build` scope stays open until `body`
 * completes, so the `db` handle is valid — extracting `db` via a separately-provided scope would close
 * it). */
const runWithDb = <A>(body: (db: Database.Interface["db"]) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(Database.layerFromPath(":memory:"))
      const db = Context.get(ctx, Database.Service).db
      return yield* body(db)
    }).pipe(Effect.scoped),
  )

/** End-to-end integration: build the runtime with a real provider, dispatch a routed event, and assert the
 * V2 path ran (adapter called). Returns the dispatch Effect (driven by the caller's scoped db context). */
const providerRuntimeEffect = (provider: MultiAgentRuntime.EventV2AdmissionBridge): Effect.Effect<void, unknown> => {
  const database = Database.layerFromPath(":memory:")
  const core = Layer.mergeAll(
    DeepAgentEventBus.layerWith({ now }),
    ApprovalQueue.layerWith({ now }),
    AgentExecution.layerWith({ now }),
  ).pipe(Layer.provideMerge(database))
  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const execution = yield* AgentExecution.Service
      return MultiAgentRuntime.layerWith({ runner: fakeRunner, execution, eventV2Admission: provider })
    }),
  ).pipe(Layer.provide(core), Layer.provide(fakeAgentList))
  const merged = Layer.mergeAll(runtime, core)
  return Effect.gen(function* () {
    const ctx = yield* Layer.build(merged)
    const rt = Context.get(ctx, MultiAgentRuntime.Service)
    return yield* rt.dispatch(request())
  }).pipe(Effect.scoped)
}

const scope = (event: DeepAgentEvent.Event): EventAdmissionWiring.AdmissionScope => ({
  workspaceId: event.workspaceID,
  securityNamespaceId: "sec_ws_wrk_1",
  projectScopeKey: event.projectID ?? event.workspaceID,
  principal: "system",
  sessionID: parentSessionIDFor(event.id),
  authorizedTrigger: true,
})

const saved = process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]

describe("C5-12 V2 admission bridge provider", () => {
  beforeAll(() => {
    process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = "true"
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[EventAdmission.EVENT_V2_ADMISSION_ENV]
    else process.env[EventAdmission.EVENT_V2_ADMISSION_ENV] = saved
  })

  test("a prefixed anchor keeps its identity across exact retry and rejects conflicting reuse", async () => {
    const database = Database.layerFromPath(":memory:")
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    const store = SessionStore.layer.pipe(Layer.provide(database))
    const sessions = SessionV2.layer.pipe(
      Layer.provide(events),
      Layer.provide(database),
      Layer.provide(store),
      Layer.provide(Project.defaultLayer),
      Layer.provide(SessionExecution.noopLayer),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.mergeAll(database, events, projector, store, sessions))
        const db = Context.get(context, Database.Service).db
        const session = Context.get(context, SessionV2.Service)
        const sessionID = SessionV2.ID.make("ses_bridge_anchor")
        yield* db
          .insert(ProjectTable)
          .values({
            id: Project.ID.global,
            worktree: AbsolutePath.make("/project"),
            sandboxes: [],
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "bridge-anchor",
            directory: "/project",
            title: "bridge anchor",
            version: "test",
            v2_authority: true,
          })
          .run()
          .pipe(Effect.orDie)
        const source = event()
        const registration = V4_EVENT_REGISTRY.lookup(source.type)
        if (!registration) throw new Error("missing test registration")
        const resolution = EventAdmissionWiring.resolveAdmissionInput(
          EventRegistry.assertPublishable(V4_EVENT_REGISTRY, toEventEnvelope(source, registration)),
          registration,
          scope(source),
        )
        if (!resolution.ok) throw new Error("admission resolution refused")
        const adapter = makeSessionV2Adapter(session, () => undefined, source.workspaceID)
        const prefixed = {
          envelope: resolution.envelope,
          sessionID,
          messageID: "msg_preserved_anchor",
          delivery: "steer" as const,
          resume: false,
          promptText: "bounded event prompt",
        }
        const first = yield* adapter.admit(prefixed)
        const retry = yield* adapter.admit(prefixed)
        expect(first.messageID).toBe(prefixed.messageID)
        expect(retry).toEqual(first)
        expect(yield* SessionInput.find(db, SessionMessage.ID.make(prefixed.messageID))).toMatchObject({
          id: prefixed.messageID,
          prompt: { text: prefixed.promptText },
        })
        const conflict = yield* adapter.admit({ ...prefixed, promptText: "changed prompt" }).pipe(Effect.flip)
        expect(conflict).toMatchObject({ _tag: "Session.PromptConflictError" })

        const legacy = { ...prefixed, messageID: "event-admission:legacy:session" }
        const oldFirst = yield* adapter.admit(legacy)
        const oldRetry = yield* adapter.admit(legacy)
        expect(oldFirst.messageID).toStartWith("msg_")
        expect(oldFirst.messageID).not.toBe(legacy.messageID)
        expect(oldRetry).toEqual(oldFirst)
      }).pipe(Effect.scoped),
    )
  })

  test("provider.admit refuses routing-only authority without a Session prompt", async () => {
    const req = request()
    const calls: V2PromptCall[] = []
    await runWithDb((db) =>
      Effect.gen(function* () {
        const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session(calls) })
        const outcome = yield* provider.admit({ request: req, scope: scope(req.event) }).pipe(Effect.exit)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (outcome._tag === "Failure")
          expect(Cause.squash(outcome.cause)).toMatchObject({ code: "EVENT_WORK_AUTH_REQUIRED" })
        expect(calls).toEqual([])
      }),
    )
  })

  test.each(["default", "custom"] as const)("%s registry cannot revive automatic IM admission", async (kind) => {
    expect(V4_EVENT_REGISTRY.lookup("im.message.created")).toBeUndefined()
    const registration = V4_EVENT_REGISTRY.lookup("ci.failure")
    if (!registration) throw new Error("Missing current Event registration")
    const custom = EventRegistry.createEventRegistry([
      { ...registration, eventType: "im.message.created", execution: "single" },
    ])
    expect(custom.lookup("im.message.created")).toBeDefined()
    const calls: V2PromptCall[] = []
    const req = {
      ...request(),
      event: event({
        type: "im.message.created",
        source: "im",
        payload: {
          groupID: "conversation",
          messageID: "ordinary",
          content: "@auto /dac unauthorized received text",
          mentions: ["auto"],
        },
      }),
    }
    await runWithDb((db) =>
      Effect.gen(function* () {
        const provider = makeV2AdmissionBridge({
          db,
          v2Session: fakeV2Session(calls),
          ...(kind === "custom" ? { registry: custom } : {}),
        })
        for (const admit of [provider.admit, provider.admitReceiptOnly!]) {
          const outcome = yield* admit({ request: req, scope: scope(req.event) }).pipe(Effect.exit)
          expect(Exit.isFailure(outcome)).toBe(true)
          if (outcome._tag === "Failure") expect(String(Cause.squash(outcome.cause))).toContain("is not registered")
        }
        expect(calls).toEqual([])
        expect(yield* EventAdmission.forSession(db, parentSessionIDFor(req.event.id))).toEqual([])
        expect(yield* db.all("SELECT count(*) count FROM session_input")).toEqual([{ count: 0 }])
      }),
    )
  })

  test("a routing-only refusal creates no successful durable admission receipt", async () => {
    const req = request()
    await runWithDb((db) =>
      Effect.gen(function* () {
        const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session([]) })
        const outcome = yield* provider.admit({ request: req, scope: scope(req.event) }).pipe(Effect.exit)
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(yield* EventAdmission.forSession(db, parentSessionIDFor(req.event.id))).toEqual([])
      }),
    )
  })

  test("registered event routing never substitutes for reviewed Work authority", async () => {
    await runWithDb((db) =>
      Effect.gen(function* () {
        for (const [type, source, execution] of [
          ["schedule.scan", "schedule", "single"],
          ["ci.repair.requested", "schedule", "dag"],
          ["ci.failure", "ci", "dag"],
          ["pr.comment", "pr", "dag"],
          ["monitor.alert", "monitor", "dag"],
        ] as const) {
          expect(V4_EVENT_REGISTRY.lookup(type)?.execution ?? "single").toBe(execution)
          const req = { ...request(), event: event({ type, source }) }
          const calls: V2PromptCall[] = []
          const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session(calls) })
          const outcome = yield* provider.admit({ request: req, scope: scope(req.event) }).pipe(Effect.exit)
          expect(Exit.isFailure(outcome)).toBe(true)
          if (outcome._tag === "Failure")
            expect(Cause.squash(outcome.cause)).toMatchObject({ code: "EVENT_WORK_AUTH_REQUIRED" })
          expect(yield* EventAdmission.forSession(db, parentSessionIDFor(req.event.id))).toEqual([])
          expect(calls).toEqual([])
        }
      }),
    )
  })

  test("DAG ingress for each registered type resolves one receipt without prompting the parent", async () => {
    for (const [type, source] of [
      ["ci.repair.requested", "schedule"],
      ["ci.failure", "ci"],
      ["pr.comment", "pr"],
      ["monitor.alert", "monitor"],
    ] as const) {
      const req = { ...request(), event: event({ type, source }) }
      const v2Calls: V2PromptCall[] = []
      await runWithDb((db) =>
        Effect.gen(function* () {
          const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session(v2Calls) })
          expect(provider.executionFor?.(req.event.type)).toBe("dag")
          if (!provider.admitReceiptOnly) throw new Error("missing receipt-only adapter")
          yield* provider.admitReceiptOnly({ request: req, scope: scope(req.event) })
          yield* provider.admitReceiptOnly({ request: req, scope: scope(req.event) })
          const rows = yield* EventAdmission.forSession(db, parentSessionIDFor(req.event.id))
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ status: "resolved" })
        }),
      )
      expect(v2Calls).toEqual([])
    }
  })

  test("receipt-only ingress fails closed on an unregistered event type", async () => {
    const req = request()
    await runWithDb((db) =>
      Effect.gen(function* () {
        const calls: V2PromptCall[] = []
        const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session(calls) })
        const badRequest = { ...req, event: { ...req.event, type: "some.unknown.type" } }
        const outcome = yield* provider.admitReceiptOnly!({ request: badRequest, scope: scope(req.event) }).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(String(outcome)).toContain("is not registered")
        expect(calls).toEqual([])
        expect(yield* EventAdmission.forSession(db, parentSessionIDFor(req.event.id))).toEqual([])
      }),
    )
  })

  test("a missing SessionV2 stack cannot bypass reviewed Work authority", async () => {
    const req = request()
    await runWithDb((db) =>
      Effect.gen(function* () {
        const provider = makeV2AdmissionBridge({ db })
        const outcome = yield* provider.admit({ request: req, scope: scope(req.event) }).pipe(Effect.exit)
        expect(Exit.isFailure(outcome)).toBe(true)
        if (outcome._tag === "Failure")
          expect(Cause.squash(outcome.cause)).toMatchObject({ code: "EVENT_WORK_AUTH_REQUIRED" })
      }),
    )
  })

  test("flag ON cannot fall back to ordinary model execution after authority refusal", async () => {
    setRegistry([agent("fixer", ["code_edit", "test_run"], "level_2")])
    resetRunner()
    const v2Calls: V2PromptCall[] = []
    const outcome = await runWithDb((db) => {
      const provider = makeV2AdmissionBridge({ db, v2Session: fakeV2Session(v2Calls) })
      return providerRuntimeEffect(provider).pipe(Effect.exit)
    })
    expect(Exit.isFailure(outcome)).toBe(true)
    if (outcome._tag === "Failure")
      expect(Cause.squash(outcome.cause)).toMatchObject({ code: "EVENT_WORK_AUTH_REQUIRED" })
    expect(v2Calls.length).toBe(0)
    expect(runnerRan.length).toBe(0)
  })
})
