export * as V4EventRuntime from "./v4-event-runtime"

import { Cause, Duration, Effect, Layer, Schedule } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { RetentionSweeper } from "@deepagent-code/core/deepagent/retention-sweeper"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SecurityResolvers } from "@deepagent-code/core/deepagent/security-resolvers"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { LSP } from "../lsp/lsp"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MultiAgentRuntime } from "./multi-agent-runtime"
import { EventDispatcher } from "./event-dispatcher"
import type { SubagentTurnRunner, SubagentTurnResult } from "./goal-loop-wiring"
import { MessageID } from "./schema"
import { SessionCompletedPublisher } from "./session-completed-publisher"
import { EventDrivenArchiver } from "@/wiki/event-driven-archiver"
import { PanelConveneConsumer } from "@/panel/panel-convene-consumer"
import { consultPanel } from "@/panel/consult"
import type { PanelTurnRunner } from "@/panel/panelist-runner"
import { makeTaskSubagentRunner } from "./goal-loop-wiring"
// §B2/§E4 (P2.8) — proactive push stack.
import { AgentPush } from "./agent-push"
import { DigestBuilder } from "./digest-builder"
import { SupervisorNotifier } from "./supervisor-notifier"
// V4.1 §N — the event-driven goal-tick consumer + its production cold-reconstruction port.
import { GoalTickConsumer } from "./goal-tick-consumer"
import { GoalTickPort } from "./goal-tick-port"
import { goalStoreRoot } from "./goal-manager"
import { SessionRevert } from "./revert"
import { SessionSteer } from "./steer"
import { EventV2Bridge } from "@/event-v2-bridge"
// §C3 (P2.9) — file locks + code-graph symbols.
import { FileLock } from "@deepagent-code/core/file-lock"
import { openProjectStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { symbolsForFilePaths } from "@deepagent-code/core/deepagent/code-indexer"
import { resolveDeepAgentCodeHome } from "@deepagent-code/core/deepagent/workspace"
import * as Log from "@deepagent-code/core/util/log"
// §C3.2 (P4.5a) — physical per-agent worktree isolation (git-CLI helper; fail-safe → event dir).
import { createAgentWorktree, cleanupAgentWorktree, type AgentWorktree } from "./agent-worktree"

// V4.0 §A4/§C — the PRODUCTION event-runtime. This is the layer that was missing: every V4 daemon and
// consumer was built + unit-tested but NEVER STARTED in prod, so published events were durably logged
// and then ignored. This layer assembles them and starts their scoped fibers with the server:
//
//   EventDispatcher   — subscribes the bus, runs the §A4 router, hands routed events to →
//   MultiAgentRuntime — the DispatchPort; coordinates §C execution via a real turn runner →
//   RetentionSweeper  — the §A3 periodic prune loop.
//
// Everything is FLAG-GATED at the point of behavior: the dispatcher only dispatches when
// v4MultiAgentRuntime is on (else the router observes + acks), so merely providing this layer does not
// change runtime behavior until an operator flips the flag. The daemon fibers are scoped to the layer,
// so they start with the server and stop when it shuts down.
//
// LAYERING: deepagent-code. Depends on the instance session stack (Session/SessionPrompt/Agent/Provider)
// for the real turn runner, plus the core V4 services.

const log = Log.create({ service: "v4-event-runtime" })

// §G — a per-turn wall-clock ceiling for event-driven agent runs. Generous (event work can be
// substantial) but finite, so a blocked tool can't stall the sequential dispatch loop forever.
const EVENT_TURN_TIMEOUT_MS = 10 * 60 * 1000

const failedTurn = (): SubagentTurnResult => ({ ok: false, structured: undefined, text: "", tokensUsed: 0, cost: 0 })

// The production SubagentTurnRunner for event-driven dispatch. Unlike the goal-loop runner (which
// parents each turn to a fixed goal session), an event has no parent session — so this creates a fresh
// ROOT session rooted in the triggering event's workspace/directory (mirrors the IM agent executor),
// then runs one prompt turn. The model is the provider default (event-triggered agents have no
// inherited session model).
// Exported for direct testing: the regression lock asserts this runner does NOT silently return
// failedTurn when invoked with no ambient InstanceRef (the real daemon-fiber environment) — proving
// every InstanceState-touching call runs inside withContext (a die would pierce orElseSucceed).
export const makeEventTurnRunner = (deps: {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly sessionPrompt: SessionPrompt.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }>
  // §C3.2 (P4.5a) — physical per-agent worktree isolation. Injectable so a test can drive it without a
  // real git repo; production defaults to the git-CLI helpers. createWorktree returns null when isolation
  // is impossible (not a git repo / git unavailable / add failed) → the runner FALLS BACK to the event
  // directory (prior behavior, never fails the turn). cleanupWorktree runs on turn settle (Effect.ensuring)
  // and preserves the agent's work on its branch. Set enableWorktreeIsolation:false to disable entirely.
  readonly enableWorktreeIsolation?: boolean
  readonly createWorktree?: (input: {
    readonly eventDirectory: string
    readonly label: string
  }) => Promise<AgentWorktree | null>
  readonly cleanupWorktree?: (wt: AgentWorktree) => Promise<void>
}): SubagentTurnRunner =>
  (input) =>
    Effect.gen(function* () {
      // §C — the event's workspaceID is a grouping key that may be a genuine "wrk"-id OR a directory
      // fallback (single-user / directory-routed). Only forward a genuine workspace id to the session.
      // (This derivation reads NO InstanceState, so it is safe on the bare daemon fiber — do it first.)
      const workspaceID =
        input.workspaceID && input.workspaceID.startsWith("wrk")
          ? WorkspaceV2.ID.make(input.workspaceID)
          : undefined
      // The turn must run in a REAL working directory. Prefer an explicit event directory; else, only a
      // NON-"wrk" workspaceID doubles as a directory. A bare "wrk_"-id is NOT a path → no directory.
      const eventDirectory =
        input.directory ?? (input.workspaceID && !input.workspaceID.startsWith("wrk") ? input.workspaceID : undefined)
      if (!eventDirectory) return failedTurn()

      // §C3.2 (P4.5a) — attempt to create a dedicated, isolated git worktree for THIS agent turn, rooted
      // at the event directory. On success the turn runs in the isolated tree (physical isolation between
      // concurrent agents, complementing the P2.9 file-locks + arbiter); on ANY failure (not a git repo,
      // git unavailable, add failed) createWorktree resolves null and we FALL BACK to the event directory
      // — the prior behavior — so a non-git / single-agent path is unaffected. Default ON; injectable +
      // toggleable for testing. The worktree is torn down on turn settle via Effect.ensuring below.
      const worktreeEnabled = deps.enableWorktreeIsolation !== false
      const createWt = deps.createWorktree ?? createAgentWorktree
      const cleanupWt = deps.cleanupWorktree ?? cleanupAgentWorktree

      // §C3.2 (P4.5a) — acquire/use/release BINDS cleanup to creation so there is NO interrupt window
      // between "worktree created" and "cleanup installed". Effect.acquireUseRelease runs `acquire`
      // UNINTERRUPTIBLY and GUARANTEES `release` runs once acquire succeeds — even if `use` (the turn) is
      // interrupted mid-flight (a MultiAgentRuntime concurrency-pool teardown or daemon shutdown). This
      // closes the leak a plain create-then-Effect.ensuring left open: an EXTERNAL interrupt observed at the
      // create→ensuring gap (the Effect.promise async boundary) would skip the finalizer install and orphan
      // the worktree dir + agent/* branch forever. timeout / normal failure / happy path are unaffected
      // (release also runs on those) — this only additionally covers the external-interrupt timing window.
      //
      // acquire — create the isolated worktree (or null on non-git / failure → fallback to the event dir).
      const acquire = worktreeEnabled
        ? Effect.promise(() => createWt({ eventDirectory, label: input.correlationID ?? input.agentType })).pipe(
            Effect.orElseSucceed(() => null),
          )
        : Effect.succeed<AgentWorktree | null>(null)
      // release — tear down the worktree, preserving the agent's work on its branch (agent-worktree.ts). A
      // NO-OP when no worktree was created (fallback path) — it NEVER touches the event directory. Wrapped
      // in catchCause so a cleanup hiccup can't become a defect during interruption/settle (fail-safe).
      const release = (worktree: AgentWorktree | null) =>
        worktree
          ? Effect.promise(() => cleanupWt(worktree)).pipe(Effect.catchCause(() => Effect.void))
          : Effect.void

      return yield* Effect.acquireUseRelease(
        acquire,
        (worktree) =>
          Effect.gen(function* () {
            // The directory the rest of the turn runs in: the isolated worktree when we got one, else the
            // event directory (fallback). Everything below (instance load, session.create) uses THIS.
            const directory = worktree?.directory ?? eventDirectory
      // CRITICAL: this runs on a background daemon fiber, which carries NO InstanceRef (that is only set
      // per-request by the instance-context middleware). EVERY InstanceState-touching call — agents.get,
      // sessions.create, defaultModel, the prompt calls — reads InstanceRef and `Effect.die`s without it
      // (instance-state.ts:15-17). A die is a DEFECT that pierces `orElseSucceed` (which only catches the
      // E channel), so it would hit the outer catchCause → EVERY event-driven turn silently returns
      // failedTurn — i.e. the whole event-driven execution chain never runs. So we ESTABLISH the instance
      // context FIRST — load it for the event's directory (load PRODUCES ctx; it does not itself need an
      // InstanceRef) — then run all four call sites inside withContext (mirrors the instance-context
      // middleware + the IM executor, which inherit it from the request fiber).
      const ctx = yield* deps.instanceStore.load({ directory }).pipe(Effect.orElseSucceed(() => undefined))
      if (!ctx) return failedTurn()

      const withContext = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        eff.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))

      // agents.get MUST run inside withContext (it resolves through InstanceState → dies without
      // InstanceRef). With the context provided it no longer dies; a genuine unknown-agent still resolves
      // to undefined via orElseSucceed → fail-soft failedTurn (semantics preserved).
      const next = yield* withContext(deps.agents.get(input.agentType)).pipe(Effect.orElseSucceed(() => undefined))
      if (!next) return failedTurn()

      const child = yield* withContext(
        deps.sessions.create({
          agent: next.name,
          title: `${input.agentType} (event)`,
          directory,
          ...(workspaceID ? { workspaceID } : {}),
          // §F2 trace back-half — stamp the correlationID onto the child session's metadata; Observability
          // .trace reads it back (json_extract) and appends this child as a "session" node, so the trace
          // follows correlationID from the event down into the child session's activity (its message /
          // tool-call turns). The Multi-Agent Runtime passes event.correlationID ?? event.id.
          ...(input.correlationID ? { metadata: { correlationID: input.correlationID } } : {}),
        } as Parameters<Session.Interface["create"]>[0]),
      ).pipe(Effect.orElseSucceed(() => undefined))
      if (!child) return failedTurn()

      if (input.prepareSession) {
        try {
          input.prepareSession(child.id)
        } catch {
          /* best-effort seed; the turn still runs */
        }
      }

      // defaultModel resolves through InstanceState too (Provider.defaultModel → InstanceState.get) →
      // wrap it, else it dies on the daemon fiber exactly like agents.get.
      const model = yield* withContext(deps.defaultModel())
      const parts = yield* withContext(deps.sessionPrompt.resolvePromptParts(input.prompt))
      const result = yield* withContext(
        deps.sessionPrompt.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model,
          agent: next.name,
          ...(input.outputSchema
            ? { format: { type: "json_schema" as const, schema: input.outputSchema } as never }
            : {}),
          parts,
        }),
      ).pipe(
        // §C1/§G — bound the turn: an event-triggered session has no interactive client, so a tool that
        // blocks on approval would otherwise hang the whole (sequential) dispatch loop indefinitely. Honor
        // the agent's DECLARED per-turn ceiling (limits.maxTurnDurationMs, threaded via input) when set +
        // positive; else fall back to the fixed default. (P3.13 — was a hard-coded constant.)
        Effect.timeout(
          typeof input.maxTurnDurationMs === "number" && input.maxTurnDurationMs > 0
            ? input.maxTurnDurationMs
            : EVENT_TURN_TIMEOUT_MS,
        ),
        // The prompt result is a SessionV1.WithParts — its assistant `info` carries the REAL per-turn
        // token accounting. Keep the full shape (info + parts) so P4.1 can thread usage/cost/text below.
        Effect.map(
          (r) =>
            r as {
              readonly info?: {
                readonly role?: string
                readonly tokens?: {
                  readonly input?: number
                  readonly output?: number
                  readonly reasoning?: number
                }
                readonly cost?: number
              }
              readonly parts?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
              // legacy/back-compat: some callers surfaced a flattened top-level `text`.
              readonly text?: string
            },
        ),
        Effect.orElseSucceed(() => undefined),
      )
      if (!result) return failedTurn()

      // P4.1 — thread the REAL token usage from the prompt result so the §E2 per-agent/hour token-budget
      // gate (multi-agent-runtime.ts debitTokens) actually debits. The completed assistant message carries
      // {input, output, reasoning, cache:{read,write}}; the budget counts input+output+reasoning (the
      // billable LLM work — same total the goal-loop runner debits; cache reads/writes are excluded to
      // match). Fail-soft to 0 when the shape is absent (a stub/non-assistant turn). Mirrors
      // makeTaskSubagentRunner (goal-loop-wiring.ts) so both runners feed the budget identically.
      const info = result.info
      const tokensUsed =
        info?.role === "assistant"
          ? Math.max(0, (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0))
          : 0
      const cost = info?.role === "assistant" && typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : 0
      // Prefer the final text part (real WithParts shape); fall back to a flattened top-level `text`.
      const text =
        result.parts?.findLast?.((p) => p.type === "text")?.text ??
        (typeof result.text === "string" ? result.text : "") ??
        ""

            return {
              ok: true,
              structured: undefined,
              text,
              tokensUsed,
              cost,
              sessionID: child.id,
            }
          }), // end use (the turn body)
        // release — GUARANTEED once acquire succeeds, on ANY exit (success / failure / timeout / external
        // interrupt). Preserves the agent's work on its branch; a no-op for the null-fallback (never the
        // event dir).
        (worktree) => release(worktree),
      )
    }).pipe(Effect.catchCause(() => Effect.succeed(failedTurn())))

// §M — the PRODUCTION PanelConvenePort for the auto-convene daemon. The PanelConveneConsumer never
// creates sessions itself (it takes an injected port); this builds the real one for the DAEMON context,
// which — like makeEventTurnRunner — carries NO InstanceRef. So we: derive a real working directory from
// the event (explicit payload.directory else a non-"wrk" workspaceID doubles as a path); establish the
// instance context (InstanceStore.load + provide InstanceRef/WorkspaceRef); create a fresh ROOT session
// the panelists parent to; build a PanelTurnRunner via makeTaskSubagentRunner (the SAME child-session +
// permission-derivation path the HTTP panelConsult handler uses via panelTurnRunnerFor); then run
// consultPanel with the frozen question and return the deterministic PanelVerdict. Risk class → quorum
// policy: "security" ⇒ the §C.6 any-block-blocks policy, else "default". Wrapped in catchCause so a
// failure surfaces as a PORT error (the consumer nacks → retry, capped) rather than a fabricated verdict.
// Exported for direct testing: the regression lock asserts this port does NOT die when invoked with no
// ambient InstanceRef (the real daemon-fiber environment) — proving every InstanceState-touching call
// runs inside withContext.
export const makeEventPanelPort = (deps: {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly sessionPrompt: SessionPrompt.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }>
}): PanelConveneConsumer.PanelConvenePort =>
  (input) =>
    Effect.gen(function* () {
      const event = input.event
      // Derive the working directory the same way makeEventTurnRunner does: an explicit event
      // `directory` in the payload, else a NON-"wrk" workspaceID (which doubles as a directory in the
      // single-user / directory-routed model). A bare "wrk_"-id is NOT a path.
      const payloadDir = (event.payload as { directory?: unknown } | null)?.directory
      const directory =
        typeof payloadDir === "string"
          ? payloadDir
          : event.workspaceID && !event.workspaceID.startsWith("wrk")
            ? event.workspaceID
            : undefined
      if (!directory) return yield* Effect.fail("panel port: no directory derivable from event" as const)

      const workspaceID =
        event.workspaceID && event.workspaceID.startsWith("wrk")
          ? WorkspaceV2.ID.make(event.workspaceID)
          : undefined

      // Establish the instance context on this daemon fiber (no InstanceRef otherwise → session.create
      // dies). Mirrors makeEventTurnRunner + the instance-context middleware.
      const ctx = yield* deps.instanceStore.load({ directory })
      const withContext = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        eff.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))

      // The panelists parent to a fresh ROOT session rooted in the event's workspace/directory.
      // CRITICAL: defaultAgent / defaultModel / sessions.create ALL resolve through InstanceState, which
      // reads InstanceRef and `Effect.die`s when it is absent (instance-state.ts:15-17). This port runs
      // on the consumer's daemon subscription fiber, which carries NO ambient InstanceRef — so EVERY such
      // call MUST run inside withContext, not just sessions.create. (Agent.defaultAgent → useEffect →
      // get → directory → context → InstanceRef; Provider.defaultModel → InstanceState.get → same path.)
      const agentName = yield* withContext(deps.agents.defaultAgent())
      const root = yield* withContext(
        deps.sessions.create({
          agent: agentName,
          title: `panel (event ${event.type})`,
          directory,
          ...(workspaceID ? { workspaceID } : {}),
        } as Parameters<Session.Interface["create"]>[0]),
      )

      const model = yield* withContext(deps.defaultModel())
      // Build the panelist turn runner exactly as the HTTP handler's panelTurnRunnerFor does — but run
      // each turn inside the established instance context (the daemon fiber has none).
      const baseRunner = makeTaskSubagentRunner({
        sessions: deps.sessions,
        agents: deps.agents,
        sessionPrompt: deps.sessionPrompt,
        parentSessionID: root.id,
        model: { providerID: model.providerID, modelID: model.modelID },
      })
      const runTurn: PanelTurnRunner = (turnInput) =>
        withContext(
          baseRunner({
            agentType: turnInput.agentType,
            prompt: turnInput.prompt,
            ...(turnInput.outputSchema ? { outputSchema: turnInput.outputSchema } : {}),
          }),
        ).pipe(Effect.map((r) => ({ structured: r.structured })))

      // Risk class → quorum policy: a security risk gets the §C.6 any-block-blocks policy; else default.
      const policy = input.riskClass === "security" ? ("security" as const) : ("default" as const)
      const verdict = yield* withContext(
        consultPanel(
          { question: input.question, codeRefs: [], parentSessionID: root.id, policy },
          { runTurn },
        ),
      )
      return verdict
    }).pipe(
      // A daemon-side failure (missing directory, unloadable instance, session create) surfaces as a
      // port error so the consumer NACKS for a capped retry — never a fabricated verdict.
      Effect.catchCause((cause) => Effect.fail(cause)),
    )

// The MultiAgentRuntime layer, built with the production event turn runner. Requires the session stack
// + core V4 services (provided by the app graph). This is the DispatchPort the dispatcher drives.
const runtimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const instanceStore = yield* InstanceStore.Service
    const concurrency = yield* WorkspaceConcurrency.Service
    // §E1 — the PRODUCTION security resolvers. Without these the four-layer gate is default-OPEN (L1/L2/L4
    // resolve to trusted/permitted/allowed unconditionally); injecting them makes L1 (event-source trust),
    // L2 (actor workspace permission) and L4 (runtime operation pre-gate) evaluate REAL facts and FAIL
    // CLOSED on any lookup error. L3 (agent capability) is pure in SecurityGate and already enforced.
    const sec = yield* SecurityResolvers.Service
    // §C3.1 — the process-wide file-lock service (a Layer.succeed singleton; the SAME instance the file
    // HTTP handlers use, so a human editing a file blocks an agent subtask from touching it).
    const fileLock = yield* FileLock.Service
    const runner = makeEventTurnRunner({
      sessions,
      agents,
      sessionPrompt,
      instanceStore,
      // provider default model, resolved per turn; falls back to failedTurn on error via the runner.
      defaultModel: () => provider.defaultModel().pipe(Effect.orDie),
    })
    // §E2 — cap concurrent agent execution per workspace (default 5).
    // §E1 — wire the four-layer gate to real, fail-closed resolvers:
    //   L1 (event_source)  — per-EVENT: the event's workspace trusted-source set (system events must
    //                        still pass this — the default set includes "system"). Fails closed.
    //   L2 (actor_permission) — the actor is a member of the workspace OR the acting agent is registered
    //                        for it (no-actor/system events defer to L1 by design). Fails closed.
    //   L4 (runtime_operation) — the agent's declared toolWhitelist pre-gate (defense-in-depth; the child
    //                        session's own permission path remains the fine-grained enforcement).
    return MultiAgentRuntime.layerWith({
      runner,
      concurrency,
      fileLock,
      // §C3.3 — feed the arbiter's semantic layer. Best-effort: open the event directory's project store
      // and read the code-graph symbol keys hosted by the subtask's files. A bare "wrk"-id (not a real
      // path) OR any store/config failure resolves to [] so file-level conflict detection still holds.
      symbolsForFiles: (event, files) =>
        Effect.gen(function* () {
          if (files.length === 0) return [] as ReadonlyArray<string>
          const directory =
            typeof (event.payload as { directory?: unknown } | null)?.directory === "string"
              ? (event.payload as { directory: string }).directory
              : event.workspaceID && !event.workspaceID.startsWith("wrk")
                ? event.workspaceID
                : undefined
          if (!directory) return [] as ReadonlyArray<string>
          const store = openProjectStore(resolveDeepAgentCodeHome(), directory)
          return yield* symbolsForFilePaths(store, files)
        }).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>))),
      trustedSourcesFor: (event) => sec.resolveTrustedSources(event.workspaceID),
      actorHasPermission: (event, agent) =>
        sec.actorHasWorkspacePermission({
          workspaceID: event.workspaceID,
          ...(event.actorID != null ? { actorID: event.actorID } : {}),
          agentID: agent.id,
        }),
      runtimeAllowed: (event, agent, capability) =>
        sec.runtimeAllowsOperation({ workspaceID: event.workspaceID, agent, capability }),
    })
  }),
)

// The master switch: are ANY V4 event-driven daemons active for this process? True if any of the
// event-driven flags is on. We read flags ONCE at layer build and start the daemon fibers only when
// active — so with all flags off (the default) the layer is genuinely INERT: nothing subscribes, nothing
// ticks, and — critically — the RetentionSweeper does NOT run (it would otherwise prune events on a
// 30-day TTL, a real behavior change). Flip a flag and restart to activate; per-event behavior remains
// additionally flag-gated inside each daemon.
const anyV4DaemonEnabled = (flags: RuntimeFlags.Info): boolean =>
  flags.v4MultiAgentRuntime ||
  flags.v4EventDrivenIm ||
  flags.v4PanelAutoConvene ||
  flags.v4AgentPushEnabled ||
  flags.v4EventDrivenArchive

// The EventDispatcher layer whose DispatchPort is the live MultiAgentRuntime. Its subscribe/tick/retry
// daemons run only when a V4 daemon is enabled (else runLoops:false ⇒ built but dormant). The dispatcher
// additionally flag-checks v4MultiAgentRuntime per event before dispatching.
const dispatcherLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rt = yield* MultiAgentRuntime.Service
    const flags = yield* RuntimeFlags.Service
    const concurrency = yield* WorkspaceConcurrency.Service
    return EventDispatcher.layerWith({
      dispatchPort: { dispatch: rt.dispatch },
      runLoops: anyV4DaemonEnabled(flags),
      // §A4 backpressure reads the live agent-execution depth (total across workspaces) so the router
      // sheds low/normal events when the runtime is saturated; high/critical always pass.
      queueDepth: () => concurrency.totalDepth(),
    })
  }),
)

// The retention sweeper daemon — started only when a V4 daemon is enabled. This coupling is
// self-consistent, not a surprise: the durable event/audit tables are written ONLY by V4 publishers
// (the flag-gated IM double-write, goal-manager, agent-push), so with all V4 flags off nothing is
// written and there is nothing to prune. Turning any V4 flag on both starts writing those rows AND
// starts the 30-day sweep that bounds them — they activate together by design.
const retentionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return RetentionSweeper.layerWith({ runLoop: anyV4DaemonEnabled(flags) })
  }),
)

// §E2 — the publish rate-limiter SWEEP daemon. The bus's per-workspace publish-rate buckets are an
// in-memory map that grows one entry per workspace that publishes; without a periodic prune it retains
// a bucket for every workspace forever (a slow leak). This scoped fiber calls sweepPublishLimiter on a
// cadence to drop windows that have already elapsed. Same flag coupling as the retention sweeper: the
// limiter is only populated by V4 publishers (im.message.created / goal.*), so with all V4 flags off
// nothing publishes → no buckets → nothing to prune, and this daemon stays inert. A failure in one pass
// is logged and swallowed so the loop never dies. Provides no service (Layer.effectDiscard) — it exists
// purely for its scoped daemon fiber, so it merges cleanly alongside the other daemon layers.
const LIMITER_SWEEP_INTERVAL_MS = 60_000
const limiterSweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (!anyV4DaemonEnabled(flags)) return
    const bus = yield* DeepAgentEventBus.Service
    yield* bus
      .sweepPublishLimiter()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.error("publish-limiter sweep failed", { cause: Cause.pretty(cause) })),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(LIMITER_SWEEP_INTERVAL_MS))),
        Effect.forkScoped,
      )
  }),
)

// ── §A4/§N — PRODUCTION schedule bootstrap ──────────────────────────────────────────────────────────
// The Scheduler's tick loop scans a durable table that, until now, NOTHING in production ever wrote to
// (the entire delay/periodic/condition machinery + the "3× CI failure → repair" example were dead). This
// block registers the two canonical §A4 schedules at startup so the tick loop has real rows to fire.
//
// The schedules live under a single SYSTEM workspace. `Scheduler.due(now)` scans across ALL workspaces
// (it filters only on status + fire_at), so one system-scoped row is enough for the periodic scan to be
// picked up process-wide. The "wrk"-prefix marks it a genuine workspace id (not a directory fallback in
// the turn runner); an absent WorkspaceConfig row resolves to DEFAULT_TRUSTED_SOURCES (which includes
// "schedule"), so the §E1 layer-1 source-trust gate passes for these self-originated events.
export const SYSTEM_WORKSPACE_ID = "wrk_system"

// (A) §A4 周期扫描 — a daily maintenance scan for the §A1 MaintenanceAgent. Fires `schedule.scan`.
export const MAINTENANCE_SCAN_EVENT = "schedule.scan"
export const MAINTENANCE_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily

// (B) §A4 条件触发 / §N — the "连续 3 次 CI 失败才启动修复" trigger. Fires `ci.repair.requested` only when
// ≥ 3 `ci.failure` events are seen in the window. crossWorkspace: real per-project CI failures (P1.4
// webhook ingress) land in their own project workspaces, so this SYSTEM-level trigger counts ci.failure
// ACROSS workspaces (the tick omits the workspace filter) — else it would never fire on real failures.
// groupByRepo (P4.5b): the count is PARTITIONED by the failure's `payload.repo` and the threshold is
// evaluated PER REPO, so a repair fires for the repo that actually failed 3× (carrying repo=<repo> +
// scoped to that repo's workspace) — not a global counter that conflates independent repos. crossWorkspace
// + groupByRepo compose: crossWorkspace gathers the cross-tenant ci.failure stream, groupByRepo splits it.
export const CI_FAILURE_EVENT = "ci.failure"
export const CI_REPAIR_EVENT = "ci.repair.requested"
export const CI_REPAIR_THRESHOLD = 3
export const CI_REPAIR_WINDOW_MS = 30 * 60 * 1000 // 30 min
export const CI_REPAIR_RECHECK_MS = 60 * 1000 // re-evaluate the window once a minute

// Stable identity keys embedded in each schedule's eventTemplate.payload + written to the unique
// `schedule_key` column. The Scheduler inserts keyed schedules with onConflictDoNothing, so a duplicate
// registration (even a concurrent second process racing the same boot) is a DB-level no-op that returns
// the existing row — idempotent across restarts with no accreting duplicate rows.
export const MAINTENANCE_SCAN_KEY = "v4:maintenance-scan"
export const CI_REPAIR_KEY = "v4:ci-3x-failure-repair"

/**
 * Register the canonical production schedules IDEMPOTENTLY. Idempotency is enforced at the DB layer: each
 * schedule is registered with a stable `scheduleKey`, written to the unique `schedule_key` column and
 * inserted with onConflictDoNothing — so a duplicate registration (even a concurrent second process
 * racing the same boot) is a no-op that returns the existing row, never a duplicate. Exported for direct,
 * clock-controlled testing; `scheduleBootstrapLayer` calls it (flag-gated) with the real clock at startup.
 */
export const registerBootstrapSchedules = (scheduler: Scheduler.Interface, now: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* scheduler.schedulePeriodic({
      workspaceID: SYSTEM_WORKSPACE_ID,
      intervalMs: MAINTENANCE_SCAN_INTERVAL_MS,
      firstFireAt: now + MAINTENANCE_SCAN_INTERVAL_MS,
      scheduleKey: MAINTENANCE_SCAN_KEY,
      eventTemplate: {
        type: MAINTENANCE_SCAN_EVENT,
        source: "schedule",
        workspaceID: SYSTEM_WORKSPACE_ID,
        priority: "low",
        payload: { scheduleKey: MAINTENANCE_SCAN_KEY, kind: "maintenance" },
      },
    })

    yield* scheduler.scheduleCondition({
      workspaceID: SYSTEM_WORKSPACE_ID,
      condition: {
        eventType: CI_FAILURE_EVENT,
        threshold: CI_REPAIR_THRESHOLD,
        windowMs: CI_REPAIR_WINDOW_MS,
        crossWorkspace: true,
        // P4.5b — count + fire PER REPO (payload.repo), so a repair is scoped to the repo that failed 3×.
        groupByRepo: true,
      },
      recheckEveryMs: CI_REPAIR_RECHECK_MS,
      firstCheckAt: now,
      scheduleKey: CI_REPAIR_KEY,
      eventTemplate: {
        type: CI_REPAIR_EVENT,
        source: "schedule",
        workspaceID: SYSTEM_WORKSPACE_ID,
        priority: "high",
        payload: { scheduleKey: CI_REPAIR_KEY, reason: "3x-ci-failure" },
      },
    })
  })

// The startup effect that registers the production schedules. Gated on v4MultiAgentRuntime — the flag
// that governs dispatch of these non-im/non-push events. Registering them while that flag is OFF would
// seed rows that fire events the dispatcher then drops, so we only register when the capability is live.
// Default OFF ⇒ nothing registered ⇒ a fresh prod DB stays empty (no dead rows). A failure is logged and
// swallowed so a transient DB hiccup at boot can't crash the layer build; the next restart re-attempts
// (idempotently). Provides no service (Layer.effectDiscard) — like the limiter sweep it exists purely for
// its startup effect and merges cleanly alongside the daemon layers.
export const scheduleBootstrapLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (!flags.v4MultiAgentRuntime) return
    const scheduler = yield* Scheduler.Service
    yield* registerBootstrapSchedules(scheduler, Date.now()).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => log.error("schedule bootstrap failed", { cause: Cause.pretty(cause) })),
      ),
    )
  }),
)

// ── §B2/§E4 (P2.8) — the PROACTIVE PUSH stack ────────────────────────────────────────────────────────
// The §B2 push stack (AgentPush policy runtime + §E4 DigestBuilder + the SupervisorNotifier caller) was
// built + tested but never STARTED in prod. This wires all three, sharing the ONE DeepAgentEventBus /
// Database / WorkspaceConfig / IMRepository the rest of the runtime uses. All gated on v4AgentPushEnabled:
//   • AgentPush.push fail-closes on the flag (returns flag_disabled) — inert when off.
//   • SupervisorNotifier's subscription runLoop is off ⇒ no subscription (no pending-row pileup).
//   • DigestBuilder's flush daemon runs ONLY when the flag is on.
// AgentPush.layer resolves REAL quiet-hours from WorkspaceConfig — not a false default.
const agentPushLayer = AgentPush.layer
const digestBuilderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return DigestBuilder.layerWith({ runLoop: flags.v4AgentPushEnabled })
  }),
)
const supervisorNotifierLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return SupervisorNotifier.layerWith({ runLoop: flags.v4AgentPushEnabled })
  }),
)
// The push stack, with AgentPush.Service provided into the digest + notifier (the notifier CALLS it).
const pushStackLayer = Layer.mergeAll(digestBuilderLayer, supervisorNotifierLayer).pipe(
  Layer.provideMerge(agentPushLayer),
)

// §L — the EVENT-DRIVEN execution archiver. Subscribes the shared bus and archives on session.completed
// (published by SessionCompletedPublisher under v4EventDrivenArchive) AND goal.completed (published by
// the goal-manager under v4MultiAgentRuntime). Its ONLY build-time dep is DeepAgentEventBus (the archive
// mechanics — archiveSessionOnCompletion — are pulled best-effort inside handle, never at layer build),
// so it merges cleanly alongside the other daemon layers over the shared bus.
//
// FLAG COUPLING: runLoop = v4EventDrivenArchive || v4MultiAgentRuntime. The archiver consumes BOTH
// trigger types, and its group ("wiki-archiver") is delivery-tracked — so it must subscribe whenever
// EITHER producer is live, else a published trigger's pending delivery row never gets acked (symmetric
// producer/consumer gating). With both flags OFF (the default) runLoop is false ⇒ NO subscription ⇒ the
// group is never registered ⇒ no pending-row pileup. That is the correctness point.
// Exported for direct flag-coupling testing; `layer` merges it. (The panel consumer layer is not
// exported because it yields the full session stack at build — its flag-off inertness is covered by the
// consumer's own layerWith(runLoop:false) unit test.)
export const archiverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return EventDrivenArchiver.layerWith({ runLoop: flags.v4EventDrivenArchive || flags.v4MultiAgentRuntime })
  }),
)

// §M — the Expert Panel AUTO-CONVENE consumer. Subscribes the shared bus, runs the pure §M policy on
// each event, and — on "convene" — drives the EXISTING V3.9 panel engine via makeEventPanelPort (which
// establishes daemon-fiber instance context, creates a root session, and runs consultPanel). Draws the
// session stack (Session/Agent/SessionPrompt/InstanceStore/Provider) — the SAME set makeEventTurnRunner
// uses in runtimeLayer — plus DeepAgentEventBus + ApprovalQueue + RuntimeFlags from the outer graph.
//
// FLAG COUPLING: runLoop = v4PanelAutoConvene. Default OFF ⇒ runLoop false ⇒ NO subscription ⇒ the
// "panel-convener" group is never registered ⇒ no pending-row pileup. The consumer additionally
// flag-gates per event (handle() acks + returns null when the flag is off), so even a stray delivery is
// discharged rather than leaking.
const panelConsumerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const instanceStore = yield* InstanceStore.Service
    const convene = makeEventPanelPort({
      sessions,
      agents,
      sessionPrompt,
      instanceStore,
      defaultModel: () => provider.defaultModel().pipe(Effect.orDie),
    })
    return PanelConveneConsumer.layerWith({ convene, runLoop: flags.v4PanelAutoConvene })
  }),
)

// V4.1 §N — the GOAL TICK CONSUMER. Subscribes goal.tick.requested and executes each tick via the
// production cold-reconstruction port (makeGoalTickPort), then re-emits the next command. This is what
// makes the goal-loop tick GENUINELY event-driven with cross-process cold recovery: a goal survives a
// process restart because every tick rebuilds its wiring from the durable run_context doc + the event
// payload (no in-memory control map needed). Draws the SAME session stack makeEventTurnRunner uses, plus
// SessionRevert / SessionSteer / LSP / EventV2Bridge for the rollback / goal-steer / diagnostics / SSE
// ports, all from the shared graph.
//
// FLAG COUPLING: runLoop = v4MultiAgentRuntime (the master event-driven switch — the goal-manager's
// dual-path start publishes the FIRST command only on this flag). Default posture matches the flag: with
// it off, runLoop is false ⇒ NO subscription ⇒ the "goal-tick-consumer" group is never registered ⇒ no
// pending-row pileup, and handle() additionally acks-and-drives-nothing on a stray delivery.
const goalTickConsumerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPrompt = yield* SessionPrompt.Service
    const revert = yield* SessionRevert.Service
    const steerBuffer = yield* SessionSteer.Service
    const provider = yield* Provider.Service
    const lsp = yield* LSP.Service
    const instanceStore = yield* InstanceStore.Service
    const events = yield* EventV2Bridge.Service
    const eventBus = yield* DeepAgentEventBus.Service
    const approvalQueue = yield* ApprovalQueue.Service
    const runTick = GoalTickPort.makeGoalTickPort({
      sessions,
      agents,
      sessionPrompt,
      revert,
      steerBuffer,
      provider,
      lsp,
      instanceStore,
      events,
      eventBus,
      approvalQueue,
      flags,
      goalStoreRoot,
    })
    return GoalTickConsumer.layerWith({ runTick, runLoop: flags.v4MultiAgentRuntime })
  }),
)

/**
 * The full V4 event-runtime, ready to merge into the instance app graph. Starts (as scoped daemons):
 * the EventDispatcher (router + scheduler tick + retry pump), the MultiAgentRuntime (DispatchPort),
 * the RetentionSweeper, the §E2 publish-limiter sweep, the §A4/§N schedule bootstrap, and the §L
 * SessionCompletedPublisher (republishes a completed root session's end-of-turn idle as
 * `session.completed` so the archiver has a trigger). All behavior is flag-gated, so providing this
 * layer is inert until the V4 flags are enabled.
 *
 * Requires from the surrounding graph: Session, SessionPrompt, Agent, Provider, RuntimeFlags,
 * EventV2Bridge, and a Database (for the core V4 services this self-provides over it). The core services
 * (DeepAgentEventBus / ApprovalQueue / Scheduler / WorkspaceConfig / WorkspaceConcurrency /
 * AgentListProvider / RetentionSweeper) are provided here so the daemons share one bus + DB.
 */
export const layer = Layer.mergeAll(
  dispatcherLayer,
  retentionLayer,
  limiterSweepLayer,
  scheduleBootstrapLayer,
  // §L — the session.completed producer. Its subscription/publish is gated on v4EventDrivenArchive
  // (inert when off). It draws DeepAgentEventBus (provided alongside the runtime), plus RuntimeFlags /
  // EventV2Bridge / Session from the shared app graph — so it shares the ONE bus the archiver consumes.
  SessionCompletedPublisher.layer,
  // §L — the event-driven archiver CONSUMER. Shares the ONE DeepAgentEventBus with the publisher above;
  // gated on v4EventDrivenArchive || v4MultiAgentRuntime (see archiverLayer).
  archiverLayer,
  // §M — the Expert Panel auto-convene CONSUMER. Shares the ONE DeepAgentEventBus + ApprovalQueue with
  // the rest of the runtime; gated on v4PanelAutoConvene (see panelConsumerLayer). Draws the session
  // stack from the outer graph (same services runtimeLayer consumes).
  panelConsumerLayer,
  // §B2/§E4 (P2.8) — the proactive-push stack (AgentPush + DigestBuilder flush + SupervisorNotifier).
  // All flag-gated on v4AgentPushEnabled; inert (no push, no flush) when off. Draws DeepAgentEventBus /
  // Database / WorkspaceConfig / IMRepository / RuntimeFlags from the shared graph.
  pushStackLayer,
  // V4.1 §N — the event-driven goal-tick consumer. Gated on v4MultiAgentRuntime (see goalTickConsumerLayer).
  // Shares the ONE DeepAgentEventBus + ApprovalQueue + session stack with the rest of the runtime.
  goalTickConsumerLayer,
).pipe(
  Layer.provideMerge(runtimeLayer),
)

