import { describe, expect } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Catalog } from "@deepagent-code/core/catalog"
import { Config } from "@deepagent-code/core/config"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { durableType } from "@deepagent-code/core/event/define"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ModelV2 } from "@deepagent-code/core/model"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Policy } from "@deepagent-code/core/policy"
import { AppProcess } from "@deepagent-code/core/process"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { QuestionV2 } from "@deepagent-code/core/question"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { Tool } from "@deepagent-code/core/tool/tool"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { BashTool } from "@deepagent-code/core/tool/bash"
import { LocationMutation } from "@deepagent-code/core/location-mutation"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import {
  activityTouchedPaths,
  harvestActivityValidation,
  onSessionSettledSeamLayer,
} from "@/deepagent/learning-runtime"
import { tmpRoot, tmpRootShared } from "../fixture/fixture"

// Real-path finalizer delivery. Every existing assertion about the G2 delivery chain feeds
// `activityTouchedPaths` / `toolSuccessResources` hand-seeded rows, so nothing proved that the
// RUNNER's own durable tool-effect + tool.success rows satisfy that query. Production said they do
// not: both abs round-6 trials logged
//   `session finalizer: skipped: no_attributable_paths`
// after the model had made 22 successful mutating calls. This test drives a genuine V2 turn (real
// receipts, real effect admission/settlement, real event log, real settle hook) and asserts the
// runtime delivered the work.

const root = mkdtempSync(tmpRootShared())
// A real git workspace with a baseline commit: the finalizer's commit is observable evidence.
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root })
spawnSync(
  "git",
  [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@test",
    "commit",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    "base",
    "-q",
  ],
  {
    cwd: root,
  },
)
const database = Database.layerFromPath(":memory:")

const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))

// Turn script: turn 0 mutates a file through a real registered tool, then runs a command that the
// inferred validation plan recognizes; turn 1 answers and ends the activity.
let turn = 0
let responses: LLMEvent[][] = []
const requests: LLMRequest[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const events = responses[turn++] ?? []
      return Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (seal !== undefined)
            yield* seal
              .seal({
                wireHash: Hash.sha256("finalizer-wire"),
                bodyHash: Hash.sha256("finalizer-body"),
                bodyLength: 40,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
          return Stream.fromIterable(events)
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
// A mutating-shaped tool whose success output carries `resource`, like the shipped write/edit
// leaves. Registering it keeps the test independent of the full built-in tool graph while
// exercising the identical registry/effect/event path those leaves use.
const observedPath = path.join(root, "touched.txt")
const agents = AgentV2.layer
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model }))
const systemContextKey = SystemContext.Key.make("test/context")
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
              removed: () => "System context source removed: test/context",
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
// The shipped bash leaf built with the host services it acquires at construction. Driving the REAL
// tool keeps the evidence faithful: the harvest reads the structured exitCode the production leaf
// writes, not a hand-shaped event.
const bashTool = BashTool.layer.pipe(Layer.provide(hostServices))

const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
// The registration view the built-in leaves use; the registry layer above already publishes
// Tools.Service against that same registry instance.
// Registers into the SAME memoized registry instance the runner resolves (the same wiring the core
// runner harness uses): the registration layer is built with `registry` provided, and the merged
// environment provides that identical layer value at one memoized slot.
const toolRegistration = Layer.effectDiscard(
  ToolRegistry.Service.use((registryService) =>
    registryService.register({
      write: Tool.make({
        description: "Write content to one file",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Struct({ resource: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text" as const, text: `wrote ${output.resource}` }],
        execute: (input) =>
          Effect.sync(() => {
            writeFileSync(input.path, "delivered by the runtime\n")
            return { resource: input.path }
          }),
      }),
      // The shipped apply_patch shape: per-file `applied[].resource`, which is the SECOND branch of
      // the extractor and the tool the abs runs actually used.
      apply_patch: Tool.make({
        description: "Apply a multi-file patch",
        input: Schema.Struct({ patchText: Schema.String }),
        output: Schema.Struct({
          applied: Schema.Array(Schema.Struct({ type: Schema.String, resource: Schema.String })),
        }),
        toModelOutput: ({ output }) => [
          { type: "text" as const, text: `applied ${output.applied.map((item) => item.resource).join(", ")}` },
        ],
        execute: (input) =>
          Effect.sync(() => {
            const applied = [...input.patchText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => ({
              type: "M",
              resource: match[1]!,
            }))
            for (const item of applied) writeFileSync(path.join(root, item.resource), "patched by the runtime\n")
            return { applied }
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
      default: () => Effect.succeed(Option.none<ModelV2.Info>()),
      small: () => Effect.succeed(Option.none<ModelV2.Info>()),
    },
  }),
)
const testOwnerAuthorization = Layer.succeed(
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
  // The production settle seam: the REAL onSessionSettled hook (learning + G2 finalizer).
  Layer.provide(
    Layer.mergeAll(
      catalog,
      ContextQueryAuthorization.defaultLayer,
      Layer.succeed(ProductionV2Sources, {}),
      testOwnerAuthorization,
      onSessionSettledSeamLayer.pipe(Layer.provide(database)),
    ),
  ),
)
// One memoized Location runtime: the runner and every tool registration resolve the SAME
// ToolRegistry instance, because both are built inside this single provided layer value.
const runtime = Layer.mergeAll(runner, toolRegistration, bashTool).pipe(
  Layer.provide(registry),
  Layer.provide(hostServices),
)
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

const sessionID = SessionSchema.ID.make("ses_finalizer_delivery")

// The project row every session insert needs (the repository's default global project).
const seedProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// One activity: the model mutates through a registered tool and runs the workspace's inferred
// validation command; the second provider turn answers and ends the activity.
const runActivity = (sessionID: SessionSchema.ID, scripted: LLMEvent[][]) =>
  Effect.gen(function* () {
    turn = 0
    responses = scripted
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: "deliver the work" }), resume: false })
    yield* session.resume(sessionID)
    expect(requests.length).toBeGreaterThan(0)
  })

const stoppedTurn = (index: number): LLMEvent[] => [
  LLMEvent.stepStart({ index }),
  LLMEvent.textStart({ id: `text-${index}` }),
  LLMEvent.textDelta({ id: `text-${index}`, text: "done" }),
  LLMEvent.textEnd({ id: `text-${index}` }),
  LLMEvent.stepFinish({ index, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const activitiesOf = (rows: readonly { activity_id: string }[]) => [...new Set(rows.map((row) => row.activity_id))]

const activityEvidence = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const receipts = yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const effects = yield* db
      .select()
      .from(V2ToolEffectTable)
      .where(eq(V2ToolEffectTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return { db, activities: activitiesOf(receipts), effects }
  })

const configureDelivery = Effect.gen(function* () {
  AgentGateway.configure({
    enabled: true,
    agentMode: "high",
    selfLearning: "manual",
    baseDir: root,
    runsDir: path.join(root, "runs"),
    durableLearning: true,
    allowProviderExecutedTools: false,
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })),
  )
})

const seedWorkspace = Effect.sync(() => {
  // CI provides Bun for this repo; using a local script keeps the real bash validation oracle
  // independent of the runner's Go toolchain version and network toolchain download.
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun -e 'process.exit(0)'" } }))
})

const newSession = (id: string) =>
  Effect.gen(function* () {
    const sessionID = SessionSchema.ID.make(id)
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: root,
        title: "G2 delivery",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return sessionID
  })

describe("G2 finalizer delivery over a REAL V2 session", () => {
  it.live("delivers the activity's work through the runtime finalizer", () =>
    Effect.gen(function* () {
      yield* configureDelivery
      yield* seedProject
      yield* seedWorkspace
      const sessionID = yield* newSession("ses_finalizer_delivery")
      yield* runActivity(sessionID, [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call_write", name: "write", input: { path: observedPath } }),
          LLMEvent.toolCall({ id: "call_validate", name: "bash", input: { command: "bun run test" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        stoppedTurn(1),
      ])

      const { db, activities, effects } = yield* activityEvidence(sessionID)
      expect(activities).toHaveLength(1)
      const activityId = activities[0]!
      expect(effects.map((row) => [row.tool_name, row.state])).toEqual([
        ["write", "settled"],
        ["bash", "settled"],
      ])
      // The break this test exists for: the durable log stores the VERSIONED type name
      // (`session.next.tool.success.1`), so a harvest filtering the bare definition name matched
      // nothing and the runtime reported `skipped: no_attributable_paths` after successful edits.
      expect(activityTouchedPaths({ db } as never, sessionID, activityId)).toEqual([observedPath])

      // Validation harvest: same join, same versioned types, and the evidence must be bound to THIS
      // activity before the finalizer may treat it as delivering authority.
      const validation = harvestActivityValidation({ db } as never, sessionID, activityId, root)
      expect(validation.map((result) => [result.command, result.passed])).toEqual([["bun run test", true]])
      expect(AgentGateway.DeepAgentSessionState.get(sessionID)?.lastValidationActivityId).toBe(activityId)

      // G-E: the verdict is a durable, replayable fact — not a stderr line that dies with the run.
      const receipts = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, durableType(SessionEvent.Delivery.Recorded)))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.data).toMatchObject({
        activityID: activityId,
        verdict: "committed",
        touchedPaths: 1,
        unattributable: 0,
      })
      expect(typeof (receipts[0]!.data as { commit?: unknown }).commit).toBe("string")

      // And the actual delivery: the runtime committed the file the model only wrote.
      const committed = spawnSync("git", ["log", "--format=%s", "-1"], { cwd: root, encoding: "utf8" })
      expect(committed.stdout?.trim()).toBe("runtime finalizer: deliver session work (auto-preserved)")
      const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8" })
      expect(files.stdout?.split("\n").filter(Boolean)).toEqual(["touched.txt"])
      expect(readFileSync(observedPath, "utf8")).toBe("delivered by the runtime\n")
    }),
  )

  it.live("attributes every file of a multi-file apply_patch to its own activity", () =>
    Effect.gen(function* () {
      yield* configureDelivery
      yield* seedProject
      yield* seedWorkspace
      const sessionID = yield* newSession("ses_finalizer_delivery_patch")
      yield* runActivity(sessionID, [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call_patch",
            name: "apply_patch",
            input: { patchText: "*** Begin Patch\n+++ b/one.txt\n+++ b/two.txt\n*** End Patch" },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        stoppedTurn(1),
      ])

      const { db, activities } = yield* activityEvidence(sessionID)
      expect(activities).toHaveLength(1)
      // apply_patch reports changed files as applied[].resource, repo-relative (exactly the shape
      // and values the shipped leaf produces) — the second extractor branch, and the one the abs
      // runs actually exercised.
      expect([...activityTouchedPaths({ db } as never, sessionID, activities[0]!)].sort()).toEqual([
        "one.txt",
        "two.txt",
      ])
    }),
  )
})
