import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { ValidationResult } from "../deepagent/validation-exec"
import type { GitGroundTruth } from "../deepagent/git-groundtruth"

const RoundReport = AgentGateway.DeepAgentRoundReport
const FailureTriage = AgentGateway.DeepAgentFailureTriage
type RoundReportModule = typeof AgentGateway.DeepAgentRoundReport

// T3 (S1-v3.4): the microbatch round_control.action vocabulary actually emitted on injected turns.
// Only advance-trigger actions are written (each injects a user turn): "continue" (legacy macro-round
// seed), "revise" (🟢), "narrow" (🟡). The terminal outcomes (🔴 not-auto-fixable, exhausted narrowing)
// inject NO turn — they break the loop and surface via the macro-round suggestion `status:"needs_human"`
// (see `redReason` below), NOT via round_control. So there is intentionally no "stop"/"escalate" action
// here: a round_control.action only ever exists on a message that advanced the loop.
export type MicroRoundAction = "continue" | "revise" | "narrow"
type RoundReportType = ReturnType<RoundReportModule["buildRoundReport"]>
type ModelDeclarations = Parameters<RoundReportModule["buildRoundReport"]>[0]["declarations"]
type NextRoundSuggestion = {
  readonly status: ReturnType<RoundReportModule["deriveStatus"]>
  readonly body: string
}

// V3 A6: the multi-round autonomous loop, wrapping one completed deepagent-code assistant turn with
// the DeepAgent round discipline — run validation, diagnose, decide (accept / revise / rollback),
// and on revise inject a diagnosis follow-up turn — bounded by maxRounds only for autonomous
// ultra runs, with
// rollback-to-best so a failed attempt never accumulates. Ops are injected so the loop logic is
// unit-testable in Effect without a live session; prompt.ts supplies the real ops (shell
// validation A3, Snapshot checkpoints A5, revise = createUserMessage + loop).
//
// Gating: runs for high/max when enabled by mode. It remains fail-closed at the call site
// (catchAll -> first turn), so validation/diagnostic failures do not regress the base turn.

const Orchestrator = AgentGateway.DeepAgentOrchestrator
const Validation = AgentGateway.DeepAgentValidation

// P2-2 stopHookGate: a HookPolicy with the stop gate that blocks finalization when required
// validations did not run this round (docs/31 §4). Evaluated at the macro-round boundary.
const StopHook = new AgentGateway.DeepAgentHooks.HookPolicy().on("stop", AgentGateway.DeepAgentHooks.stopHookGate())

// A stable signature of a validation round: each command + pass/fail, order-independent. Two
// rounds with the same signature failed in the same way (no progress on the validation axis).
const validationSignature = (results: readonly ValidationResult[]): string =>
  results
    .map((r) => `${r.command}=${r.passed ? "1" : "0"}`)
    .sort()
    .join(",")

export const multiRoundEnabled = (): boolean =>
  process.env["DEEPAGENT_MULTIROUND"] !== "0" && process.env["DEEPAGENT_MULTIROUND"] !== "false"

export type MultiRoundOps<T> = {
  readonly sessionID: string
  readonly agentMode: string
  readonly enabled: boolean
  readonly maxRounds: number | null
  readonly first: T
  readonly validationCommands: readonly string[]
  // Re-establish the orchestrator session (the gateway prunes it on turn completion, so the
  // driver must ensure it exists before running rounds — F3 fix).
  readonly ensureSession: () => void
  readonly runValidation: (commands: readonly string[]) => Effect.Effect<ValidationResult[]>
  readonly track: () => Effect.Effect<string | undefined>
  readonly restore: (checkpoint: string) => Effect.Effect<void>
  // T3 (S1-v3.4): the revise turn carries the triage action so the user message it injects can be
  // tagged with round_control.action ("revise" green / "narrow" yellow) for frontend folding.
  // Back-compat: action is optional and the producer defaults to existing "continue" behavior.
  readonly reviseTurn: (diagnosisText: string, action?: MicroRoundAction) => Effect.Effect<T>
  // T3: how many narrowing attempts a yellow stall gets before escalating to red (default 1).
  readonly narrowLimit?: number // V3.1 no-progress gate: K consecutive micro-rounds with no material improvement (same
  // validation signature AND same diff fingerprint) stop the loop — the primary defense against
  // token-wasting thrash. ultra's brakes are stricter (smaller K) because it has no human in the
  // loop. Absent => use noProgressLimit's default. A diff fingerprint source is optional; without
  // it the gate falls back to validation signature only.
  readonly noProgressLimit?: number
  readonly diffFingerprint?: () => Effect.Effect<string>
  // docs/34 §9 S9 (DAP-13): for ultra, supply both the baseline pack snapshot id (from the run's
  // first macro-round) and the current one. If they differ — risk elevation, scope change,
  // permission expansion via a newly-activated pack — the gate forces needs_human instead of
  // auto-advancing. Absent => no pack-change gate (high/max already stop for human approval).
  readonly baselinePackSnapshotId?: string
  readonly packSnapshotId?: string
  // V3.1 A3 (macro-round): optional. When provided, after the micro-round loop settles the driver
  // builds a structured round report (model declarations + runner ground truth) and emits the
  // {status, body} next-round suggestion. high/max surface it for human approval; ultra (Phase 4)
  // approves automatically. Absent => behavior unchanged (existing callers/tests unaffected).
  readonly onMacroRound?: (suggestion: NextRoundSuggestion, report: RoundReportType) => Effect.Effect<void>
  // Model's structured self-report (claims) for the just-finished turn, reconciled against the
  // runner's ground truth. The model ending its turn is its IMPLICIT claim that the work is
  // complete and passing; declarations capture that claim independently of runner truth so
  // reconcile() can detect "model thinks it's done but validation fails". `passedTruth` is passed
  // only so a custom self-report can reference it; the DEFAULT must NOT echo it (that would make
  // reconciliation circular — the historical P0 bug).
  readonly declarationsFor?: (lastResultPassed: boolean) => ModelDeclarations
  // Runner ground truth for the change-surface dimension (real git diff). Injected by the runner,
  // never by the model. Absent => no change-surface evidence (reconciliation stays sound but only
  // reconciles the validation dimension).
  readonly gitGroundTruth?: () => Effect.Effect<GitGroundTruth>
  // The change surface the model CLAIMS it touched (derived from its actual edit/write tool
  // calls), reconciled against the real git diff. Independent of ground truth.
  // P2-4: a THUNK (not a snapshot) so it is read AFTER the micro-round revise turns have run and
  // accumulated their edits — a pre-loop snapshot would miss every revise turn's changes.
  readonly claimedChangeSurface?: readonly string[] | (() => readonly string[])
  // The round number this macro-round represents (1-based). Defaults to 1.
  readonly macroRound?: number
}

// P2-4: resolve a claimed-change-surface that may be a static array or a lazy thunk (read after
// revise turns accumulate their edits).
const resolveClaimedChangeSurface = (value: readonly string[] | (() => readonly string[]) | undefined): string[] =>
  typeof value === "function" ? [...value()] : value ? [...value] : []

export const maybeRunRounds = <T>(ops: MultiRoundOps<T>): Effect.Effect<T> =>
  Effect.gen(function* () {
    // Micro-round loop runs for every managed strength (high/max/ultra); general is single-round.
    if (!ops.enabled || ops.agentMode === "general") return ops.first

    ops.ensureSession() // F3: recreate the session pruned by the gateway on turn completion
    Orchestrator.setValidationCommands(ops.sessionID, [...ops.validationCommands])
    let best = yield* ops.track()
    let result = ops.first
    let lastResults: ValidationResult[] = []
    // T3: when the loop exits via a 🔴 triage (or exhausted narrowing), the reason is surfaced as the
    // needs_human body so a human knows "this is not something I could auto-fix".
    let redReason: string | null = null

    // No-progress gate: stop after K consecutive rounds with no material improvement. ultra (no
    // human fallback) gets a stricter K. A "fingerprint" combines the validation signature with an
    // optional diff fingerprint; identical fingerprints across rounds means the revise turn changed
    // nothing meaningful, so we stop instead of burning tokens on a thrash loop.
    const noProgressLimit = ops.noProgressLimit ?? (ops.agentMode === "ultra" ? 2 : 3)
    const narrowLimit = ops.narrowLimit ?? 1
    let prevFingerprint: string | undefined
    let stagnantRounds = 0
    // T3: triage state carried across rounds.
    let previousCategory: string | null = null
    let prevFailedCount: number | undefined
    let narrowAttempts = 0
    // T3 (C1 fix): the PREVIOUS round's diff fingerprint, to compute a per-round delta. The cumulative
    // `git diff --stat HEAD` is non-empty from round 1 on (the tree always carries earlier edits), so
    // "did the model change something THIS round" must be `diffFp !== prevDiffFp`, not `diffFp != ""`.
    let prevDiffFp: string | undefined

    for (let round = 1; ops.maxRounds === null || round <= ops.maxRounds; round++) {
      const { should, commands } = Orchestrator.shouldRunValidation(ops.sessionID)
      if (!should) break // no validation configured -> accept the current candidate

      const results = yield* ops.runValidation(commands)
      lastResults = results
      const decision = Orchestrator.processValidationResults(ops.sessionID, results)
      const passed = Validation.allPassed(results) && decision.action === "complete"

      if (passed) {
        const c = yield* ops.track()
        if (c) best = c
        break
      }
      if (decision.action === "complete" || decision.action === "budget_pause") {
        // diagnosis said rollback/block, or budget exhausted: restore so we never leave the
        // workspace in a broken state, then stop.
        if (best) yield* ops.restore(best)
        break
      }

      // No-progress detection (before spending another revise turn): compare this round's
      // fingerprint to the previous failing round's. If unchanged for `noProgressLimit` rounds,
      // the loop is thrashing — stop and surface the latest results to the macro-round.
      const diffFp = ops.diffFingerprint ? yield* ops.diffFingerprint() : ""
      const fingerprint = `${validationSignature(results)}|${diffFp}`
      const fingerprintUnchanged = prevFingerprint !== undefined && fingerprint === prevFingerprint
      if (fingerprintUnchanged) {
        stagnantRounds++
        if (stagnantRounds >= noProgressLimit) {
          // U1: no progress is a runtime signal that the current plan isn't working — mark the plan
          // stale so finalization is gated and the next turn must replan.
          AgentGateway.DeepAgentSessionState.markPlanStale(ops.sessionID, "no_progress")
          if (best) yield* ops.restore(best)
          break
        }
      } else {
        stagnantRounds = 0
      }
      prevFingerprint = fingerprint

      // T3 (S1-v3.4): triage this failing round (fixability × progress) BEFORE spending a revise.
      const failedResults = results.filter((r) => !r.passed)
      // C1 fix: per-round delta. `diffFp` is the CUMULATIVE working-tree diff, so "changed this round"
      // is whether it differs from the previous round's cumulative diff — not whether it is non-empty
      // (which is true from round 1 on because the tree always carries prior edits). With no diff source
      // we cannot measure it, so default true (non-punitive: absence of a signal never forces stall/red).
      const changedThisRound = ops.diffFingerprint ? diffFp !== (prevDiffFp ?? "") : true
      const triage = FailureTriage.classifyFailure({
        failed: failedResults,
        changedThisRound,
        round,
        previousCategory,
        prevFailedCount,
        stagnant: fingerprintUnchanged,
        // The failed results already carry their raw command output; do NOT pass the human summary
        // here — it embeds command names like "npm test" and the word "failed", which would pollute
        // analyzeErrors into mis-reading an unknown failure as a test_failure.
        errorOutput: null,
      })
      prevDiffFp = diffFp
      // Carry category/count for next round's flip/regression detection.
      previousCategory = triage.category
      prevFailedCount = failedResults.length

      // 🔴 not_auto_fixable: this is not something microbatch can fix (env/deps/network/unknown).
      // Exit immediately WITHOUT burning further rounds, and mark the plan stale so the macro-round
      // surfaces needs_human with the reason. This is a CORRECT exit, the opposite of thrash-revising.
      if (triage.tier === "not_auto_fixable") {
        AgentGateway.DeepAgentSessionState.markPlanStale(ops.sessionID, "no_progress")
        if (best) yield* ops.restore(best)
        redReason = triage.reason
        break
      }

      // 🟡 needs_narrowing: give a bounded number of focused narrowing retries, then escalate. ALL
      // yellow substates (stall/regression/oscillation/half_progress) count toward the same budget —
      // otherwise a model that keeps producing fresh-but-failing edits (oscillation/regression never
      // trips the fingerprint-unchanged no-progress gate, and high/max have maxRounds=null) could
      // narrow forever. half_progress (failures strictly dropping) is exempt: real progress should not
      // be cut off by the narrow budget.
      if (triage.tier === "needs_narrowing" && triage.substate !== "half_progress") {
        narrowAttempts++
        if (narrowAttempts > narrowLimit) {
          AgentGateway.DeepAgentSessionState.markPlanStale(ops.sessionID, "no_progress")
          if (best) yield* ops.restore(best)
          redReason = `narrowing budget exhausted past ${narrowLimit} attempt(s): ${triage.reason}`
          break
        }
      } else {
        narrowAttempts = 0
      }

      // continue / escalate -> rollback the failed attempt to best, then revise in a new turn.
      if (best) yield* ops.restore(best)
      lastResults = results
      // 🟡 → "narrow" (carry the triage reason as a narrowing constraint); 🟢 → "revise".
      const action: MicroRoundAction = triage.tier === "needs_narrowing" ? "narrow" : "revise"
      const turnText =
        triage.tier === "needs_narrowing"
          ? `${Validation.summarizeResults(results)}\n\nNarrowing guidance (${triage.substate}): ${triage.reason}. Focus on the specific failing file/symbol; do not widen the change surface.`
          : Validation.summarizeResults(results)
      result = yield* ops.reviseTurn(turnText, action)
    }

    // V3.1 A3 macro-round: after the micro-round loop settles, build the structured round report
    // from runner ground truth + the model's declarations and emit the {status, body} next-round
    // suggestion. high/max surface it for human approval; ultra (Phase 4) auto-approves. The
    // status is derived OBJECTIVELY from the report, never from the model's self-report alone.
    if (ops.onMacroRound) {
      const passedTruth = lastResults.length > 0 && Validation.allPassed(lastResults)
      // The model ended its turn, which is its implicit claim that the work is complete and
      // passing. Capturing that claim INDEPENDENTLY of runner truth is what lets reconcile()
      // detect "model thinks it's done but validation actually fails" -> needs_human. The default
      // must therefore claim success (claimed_validation_passed: true, completion_claim:
      // "complete"), NOT echo passedTruth. A caller may override via declarationsFor.
      const declarations: ModelDeclarations = ops.declarationsFor
        ? ops.declarationsFor(passedTruth)
        : {
            completion_claim: "complete",
            implementation_summary: "",
            claimed_change_surface: resolveClaimedChangeSurface(ops.claimedChangeSurface),
            claimed_doc_updates: [],
            claimed_validation_passed: true,
          }
      const git = ops.gitGroundTruth
        ? yield* ops.gitGroundTruth()
        : { changed_files: [], diff_stat: null, repo_root: null }
      const report = RoundReport.buildRoundReport({
        runId: ops.sessionID,
        sessionID: ops.sessionID,
        round: ops.macroRound ?? 1,
        declarations,
        groundTruth: { validations: lastResults, changed_files: git.changed_files, diff_stat: git.diff_stat },
      })
      // P2-2 stopHookGate (docs/31 §4): finalization is blocked when required validations were
      // configured for this workspace but did NOT actually run this round. Without this, a turn
      // that skipped its configured typecheck/test could still emit "done". When the gate blocks,
      // we force needs_human so a human (or ultra supervisor) sees that validation must run first.
      const requiredValidationsRun = ops.validationCommands.length === 0 || lastResults.length > 0
      // docs/34 §9 S9 (DAP-13): an ultra pack-set change (snapshot id differs from the run baseline)
      // means the active domain risk/scope shifted — never auto-advance, escalate to human.
      const packChanged =
        ops.agentMode === "ultra" &&
        ops.baselinePackSnapshotId !== undefined &&
        ops.packSnapshotId !== undefined &&
        ops.packSnapshotId !== ops.baselinePackSnapshotId
      // U1: a pack change is also a plan-staleness signal (scope/risk shifted under the plan).
      if (packChanged) AgentGateway.DeepAgentSessionState.markPlanStale(ops.sessionID, "pack_changed")
      // U1: finalization is blocked while the plan latch is stale (any of the five runtime signals),
      // UNLESS we've already exhausted the replan budget — then the escape hatch routes to
      // needs_human rather than looping forever demanding a plan update.
      const latch = AgentGateway.DeepAgentSessionState.planLatch(ops.sessionID)
      const planStale = latch?.latch === "stale" && !AgentGateway.DeepAgentPlanController.shouldEscapeToHuman(latch)
      // U9: high+ runs must produce a completion report (a plan whose steps are all resolved) before
      // finalizing. general/direct have no hard gate. We treat "report present" as: a plan exists and
      // nothing is outstanding (buildCompletionReport().complete). Escape hatch still applies via the
      // stale check above so a weak model is never deadlocked.
      const hardGate = AgentGateway.DeepAgentPlanController.hardGateEnabled(ops.agentMode)
      const plan = AgentGateway.DeepAgentSessionState.getPlan(ops.sessionID)
      const planExists = plan != null
      const completionReport = planExists ? AgentGateway.DeepAgentPlanController.buildCompletionReport(plan) : null
      const hasCompletionReport = completionReport?.complete === true
      // U10: a plan that finished with a `blocked` step is NOT a clean "done" — finalize is allowed
      // (blocked counts as resolved so the run never deadlocks), but it must route to needs_human so
      // the operator sees WHY the plan could not be fully executed. This is the honest escape hatch
      // that stops the model from marking a step falsely `done` to satisfy the gate.
      const blockedSteps = completionReport?.blocked ?? []
      const hasBlocked = blockedSteps.length > 0
      const stopDecision = StopHook.evaluate({
        name: "stop",
        payload: { requiredValidationsRun, planStale, hardGate, planExists, hasCompletionReport },
      })
      const baseStatus = RoundReport.deriveStatus(report)
      // T3: a 🔴 triage exit (or exhausted narrowing) forces needs_human with the triage reason, so the
      // operator sees "not auto-fixable: <reason>" rather than a generic continue/done.
      const status =
        redReason != null || stopDecision.decision === "block" || packChanged || hasBlocked
          ? "needs_human"
          : baseStatus
      const suggestion: NextRoundSuggestion = {
        status,
        body: redReason
          ? `Not auto-fixable: ${redReason}. Configured validations: ${ops.validationCommands.join(", ")}.`
          : packChanged
            ? `Domain pack set changed mid-run (${ops.baselinePackSnapshotId} -> ${ops.packSnapshotId}); risk/scope may have shifted, human review required before continuing.`
            : stopDecision.decision === "block"
              ? `${stopDecision.blockReason}. Configured validations: ${ops.validationCommands.join(", ")}.`
              : hasBlocked
                ? `Plan finished with blocked step(s) needing human input: ${blockedSteps.join("; ")}.`
                : RoundReport.summarizeForSuggestion(report),
      }
      yield* ops.onMacroRound(suggestion, report)
    }

    return result
  })
