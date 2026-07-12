import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import type {
  ControllerDeps,
  GraderPorts,
  RollbackPort,
  StepExecutor,
  StepExecutorResult,
} from "@deepagent-code/core/deepagent/goal-loop"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import type * as LSPClient from "../lsp/client"
import { LSP } from "../lsp/lsp"
import { runPanel } from "../panel/orchestrator"
import { buildPanelistRunner, parseReviewResult, REVIEWER_SCHEMA } from "../panel/panelist-runner"
import { DEFAULT_QUORUM_POLICY, type PanelLens, type PanelVerdict } from "../agent/schema/panel"
import { ReviewResult } from "../agent/schema/orchestration"
import { RuntimeFlags } from "../effect/runtime-flags"
import { SessionPrompt } from "./prompt"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { MessageID, SessionID } from "./schema"
import { runValidationCommands } from "../deepagent/validation-exec"

/**
 * V3.9 §D / §F.3 — Goal Loop production WIRING.
 *
 * `goal-loop.ts` (core) is a PURE controller + deterministic Grader over INJECTED ports (§D.3/§D.6):
 * it CANNOT import LSP / panel / reviewer / SessionPrompt (all deepagent-code). This module is the
 * missing half — it assembles a real `GraderPorts` + `RollbackPort` + `StepExecutor` from the live
 * services and hands back a `ControllerDeps` so a caller does `makeGoalLoop(deps)`. Everything here is
 * gated by `flags.experimentalGoalLoop` (§F.3): flag OFF ⇒ `makeGoalLoopWiring` yields `null` and the
 * goal loop is simply unavailable — no service is touched, no effect on base behaviour, and NO import
 * of wiki/panel changes anything (the three V3.9 flags are independently rollback-safe).
 *
 * The real port mappings (§D.3 "不新造打分模型" — reuse existing capabilities):
 *   tests_pass     → `runValidationCommands` (the SAME validation runner the multi-round loop uses);
 *                    `pass = allPassed(results)`.
 *   no_diagnostics → `LSP.Service.diagnostics()`, reduced to the single highest severity present,
 *                    mapped to a label ("error"/"warning"/"info"/"hint"); null when none.
 *   reviewer_clean → a reviewer subagent turn (ReviewResult schema); `pass` iff no finding strictly
 *                    exceeds `maxSeverity`.
 *   panel_approves → `runPanel(...)` with a real lens-prompted panelist runner (§D.7 关键决策点召集
 *                    panel); `decision = verdict.decision`.
 *   rollback       → `SessionRevert.Service`, best-effort (never fatal).
 *   step executor  → ONE `SessionPrompt` turn against the `goal-worker` agent (§D.6 不越权: the turn
 *                    runs through the NORMAL session/tool permission path — the loop never elevates).
 *
 * The subagent turns (panelist / reviewer / step) all funnel through ONE injected `SubagentTurnRunner`
 * port (`makeTaskSubagentRunner` is the real one — it creates a child session with derived permissions
 * and drives one turn via the SAME `SessionPrompt` ops the `task` tool uses). Keeping it a port means
 * the integration test can stub the leaf LLM I/O while every aggregator (Grader, arbiter, controller)
 * runs for real.
 */

// ---------------------------------------------------------------------------------------------------
// Severity mapping — LSP DiagnosticSeverity (1=Error, 2=Warning, 3=Information, 4=Hint) → the label
// strings goal-loop.ts's SEVERITY_RANK understands. Lower LSP number = MORE severe.
// ---------------------------------------------------------------------------------------------------

const LSP_SEVERITY_LABEL: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" }

/** The single highest severity present across the diagnostics map, or null when there are none. */
export const highestDiagnosticSeverity = (
  diagnostics: Record<string, readonly LSPClient.Diagnostic[]>,
): string | null => {
  let best: number | null = null // lower number = more severe
  for (const issues of Object.values(diagnostics)) {
    for (const d of issues) {
      const sev = typeof d.severity === "number" ? d.severity : 1 // undefined severity ⇒ treat as Error
      if (best === null || sev < best) best = sev
    }
  }
  return best === null ? null : (LSP_SEVERITY_LABEL[best] ?? "error")
}

// review severity ordering for the reviewer_clean gate (higher = more severe).
const REVIEW_SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 }
const reviewRank = (s: string): number => REVIEW_SEVERITY_RANK[s.trim().toLowerCase()] ?? 99

// ---------------------------------------------------------------------------------------------------
// SubagentTurnRunner — the single real seam that drives ONE subagent turn. Production wires
// `makeTaskSubagentRunner`; tests inject a stub. Never throws — a failure resolves to `ok:false`.
// ---------------------------------------------------------------------------------------------------

export type SubagentTurnResult = {
  readonly ok: boolean
  /** The structured output object when an output schema was requested and the turn produced one. */
  readonly structured: unknown | undefined
  /** The final text part (free-text turns). */
  readonly text: string
  /** input+output+reasoning tokens for this turn (0 when unknown). */
  readonly tokensUsed: number
  /** dollar cost for this turn (0 when unknown). */
  readonly cost: number
  /**
   * §D/§E F3 — the id of the session the turn actually ran in (the created child session for the real
   * runner). The goal-worker StepExecutor uses it to MIRROR the worker's plan-state back into the goal
   * plan doc after the turn. Undefined when the runner does not create/expose a session (stubs).
   */
  readonly sessionID?: string
}

export type SubagentTurnInput = {
  readonly agentType: string
  readonly prompt: string
  /** Optional JSON Schema forcing a structured final turn (reviewer / panelist). */
  readonly outputSchema?: Record<string, unknown>
  /**
   * V4.0 §C — the workspace/directory the turn should be rooted in, for a runner that is NOT bound to a
   * fixed parent session (the event-driven Multi-Agent Runtime creates a fresh root session per event
   * in the triggering event's workspace). The goal-loop runner ignores these (it parents to the goal
   * session). `workspaceID` is a genuine "wrk"-id or a directory-fallback; `directory` is the worktree.
   */
  readonly workspaceID?: string
  readonly directory?: string
  /**
   * §F2 trace — the triggering event's correlationID. When present, the runner STAMPS it onto the child
   * session's `metadata.correlationID`. This is one HALF of the §F2 back-half: `Observability.trace` READS
   * it back (json_extract over session metadata, scoped to the same correlationID + routing key) and
   * appends the child session as a "session" node, so the trace follows correlationID from the event down
   * into the child session's activity (its message / tool-call turns). The stamp is inert on its own — the
   * trace-query read is what makes it observable. The goal-loop runner leaves this unset (its turns belong
   * to the goal session's own trace); the event-driven Multi-Agent Runtime passes `event.correlationID ??
   * event.id` so a coordinated turn's child session joins back to the triggering event.
   */
  readonly correlationID?: string
  /**
   * §C1/§G — the executing agent's declared per-turn wall-clock ceiling (limits.maxTurnDurationMs). The
   * event turn runner bounds the turn with THIS when set, falling back to its fixed default otherwise.
   * The goal-loop runner ignores it (its turns are bounded by the goal ledger). Unset ⇒ default timeout.
   */
  readonly maxTurnDurationMs?: number
  /**
   * §D/§E F3 — optional hook invoked with the child session id AFTER the session is created but BEFORE
   * the prompt turn runs. The goal-worker StepExecutor uses it to SEED the child session's plan-state
   * from the goal plan doc, so the worker's `plan` tool edits build on (and stay bound to) the goal's
   * plan. Reviewer/panelist turns do not pass it. Never throws (best-effort).
   */
  readonly prepareSession?: (sessionID: string) => void
}

export type SubagentTurnRunner = (input: SubagentTurnInput) => Effect.Effect<SubagentTurnResult>

// ---------------------------------------------------------------------------------------------------
// GraderPorts builder — assembles the four evaluator ports from the live services + the turn runner.
// Each port lives on the `never` channel (a port must resolve to a concrete result, never fail the
// loop): every effect below is wrapped so a defect degrades to the SAFE (unmet) result.
// ---------------------------------------------------------------------------------------------------

export type GraderPortsDeps = {
  /** Reuses the workspace validation runner (same as the multi-round loop). */
  readonly runValidation: (commands: readonly string[]) => Effect.Effect<{ readonly pass: boolean }>
  /** Live LSP diagnostics reduced to the single highest severity label, or null. */
  readonly diagnostics: () => Effect.Effect<{ readonly maxSeverity: string | null }>
  /** Drives ONE reviewer / panelist subagent turn. */
  readonly runTurn: SubagentTurnRunner
  /** The Expert Panel question builder — the caller pins the concrete question / lens set. */
  readonly panelQuestion: () => PanelQuestionInput
  /** Parent session id for the panel's concurrency semaphore. */
  readonly parentSessionID: string
  /**
   * §F.3 — whether the Expert Panel (§C) is enabled (`flags.experimentalExpertPanel`). The Goal Loop
   * MAY convene a panel at a decision point, but the panel is an INDEPENDENTLY-gated capability: when
   * it is off, a `panel_approves` criterion must NOT silently run the panel under the goal-loop flag —
   * it fail-closes to `needs_human` (never a silent approve). This is what makes the two flags
   * independently rollback-safe: goal_loop can run with panel_approves criteria while the panel is off,
   * and it degrades to human escalation rather than coupling the two flags.
   */
  readonly expertPanelEnabled: boolean
}

/** A minimal panel question the goal loop convenes at a decision point (§D.7 ×C). */
export type PanelQuestionInput = {
  readonly question: string
  readonly codeRefs: readonly string[]
  readonly lenses: readonly PanelLens[]
  readonly maxRounds?: number
}

// §C: parseReviewResult / REVIEWER_SCHEMA / the panelist runner are shared with the standalone Expert
// Panel entry via `panel/panelist-runner.ts` (single source of truth for how a lens panelist is driven
// and how its ReviewResult maps to a PanelOpinion). This module keeps only the goal-loop-specific glue.

// Catch BOTH typed failures AND defects (die) so a port always resolves to a concrete result and
// never crashes the loop (the ports live on the `never` channel — see goal-loop.ts). `orElseSucceed`
// alone only handles typed failures, not defects (e.g. a rejected Effect.promise from the runner).
const safe = <A>(effect: Effect.Effect<A, unknown>, fallback: A): Effect.Effect<A> =>
  effect.pipe(Effect.catchCause(() => Effect.succeed(fallback)))

export const buildGraderPorts = (deps: GraderPortsDeps): GraderPorts => ({
  runTests: (commands) => safe(deps.runValidation(commands), { pass: false }),
  diagnostics: () => safe(deps.diagnostics(), { maxSeverity: null }),
  reviewerClean: (maxSeverity) =>
    safe(
      deps
        .runTurn({
          agentType: "reviewer",
          prompt: `Review the current changes for the active goal. Report any finding whose severity exceeds "${maxSeverity}". Be adversarial and concrete.`,
          outputSchema: REVIEWER_SCHEMA,
        })
        .pipe(
          Effect.map((turn) => {
            const review = parseReviewResult(turn.structured)
            if (review == null) return { pass: false } // no confirmable clean result ⇒ NOT clean
            const worst = review.findings.reduce((r, f) => Math.max(r, reviewRank(f.severity)), 0)
            return { pass: worst <= reviewRank(maxSeverity) }
          }),
        ),
      { pass: false },
    ),
  panelApproves: () =>
    // §F.3: the panel is independently gated. When experimentalExpertPanel is OFF, do NOT convene a
    // panel (that would couple the flags) — fail-closed to needs_human so the goal loop escalates to a
    // human instead of silently approving or silently running a disabled capability.
    !deps.expertPanelEnabled
      ? Effect.succeed({ decision: "needs_human" })
      : safe(
          Effect.suspend(() => {
            const q = deps.panelQuestion()
            // The panelist runner is SHARED with the standalone Expert Panel entry (panelist-runner.ts):
            // both convene identically-prompted lens panelists. deps.runTurn matches the PanelTurnRunner
            // shape (agentType/prompt/outputSchema → { structured }).
            return runPanel({
              question: {
                question: q.question,
                codeRefs: q.codeRefs,
                lenses: q.lenses,
                maxRounds: q.maxRounds ?? 1,
                policy: DEFAULT_QUORUM_POLICY,
              },
              runPanelist: buildPanelistRunner(deps.runTurn),
              parentSessionID: deps.parentSessionID,
            })
          }).pipe(Effect.map((verdict: PanelVerdict) => ({ decision: verdict.decision }))),
          // A panel that cannot run at all ⇒ escalate to a human, never a silent approve.
          { decision: "needs_human" },
        ),
})

// ---------------------------------------------------------------------------------------------------
// StepExecutor + RollbackPort builders.
// ---------------------------------------------------------------------------------------------------

/**
 * §D/§E F3 — the PLAN BRIDGE. The goal-worker runs in an isolated CHILD session (for permission
 * derivation), but its `plan` tool reads/writes plan-state keyed by THAT child session id, while the
 * Controller's grader reads the goal PLAN DOC from the store. Without a bridge the worker's plan edits
 * never reach the graded plan (the §E F3 defect). This port makes the goal plan doc the single source
 * of truth around each turn:
 *   - `seedChildPlan(childId)`  : before the turn, copy the goal plan doc INTO the child's plan-state so
 *                                 the worker's plan tool builds on the real plan (getPlan/setPlan hit it).
 *   - `mirrorChildPlan(childId)`: after the turn, copy the child's resulting plan-state BACK into the
 *                                 goal plan doc (a new version), so the grader + version-idempotency see
 *                                 the worker's progress. Returns true iff the goal plan doc changed.
 * Both are best-effort and pure w.r.t. the store; production wires them to AgentGateway + the store.
 */
export type PlanBridge = {
  readonly seedChildPlan: (childSessionID: string) => void
  readonly mirrorChildPlan: (childSessionID: string) => void
}

/**
 * Build a StepExecutor that drives ONE goal-worker turn per tick (§D.6 一 tick = 一 SessionPrompt turn).
 * When `planBridgeFor` is supplied (production), it is called PER TICK with that tick's goal plan doc id
 * to obtain a PlanBridge bound to the right goal (the Controller reuses one executor across goals, and
 * each tick carries its own `planDocId`). The bridge seeds the child session from the goal plan before
 * the turn and mirrors the worker's edits back after — so the worker maintains its OWN goal's plan
 * (§E.3 acceptance) even though it runs in an isolated, permission-derived child session.
 */
export const buildStepExecutor = (
  runTurn: SubagentTurnRunner,
  planBridgeFor?: (planDocId: string) => PlanBridge,
): StepExecutor =>
  (input) => {
    const planBridge = planBridgeFor?.(input.planDocId)
    return runTurn({
      agentType: "goal-worker",
      prompt: renderStepPrompt(input),
      ...(planBridge ? { prepareSession: (childId: string) => planBridge.seedChildPlan(childId) } : {}),
    }).pipe(
      Effect.map((turn): StepExecutorResult => {
        // Mirror the worker's plan-state back into the goal plan doc AFTER the turn (best-effort; a
        // bridge defect must not fail the tick — the grader simply sees no plan advance and the loop
        // treats it as no-progress, which stall detection ultimately catches).
        if (planBridge && turn.sessionID) {
          try {
            planBridge.mirrorChildPlan(turn.sessionID)
          } catch {
            /* best-effort mirror */
          }
        }
        return {
          tokensUsed: turn.tokensUsed,
          cost: turn.cost,
          // A turn that could not run at all is a critical failure for THIS tick → the loop rolls back.
          ...(turn.ok ? {} : { critical: true }),
        }
      }),
      // A defect never propagates: report it as a critical failure (the loop rolls back, not throws).
      Effect.catchCause(() => Effect.succeed({ tokensUsed: 0, cost: 0, critical: true })),
    )
  }

/**
 * §D/§E F3 — the production PlanBridge over the goal plan doc + session-state. `store` holds the goal
 * plan doc (`planDocId`, body = JSON PlanDoc, the grader's source of truth). `agentMode` seeds the
 * child's session-state row. Both directions are defensive: a malformed/absent plan doc, a missing
 * child plan, or an unchanged mirror are all safe no-ops (they never throw and never write a spurious
 * version — DocumentStore.update is a no-op when the body is unchanged, INV-4).
 */
export const makePlanBridge = (input: {
  readonly store: DocumentStore
  readonly planDocId: string
  readonly agentMode: string
}): PlanBridge => ({
  seedChildPlan: (childSessionID) => {
    const doc = input.store.get(input.planDocId)
    if (!doc) return
    let plan: unknown
    try {
      plan = JSON.parse(doc.body)
    } catch {
      return // malformed goal plan → nothing to seed; the worker will just start fresh
    }
    // Ensure the child has a session-state row, then bind its plan to the goal plan so the worker's
    // `plan` tool (getPlan/setPlan keyed on the child id) reads and extends the REAL goal plan.
    AgentGateway.DeepAgentSessionState.getOrCreate(childSessionID, input.agentMode as never)
    AgentGateway.DeepAgentSessionState.setPlan(childSessionID, plan as never)
  },
  mirrorChildPlan: (childSessionID) => {
    const childPlan = AgentGateway.DeepAgentSessionState.getPlan(childSessionID)
    if (childPlan == null) return // the worker never touched the plan this turn → nothing to mirror
    const doc = input.store.get(input.planDocId)
    if (!doc) return
    // Write the worker's plan back into the goal plan doc. DocumentStore.update is a content-addressed
    // no-op when the body is unchanged (INV-4), so a turn that changed nothing bumps NO version — which
    // is exactly what the Controller's version-based idempotency + stall detection expect.
    input.store.update(input.planDocId, JSON.stringify(childPlan))
  },
})

const renderStepPrompt = (input: {
  readonly goalId: string
  readonly sessionId: string
  readonly planDocId: string
  readonly activeStepId: string | null
}): string =>
  [
    `Advance goal ${input.goalId}. Execute exactly ONE plan step of real progress this turn.`,
    input.activeStepId
      ? `The active step is "${input.activeStepId}". Complete it, then mark it done and set the next step active.`
      : `No step is currently active. Read the plan, pick the next pending step, mark it active, and make progress.`,
    `Ground every "done" in a verifiable fact (a command you ran, a test that passed). Do NOT mark a step done to satisfy the gate.`,
  ].join("\n")

// ---------------------------------------------------------------------------------------------------
// makeTaskSubagentRunner — the REAL turn runner (item 4 live wiring). One call = one SessionPrompt
// turn against a freshly-created child session whose permissions are derived exactly as the `task`
// tool derives them (§D.6 不越权: the child runs the normal session/tool permission path; the loop
// never elevates). No recursion hazard: the loop drives ONE turn and returns — it does not itself run
// inside a tool, and it never re-enters the goal loop.
// ---------------------------------------------------------------------------------------------------

export type TaskSubagentRunnerDeps = {
  readonly sessions: Session.Interface
  readonly agents: Agent.Interface
  readonly sessionPrompt: SessionPrompt.Interface
  /** The parent (goal) session; the child is parented here and inherits its deny rules + directory. */
  readonly parentSessionID: SessionID
  /** The model the goal runs on (providerID/modelID) — mirrors the task tool inheriting the model. */
  readonly model: { readonly providerID: string; readonly modelID: string }
}

/**
 * Production `SubagentTurnRunner`: create a child session (parent = goal session) with the subagent's
 * derived permissions, then drive ONE `SessionPrompt.prompt` turn. Extracts the structured output (when
 * an output schema was requested) or the final text, plus this turn's token/cost accounting. NEVER
 * throws — any failure (unknown agent, prompt defect) resolves to `ok:false` so the Grader / executor
 * degrade safely rather than crashing the loop.
 */
export const makeTaskSubagentRunner = (deps: TaskSubagentRunnerDeps): SubagentTurnRunner =>
  (input) =>
    Effect.gen(function* () {
      const next = yield* deps.agents.get(input.agentType)
      if (!next) return failedTurn(`unknown agent type: ${input.agentType}`)
      const parent = yield* deps.sessions.get(deps.parentSessionID)
      const parentAgent = parent.agent
        ? yield* deps.agents.get(parent.agent).pipe(Effect.orElseSucceed(() => undefined))
        : undefined

      const child = yield* deps.sessions.create({
        parentID: deps.parentSessionID,
        title: `${input.agentType} (goal-loop)`,
        agent: next.name,
        // §F2 trace back-half — stamp the correlationID onto the child session's metadata; Observability
        // .trace reads it back (json_extract) and appends this child as a "session" node, so the trace
        // joins the child's activity back to the event. Omitted when the caller supplies none (goal-loop
        // turns belong to the goal session's own trace).
        ...(input.correlationID ? { metadata: { correlationID: input.correlationID } } : {}),
        permission: deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          parentAgent,
          subagent: next,
          // §E/§F.3: this is the flag-gated opt-in call site (makeTaskSubagentRunner is only reached
          // through makeGoalLoopWiring, which returns null unless experimentalGoalLoop is on). Honoring
          // the PLAN_WRITE_OWN_GOAL capability HERE — and nowhere else — makes the flag the structural
          // gate for the §E relaxation.
          allowPlanWriteCapability: true,
        }),
      })

      // §D/§E F3: seed the child session BEFORE the turn (the goal-worker executor uses this to bind
      // the child's plan-state to the goal plan doc). Best-effort — a defect here must not fail the turn.
      if (input.prepareSession) {
        try {
          input.prepareSession(child.id)
        } catch {
          /* best-effort seed; the turn still runs */
        }
      }

      const parts = yield* deps.sessionPrompt.resolvePromptParts(input.prompt)
      const result = yield* deps.sessionPrompt.prompt({
        messageID: MessageID.ascending(),
        sessionID: child.id,
        model: {
          providerID: ProviderV2.ID.make(deps.model.providerID),
          modelID: ModelV2.ID.make(deps.model.modelID),
        },
        agent: next.name,
        ...(input.outputSchema
          ? { format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: input.outputSchema }) }
          : {}),
        parts,
      })

      const info = result.info
      const structured =
        info.role === "assistant" && input.outputSchema ? (info.structured as unknown | undefined) : undefined
      const text = result.parts.findLast((p) => p.type === "text")?.text ?? ""
      const tokens =
        info.role === "assistant"
          ? Math.max(0, (info.tokens.input ?? 0) + (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0))
          : 0
      const cost = info.role === "assistant" && Number.isFinite(info.cost) ? info.cost : 0
      return { ok: true, structured, text, tokensUsed: tokens, cost, sessionID: child.id } satisfies SubagentTurnResult
    }).pipe(Effect.catchCause(() => Effect.succeed(failedTurn("subagent turn failed"))))

const failedTurn = (_reason: string): SubagentTurnResult => ({
  ok: false,
  structured: undefined,
  text: "",
  tokensUsed: 0,
  cost: 0,
})

// ---------------------------------------------------------------------------------------------------
// makeGoalLoopWiring — the flag-gated factory. Returns a full `ControllerDeps` a caller feeds to
// `makeGoalLoop(deps)`, or `null` when `experimentalGoalLoop` is OFF (§F.3: flag off ⇒ the wiring is
// never constructed and the goal loop is unavailable; base behaviour is untouched, and this module's
// existence does not couple wiki/panel — the three flags are independent).
// ---------------------------------------------------------------------------------------------------

export type GoalLoopWiringInput = {
  /** The core DocumentStore holding the goal's plan + persisted loop state + audit docs. */
  readonly store: DocumentStore
  /** The goal (parent) session id. */
  readonly parentSessionID: string
  /** Working directory the validation commands run in. */
  readonly cwd: string
  /** The real subagent turn runner (production: makeTaskSubagentRunner; tests: a stub). */
  readonly runTurn: SubagentTurnRunner
  /** Builds the Expert Panel question convened at a decision point (§D.7). */
  readonly panelQuestion: () => PanelQuestionInput
  /** Live LSP diagnostics accessor (production: LSP.Service.diagnostics). */
  readonly diagnostics: () => Effect.Effect<Record<string, readonly LSPClient.Diagnostic[]>>
  /** Best-effort rollback (production: SessionRevert). */
  readonly rollback: RollbackPort
  /**
   * §D/§E F3 — the AgentMode used to seed a goal-worker child session's state row when bridging the
   * plan. Defaults to "general". Only affects the child's budget defaults; the plan itself is copied
   * verbatim from the goal plan doc.
   */
  readonly agentMode?: string
  readonly now?: () => number
}

/**
 * Assemble `ControllerDeps` when `experimentalGoalLoop` is enabled; otherwise `null`. Reads the flag
 * from the RuntimeFlags service so the gate is honoured at construction time.
 */
export const makeGoalLoopWiring = (
  input: GoalLoopWiringInput,
): Effect.Effect<ControllerDeps | null, never, RuntimeFlags.Service> =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    if (!flags.experimentalGoalLoop) return null

    const ports = buildGraderPorts({
      runValidation: (commands) =>
        Effect.promise(() => runValidationCommands(commands, input.cwd)).pipe(
          Effect.map((results) => ({ pass: AgentGateway.DeepAgentValidation.allPassed(results) })),
        ),
      diagnostics: () =>
        input.diagnostics().pipe(Effect.map((d) => ({ maxSeverity: highestDiagnosticSeverity(d) }))),
      runTurn: input.runTurn,
      panelQuestion: input.panelQuestion,
      parentSessionID: input.parentSessionID,
      // §F.3: the panel is independently gated — pass its own flag through so panel_approves fail-closes
      // to needs_human when the Expert Panel is disabled, instead of coupling to experimentalGoalLoop.
      expertPanelEnabled: flags.experimentalExpertPanel,
    })

    // §D/§E F3: bind a PlanBridge to each tick's goal plan doc so the isolated worker's plan edits are
    // mirrored into the graded plan doc (and seeded from it). Shares the SAME store the Controller reads.
    const planBridgeFor = (planDocId: string): PlanBridge =>
      makePlanBridge({ store: input.store, planDocId, agentMode: input.agentMode ?? "general" })

    return {
      store: input.store,
      ports,
      executor: buildStepExecutor(input.runTurn, planBridgeFor),
      rollback: input.rollback,
      now: input.now ?? (() => Date.now()),
    } satisfies ControllerDeps
  })

/**
 * The production LSP-backed diagnostics accessor. Kept separate so `makeGoalLoopWiring` stays
 * service-agnostic (testable with an injected diagnostics fn) while production reads live LSP.
 */
export const liveDiagnostics = (): Effect.Effect<
  Record<string, readonly LSPClient.Diagnostic[]>,
  never,
  LSP.Service
> =>
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    return yield* lsp
      .diagnostics()
      .pipe(Effect.catchCause(() => Effect.succeed({} as Record<string, LSPClient.Diagnostic[]>)))
  })

/** The production rollback port backed by SessionRevert (best-effort, never fatal). */
export const liveRollback = (
  revert: SessionRevert.Interface,
  latestMessageID: (sessionID: string) => Effect.Effect<string | null>,
): RollbackPort =>
  (rbInput) =>
    Effect.gen(function* () {
      const messageID = yield* latestMessageID(rbInput.sessionId).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      )
      if (messageID == null) return
      yield* revert
        .revert({ sessionID: SessionID.make(rbInput.sessionId), messageID: MessageID.make(messageID) })
        .pipe(Effect.ignore)
    }).pipe(Effect.catchCause(() => Effect.void))

export * as GoalLoopWiring from "./goal-loop-wiring"

