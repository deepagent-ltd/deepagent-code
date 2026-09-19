import { afterAll, describe, expect } from "bun:test"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { LLMClient, LLMEvent, Model, type LLMClientShape } from "@deepagent-code/llm"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import fs from "fs/promises"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { AgentV2 } from "@deepagent-code/core/agent"
import { AgentPlugin } from "@deepagent-code/core/plugin/agent"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Catalog } from "@deepagent-code/core/catalog"
import { Config as CoreConfig } from "@deepagent-code/core/config"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { V2StructuredOutputEvidenceTable } from "@deepagent-code/core/session/runner/v2-structured-output-evidence.sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { SessionV2 } from "@deepagent-code/core/session"
import { TaskTool as CoreTaskTool } from "@deepagent-code/core/tool/task"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { ToolRegistry as CoreToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PRFinalizeTool } from "@/tool/pr_finalize"
import { MessageID as MessageIDValue } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

// V2-authority E2E for pr_finalize (#29 part 3): a completed write-isolated task run with its
// retained branch flows through the durable review cycle — reviewer run admitted on the
// TaskRunAuthority, verdict sealed by the structured-output evidence authority, plumbing merge
// into the parent branch, branch cleanup — with changes_requested retaining the branch and
// crash-retry converging. The runner harness mirrors test/tool/task-v2-authority.test.ts (one
// fake text turn per drain; the reviewer verdict JSON rides the prose).

// Redirect the deterministic worktree layout's data root into scratch space for this file.
const tmpBase = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-finalize-")))
const dataRoot = path.join(tmpBase, "data")
const priorTestHome = process.env.DEEPAGENT_CODE_TEST_HOME
const priorDataHome = process.env.DEEPAGENT_CODE_HOME
process.env.DEEPAGENT_CODE_TEST_HOME = dataRoot
process.env.DEEPAGENT_CODE_HOME = dataRoot
afterAll(() => {
  if (priorTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = priorTestHome
  if (priorDataHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = priorDataHome
})

// Every provider turn returns prose embedding a JSON payload (the reviewer verdict).
let payloadJson = '{"verdict":"approve","rationale":"No findings."}'

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Stream.fromIterable(textResponse(`research result body ${payloadJson}`))) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const textResponse = (text: string, id = "txt_pr") => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const gitIn = (cwd: string, args: string[]) =>
  Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })

function expectExit0(proc: ReturnType<typeof gitIn>, what: string) {
  if (proc.exitCode !== 0) throw new Error(`${what} failed: ${proc.stderr.toString()}`)
}

const makeRepo = async (root: string) => {
  await fs.mkdir(root, { recursive: true })
  expectExit0(gitIn(root, ["init", "-b", "main"]), "git init")
  gitIn(root, ["config", "user.email", "test@deepagent.local"])
  gitIn(root, ["config", "user.name", "DeepAgent Test"])
  await fs.writeFile(`${root}/README.md`, "# fixture repo\n")
  expectExit0(gitIn(root, ["add", "-A"]), "git add")
  expectExit0(gitIn(root, ["commit", "-m", "init"]), "git commit")
  return fs.realpath(root)
}

const repo = await makeRepo(path.join(tmpBase, "repo"))
const directory = AbsolutePath.make(repo)

const database = Database.layerFromPath(":memory:")
const selectionSourcesLayer = Layer.succeed(ProductionV2Sources, {})
const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const fakeModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model: fakeModel }))
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
const applications = ApplicationTools.layer
const coreRegistry = CoreToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentV2.layer
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
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
const location = Location.layer({ directory }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const coreConfig = Layer.succeed(
  CoreConfig.Service,
  CoreConfig.Service.of({
    entries: () =>
      Effect.succeed([
        new CoreConfig.Document({
          type: "document",
          info: new CoreConfig.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
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
const testOwnerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const grantLookupLayer = Layer.succeedContext(
  Context.make(V2ToolEffect.CurrentPermissionGrantLookup, () => Effect.succeed([])),
)
const historyEpochLookupLayer = Layer.succeedContext(
  Context.make(V2ProviderTurn.CurrentHistoryEpochLookup, () => Effect.succeed(undefined)),
)
const remoteCompactionLayer = Layer.succeedContext(
  Context.make(SessionCompaction.CurrentRemoteCompaction, () =>
    Effect.fail(new Error("remote compaction unavailable")),
  ),
)
const settleHookLayer = Layer.succeedContext(Context.make(SessionRunner.CurrentOnSessionSettled, () => Effect.void))
const gateway = Layer.succeed(
  AgentGateway.Runtime,
  AgentGateway.Runtime.of({
    get snapshot() {
      return AgentGateway.snapshot()
    },
    get active() {
      return AgentGateway.isActiveDeepAgentRuntime()
    },
    get baseDir() {
      return AgentGateway.learningAuthorityConfig().baseDir
    },
    get runsDir() {
      return AgentGateway.learningAuthorityConfig().runsDir
    },
    get selfLearning() {
      return AgentGateway.selfLearningPolicy()
    },
    get durableLearning() {
      return AgentGateway.durableLearningEnabled()
    },
    withStorage: (operation) => operation(),
    ensureKnowledgeSeeded: AgentGateway.flushKnowledgeSeed,
    systemPrompt: AgentGateway.systemPrompt,
    volatileRoundContext: AgentGateway.volatileRoundContext,
    volatileContinuationContext: AgentGateway.volatileContinuationContext,
  }),
)
const sessionContext = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const runnerStack = SessionRunnerLLM.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(providerTurns),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
  Layer.provide(grantLookupLayer),
  Layer.provide(historyEpochLookupLayer),
  Layer.provide(remoteCompactionLayer),
  Layer.provide(sessionContext),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(coreRegistry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(coreConfig),
  Layer.provide(
    Layer.mergeAll(
      catalog,
      selectionSourcesLayer,
      ContextQueryAuthorization.defaultLayer,
      testOwnerAuthorization,
      settleHookLayer,
      gateway,
    ),
  ),
)
const runner = runnerStack.pipe(Layer.provideMerge(database))
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => runnerStack).pipe(
    // This harness supplies its instrumented runner as the complete keyed Location tree.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
  ),
)
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(CoreTaskTool.delegationSlotLayer),
  Layer.provide(locations),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const agentRoster = Layer.effectDiscard(AgentPlugin.Plugin.effect).pipe(
  Layer.provide(agents),
  Layer.provide(location),
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
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Config.defaultLayer,
    RuntimeFlags.defaultLayer,
    events,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    agentRoster,
    coreRegistry,
    models,
    systemContext,
    location,
    skillGuidance,
    coreConfig,
    catalog,
    runner,
    locations,
    execution,
    sessions,
  ),
)

const rev = (ref: string) => gitIn(repo, ["rev-parse", ref]).stdout.toString().trim()
const branchExists = (branch: string) =>
  gitIn(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0

/**
 * A completed, released isolated run whose retained branch carries one commit — the tool's input
 * state. The commit simulates the child's own committed work inside its worktree.
 */
const settledRunWithCommit = (toolCallID: string, file: string, content: string) =>
  Effect.gen(function* () {
    const v2 = yield* SessionV2.Service
    const { db } = yield* Database.Service
    const eventsService = yield* EventV2.Service
    const parent = yield* v2.create({ location: { directory } })
    const submitted = yield* TaskRunAuthority.submit(db, eventsService, v2, {
      parentSessionID: parent.id,
      parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
      toolCallID,
      deliveryMode: "foreground",
      prompt: new Prompt({ text: `implement ${file}` }),
      agent: "general",
      child: {
        title: `task: ${toolCallID}`,
        location: { directory },
        permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
        workspace: { mode: "worktree" as const },
      },
    })
    const row = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, submitted.run.runID)).get().pipe(Effect.orDie)
    yield* Effect.promise(() => fs.writeFile(`${row!.worktree_directory}/${file}`, content))
    expectExit0(gitIn(row!.worktree_directory!, ["add", "-A"]), "worker add")
    expectExit0(gitIn(row!.worktree_directory!, ["commit", "-m", `implement ${file}`]), "worker commit")
    const tip = rev(`refs/heads/${row!.worktree_branch}`)

    const claimed = yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      leaseMs: 60_000,
      now: 1_000,
    })
    yield* TaskRunAuthority.settle(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      claimGeneration: claimed.claimGeneration,
      state: "completed",
      reason: "done",
      output: `implemented ${file}`,
      now: 2_000,
    })
    yield* TaskWorkspace.release(db, { runID: submitted.run.runID })
    return { runID: submitted.run.runID, parent, tip }
  })

const finalizeContext = (sessionID: SessionSchema.ID, messageID: ReturnType<typeof MessageIDValue.make>, callID: string) => ({
  sessionID,
  messageID,
  callID,
  agent: "build",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.pr_finalize (V2 authority)", () => {
  it.instance(
    "validated verdict merges the retained branch into the parent and cleans up",
    () =>
    Effect.gen(function* () {
      const settled = yield* settledRunWithCommit("call-pr-e2e-1", "feature.txt", "feature work\n")
      payloadJson = JSON.stringify({
        implementationCommitSha: settled.tip,
        verdict: "approve",
        rationale: "No findings after exact-SHA review.",
      })
      const parentHeadBefore = rev("refs/heads/main")

      const finalize = yield* PRFinalizeTool
      const result = yield* (yield* finalize.init()).execute(
        {},
        finalizeContext(settled.parent.id, MessageIDValue.make("msg_pr_finalize_e2e_1"), "tool_pr_finalize_e2e_1"),
      )

      expect(result.output).toContain('"status":"merged"')
      // The merge landed the worktree commits in the parent branch (ff) and the checkout is clean.
      expect(rev("refs/heads/main")).toBe(settled.tip)
      expect(yield* Effect.promise(() => fs.readFile(`${repo}/feature.txt`, "utf8"))).toBe("feature work\n")
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")
      expect(parentHeadBefore).not.toBe(settled.tip)

      // The durable receipts: the PR cycle settled 'removed' with the receipt columns, the branch
      // is pruned, and the reviewer run holds a validated evidence row.
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, settled.runID))
        .get()
        .pipe(Effect.orDie)
      expect(row!.worktree_state).toBe("removed")
      expect(row!.pr_operation_key).toBe(`pr:${settled.runID}:${settled.tip}`)
      expect(row!.pr_started_at).not.toBeNull()
      expect(row!.pr_id).toContain("pr-")
      expect(branchExists(row!.worktree_branch!)).toBe(false)

      const reviewer = yield* db
        .select()
        .from(TaskRunTable)
        .where(and(eq(TaskRunTable.tool_call_id, `pr_review:${row!.pr_operation_key}`), eq(TaskRunTable.execution_runtime, "v2")))
        .get()
        .pipe(Effect.orDie)
      expect(reviewer).toBeDefined()
      expect(reviewer!.state).toBe("completed")
      expect(reviewer!.execution_spec?.agent).toBe("reviewer")
      const evidence = yield* db
        .select()
        .from(V2StructuredOutputEvidenceTable)
        .where(eq(V2StructuredOutputEvidenceTable.run_id, reviewer!.run_id))
        .get()
        .pipe(Effect.orDie)
      expect(evidence?.validation_outcome).toBe("validated")
      expect(evidence?.schema_name).toBe("pr_review_verdict")
      expect(JSON.parse(evidence!.raw_output)).toMatchObject({ verdict: "approve" })
    }),
    { git: true },
    30_000,
  )

  it.instance(
    "changes_requested retains the branch and never merges",
    () =>
    Effect.gen(function* () {
      const settled = yield* settledRunWithCommit("call-pr-e2e-2", "revision.txt", "buggy\n")
      payloadJson = JSON.stringify({
        implementationCommitSha: settled.tip,
        verdict: "request_changes",
        rationale: "revision.txt still contains the known bad value",
      })
      const parentBefore = rev("refs/heads/main")

      const finalize = yield* PRFinalizeTool
      const result = yield* (yield* finalize.init()).execute(
        {},
        finalizeContext(settled.parent.id, MessageIDValue.make("msg_pr_finalize_e2e_2"), "tool_pr_finalize_e2e_2"),
      )

      expect(result.output).toContain('"status":"changes_requested"')
      expect(rev("refs/heads/main")).toBe(parentBefore)
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, settled.runID))
        .get()
        .pipe(Effect.orDie)
      expect(row!.worktree_state).toBe("retained")
      // Documented policy: the retained branch keeps the reviewed commits reachable.
      expect(branchExists(row!.worktree_branch!)).toBe(true)
      // Re-invoking the tool on the same tip converges on the recorded decision (no new cycle).
      const again = yield* (yield* finalize.init()).execute(
        { run_ids: [settled.runID] },
        finalizeContext(settled.parent.id, MessageIDValue.make("msg_pr_finalize_e2e_2b"), "tool_pr_finalize_e2e_2b"),
      )
      expect(again.output).toContain('"status":"converged"')
      expect(rev("refs/heads/main")).toBe(parentBefore)
    }),
    { git: true },
    30_000,
  )

  it.instance(
    "crash between merge and cleanup converges on retry",
    () =>
    Effect.gen(function* () {
      const settled = yield* settledRunWithCommit("call-pr-e2e-3", "crash.txt", "crash proof\n")
      payloadJson = JSON.stringify({
        implementationCommitSha: settled.tip,
        verdict: "approve",
        rationale: "No findings.",
      })
      // The crash window: the physical merge landed but the cleanup CAS did not.
      const { db } = yield* Database.Service
      const { TaskPRReview } = yield* Effect.promise(() => import("@deepagent-code/core/session/task-pr-review"))
      const key = TaskPRReview.operationKey({ runID: settled.runID, tip: settled.tip })
      yield* TaskPRReview.submitReview(db, { runID: settled.runID, key })
      yield* TaskPRReview.merge(db, { runID: settled.runID, key })
      const midCrash = yield* db
        .select({ state: TaskRunTable.worktree_state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, settled.runID))
        .get()
        .pipe(Effect.orDie)
      expect(midCrash!.state).toBe("submitted")

      const finalize = yield* PRFinalizeTool
      const result = yield* (yield* finalize.init()).execute(
        { run_ids: [settled.runID] },
        finalizeContext(settled.parent.id, MessageIDValue.make("msg_pr_finalize_e2e_3"), "tool_pr_finalize_e2e_3"),
      )

      expect(result.output).toContain('"status":"merged"')
      const row = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, settled.runID))
        .get()
        .pipe(Effect.orDie)
      expect(row!.worktree_state).toBe("removed")
      expect(branchExists(row!.worktree_branch!)).toBe(false)
      expect(rev("refs/heads/main")).toBe(settled.tip)
    }),
    { git: true },
    30_000,
  )

  it.instance(
    "a verdict not bound to the reviewed tip fails closed and leaves the cycle open",
    () =>
    Effect.gen(function* () {
      const settled = yield* settledRunWithCommit("call-pr-e2e-4", "unbound.txt", "unbound\n")
      payloadJson = JSON.stringify({
        implementationCommitSha: "0".repeat(40),
        verdict: "approve",
        rationale: "Not bound to the reviewed commit.",
      })
      const parentBefore = rev("refs/heads/main")

      const finalize = yield* PRFinalizeTool
      const refused = yield* Effect.exit(
        (yield* finalize.init()).execute(
          {},
          finalizeContext(settled.parent.id, MessageIDValue.make("msg_pr_finalize_e2e_4"), "tool_pr_finalize_e2e_4"),
        ),
      )
      expect(refused._tag).toBe("Failure")
      expect(rev("refs/heads/main")).toBe(parentBefore)
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, settled.runID))
        .get()
        .pipe(Effect.orDie)
      expect(row!.worktree_state).toBe("submitted")
      expect(branchExists(row!.worktree_branch!)).toBe(true)
    }),
    { git: true },
    30_000,
  )
})
