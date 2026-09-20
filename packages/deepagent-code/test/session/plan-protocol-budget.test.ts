import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import { LLMClient, LLMEvent, Model, ToolFailure, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { AgentV2 } from "@deepagent-code/core/agent"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Catalog } from "@deepagent-code/core/catalog"
import { Config } from "@deepagent-code/core/config"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { LocationMutation } from "@deepagent-code/core/location-mutation"
import { Policy } from "@deepagent-code/core/policy"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { QuestionV2 } from "@deepagent-code/core/question"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { Tool } from "@deepagent-code/core/tool/tool"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { AppProcess } from "@deepagent-code/core/process"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { tmpRootShared } from "../fixture/fixture"

/**
 * The plan-protocol termination budget, driven through a REAL V2 drain.
 *
 * `SessionRunner` counts consecutive plan-protocol violations and ends the whole activity once the
 * count reaches `PLAN_PROTOCOL_MAX_ATTEMPTS`. Two different things used to be counted as one:
 *
 *   - a plan TOOL error (the settlement failed), and
 *   - a plan REJECTION the protocol itself reported (`plan_protocol: invalid | conflict | no_progress`).
 *
 * The plan tool's own rejections tell the model to correct its payload and retry once, so a
 * corrected retry is the expected next move. Counting the failed settlement anyway meant one
 * transient tool error plus any single rejection burned the entire 2-attempt budget and ended the
 * drain — measured on the full-roster sweep, where tasks died after 1-35 steps with
 * `PlanProtocolViolation ... budget exhausted` while the model was still correcting its payload.
 *
 * These tests pin BOTH directions, because either half alone is passable by a wrong implementation:
 * excluding tool errors must not disable the budget that stops a model which cannot produce a valid
 * plan at all.
 */

const root = mkdtempSync(tmpRootShared())
const database = Database.layerFromPath(":memory:")

const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))

/** What the scripted `plan` tool does on the NEXT call. */
type PlanStub = { kind: "tool-error"; message: string } | { kind: "protocol"; protocol: string; code: string }
let planScript: PlanStub[] = []
let planCalls = 0

let turn = 0
let responses: LLMEvent[][] = []
const requests: LLMRequest[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const batch = responses[turn++] ?? []
      return Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (seal !== undefined)
            yield* seal
              .seal({
                wireHash: Hash.sha256(`plan-protocol-wire-${turn}`),
                bodyHash: Hash.sha256("plan-protocol-body"),
                bodyLength: 40,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
          return Stream.fromIterable(batch)
        }),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const agents = AgentV2.layer
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model }))
const systemContextKey = SystemContext.Key.make("test/plan-protocol/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registryService) =>
      registryService.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine([
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/plan-protocol/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(SystemContextRegistry.layer))
const location = Location.layer({ directory: AbsolutePath.make(root) }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const hostServices = Layer.mergeAll(
  FSUtil.defaultLayer,
  location,
  Policy.layer.pipe(Layer.provide(location)),
  LocationMutation.layer.pipe(Layer.provide(location), Layer.provide(FSUtil.defaultLayer), Layer.orDie),
  permission,
  config,
  AppProcess.defaultLayer,
).pipe(Layer.provideMerge(location))

const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)

// The stub `plan` leaf. Its TWO shapes are the whole point of the test:
//   - "tool-error"  -> the settlement FAILS; `fromResultValue` yields no structured output at all,
//                      which is what a failed plan call looks like to the runner.
//   - "protocol"    -> the settlement SUCCEEDS carrying `plan_protocol`, which is a protocol verdict.
// The input is a permissive record so the scripted model payload never has to be schema-perfect.
const toolRegistration = Layer.effectDiscard(
  ToolRegistry.Service.use((registryService) =>
    registryService.register({
      plan: Tool.make({
        description: "Stub plan tool: replays a scripted outcome",
        input: Schema.Struct({ operation: Schema.optional(Schema.String), goal: Schema.optional(Schema.String) }),
        output: Schema.Struct({
          output: Schema.String,
          plan_protocol: Schema.optional(Schema.Literals(["success", "invalid", "conflict", "no_progress"])),
          plan_error_code: Schema.optional(Schema.String),
        }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: output.output }],
        execute: () =>
          Effect.gen(function* () {
            const scripted = planScript[planCalls++] ?? { kind: "tool-error" as const, message: "unscripted" }
            if (scripted.kind === "tool-error") return yield* new ToolFailure({ message: scripted.message })
            return {
              output: `plan rejected: ${scripted.code}`,
              plan_protocol: scripted.protocol as "invalid" | "conflict" | "no_progress",
              plan_error_code: scripted.code,
            }
          }),
      }),
    }),
  ),
)

const catalog = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.die("unexpected catalog.provider.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: (providerID, modelID) => Effect.fail(new Catalog.ModelNotFoundError({ providerID, modelID })),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none()),
      small: () => Effect.succeed(Option.none()),
    },
  }),
)
const ownerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const sessionContext = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(
    AgentGateway.runtimeLayer({
      enabled: true,
      agentMode: "high",
      baseDir: root,
      runsDir: path.join(root, "runs"),
    }),
  ),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(providerTurns),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
  Layer.provide(sessionContext),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(toolRegistration),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(config),
  Layer.provide(
    Layer.mergeAll(
      catalog,
      ContextQueryAuthorization.defaultLayer,
      Layer.succeed(ProductionV2Sources, {}),
      ownerAuthorization,
    ),
  ),
)
const runtime = Layer.mergeAll(runner, toolRegistration).pipe(Layer.provide(registry), Layer.provide(hostServices))
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => runtime).pipe(Effect.map((service) => service as unknown as LocationServiceMap["Service"])),
)
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(locations),
  Layer.provide(Delegation.delegationSlotLayer),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)

const it = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    questions,
    projector,
    store,
    registry,
    hostServices,
    runtime,
    execution,
    sessions,
  ),
)

// Every case gets its OWN session: the violation streak is seeded from durable history
// (`countPlanProtocolViolations(context)`), so reusing one session would carry the previous case's
// rejections into the next one's budget.
const sessionFor = (name: string) => SessionSchema.ID.make(`ses_plan_protocol_${name}`)

/** One provider response that calls the stub `plan` tool once. */
const planCallTurn = (index: number, callID: string, goal = "g"): LLMEvent[] => [
  LLMEvent.stepStart({ index }),
  LLMEvent.toolCall({ id: callID, name: "plan", input: { operation: "create", goal } }),
  LLMEvent.stepFinish({ index, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const answerTurn = (index: number): LLMEvent[] => [
  LLMEvent.stepStart({ index }),
  LLMEvent.textStart({ id: `text-${index}` }),
  LLMEvent.textDelta({ id: `text-${index}`, text: "done" }),
  LLMEvent.textEnd({ id: `text-${index}` }),
  LLMEvent.stepFinish({ index, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

// A Session row must exist before the drain can resolve one, and every insert needs the global
// project row (the same two seeds the finalizer harness performs).
const seedProjectAndSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: root,
        title: "plan protocol budget",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const drive = (name: string, scripted: LLMEvent[][], plan: PlanStub[]) =>
  Effect.gen(function* () {
    const sessionID = sessionFor(name)
    turn = 0
    planCalls = 0
    responses = scripted
    planScript = plan
    yield* seedProjectAndSession(sessionID)
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: "do the work" }), resume: false })
    yield* session.resume(sessionID)
  })

/**
 * Durable evidence of what the drain decided. The termination signal is a published
 * `session.next.step.failed` carrying the `PlanProtocolViolation` message — request counts are NOT
 * a usable proxy here (a rejected turn still drives a retry, so the count differs between cases for
 * reasons unrelated to the budget).
 */
const failureEvents = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
  return rows.map((row) => ({ type: row.type, data: JSON.stringify(row.data ?? {}) }))
})

const terminations = (rows: readonly { type: string; data: string }[]) =>
  rows.filter((row) => row.type.startsWith("session.next.step.failed") && row.data.includes("PlanProtocolViolation"))

const toolFailures = (rows: readonly { type: string; data: string }[]) =>
  rows.filter((row) => row.type === "session.next.tool.failed.1")

describe("plan protocol termination budget", () => {
  it.effect("a plan TOOL error does not spend the budget", () =>
    Effect.gen(function* () {
      // Both calls FAIL as tools. Before the fix this armed termination on the second call.
      yield* drive(
        "tool_error",
        [planCallTurn(0, "call_a"), planCallTurn(1, "call_b"), answerTurn(2)],
        [
          { kind: "tool-error", message: "transient tool failure" },
          { kind: "tool-error", message: "transient tool failure" },
        ],
      )
      expect(planCalls).toBe(2)
      const rows = yield* failureEvents
      // Both plan calls really did fail as tools…
      expect(toolFailures(rows)).toHaveLength(2)
      // …and the drain continued: no protocol termination was published, so the model kept its
      // remaining chance to correct the payload. Before the fix the second failure armed
      // termination and ended the activity here.
      expect(terminations(rows)).toEqual([])
      expect(requests.length).toBeGreaterThanOrEqual(3)
    }),
  )

  it.effect("a CORRECTED payload does not accumulate toward termination", () =>
    Effect.gen(function* () {
      // Same verdict, DIFFERENT payloads: the model is iterating on the rejection, which is what the
      // tool's "correct the plan payload and retry once" instruction asks for. Both aborted roster
      // tasks did exactly this and still lost the whole task.
      yield* drive(
        "corrected_payload",
        [planCallTurn(0, "call_a", "first"), planCallTurn(1, "call_b", "second"), answerTurn(2)],
        [
          { kind: "protocol", protocol: "invalid", code: "unsafe_step_identity" },
          { kind: "protocol", protocol: "invalid", code: "empty_goal" },
        ],
      )
      expect(planCalls).toBe(2)
      expect(terminations(yield* failureEvents)).toEqual([])
    }),
  )

  it.effect("resending the SAME rejected payload still terminates", () =>
    Effect.gen(function* () {
      // The loop this budget exists to stop: an unchanged payload means the retry produced nothing.
      yield* drive(
        "same_payload",
        [planCallTurn(0, "call_a"), planCallTurn(1, "call_b"), answerTurn(2)],
        [
          { kind: "protocol", protocol: "invalid", code: "empty_goal" },
          { kind: "protocol", protocol: "invalid", code: "empty_goal" },
        ],
      )
      expect(planCalls).toBe(2)
      const ended = terminations(yield* failureEvents)
      expect(ended).toHaveLength(1)
      expect(ended[0]?.data).toContain("empty_goal")
    }),
  )
})
