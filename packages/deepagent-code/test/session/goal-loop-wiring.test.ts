import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Diagnostic } from "../../src/lsp/client"
import {
  buildGraderPorts,
  buildStepExecutor,
  highestDiagnosticSeverity,
  makeGoalLoopWiring,
  type PanelQuestionInput,
  type SubagentTurnResult,
  type SubagentTurnRunner,
} from "../../src/session/goal-loop-wiring"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { ReviewResult } from "../../src/agent/schema/orchestration"

/**
 * V3.9 §D wiring unit tests. Every leaf (LSP diagnostics, validation runner, subagent turn) is
 * injected as a deterministic stub, so these assert the real port-assembly logic (severity reduction,
 * reviewer/panel decision mapping, flag gating, step→executor result mapping) without any LLM / LSP.
 */

const diag = (severity: number): Diagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: "x",
  severity: severity as Diagnostic["severity"],
})

const turnFrom = (over: Partial<SubagentTurnResult> = {}): SubagentTurnResult => ({
  ok: true,
  structured: undefined,
  text: "",
  tokensUsed: 0,
  cost: 0,
  ...over,
})

const reviewTurn = (result: ReviewResult): SubagentTurnRunner => () =>
  Effect.succeed(turnFrom({ structured: result }))

const panelQuestion = (): PanelQuestionInput => ({
  question: "approve the migration?",
  codeRefs: [],
  lenses: ["correctness", "security"],
  maxRounds: 1,
})

const baseDeps = (over: Partial<Parameters<typeof buildGraderPorts>[0]> = {}) => ({
  runValidation: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null as string | null }),
  runTurn: (() => Effect.succeed(turnFrom())) as SubagentTurnRunner,
  panelQuestion,
  parentSessionID: "parent-1",
  expertPanelEnabled: true, // default ON so the panel-path tests exercise the real runPanel
  ...over,
})

describe("V3.9 §D wiring — highestDiagnosticSeverity (LSP severity reduction)", () => {
  test("empty map → null", () => {
    expect(highestDiagnosticSeverity({})).toBeNull()
    expect(highestDiagnosticSeverity({ "a.ts": [] })).toBeNull()
  })
  test("reduces to the single most-severe label (lower LSP number = more severe)", () => {
    expect(highestDiagnosticSeverity({ "a.ts": [diag(2), diag(3)], "b.ts": [diag(1)] })).toBe("error")
    expect(highestDiagnosticSeverity({ "a.ts": [diag(2), diag(4)] })).toBe("warning")
    expect(highestDiagnosticSeverity({ "a.ts": [diag(4)] })).toBe("hint")
  })
  test("undefined severity is treated as Error (never a silent pass)", () => {
    expect(highestDiagnosticSeverity({ "a.ts": [{ ...diag(3), severity: undefined }] })).toBe("error")
  })
})

describe("V3.9 §D wiring — GraderPorts.diagnostics", () => {
  test("maps live diagnostics through the reducer", async () => {
    const ports = buildGraderPorts(
      baseDeps({ diagnostics: () => Effect.succeed({ maxSeverity: "warning" }) }),
    )
    expect(await Effect.runPromise(ports.diagnostics())).toEqual({ maxSeverity: "warning" })
  })
})

describe("V3.9 §D wiring — GraderPorts.runTests", () => {
  test("passes through the validation runner result", async () => {
    const pass = buildGraderPorts(baseDeps({ runValidation: () => Effect.succeed({ pass: true }) }))
    expect(await Effect.runPromise(pass.runTests(["bun test"]))).toEqual({ pass: true })
    const fail = buildGraderPorts(baseDeps({ runValidation: () => Effect.succeed({ pass: false }) }))
    expect(await Effect.runPromise(fail.runTests(["bun test"]))).toEqual({ pass: false })
  })
  test("a defect in the runner degrades to pass:false (fail-closed)", async () => {
    const ports = buildGraderPorts(baseDeps({ runValidation: () => Effect.die("boom") }))
    expect(await Effect.runPromise(ports.runTests(["bun test"]))).toEqual({ pass: false })
  })
})

describe("V3.9 §D wiring — GraderPorts.reviewerClean", () => {
  const review = (findings: ReviewResult["findings"], verdict: ReviewResult["verdict"] = "approve"): ReviewResult => ({
    findings,
    verdict,
  })
  const finding = (severity: string) => ({
    severity: severity as ReviewResult["findings"][number]["severity"],
    category: "correctness" as const,
    file: "a.ts",
    summary: "s",
    failureScenario: "f",
    confidence: 0.9,
  })

  test("clean when no finding exceeds maxSeverity", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: reviewTurn(review([finding("medium")])) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: true })
  })
  test("not clean when a finding exceeds maxSeverity", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: reviewTurn(review([finding("critical")])) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
  test("no confirmable structured result → NOT clean (fail-closed, never a silent pass)", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ structured: undefined })) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
  test("a failed turn → NOT clean", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ ok: false })) }))
    expect(await Effect.runPromise(ports.reviewerClean("high"))).toEqual({ pass: false })
  })
})

describe("V3.9 §D wiring — GraderPorts.panelApproves (real runPanel + arbiter)", () => {
  const finding = () => ({
    severity: "high" as const,
    category: "security" as const,
    file: "a.ts",
    summary: "s",
    failureScenario: "repro",
    confidence: 0.95,
  })
  test("all panelists approve → decision approve", async () => {
    const runTurn: SubagentTurnRunner = () =>
      Effect.succeed(turnFrom({ structured: { findings: [], verdict: "approve" } as ReviewResult }))
    const ports = buildGraderPorts(baseDeps({ runTurn }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "approve" })
  })
  test("a high-confidence block → decision block (fail-closed via real arbiter)", async () => {
    const runTurn: SubagentTurnRunner = () =>
      Effect.succeed(turnFrom({ structured: { findings: [finding()], verdict: "block" } as ReviewResult }))
    const ports = buildGraderPorts(baseDeps({ runTurn }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "block" })
  })
  test("all panelists absent → needs_human (never a silent approve)", async () => {
    const ports = buildGraderPorts(baseDeps({ runTurn: () => Effect.succeed(turnFrom({ ok: false })) }))
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "needs_human" })
  })
  test("§F.3 panel flag OFF → needs_human WITHOUT convening the panel (flag independence)", async () => {
    let ran = false
    const runTurn: SubagentTurnRunner = () => {
      ran = true
      return Effect.succeed(turnFrom({ structured: { findings: [], verdict: "approve" } as ReviewResult }))
    }
    const ports = buildGraderPorts(baseDeps({ runTurn, expertPanelEnabled: false }))
    // With the Expert Panel disabled the goal loop must NOT run the panel (would couple the two flags);
    // it fail-closes to needs_human — never silently approving, never silently running a disabled cap.
    expect(await Effect.runPromise(ports.panelApproves())).toEqual({ decision: "needs_human" })
    expect(ran).toBe(false) // the panel was NOT convened
  })
})

describe("V3.9 §D wiring — buildStepExecutor", () => {
  test("maps a good turn → tokens/cost, no critical", async () => {
    const exec = buildStepExecutor(() => Effect.succeed(turnFrom({ ok: true, tokensUsed: 42, cost: 0.1 })))
    const res = await Effect.runPromise(
      exec({ goalId: "g", sessionId: "s", planDocId: "p", activeStepId: "a" }),
    )
    expect(res.tokensUsed).toBe(42)
    expect(res.cost).toBe(0.1)
    expect(res.critical).toBeUndefined()
  })
  test("a failed turn → critical (loop rolls back)", async () => {
    const exec = buildStepExecutor(() => Effect.succeed(turnFrom({ ok: false })))
    const res = await Effect.runPromise(
      exec({ goalId: "g", sessionId: "s", planDocId: "p", activeStepId: null }),
    )
    expect(res.critical).toBe(true)
  })
  test("a defect → critical, never thrown", async () => {
    const exec = buildStepExecutor(() => Effect.die("boom"))
    const res = await Effect.runPromise(exec({ goalId: "g", sessionId: "s", planDocId: "p", activeStepId: null }))
    expect(res.critical).toBe(true)
  })
})

describe("V3.9 §D/§F.3 wiring — makeGoalLoopWiring flag gate", () => {
  const input = {
    store: {} as never,
    parentSessionID: "s",
    cwd: "/tmp",
    runTurn: (() => Effect.succeed(turnFrom())) as SubagentTurnRunner,
    panelQuestion,
    diagnostics: () => Effect.succeed({} as Record<string, Diagnostic[]>),
    rollback: () => Effect.void,
  }
  test("flag OFF → null (goal loop unavailable, no wiring constructed)", async () => {
    const deps = await Effect.runPromise(
      makeGoalLoopWiring(input).pipe(Effect.provide(RuntimeFlags.layer({ experimentalGoalLoop: false }))),
    )
    expect(deps).toBeNull()
  })
  test("flag ON → a full ControllerDeps is constructed", async () => {
    const deps = await Effect.runPromise(
      makeGoalLoopWiring(input).pipe(Effect.provide(RuntimeFlags.layer({ experimentalGoalLoop: true }))),
    )
    expect(deps).not.toBeNull()
    expect(typeof deps!.ports.runTests).toBe("function")
    expect(typeof deps!.executor).toBe("function")
    expect(typeof deps!.now).toBe("function")
  })
})
