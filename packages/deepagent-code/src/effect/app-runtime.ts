import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { V2OwnerSeed } from "@deepagent-code/core/session/runner/v2-owner-seed"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { Hash } from "@deepagent-code/core/util/hash"
import { attach } from "./run-service"
import * as Observability from "@deepagent-code/core/effect/observability"

import { SessionV2 } from "@deepagent-code/core/session"
import { devCampaignMint } from "@/effect/dev-campaign-mint"
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
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Reference } from "@/reference/reference"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@deepagent-code/core/npm"
import { memoMap } from "@deepagent-code/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { LegacyEventCanonicalizerRuntime } from "@/legacy-event-canonicalizer-runtime"
import { productionSourcesLayer } from "@/context-federation/production-sources"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { RecoveryExecutor } from "@/server/recovery-executor"
import { V2RunnerFrame } from "@/session/v2-runner-frame"

const baseAppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Database.defaultLayer,
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
  EventV2Bridge.defaultLayer,
  SessionProjection.defaultLayer,
  DurableLearningRuntime.defaultLayer,
  // RISK-003 ④: durable schedule for the legacy event canonicalizer (flag-gated, default OFF).
  LegacyEventCanonicalizerRuntime.defaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  // §16.3 order 3 caller wiring: the flag-gated subagent V2 drive resolves SessionV2 via
  // serviceOption from THIS root scope. The same memoized liveLayer is already built inside the
  // SessionPrompt subtree, so providing it here only exports the shared singleton — no split-brain,
  // no extra construction.
  SessionV2.liveLayer,
  // W3.10 — V2 runner real frame (O-W3-10): LAST-WINS within the merge over the live layer's
  // internal LocationServiceMap.layer — per-location runner trees build with the ref's instance
  // context + a ProductionV2Sources override carrying the REAL location identity (same derivation
  // as the C6 readiness probe), so runner selection rows bind the real frame instead of v2:local.
  V2RunnerFrame.runnerFrameLocationMapLayer,
  // The augmented map resolves the identity per location ref through `LocationIndexRuntime` (needs
  // the service in the graph env at drain time — the index handle + identity are per instance).
  LocationIndexRuntime.defaultLayer,
  GoalManager.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.configuredLayer,
  ToolRegistry.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Reference.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
).pipe(Layer.provideMerge(InstanceLayer.layer), Layer.provideMerge(Observability.layer))

// §16.3 order 4: V2 turn receipts record the durable history-window boundary (PromptEpoch active
// row) instead of the ContextEpoch revision; read-only seam, absent epoch keeps pre-seam identity.
// Direction matters: the seam must be PROVIDED INTO the base graph so the runner's drain fibers
// (built inside SessionV2.liveLayer) can resolve it — a seam piped AROUND the base graph stays
// invisible to that subtree and silently degrades to the pre-seam identity. The seam self-feeds the
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
  // W2.2 — C1B recovery executor production wiring (in-app composition): provide the DB-backed
  // durable SessionProviderRecovery service over the shared Database singleton (single-instance
  // local process, no clustering) and the executor whose layer build runs the startup drain —
  // process boot = post-crash resume (applies committed pending recovery commands, never fails).
  // Both self-provide the module-level Database.defaultLayer constant (memoized by object
  // identity, so it is the SAME connection the base graph builds — no split-brain).
  Layer.provide(RecoveryExecutor.recoveryDurableLayer.pipe(Layer.provide(Database.defaultLayer))),
  Layer.provide(
    RecoveryExecutor.layer.pipe(
      Layer.provide(RecoveryExecutor.recoveryDurableLayer.pipe(Layer.provide(Database.defaultLayer))),
      Layer.provide(Database.defaultLayer),
    ),
  ),
  Layer.provideMerge(devCampaignMint),
  // W0.5: deliver the shipped owner-authorization.json into the local DB once per runtime build
  // (after the database layer initialized; fail-open on file absence, fail-closed on verification
  // failure — nothing unverifiable is written).
  Layer.provideMerge(
    V2OwnerSeed.layer({ env: process.env, appRoot: V2OwnerSeed.defaultOwnerAuthorizationAppRoot() }),
  ),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

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
