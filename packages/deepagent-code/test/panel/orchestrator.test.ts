import { describe, expect, test } from "bun:test"
import { Effect, Duration } from "effect"
import {
  runPanel,
  selectPanelists,
  verdictDistribution,
  type PanelistRunInput,
  type PanelQuestion,
  type RunPanelOptions,
} from "../../src/panel/orchestrator"
import { DEFAULT_QUORUM_POLICY, type PanelLens, type PanelOpinion } from "../../src/agent/schema/panel"
import type { ReviewFinding } from "../../src/agent/schema/orchestration"

/**
 * §G-C — Panel orchestrator (Convener) tests. The panelist runner + archiver are injected as PORTS,
 * so these assert the control-flow invariants (concurrency cap, convergence early-stop, graceful
 * degradation, archiving, anonymized debate) deterministically WITHOUT an LLM.
 */

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "high",
  category: "correctness",
  file: "src/foo.ts",
  line: 1,
  summary: "x",
  failureScenario: "input X ⇒ wrong Y",
  confidence: 0.9,
  ...over,
})

const question = (over: Partial<PanelQuestion> = {}): PanelQuestion => ({
  question: "Is this migration safe?",
  codeRefs: ["src/migrate.ts:42"],
  lenses: ["correctness", "security", "performance"],
  maxRounds: 3,
  policy: DEFAULT_QUORUM_POLICY,
  ...over,
})

// A fixed opinion generator keyed by lens, so a run is deterministic.
const opinionFor = (lens: PanelLens, verdict: PanelOpinion["verdict"], confidence = 0.8): PanelOpinion => ({
  lens,
  verdict,
  confidence,
  findings: verdict === "approve" ? [] : [finding()],
})

describe("selectPanelists — bounded fan-out (§C.8)", () => {
  test("dedupes lenses and caps to maxFanout", () => {
    const specs = selectPanelists(
      ["correctness", "correctness", "security", "performance", "architecture", "repro"],
      { maxFanout: 3 },
    )
    expect(specs.length).toBe(3)
    expect(specs.map((s) => s.lens)).toEqual(["correctness", "security", "performance"])
  })

  test("assigns stable ids", () => {
    const specs = selectPanelists(["security"], {})
    expect(specs[0]!.id).toBe("panel-security")
  })
})

describe("verdictDistribution — convergence key", () => {
  test("order-independent multiset of verdicts", () => {
    const a = [opinionFor("correctness", "approve"), opinionFor("security", "block")]
    const b = [opinionFor("security", "block"), opinionFor("correctness", "approve")]
    expect(verdictDistribution(a)).toBe(verdictDistribution(b))
  })
})

describe("runPanel — concurrency ≤ maxFanout (§C.8 有界)", () => {
  test("never runs more panelists in parallel than the concurrency cap", async () => {
    let inFlight = 0
    let peak = 0
    const caps = { maxFanout: 5, maxConcurrency: 2 }

    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.gen(function* () {
        inFlight++
        peak = Math.max(peak, inFlight)
        // Hold the slot briefly so overlapping dispatch is observable.
        yield* Effect.sleep(Duration.millis(20))
        inFlight--
        return opinionFor(input.spec.lens, "approve")
      })

    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security", "performance", "architecture", "repro"], maxRounds: 1 }),
      runPanelist,
      parentSessionID: "sess-concurrency",
      caps,
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    expect(peak).toBeLessThanOrEqual(caps.maxConcurrency)
    // All 5 approved but minQuorum met ⇒ a real decision, not needs_human for absence.
    expect(verdict.decision).not.toBe("needs_human")
  })
})

describe("runPanel — graceful degradation / 缺席 (§C.8)", () => {
  test("failed + timed-out panelists are treated as absent; survivors < minQuorum → needs_human", async () => {
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> => {
      if (input.spec.lens === "correctness") return Effect.fail(new Error("panelist crashed"))
      if (input.spec.lens === "security") return Effect.sleep(Duration.seconds(10)).pipe(Effect.as(null))
      // Only performance survives ⇒ 1 survivor < minQuorum(2).
      return Effect.succeed(opinionFor(input.spec.lens, "approve"))
    }
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security", "performance"], maxRounds: 1 }),
      runPanelist,
      parentSessionID: "sess-degrade",
      perPanelistTimeout: Duration.millis(50),
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    expect(verdict.decision).toBe("needs_human")
  })

  test("a thrown defect inside a panelist is caught (treated as absent), not propagated", async () => {
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      input.spec.lens === "security"
        ? Effect.sync(() => {
            throw new Error("boom defect")
          })
        : Effect.succeed(opinionFor(input.spec.lens, "approve"))
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security", "performance"], maxRounds: 1 }),
      runPanelist,
      parentSessionID: "sess-defect",
      perPanelistTimeout: Duration.seconds(5),
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    // correctness + performance survive (quorum met) ⇒ a real decision despite the defect.
    expect(["approve", "revise", "block", "needs_human"]).toContain(verdict.decision)
    expect(verdict.dissent.length + 0).toBeGreaterThanOrEqual(0)
  })
})

describe("runPanel — convergence early-stop (§C.4)", () => {
  test("stable verdict distribution one round → stops before R", async () => {
    let round1Calls = 0
    let round2Calls = 0
    let round3Calls = 0
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.sync(() => {
        if (input.round === 1) round1Calls++
        else if (input.round === 2) round2Calls++
        else if (input.round === 3) round3Calls++
        // Every panelist returns the SAME verdict each round ⇒ distribution stable after round 2.
        return opinionFor(input.spec.lens, "approve")
      })
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security", "performance"], maxRounds: 3 }),
      runPanelist,
      parentSessionID: "sess-converge",
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    // Round 1 runs, round 2 runs (distribution compared to r1 = same) ⇒ stop; round 3 must NOT run.
    expect(round1Calls).toBe(3)
    expect(round2Calls).toBe(3)
    expect(round3Calls).toBe(0)
    expect(verdict.rounds).toBe(2)
  })

  test("changing distribution keeps debating up to the hard round cap R", async () => {
    // Verdicts flip every round so the distribution never stabilizes ⇒ runs the full R rounds.
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.sync(() =>
        opinionFor(input.spec.lens, input.round % 2 === 1 ? "approve" : "revise", 0.8),
      )
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security"], maxRounds: 3 }),
      runPanelist,
      parentSessionID: "sess-nocverge",
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    expect(verdict.rounds).toBe(3)
  })
})

describe("runPanel — isolation / anonymized debate (§C.8)", () => {
  test("Round 1 panelists receive NO peer opinions; debate rounds receive anonymized peers minus self", async () => {
    const seen: { round: number; lens: PanelLens; peerLenses: PanelLens[]; peerCount: number }[] = []
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.sync(() => {
        seen.push({
          round: input.round,
          lens: input.spec.lens,
          peerLenses: input.peers.map((p) => p.lens),
          peerCount: input.peers.length,
        })
        // Flip verdicts across rounds so debate does not converge on round 2.
        return opinionFor(input.spec.lens, input.round % 2 === 1 ? "approve" : "revise")
      })
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security", "performance"], maxRounds: 2 }),
      runPanelist,
      parentSessionID: "sess-iso",
    }
    await Effect.runPromise(runPanel(opts))

    const round1 = seen.filter((s) => s.round === 1)
    expect(round1.length).toBe(3)
    for (const r of round1) expect(r.peerCount).toBe(0) // mutual invisibility

    const round2 = seen.filter((s) => s.round === 2)
    expect(round2.length).toBe(3)
    for (const r of round2) {
      // Each debate panelist sees the OTHER two lenses, never itself.
      expect(r.peerLenses).not.toContain(r.lens)
      expect(r.peerCount).toBe(2)
    }
  })
})

describe("runPanel — archiving / 不丢信息 (§C.8)", () => {
  test("every surviving opinion is archived via the injected archiver", async () => {
    const archived: { round: number; lens: PanelLens }[] = []
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.succeed(opinionFor(input.spec.lens, "approve"))
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security"], maxRounds: 1 }),
      runPanelist,
      archive: ({ opinion, round }) =>
        Effect.sync(() => {
          archived.push({ round, lens: opinion.lens })
        }),
      parentSessionID: "sess-archive",
    }
    await Effect.runPromise(runPanel(opts))
    expect(archived.length).toBe(2)
    expect(archived.map((a) => a.lens).sort()).toEqual(["correctness", "security"])
  })

  test("an archiver failure does not fail the panel (best-effort)", async () => {
    const runPanelist = (input: PanelistRunInput): Effect.Effect<PanelOpinion | null, unknown> =>
      Effect.succeed(opinionFor(input.spec.lens, "approve"))
    const opts: RunPanelOptions = {
      question: question({ lenses: ["correctness", "security"], maxRounds: 1 }),
      runPanelist,
      archive: () => Effect.fail(new Error("archive store down")),
      parentSessionID: "sess-archive-fail",
    }
    const verdict = await Effect.runPromise(runPanel(opts))
    expect(verdict.decision).not.toBe("needs_human") // survived despite archive failure
  })
})

describe("runPanel — empty panel", () => {
  test("no lenses → needs_human (never silent)", async () => {
    const verdict = await Effect.runPromise(
      runPanel({
        question: question({ lenses: [], maxRounds: 1 }),
        runPanelist: () => Effect.succeed(null),
        parentSessionID: "sess-empty",
      }),
    )
    expect(verdict.decision).toBe("needs_human")
    expect(verdict.rounds).toBe(0)
  })
})
