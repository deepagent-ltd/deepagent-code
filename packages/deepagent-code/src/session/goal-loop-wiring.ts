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
import { runPanel, type PanelistRunInput, type PanelistRunner } from "../panel/orchestrator"
import { DEFAULT_QUORUM_POLICY, type PanelLens, type PanelOpinion, type PanelVerdict } from "../agent/schema/panel"
import { ReviewResult } from "../agent/schema/orchestration"
import { ToolJsonSchema } from "../tool/json-schema"
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
}

export type SubagentTurnInput = {
  readonly agentType: string
  readonly prompt: string
  /** Optional JSON Schema forcing a structured final turn (reviewer / panelist). */
  readonly outputSchema?: Record<string, unknown>
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

// Parse a reviewer subagent's structured ReviewResult; a malformed / absent result is treated as
// "findings unknown" → the gate cannot confirm clean → NOT clean (fail-closed, never a silent pass).
const parseReviewResult = (structured: unknown): ReviewResult | null => {
  if (structured == null) return null
  try {
    return ReviewResult.make(structured as ReviewResult)
  } catch {
    // structured may already be a decoded object from a prior JSON round-trip; accept a shape-check.
    const anyVal = structured as { findings?: unknown; verdict?: unknown }
    if (Array.isArray(anyVal.findings) && typeof anyVal.verdict === "string") return anyVal as ReviewResult
    return null
  }
}

/** Map a reviewer turn output → the panel's PanelOpinion shape (for the panelist runner). */
const opinionFromReview = (lens: PanelLens, review: ReviewResult | null): PanelOpinion | null => {
  if (review == null) return null
  // Confidence = max finding confidence (approve with no findings ⇒ full confidence in "approve").
  const confidence =
    review.findings.length === 0
      ? 1
      : review.findings.reduce((m, f) => Math.max(m, Number.isFinite(f.confidence) ? f.confidence : 0), 0)
  return { lens, verdict: review.verdict, findings: review.findings, confidence }
}

const REVIEWER_SCHEMA = ToolJsonSchema.fromSchema(ReviewResult) as unknown as Record<string, unknown>

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
      buildPanelistRunner(deps.runTurn).pipe(
        Effect.flatMap((runPanelist) => {
          const q = deps.panelQuestion()
          return runPanel({
            question: {
              question: q.question,
              codeRefs: q.codeRefs,
              lenses: q.lenses,
              maxRounds: q.maxRounds ?? 1,
              policy: DEFAULT_QUORUM_POLICY,
            },
            runPanelist,
            parentSessionID: deps.parentSessionID,
          })
        }),
        Effect.map((verdict: PanelVerdict) => ({ decision: verdict.decision })),
      ),
      // A panel that cannot run at all ⇒ escalate to a human, never a silent approve.
      { decision: "needs_human" },
    ),
})

// A panelist runner over the turn runner: each seat is a lens-prompted reviewer subagent whose
// structured ReviewResult becomes a PanelOpinion. Absent/failed ⇒ null (§C.8 缺席).
const buildPanelistRunner = (runTurn: SubagentTurnRunner): Effect.Effect<PanelistRunner> =>
  Effect.sync(
    () => (input: PanelistRunInput) =>
      runTurn({
        agentType: "reviewer",
        prompt: renderPanelistPrompt(input),
        outputSchema: REVIEWER_SCHEMA,
      }).pipe(
        Effect.map((turn) => opinionFromReview(input.spec.lens, parseReviewResult(turn.structured))),
        Effect.catchCause(() => Effect.succeed(null as PanelOpinion | null)),
      ),
  )

const renderPanelistPrompt = (input: PanelistRunInput): string => {
  const base = [
    `You are the ${input.spec.lens} expert on a review panel (round ${input.round}).`,
    `Question (frozen): ${input.question.question}`,
    input.question.codeRefs.length > 0 ? `Code references: ${input.question.codeRefs.join(", ")}` : "",
  ].filter((s) => s.length > 0)
  if (input.round > 1 && input.peers.length > 0) {
    base.push(
      `Anonymized peer opinions from the previous round: ${input.peers
        .map((p) => `${p.verdict}(${p.confidence.toFixed(2)})`)
        .join(", ")}. You may revise, but justify with reproducible evidence.`,
    )
  }
  return base.join("\n")
}

// ---------------------------------------------------------------------------------------------------
// StepExecutor + RollbackPort builders.
// ---------------------------------------------------------------------------------------------------

/** Build a StepExecutor that drives ONE goal-worker turn per tick (§D.6 一 tick = 一 SessionPrompt turn). */
export const buildStepExecutor = (runTurn: SubagentTurnRunner): StepExecutor =>
  (input) =>
    runTurn({
      agentType: "goal-worker",
      prompt: renderStepPrompt(input),
    }).pipe(
      Effect.map(
        (turn): StepExecutorResult => ({
          tokensUsed: turn.tokensUsed,
          cost: turn.cost,
          // A turn that could not run at all is a critical failure for THIS tick → the loop rolls back.
          ...(turn.ok ? {} : { critical: true }),
        }),
      ),
      // A defect never propagates: report it as a critical failure (the loop rolls back, not throws).
      Effect.catchCause(() => Effect.succeed({ tokensUsed: 0, cost: 0, critical: true })),
    )

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
      return { ok: true, structured, text, tokensUsed: tokens, cost } satisfies SubagentTurnResult
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

    return {
      store: input.store,
      ports,
      executor: buildStepExecutor(input.runTurn),
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

