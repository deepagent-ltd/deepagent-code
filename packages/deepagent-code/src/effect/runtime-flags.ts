import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
// A capability that ships ON by default but can be explicitly disabled with `=false` (U5: background
// subagents are promoted from experimental to a stable local capability in V3.3).
const stableOn = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("DEEPAGENT_CODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@deepagent-code/RuntimeFlags", {
  autoShare: bool("DEEPAGENT_CODE_AUTO_SHARE"),
  pure: bool("DEEPAGENT_CODE_PURE"),
  disableDefaultPlugins: bool("DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("DEEPAGENT_CODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("DEEPAGENT_CODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE"),
    direct: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE"),
    direct: bool("DEEPAGENT_CODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("DEEPAGENT_CODE_ENABLE_EXA"),
    legacy: bool("DEEPAGENT_CODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("DEEPAGENT_CODE_ENABLE_PARALLEL"),
    legacy: bool("DEEPAGENT_CODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("DEEPAGENT_CODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("DEEPAGENT_CODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_REFERENCES"),
  // U5 (V3.3): promoted from experimental to a stable LOCAL capability — background subagents are on
  // by default. NOTE: this is local, non-durable (process restart loses live jobs); cross-restart
  // recovery + remote/cloud agents are deferred to V3.4 (S1 §10). Disable with =false.
  experimentalBackgroundSubagents: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("DEEPAGENT_CODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_LSP_TOOL"),
  // V3.8 App-A C2.5 (Stage 5): query_log tool — lets the agent retrieve slices of the append-only
  // Conversation Log (full reasoning / edited-withdrawn originals / untruncated tool IO) on demand.
  // Promoted ON by default: the WRITE side is now wired (SessionPrompt.runLoop drives
  // ConversationLogWriter each iteration + a final pass), so the log is actually populated and the
  // read tool returns real entries. The writer is default-safe (matchCauseEffect → no-op on any fs
  // failure), so enabling the tool by default cannot crash a turn. Set `=false` to disable.
  experimentalQueryLogTool: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_QUERY_LOG"),
  // V3.8 App-A Stage 1: maintain the Session Ledger alongside compaction (parse each compaction
  // summary into structured ledger entries + persist as the `ledger` DocType). Coexists with V1
  // compaction — does NOT replace the assembly path. Default OFF (gated grey rollout, C6 §1). Enable
  // with DEEPAGENT_CODE_EXPERIMENTAL_CONTEXT_LEDGER.
  experimentalContextLedger: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_CONTEXT_LEDGER"),
  // L6 (V3.4): code_intel (symbol-driven AI IDE entry) ships ON by default and is promoted out of
  // the experimental gate — `=false` disables. grep is never disabled; no-server files fall back.
  codeIntelTool: stableOn("DEEPAGENT_CODE_CODE_INTEL_TOOL"),
  // P3A (S1-v3.5): profile tool (symbol/region-driven PAP profiling entry). Ships ON by default;
  // set =false to disable. Requires R0 privilege gate + execution approval at runtime.
  profileTool: stableOn("DEEPAGENT_CODE_PROFILE_TOOL"),
  // D3 (S1-v3.5): debug tool (DAP symbol-driven debugger entry). Ships ON by default;
  // set =false to disable. Requires R0 privilege gate + execution approval at runtime.
  debugTool: stableOn("DEEPAGENT_CODE_DEBUG_TOOL"),
  // M7 (S1-v3.4): when a connected MCP server's tier derives to `read_only` (catalog-matched), its
  // tools auto-allow without a per-call prompt. ON by default (the V3.4 design). Set `=false` to
  // restore the pre-M7 behavior where EVERY MCP tool call goes through `ctx.ask` — a defense-in-depth
  // escape hatch for users who want the human checkpoint on read-only servers too.
  mcpReadOnlyAutoAllow: stableOn("DEEPAGENT_CODE_MCP_READONLY_AUTO_ALLOW"),
  experimentalOxfmt: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES"),
  // V3.9 §C: Expert Panel（会诊机制）— differentiated expert lenses answer one frozen high-risk
  // question independently, aggregated by a deterministic non-LLM Arbiter. SHIPS ON by default (mode
  // redesign: mature capabilities are always present, flags are only a kill-switch — mirrors Codex's
  // stable-default features). Set DEEPAGENT_CODE_EXPERIMENTAL_EXPERT_PANEL=false to disable. The
  // Arbiter is a pure function; this flag only gates the session-driven Convener orchestration.
  experimentalExpertPanel: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_EXPERT_PANEL"),
  // V3.9 §B: Repo & Wiki（人向监督层）— the human-facing PROJECTION layer over the four graphs (not a
  // fifth store): render doc/code nodes as Markdown, full-text search, docs↔code cross-links, and a
  // per-session execution archive. Knowledge/Memory pages are governable (edit → new version + human
  // provenance via evidence-gate); Document/Code pages are read-only; sealed scope is NEVER projected
  // (INV-7). SHIPS ON by default (kill-switch only; it is pure projection + reuse of the existing
  // promote/reject pipeline, so it is rollback-safe). Set DEEPAGENT_CODE_EXPERIMENTAL_WIKI=false to disable.
  experimentalWiki: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_WIKI"),
  // V3.9 §D: Goal Loop（自主长跑原语）— a supervised, cross-tick control loop that drives 计划→执行→验证→
  // 迭代 against an OBJECTIVELY decidable completion criterion until met or a HARD stop limit fires. The
  // Controller + deterministic Grader live in core (`deepagent/goal-loop.ts`, PURE with injected ports);
  // this flag gates the deepagent-code WIRING (GraderPorts → validation runner / LSP diagnostics /
  // reviewer / Panel; step executor → SessionPrompt; rollback → revert) plus the loop/design worker
  // native agent. SHIPS ON by default (kill-switch only; the schemas are additive and the loop cannot
  // start without objective criteria + hard limits, so it is safe on by default — this is what powers
  // the loop/design collaboration modes). Set DEEPAGENT_CODE_EXPERIMENTAL_GOAL_LOOP=false to disable.
  experimentalGoalLoop: stableOn("DEEPAGENT_CODE_EXPERIMENTAL_GOAL_LOOP"),
  experimentalIconDiscovery: enabledByExperimental("DEEPAGENT_CODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("DEEPAGENT_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  // T3 (S1-v3.4): how many narrowing attempts a 🟡 stall is given before it escalates to 🔴.
  // Default 1 (one focused retry, then hand off). `positiveInteger` → undefined when unset/invalid,
  // so the loop applies its own default of 1.
  microbatchNarrowLimit: positiveInteger("DEEPAGENT_CODE_MICROBATCH_NARROW_LIMIT"),
  bashDefaultTimeoutMs: positiveInteger("DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("DEEPAGENT_CODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("DEEPAGENT_CODE_EXPERIMENTAL_WEBSOCKETS"),
  // ── V4.0 event-driven Agent-OS (all default OFF — gated grey rollout) ──────────────────────────
  // V4.0 §A/§B: route inbound IM messages through the DeepAgent Event Bus (im.message.created domain
  // events → Router → Scheduler) instead of the direct synchronous session path. Default OFF: the
  // double-write shim keeps the legacy path authoritative until the bus is proven. Enable with
  // DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM.
  v4EventDrivenIm: bool("DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM"),
  // V4.0 §A4: allow the agent to PUSH proactively (agent-initiated outbound messages driven by
  // monitor/schedule/ci events) rather than only replying to a human turn. Default OFF — proactive
  // push is high-blast-radius and must be explicitly opted into. Enable with
  // DEEPAGENT_CODE_V4_AGENT_PUSH_ENABLED.
  v4AgentPushEnabled: bool("DEEPAGENT_CODE_V4_AGENT_PUSH_ENABLED"),
  // V4.0 §C: the Multi-Agent Runtime (coordinated multi-agent execution over the bus with handoff +
  // agent.task.* coordination events). Default OFF until the runtime + scheduler are integration-
  // proven. Enable with DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME.
  v4MultiAgentRuntime: bool("DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME"),
  // V4.0 §D: permit autonomy level 2 (act-then-report — the agent executes reversible actions without
  // a pre-approval turn, subject to the Oversight ceiling). Default OFF: levels 0/1 (ask-first) remain
  // the ceiling until Oversight UI ships. Enable with DEEPAGENT_CODE_V4_AGENT_AUTONOMY_LEVEL_2.
  v4AgentAutonomyLevel2: bool("DEEPAGENT_CODE_V4_AGENT_AUTONOMY_LEVEL_2"),
  // V4.0 §B: threaded conversations (thread-scoped event correlation + reply grouping in the IM
  // surface). Default OFF until the thread projection + UI land. Enable with
  // DEEPAGENT_CODE_V4_THREAD_ENABLED.
  v4ThreadEnabled: bool("DEEPAGENT_CODE_V4_THREAD_ENABLED"),
  // V4.0 §B: inbound file/attachment upload on the IM surface (attachment events + storage). Default
  // OFF until storage + scanning are wired. Enable with DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED.
  v4FileUploadEnabled: bool("DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED"),
  // V4.0 §M: the Expert Panel AUTO-CONVENE consumer. When on, the PanelConveneConsumer subscribes to
  // the bus and auto-summons an Expert Panel for high-risk events (destructive migrations, security
  // alerts, architecture changes) per the pure PanelConvenePolicy, publishing a panel.verdict and
  // routing a needs_human verdict to the §D2 Approval Queue. Default OFF: auto-convening is high-cost
  // (fans out reviewer subagents) and high-blast-radius, so it must be explicitly opted into — an
  // explicit V3.9 in-session Convener call is unaffected. Enable with DEEPAGENT_CODE_V4_PANEL_AUTO_CONVENE.
  v4PanelAutoConvene: bool("DEEPAGENT_CODE_V4_PANEL_AUTO_CONVENE"),
  client: Config.string("DEEPAGENT_CODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
