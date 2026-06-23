import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import type { ValidationResult } from "../deepagent/validation-exec"
import type { GitGroundTruth } from "../deepagent/git-groundtruth"

const RoundReport = AgentGateway.DeepAgentRoundReport
type RoundReportModule = typeof AgentGateway.DeepAgentRoundReport
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

export const multiRoundEnabled = (): boolean => process.env["DEEPAGENT_MULTIROUND"] !== "0" && process.env["DEEPAGENT_MULTIROUND"] !== "false"

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
  readonly reviseTurn: (diagnosisText: string) => Effect.Effect<T>
  // V3.1 no-progress gate: K consecutive micro-rounds with no material improvement (same
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
const resolveClaimedChangeSurface = (
  value: readonly string[] | (() => readonly string[]) | undefined,
): string[] => (typeof value === "function" ? [...value()] : value ? [...value] : [])

export const maybeRunRounds = <T>(ops: MultiRoundOps<T>): Effect.Effect<T> =>
  Effect.gen(function* () {
    // Micro-round loop runs for every managed strength (high/max/ultra); general is single-round.
    if (!ops.enabled || ops.agentMode === "general") return ops.first

    ops.ensureSession() // F3: recreate the session pruned by the gateway on turn completion
    Orchestrator.setValidationCommands(ops.sessionID, [...ops.validationCommands])
    let best = yield* ops.track()
    let result = ops.first
    let lastResults: ValidationResult[] = []

    // No-progress gate: stop after K consecutive rounds with no material improvement. ultra (no
    // human fallback) gets a stricter K. A "fingerprint" combines the validation signature with an
    // optional diff fingerprint; identical fingerprints across rounds means the revise turn changed
    // nothing meaningful, so we stop instead of burning tokens on a thrash loop.
    const noProgressLimit = ops.noProgressLimit ?? (ops.agentMode === "ultra" ? 2 : 3)
    let prevFingerprint: string | undefined
    let stagnantRounds = 0

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
      if (prevFingerprint !== undefined && fingerprint === prevFingerprint) {
        stagnantRounds++
        if (stagnantRounds >= noProgressLimit) {
          if (best) yield* ops.restore(best)
          break
        }
      } else {
        stagnantRounds = 0
      }
      prevFingerprint = fingerprint

      // continue / escalate -> rollback the failed attempt to best, then revise in a new turn.
      if (best) yield* ops.restore(best)
      lastResults = results
      result = yield* ops.reviseTurn(Validation.summarizeResults(results))
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
      const git = ops.gitGroundTruth ? yield* ops.gitGroundTruth() : { changed_files: [], diff_stat: null }
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
      const stopDecision = StopHook.evaluate({ name: "stop", payload: { requiredValidationsRun } })
      const baseStatus = RoundReport.deriveStatus(report)
      // docs/34 §9 S9 (DAP-13): an ultra pack-set change (snapshot id differs from the run baseline)
      // means the active domain risk/scope shifted — never auto-advance, escalate to human.
      const packChanged =
        ops.agentMode === "ultra" &&
        ops.baselinePackSnapshotId !== undefined &&
        ops.packSnapshotId !== undefined &&
        ops.packSnapshotId !== ops.baselinePackSnapshotId
      const status = stopDecision.decision === "block" || packChanged ? "needs_human" : baseStatus
      const suggestion: NextRoundSuggestion = {
        status,
        body: packChanged
          ? `Domain pack set changed mid-run (${ops.baselinePackSnapshotId} -> ${ops.packSnapshotId}); risk/scope may have shifted, human review required before continuing.`
          : stopDecision.decision === "block"
            ? `${stopDecision.blockReason}. Configured validations: ${ops.validationCommands.join(", ")}.`
            : RoundReport.summarizeForSuggestion(report),
      }
      yield* ops.onMacroRound(suggestion, report)
    }

    return result
  })
