import { Effect, Duration } from "effect"
import { Orchestration } from "@deepagent-code/core/deepagent/orchestration"
import { TaskConcurrency } from "../tool/task-concurrency"
import {
  type PanelLens,
  type PanelOpinion,
  type PanelVerdict,
  type QuorumPolicy,
  DEFAULT_QUORUM_POLICY,
} from "../agent/schema/panel"
import { arbitrate } from "./arbiter"

/**
 * V3.9 §C.4 — the Convener flow (会诊流程), session-scoped form. The Convener freezes the question,
 * fans out N panelists in Round 1 (same frozen question, per-lens prompt, fresh context, mutually
 * invisible), optionally runs debate Rounds 2..R (each panelist sees ANONYMIZED others' opinions and
 * may revise; converges early when the verdict distribution is stable), then hands the surviving
 * opinions to the deterministic Arbiter (`arbitrate`) for the `PanelVerdict`.
 *
 * §C.8 invariants enforced HERE (the Arbiter owns determinism + dissent):
 *   - isolation : each panelist runs in an independent session; Round-1 requests carry NO peer
 *                 opinions; debate rounds pass ANONYMIZED opinions only (lens label stripped of any
 *                 identity — see `anonymize`).
 *   - bounded   : fan-out ≤ resolveCaps(caps).maxFanout; ≤ R rounds; per-panelist timeout; the real
 *                 concurrency gate is `TaskConcurrency.withTaskSlot` (same hard limiter as `task`).
 *   - graceful  : a panelist that fails or times out is treated as ABSENT (dropped, not fatal); if
 *                 the survivors fall below policy.minQuorum the Arbiter returns `needs_human` — never
 *                 a silent approve.
 *   - no loss   : every collected opinion (including the final round of losers) is archived via the
 *                 injected `PanelArchiver` so §B's Wiki can project it; dissent is preserved by the
 *                 Arbiter into PanelVerdict.dissent[].
 *
 * The panelist execution + archiving are injected as PORTS so this orchestration is a pure control
 * loop: production wires `runPanelist` to the `task` fan-out (a lens-prompted reviewer subagent) and
 * `archive` to the Document Graph; tests wire deterministic stubs and assert the control invariants
 * without an LLM.
 */

/** Which panelist to run: a lens + a stable id so debate rounds can address the same expert. */
export type PanelistSpec = {
  readonly lens: PanelLens
  /** Stable identifier for this seat across rounds (e.g. `panel-<lens>` or an agent/session id). */
  readonly id: string
}

/** The frozen 会诊 question. Nothing here changes once a panel starts (§C.4 全部冻结). */
export type PanelQuestion = {
  readonly question: string
  /** Code references (file / file:line) the panelists must ground their findings in. */
  readonly codeRefs: readonly string[]
  /** The lens set to convene; deduped + capped to maxFanout by `runPanel`. */
  readonly lenses: readonly PanelLens[]
  /** Hard cap on debate rounds R (≥ 1). Round 1 is always run; 2..R are debate. */
  readonly maxRounds: number
  readonly policy: QuorumPolicy
}

/**
 * A peer opinion as seen by a panelist during debate — ANONYMIZED (no seat identity).
 *
 * §C.8 去相关化: the `lens` is DELIBERATELY omitted. Every seat's id is `panel-<lens>` (one seat per
 * lens), so the lens label IS the seat identity — surfacing it to peers would fully re-identify each
 * opinion's author and defeat the anonymized-debate invariant (a panelist could anchor on "the security
 * expert said…"). Only the de-identified verdict / findings / confidence cross the debate boundary; the
 * Arbiter still sees the full per-lens opinions (it runs on `currentOpinions`, not this shape).
 */
export type AnonymizedOpinion = {
  readonly verdict: PanelOpinion["verdict"]
  readonly findings: PanelOpinion["findings"]
  readonly confidence: number
}

/** Input handed to a single panelist run. `peers` is empty in Round 1 (mutual invisibility). */
export type PanelistRunInput = {
  readonly spec: PanelistSpec
  readonly question: PanelQuestion
  readonly round: number
  /** Anonymized peer opinions from the PREVIOUS round; empty on Round 1. */
  readonly peers: readonly AnonymizedOpinion[]
}

/**
 * Port: run one panelist to completion and return its opinion, or `null` if it failed/timed out
 * (§C.8 缺席). Implementations MUST NOT throw — a failure is reported as `null`. The orchestrator
 * additionally wraps each call in a per-panelist timeout + the TaskConcurrency slot.
 */
export type PanelistRunner = (input: PanelistRunInput) => Effect.Effect<PanelOpinion | null, unknown>

/** Port: archive an opinion to the Document Graph (§C.8 全部 opinion 归档). Best-effort, never fatal. */
export type PanelArchiver = (input: {
  readonly opinion: PanelOpinion
  readonly round: number
  readonly question: PanelQuestion
}) => Effect.Effect<void, unknown>

export type RunPanelOptions = {
  readonly question: PanelQuestion
  readonly runPanelist: PanelistRunner
  /** Optional archiver; when absent, opinions are not archived (still valid, just no projection). */
  readonly archive?: PanelArchiver
  /** Parent session id — the key for the TaskConcurrency semaphore (bounds real parallelism). */
  readonly parentSessionID: string
  /** Per-panelist timeout; a slower panelist is treated as absent. Default 5 minutes. */
  readonly perPanelistTimeout?: Duration.Input
  /** Orchestration caps (maxFanout / maxConcurrency). Defaults to the lenient orchestration caps. */
  readonly caps?: Orchestration.OrchestrationCaps
  /** Subagent type used for the concurrency-slot key (defaults to "reviewer"). */
  readonly subagentType?: string
}

const DEFAULT_PANELIST_TIMEOUT = Duration.minutes(5)

/** Deterministically dedupe + cap the requested lenses to maxFanout, preserving request order. */
export const selectPanelists = (
  lenses: readonly PanelLens[],
  caps?: Orchestration.OrchestrationCaps,
): PanelistSpec[] => {
  const { maxFanout } = Orchestration.resolveCaps(caps)
  const seen = new Set<PanelLens>()
  const specs: PanelistSpec[] = []
  for (const lens of lenses) {
    if (seen.has(lens)) continue
    seen.add(lens)
    specs.push({ lens, id: `panel-${lens}` })
    if (specs.length >= maxFanout) break
  }
  return specs
}

/** Strip a peer opinion down to its anonymized, de-identified form for debate rounds (§C.4 匿名). The
 * lens is dropped here (see AnonymizedOpinion) so peers cannot re-identify the author by seat. */
const anonymize = (op: PanelOpinion): AnonymizedOpinion => ({
  verdict: op.verdict,
  findings: op.findings,
  confidence: op.confidence,
})

/**
 * The verdict distribution of a round, as a stable string, for convergence detection. Two rounds
 * "converged" when their sorted verdict multisets are identical (§C.4 收敛检测：verdict 分布连续一轮
 * 无变化即提前停).
 */
export const verdictDistribution = (opinions: readonly PanelOpinion[]): string =>
  opinions
    .map((o) => o.verdict)
    .sort()
    .join(",")

/**
 * Run one round: fan out every panelist concurrently under the hard concurrency gate, each with a
 * per-panelist timeout, collecting only the survivors (absent panelists → dropped). Archiving is
 * best-effort per surviving opinion.
 */
const runRound = (input: {
  readonly specs: readonly PanelistSpec[]
  readonly round: number
  readonly peersByLens: ReadonlyMap<PanelLens, readonly AnonymizedOpinion[]>
  readonly opts: RunPanelOptions
}): Effect.Effect<PanelOpinion[]> =>
  Effect.gen(function* () {
    const { specs, round, opts } = input
    const timeout = opts.perPanelistTimeout ?? DEFAULT_PANELIST_TIMEOUT
    const subagentType = opts.subagentType ?? "reviewer"

    const runOne = (spec: PanelistSpec): Effect.Effect<PanelOpinion | null> =>
      TaskConcurrency.withTaskSlot({
        parentSessionID: opts.parentSessionID,
        subagentType,
        caps: opts.caps,
        effect: opts
          .runPanelist({
            spec,
            question: opts.question,
            round,
            peers: input.peersByLens.get(spec.lens) ?? [],
          })
          // §C.8 优雅降级: any failure/defect OR a timeout ⇒ treat the panelist as ABSENT (null).
          // catchCause runs FIRST (inner) so a fast failure/defect resolves to null immediately;
          // timeoutOrElse (outer) covers a panelist that hangs past the deadline. Both yield null.
          .pipe(
            Effect.catchCause(() => Effect.succeed(null as PanelOpinion | null)),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.succeed(null as PanelOpinion | null),
            }),
          ),
      })

    // `concurrency: "unbounded"` here dispatches all seats at once; the ACTUAL parallelism is clamped
    // by the per-session TaskConcurrency semaphore inside `runOne`, exactly like the `task` tool. We
    // never exceed maxFanout because `specs` was already capped by `selectPanelists`.
    const results = yield* Effect.forEach(specs, runOne, { concurrency: "unbounded" })
    const survivors = results.filter((r): r is PanelOpinion => r !== null)

    if (opts.archive) {
      yield* Effect.forEach(
        survivors,
        (opinion) => opts.archive!({ opinion, round, question: opts.question }).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      )
    }
    return survivors
  })

/**
 * §C.4 — run a full Expert Panel and return the deterministic `PanelVerdict`.
 *
 * Flow: freeze → Round 1 fan-out → (debate 2..R with anonymized peers, early-stop on stable verdict
 * distribution) → Arbiter. The Arbiter owns the final decision; this function owns isolation,
 * bounding, graceful degradation, and archiving.
 */
export const runPanel = (opts: RunPanelOptions): Effect.Effect<PanelVerdict> =>
  Effect.gen(function* () {
    const question = opts.question
    const policy = question.policy ?? DEFAULT_QUORUM_POLICY
    const maxRounds = Number.isFinite(question.maxRounds) && question.maxRounds >= 1 ? Math.floor(question.maxRounds) : 1
    const specs = selectPanelists(question.lenses, opts.caps)

    // Degenerate case: no lenses to convene ⇒ nothing survives ⇒ Arbiter escalates (never silent).
    if (specs.length === 0) {
      return arbitrate([], policy, 0)
    }

    let currentOpinions: PanelOpinion[] = []
    let prevDistribution: string | null = null
    let roundsRun = 0

    for (let round = 1; round <= maxRounds; round++) {
      const peersByLens = new Map<PanelLens, readonly AnonymizedOpinion[]>()
      if (round > 1) {
        // Debate: each panelist sees ANONYMIZED peer opinions from the previous round, EXCLUDING its
        // own (a panelist should critique peers, not re-read itself).
        for (const spec of specs) {
          const peers = currentOpinions.filter((o) => o.lens !== spec.lens).map(anonymize)
          peersByLens.set(spec.lens, peers)
        }
      }

      const roundOpinions = yield* runRound({ specs, round, peersByLens, opts })
      roundsRun = round

      // A round in which every panelist was absent produces nothing; keep the prior round's opinions
      // (the last non-empty snapshot) and stop debating — more rounds cannot improve on silence.
      if (roundOpinions.length === 0) {
        break
      }
      currentOpinions = roundOpinions

      // §C.4 收敛检测: if the verdict distribution is unchanged from the previous round, stop early.
      const distribution = verdictDistribution(currentOpinions)
      if (prevDistribution !== null && distribution === prevDistribution) {
        break
      }
      prevDistribution = distribution
    }

    return arbitrate(currentOpinions, policy, roundsRun)
  })

export * as Orchestrator from "./orchestrator"
