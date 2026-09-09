import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { V2OwnerSeed } from "@deepagent-code/core/session/runner/v2-owner-seed"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { Hash } from "@deepagent-code/core/util/hash"
import { attach } from "./run-service"
import * as Observability from "@deepagent-code/core/effect/observability"

import { DevCampaignMint, devCampaignMint } from "@/effect/dev-campaign-mint"
import { PromptEpoch } from "@/session/prompt-epoch"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Database } from "@deepagent-code/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@deepagent-code/core/filesystem/ripgrep"
import { Search } from "@deepagent-code/core/filesystem/search"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionProjection } from "@/session/session-projector"
import { SessionPrompt } from "@/session/prompt"
import { GoalManager } from "@/session/goal-manager"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { CompositionDigest } from "./composition-digest"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Reference } from "@/reference/reference"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@deepagent-code/core/npm"
import { makeMemoMap } from "@deepagent-code/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { LegacyEventCanonicalizerRuntime } from "@/legacy-event-canonicalizer-runtime"
import { productionSourcesLayer } from "@/context-federation/production-sources"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { RecoveryExecutor } from "@/server/recovery-executor"
import { V2RunnerFrame } from "@/session/v2-runner-frame"
import { V2OutboxRuntime } from "@/event/v2-outbox-runtime"

const v2StartupRecovery = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* DevCampaignMint
    yield* V2OwnerSeed.Service
    const outcome = yield* (yield* SessionRestart.Service).redriveStartup
    if (outcome.blocked.length > 0)
      yield* Effect.logWarning("V2 startup recovery left fenced Sessions", outcome.blocked)
  }),
)

// Records which database file this root opened. `Server.listen` compares it against the listen
// target before adopting this root — env (`Flag.DEEPAGENT_CODE_DB`) can change between builds in
// tests, so a built root is only authoritative for the file captured at ITS build time.
let rootDatabasePath: string | undefined
const captureRootDatabasePath = Layer.effectDiscard(
  Effect.sync(() => {
    rootDatabasePath = Database.path()
  }),
)

const baseAppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Ripgrep.defaultLayer,
  Search.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  ModelsDev.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  V2OutboxRuntime.layer,
  SessionProjection.defaultLayer,
  DurableLearningRuntime.layer,
  // RISK-003 ④: durable schedule for the legacy event canonicalizer (flag-gated, default OFF).
  LegacyEventCanonicalizerRuntime.defaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.productionLayer,
  v2StartupRecovery,
  LocationIndexRuntime.defaultLayer,
  GoalManager.productionLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.configuredLayer,
  ToolRegistry.productionLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Reference.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
).pipe(
  // These authorities must be providers of the merged production graph, not siblings whose
  // outputs cannot satisfy V2 outbox/session inputs.
  Layer.provideMerge(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provideMerge(V2RunnerFrame.sessionRuntimeLayer),
  // RI-123: same owner-qualification references the HTTP graph root provides — prompt paths
  // running on this root resolve them from the calling fiber's context.
  Layer.provideMerge(V2RunnerFrame.ownerQualificationReferencesLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
  Layer.provide(DurableLearningRuntime.reviewerRegistryLayer),
  Layer.provide(DurableLearningRuntime.lifecycleObserverLayer.pipe(Layer.provide(Database.defaultLayer))),
)

// §16.3 order 4: V2 turn receipts record the durable history-window boundary (PromptEpoch active
// row) instead of the ContextEpoch revision; read-only seam, absent epoch keeps pre-seam identity.
// Direction matters: the seam must be PROVIDED INTO the base graph so the open application V2
// runtime captures it before constructing its Location map. The seam self-feeds the
// module-level Database.defaultLayer constant: memoized per runtime by object identity, so it is
// the SAME connection the base graph builds (no split-brain).

// ---------------------------------------------------------------------------------------------------
// 1.4.8.rN dev campaign mint (live-test seam, env-gated, NEVER active without the env var): when
// DEEPAGENT_CODE_V2_DEV_CAMPAIGN is a JSON {campaignID, privateKeyPem, identity:{subjectCommit,
// subjectTree, schemaDigest, buildID, packageDigest}}, the root runtime inserts ONE signed owner
// authorization row (ephemeral issuance pair, onConflictDoNothing semantics). Production r0 mints
// campaigns through the operator flow instead — this seam exists so the packaged live test can boot
// the V2-only profile with a verifiable campaign against a real provider.
export const AppLayer = baseAppLayer.pipe(
  // W3.7 — the ProductionV2Sources VALUE seam: provided INTO the base graph (same context-flow
  // mechanism as the PromptEpoch seam below) so the location-layer runner subtree — whose
  // `productionV2SourcesLayer` forwards an outer-scope value from its build context — resolves the
  // LIVE four-graph sources (LiveCodeQuery / LocationIndexCoordinator / durable knowledge +
  // released-snapshot picker). `process.cwd()` is the production workspace (one server per
  // project); absent this seam the runner degrades the four graphs honestly (pre-W3.7 behavior).
  Layer.provide(productionSourcesLayer({ workspaceDirectory: process.cwd() })),
  Layer.provide(PromptEpoch.v2RunnerSeamLayer.pipe(Layer.provide(Database.defaultLayer))),
  // W7 — settle-triggered durable learning: the runner's `onSessionSettled` hook (same INTO-the-base
  // graph direction as the v2RunnerSeam above; `DEEPAGENT_DURABLE_LEARNING=false` keeps legacy-only).
  Layer.provide(DurableLearningRuntime.onSessionSettledSeamLayer.pipe(Layer.provide(Database.defaultLayer))),
  // W2.2 — C1B recovery executor production wiring: the executor layer build runs the startup drain —
  // process boot = post-crash resume (applies committed pending recovery commands, never fails).
  // It self-provides the module-level Database.defaultLayer constant (memoized by object
  // identity, so it is the SAME connection the base graph builds — no split-brain).
  Layer.provide(RecoveryExecutor.layer.pipe(Layer.provide(Database.defaultLayer))),
  Layer.provideMerge(devCampaignMint),
  // W0.5: deliver the shipped owner-authorization.json into the local DB once per runtime build
  // (after the database layer initialized; fail-open on file absence, fail-closed on verification
  // failure — nothing unverifiable is written).
  Layer.provideMerge(V2OwnerSeed.layer({ env: process.env, appRoot: V2OwnerSeed.defaultOwnerAuthorizationAppRoot() })),
  Layer.provideMerge(captureRootDatabasePath),
)

// The embedded in-process HTTP server (`Server.Default`) builds its route graph with
// this same memo map, so InstanceStore / PTY / LocationServiceMap / Database identity —
// and therefore disposal authority — live in ONE explicit process root shared by the
// AppRuntime bridges (CLI/TUI worker) and the embedded server. `Server.listen`
// listeners and test runtimes keep private per-root maps (RI-106).
const rootMemoMap = makeMemoMap()
const rt = ManagedRuntime.make(AppLayer, { memoMap: rootMemoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

/** Memo map of the one explicit process root; `Server.Default` builds its web handler with it. */
export const embeddedServerMemoMap = () => rootMemoMap

/**
 * The fully-built AppRuntime root, or `undefined` before the first build completes (and after
 * dispose). Never triggers a build. `Server.listen` adopts this root's memo map when the listen
 * target is the same database file: the lifetime runtime lock (`<db>.runtime.lock`) is
 * process-exclusive, so a listener opening its own private root for that file would re-run the
 * external preflight against this process's OWN lock and misclassify it as a competing process
 * (maintenance-only boot — the file-backed `serve` P0). Adopting keeps one owner, one lock.
 */
export const builtAppRuntimeRoot = () => {
  if (rt.cachedContext === undefined || rootDatabasePath === undefined) return undefined
  return { memoMap: rootMemoMap, databasePath: rootDatabasePath }
}

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}

/**
 * RI-36/RI-44 — programmatic composition digest of the AppRuntime root, for embedded consumers
 * (CLI/TUI worker, tests). Runs against the SAME root context the embedded server shares, so its
 * digest must equal the HTTP-exposed digest of the server route graph facet by facet.
 */
export const compositionDigest = (): Promise<CompositionDigest.Record> => AppRuntime.runPromise(CompositionDigest.current)
