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
  // V4.0.1 P0: three-layer SOFT-LANDING compaction (reminder → fallback "death notes" → hard rollover).
  // Before a hard LLM-summary compaction, the turn loop gives the model a reminder (soft line) and then a
  // one-shot forced "临终笔记" fallback message (all tools retained) so it can flush un-persisted decisions /
  // next-step intent into the durable plan doc BEFORE lossy summarization. Pure-additive, strictly safer
  // default (loses less on compaction), no autonomous side effects → SHIPS ON (mirrors v4Steering posture).
  // With `=false`, overflowStatus() collapses to the pre-V4.0.1 single-threshold ok/hard behavior (逐字节
  // equivalent). Also respects DEEPAGENT_CODE_DISABLE_AUTOCOMPACT (no compaction → no soft-landing).
  softLandingCompaction: stableOn("DEEPAGENT_CODE_SOFT_LANDING_COMPACTION"),
  // V4.0.1 P0b: OUTPUT soft-landing — when a response is cut off at the output-token ceiling
  // (finish === "length") with no pending tool call, instead of ending the turn (the pre-V4.0.1 behavior),
  // inject a "continue from where you were cut off, do not repeat" tail message and loop once more so the
  // model resumes. Bounded by OUTPUT_CONTINUATION_MAX consecutive continuations (reset on any natural stop)
  // to prevent an infinite loop. Improves on Codex, which treats an output-cap hit as a retryable stream
  // error and re-sends the identical request (re-hitting the same cap). Pure-additive, strictly better
  // default (a truncated long answer now completes instead of stopping mid-sentence) → SHIPS ON. With
  // `=false` a length-capped response ends the turn exactly as before V4.0.1.
  outputSoftLanding: stableOn("DEEPAGENT_CODE_OUTPUT_SOFT_LANDING"),
  // V4.0.1 P2: goal BUDGET soft-notify — when cost/maxCost crosses tiered fractions (default [0.7, 0.9]),
  // inject a "converge, don't expand" reminder into the next tick's step-prompt TAIL (never the prefix),
  // mirroring Codex's <rollout_budget>. Pure-additive reminder with NO halting behavior change → SHIPS ON.
  // With `=false` no budget notice is injected (pre-V4.0.1 behavior).
  goalBudgetSoftNotify: stableOn("DEEPAGENT_CODE_GOAL_BUDGET_SOFT_NOTIFY"),
  // V4.0.1 P2: goal NET-token budget accounting. When on, BudgetLedger.tokens accumulates NET generation
  // (output + max(0, input − carriedPrefixTokens)) instead of gross throughput, so a long task's ledger no
  // longer inflates linearly from the repeated static prefix each tick. This CHANGES the accumulation
  // semantics of an already-persisted ledger, so it defaults OFF and only applies to goals CREATED after it
  // is enabled (each goal stamps a `budgetTokenScope: "gross" | "net"` marker; loadState picks the
  // accumulation by marker — never mid-flight). NOTE: token overflow no longer halts a goal regardless of
  // this flag (that halt was removed in P2); this flag only governs the ledger COUNTING convention.
  // Promoted ON (V4.0.1): net accounting is the CORRECT ledger convention (a long task's ledger no longer
  // inflates linearly from the repeated static prefix). Safe as a default because it is stamped PER-GOAL at
  // creation via `budgetTokenScope` — only goals created after this is on accumulate "net"; every
  // already-persisted ledger keeps its stamped "gross" scope and is never re-interpreted mid-flight. Set
  // `=false` to force new goals back to the pre-V4.0.1 gross throughput accounting.
  goalNetTokenBudget: stableOn("DEEPAGENT_CODE_GOAL_NET_TOKEN_BUDGET"),
  // V4.0.1 P1: World State / summary responsibility separation. When on, the compaction summary is narrowed
  // to four buckets (progress+decisions / constraints+prefs / next steps / data references) and files /
  // env / diagnostics are carried by a snapshot-diff World State layer re-injected as a TAIL user block at
  // tick start + after each hard compaction (never the static prefix). Also opens a "always load World
  // State" path for the goal-worker (P3(d)), bypassing shouldLoadBridge's general short-circuit. Because it
  // alters context assembly. Promoted ON (V4.0.1): it is a pure tail-only re-injection (never the static
  // prefix) and the summary narrowing keeps the LLM summary focused, so it is safe as a default; with
  // `=false` the summary keeps the legacy "record everything" template and nothing is re-injected (逐字节
  // equivalent to V4.1). The summary
  // narrowing and the re-injection MUST be gated by this single flag together (splitting them would create a
  // "summary drops files, nothing re-injects" information hole).
  worldStateReinjection: stableOn("DEEPAGENT_CODE_WORLD_STATE_REINJECTION"),
  // T3 (S1-v3.4): how many narrowing attempts a 🟡 stall is given before it escalates to 🔴.
  // Default 1 (one focused retry, then hand off). `positiveInteger` → undefined when unset/invalid,
  // so the loop applies its own default of 1.
  microbatchNarrowLimit: positiveInteger("DEEPAGENT_CODE_MICROBATCH_NARROW_LIMIT"),
  bashDefaultTimeoutMs: positiveInteger("DEEPAGENT_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("DEEPAGENT_CODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("DEEPAGENT_CODE_EXPERIMENTAL_WEBSOCKETS"),
  // ── V4.0 event-driven Agent-OS — DEFAULT OFF (production-safe, operator opt-in) ──────────────────
  // Per §H3 (Feature Flags: all six ship OFF) and §H1 (staged rollout: shadow → low-risk → push
  // manual-confirm → multi-agent gradually), every V4 CAPABILITY defaults OFF in production. This is the
  // pre-V4 (V3.8-equivalent) behavior by default; a deployment turns capabilities on deliberately as it
  // advances the rollout. IMPORTANT: the always-on SAFETY GATES (security-gate, rate-limit) are NOT
  // gated by these flags — they run regardless once wired; these flags gate only the V4 capabilities
  // themselves, never the safety checks. Each flag is an independent OPT-IN: set the env var `=true` to
  // enable one capability for verification or a staged rollout. `bool(name)` = default false, override
  // on with `=true`; the `RuntimeFlags.layer({...})` test helper can also force any flag on
  // programmatically (tests opt into the behavior they exercise).
  //
  // §A/§B: route inbound IM messages through the DeepAgent Event Bus (im.message.created → Router →
  // Scheduler) alongside the legacy path (double-write). Enable with DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM=true.
  v4EventDrivenIm: bool("DEEPAGENT_CODE_V4_EVENT_DRIVEN_IM"),
  // §A4: allow the agent to PUSH proactively (monitor/schedule/ci-driven outbound), through the §B2
  // policy gate. HIGH-RISK (side-effecting outbound) — operator opt-in. Enable with DEEPAGENT_CODE_V4_AGENT_PUSH_ENABLED=true.
  v4AgentPushEnabled: bool("DEEPAGENT_CODE_V4_AGENT_PUSH_ENABLED"),
  // §C: the Multi-Agent Runtime (coordinated multi-agent execution over the bus + agent.task.*
  // coordination). This is the master switch that starts the event-runtime daemons — including the V4.1
  // §N event-driven goal-tick chain (GoalTickConsumer + cold-recovery port). PROMOTED ON by default (V4.1):
  // the daemon audit is GO (every gated daemon is complete + correctly started, InstanceRef-die fix at both
  // sites, approval keys match, goal.tick is now a real consumed command with cross-process cold recovery),
  // and autonomous level_2 edits are the INTENDED semantic of this flag (governed by each agent descriptor's
  // declared autonomy ceiling, guarded by the four-layer SecurityGate + Approval Queue + concurrency cap +
  // file locks + trusted-source gating on external events — external webhooks stay fail-closed until an
  // operator opts their source into the workspace trustedSources). Set
  // DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME=false to restore the pre-V4 (V3.8-equivalent) inert posture: no
  // daemons subscribe, ticks run via the in-process BackgroundJob driver, nothing is autonomous.
  v4MultiAgentRuntime: stableOn("DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME"),
  // NOTE: there is deliberately NO separate "autonomy level 2" flag. The §D autonomy gate
  // (AutonomyPolicy.decide in multi-agent-runtime.ts) is driven purely by each agent's DECLARED autonomy
  // ceiling in its descriptor — a flag could only ever have MASKED that, and a former
  // v4AgentAutonomyLevel2 flag was inert (advertised in /global/capabilities but wired to neither the UI
  // nor the gate), so it was removed rather than left as a control that controls nothing. Enabling
  // v4MultiAgentRuntime authorizes autonomous action up to each agent's own ceiling (builtin fixers are
  // level_2 = act-then-report), guarded by the four-layer SecurityGate + Approval Queue + concurrency cap
  // + file locks + trusted-source gating on external events. To restrict autonomy, tighten the agent
  // descriptors' `autonomy` levels — config can only tighten a ceiling, never raise it.
  // §B: threaded conversations (thread query + reply grouping on the IM surface). Default OFF (known
  // correctness bugs pending). Enable with DEEPAGENT_CODE_V4_THREAD_ENABLED=true.
  v4ThreadEnabled: bool("DEEPAGENT_CODE_V4_THREAD_ENABLED"),
  // §B: inbound file/attachment upload on the IM surface (im_attachments + local-disk storage). Enable
  // with DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED=true.
  v4FileUploadEnabled: bool("DEEPAGENT_CODE_V4_FILE_UPLOAD_ENABLED"),
  // §M: the Expert Panel AUTO-CONVENE consumer — auto-summons an Expert Panel for high-risk events
  // (destructive migrations, security alerts, architecture changes) per PanelConvenePolicy, routing a
  // needs_human verdict to the §D2 Approval Queue. HIGH-COST (fans out reviewer subagents) + autonomous
  // — operator opt-in. Enable with DEEPAGENT_CODE_V4_PANEL_AUTO_CONVENE=true.
  v4PanelAutoConvene: bool("DEEPAGENT_CODE_V4_PANEL_AUTO_CONVENE"),
  // §L: the EVENT-DRIVEN execution archiver TRIGGER. When on, a completed ROOT session (its end-of-turn
  // idle signal) is republished as a `session.completed` event onto the DeepAgent Event Bus, so the §L
  // EventDrivenArchiver has a trigger and archives the execution trajectory as a Wiki page OFF the
  // session loop. Independent of IM (§L is a Repo/Wiki capability, not an IM one — the archiver's own
  // header says so), so it carries its OWN flag rather than riding v4EventDrivenIm. Default OFF (P0.3
  // production posture): with it off the bridge is inert — nothing subscribes, nothing publishes, and
  // the V3.9 inline archive (prompt.ts, gated by experimentalWiki) remains the only archival path.
  // Enable with DEEPAGENT_CODE_V4_EVENT_DRIVEN_ARCHIVE=true.
  v4EventDrivenArchive: bool("DEEPAGENT_CODE_V4_EVENT_DRIVEN_ARCHIVE"),
  // V4.1 §S1.1: mid-turn STEERING — a user message that arrives while a turn is in flight is buffered
  // in a durable per-session steer queue and ABSORBED at the next model-request boundary of the live
  // turn loop (SessionPrompt.runLoop), appended as an ordinary tail user message (never aborting the
  // in-flight stream/tools). Unlike the HIGH-RISK V4 autonomy flags, steering is a pure-additive
  // soft-absorb with NO autonomous side effects, so it SHIPS ON by default — it is the foundational
  // interactive primitive. It is nonetheless a real kill-switch: with `=false` the drain never runs and
  // behavior is exactly the pre-steering path (busy sessions await / BusyError as before). This gates
  // ONLY the runLoop steer drain — it does NOT activate the dormant experimentalEventSystem V2 runner.
  // Disable with DEEPAGENT_CODE_V4_STEERING=false.
  v4Steering: stableOn("DEEPAGENT_CODE_V4_STEERING"),
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
