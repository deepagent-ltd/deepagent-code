import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import type { Diagnostic } from "../../src/lsp/client"
import {
  buildGraderPorts,
  buildStepExecutor,
  highestDiagnosticSeverity,
  makeGoalLoopWiring,
  makePlanBridge,
  makeTaskSubagentRunner,
  type PanelQuestionInput,
  type SubagentTurnResult,
  type SubagentTurnRunner,
} from "../../src/session/goal-loop-wiring"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { ReviewResult } from "../../src/agent/schema/orchestration"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import type { Session } from "../../src/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { SessionID } from "../../src/session/schema"
import { PLAN_WRITE_OWN_GOAL } from "../../src/agent/subagent-permissions"
import { createPlanDoc, planScope, type PlanDoc, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"

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

// V4.0.1 P2 — the StepExecutor input now also carries the goal's ledger + limits (so the wiring can
// thread a tiered cost soft-notice into the step-prompt tail). This helper builds a minimal valid input
// for the buildStepExecutor unit tests; individual tests override ledger/limits when they exercise the
// budget notice.
const execInput = (
  over: Partial<Parameters<ReturnType<typeof buildStepExecutor>>[0]> = {},
): Parameters<ReturnType<typeof buildStepExecutor>>[0] => ({
  goalId: "g",
  sessionId: "s",
  planDocId: "p",
  goal: "reach goal",
  activeStepId: null,
  activeStep: null,
  graderFeedback: [],
  ledger: { ticks: 0, tokens: 0, cost: 0, wallclockMs: 0, startedAtMs: 0 },
  limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000 },
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

describe("makeTaskSubagentRunner capability boundary", () => {
  const worker: Agent.Info = {
    name: "goal-worker",
    mode: "subagent",
    permission: Permission.fromConfig({ "*": "deny", read: "allow" }),
    capabilities: [PLAN_WRITE_OWN_GOAL],
    options: {},
  }
  const parent: Agent.Info = {
    name: "parent",
    mode: "primary",
    permission: [],
    options: {},
  }

  const run = async (
    input: { readonly allowPlanWriteCapability?: boolean; readonly purpose?: "goal-loop" | "panel" | "generic" },
    turn: { readonly outputSchema?: Record<string, unknown> } = {},
  ) => {
    const created: Array<NonNullable<Session.CreateInput>> = []
    const prompted: SessionPrompt.PromptInput[] = []
    const assistants: SessionV1.WithParts[] = []
    const sessions = {
      get: () => Effect.succeed({ id: SessionID.make("ses_parent"), agent: parent.name, permission: [] }),
      create: (createInput: NonNullable<Session.CreateInput>) => {
        created.push(createInput)
        return Effect.succeed({ id: SessionID.make("ses_child") })
      },
      messages: () => Effect.succeed(assistants),
    } as unknown as Session.Interface
    const agents = {
      get: (name: string) => Effect.succeed(name === worker.name ? worker : name === parent.name ? parent : undefined),
    } as unknown as Agent.Interface
    const sessionPrompt = {
      resolvePromptParts: () => Effect.succeed([]),
      cancel: () => Effect.void,
      prompt: (promptInput: SessionPrompt.PromptInput) => {
        prompted.push(promptInput)
        const assistant = {
          info: {
            role: "assistant",
            id: `msg_${prompted.length}`,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            ...(promptInput.format ? { structured: { verdict: "revise" } } : {}),
          },
          parts: promptInput.format
            ? []
            : [{ type: "text", text: "grounded review draft", synthetic: false, ignored: false }],
        } as unknown as SessionV1.WithParts
        assistants.push(assistant)
        return Effect.succeed(assistant)
      },
    } as unknown as SessionPrompt.Interface
    const runner = makeTaskSubagentRunner({
      sessions,
      agents,
      sessionPrompt,
      parentSessionID: SessionID.make("ses_parent"),
      model: { providerID: "test", modelID: "test" },
      ...input,
    })

    const result = await Effect.runPromise(
      runner({ agentType: worker.name, prompt: "run", outputSchema: turn.outputSchema }),
    )
    return { result, createInput: created[0], prompted }
  }

  test("defaults plan-write capability to false and labels generic children accurately", async () => {
    const { result, createInput } = await run({})
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (generic)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).not.toBe("allow")
  })

  test("goal-loop callers explicitly opt in and receive the capability grant", async () => {
    const { result, createInput } = await run({ allowPlanWriteCapability: true, purpose: "goal-loop" })
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (goal-loop)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).toBe("allow")
  })

  test("panel callers remain opted out and use a panel child title", async () => {
    const { result, createInput } = await run({ allowPlanWriteCapability: false, purpose: "panel" })
    expect(result.ok).toBe(true)
    expect(createInput?.title).toBe("goal-worker (panel)")
    expect(Permission.evaluate("plan", "*", createInput?.permission ?? []).action).not.toBe("allow")
  })

  test("structured reviewer turns collect evidence before the separate finalizer", async () => {
    const { result, prompted } = await run(
      { purpose: "panel" },
      {
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ verdict: "revise" })
    expect(prompted).toHaveLength(2)
    expect(prompted[0]?.format).toBeUndefined()
    expect(prompted[1]?.format?.type).toBe("json_schema")
    expect(prompted[1]?.metadata?.deepagent?.structured_finalizer).toBeDefined()
  })
})

const baseDeps = (over: Partial<Parameters<typeof buildGraderPorts>[0]> = {}) => ({
  runValidation: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null as string | null, checked: true }),
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
      baseDeps({ diagnostics: () => Effect.succeed({ maxSeverity: "warning", checked: true }) }),
    )
    expect(await Effect.runPromise(ports.diagnostics())).toEqual({ maxSeverity: "warning", checked: true })
  })

  test("a diagnostics DEFECT surfaces checked:false (unknown, not clean) — fail-open fix", async () => {
    // The safe() wrapper catches a defect from the injected diagnostics fn. It must fall back to
    // checked:false so the grader treats it as an unmet gap, NOT { maxSeverity: null } read as clean.
    const ports = buildGraderPorts(baseDeps({ diagnostics: () => Effect.die("LSP crashed") }))
    expect(await Effect.runPromise(ports.diagnostics())).toEqual({ maxSeverity: null, checked: false })
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
    const res = await Effect.runPromise(exec(execInput({ activeStepId: "a" })))
    expect(res.tokensUsed).toBe(42)
    expect(res.cost).toBe(0.1)
    expect(res.critical).toBeUndefined()
  })
  test("a failed turn → critical (loop rolls back)", async () => {
    const exec = buildStepExecutor(() => Effect.succeed(turnFrom({ ok: false })))
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.critical).toBe(true)
  })
  test("a defect → critical, never thrown", async () => {
    const exec = buildStepExecutor(() => Effect.die("boom"))
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.critical).toBe(true)
  })

  test("threads prior grader gaps into the next goal-worker prompt", async () => {
    let seenPrompt = ""
    const exec = buildStepExecutor((input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    })

    await Effect.runPromise(
      exec(
        execInput({
          graderFeedback: [
            "plan_complete: outstanding steps [a]",
            "tests_pass: one or more of [bun test] failed",
          ],
        }),
      ),
    )

    expect(seenPrompt).toContain("GRADER FEEDBACK FROM THE PREVIOUS TICK")
    expect(seenPrompt).toContain("plan_complete: outstanding steps [a]")
    expect(seenPrompt).toContain("tests_pass: one or more of [bun test] failed")
    expect(seenPrompt.indexOf("GRADER FEEDBACK")).toBeLessThan(seenPrompt.indexOf("Advance goal"))
  })

  // V4.0.1 P2 §4.4 — tiered cost soft-notice threaded into the step-prompt TAIL.
  test("budgetSoftNotify ON: a tick past the cost tier threads a BUDGET NOTICE into the prompt tail", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    // 8/10 = 80% cost → crosses the default 0.7 tier.
    const exec = buildStepExecutor(runTurn, undefined, undefined, true)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 8, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).toMatch(/BUDGET NOTICE/)
    expect(seenPrompt).toMatch(/80% used/)
    // The notice is in the TAIL (after the fixed advance instruction), never a prefix.
    expect(seenPrompt.indexOf("BUDGET NOTICE")).toBeGreaterThan(seenPrompt.indexOf("Advance goal"))
  })

  test("budgetSoftNotify OFF: no notice is threaded even when the cost tier is crossed", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const exec = buildStepExecutor(runTurn, undefined, undefined, false)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 9, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).not.toMatch(/BUDGET NOTICE/)
  })

  // V4.0.1 P2 §4.4 — the real turn runner surfaces the granular breakdown feeding the NET-token ledger.
  test("surfaces granular net-token fields (input/output/carriedPrefix) from a turn", async () => {
    const exec = buildStepExecutor(() =>
      Effect.succeed(turnFrom({ ok: true, tokensUsed: 100, inputTokens: 80, outputTokens: 20, carriedPrefixTokens: 60 })),
    )
    const res = await Effect.runPromise(exec(execInput()))
    expect(res.tokensUsed).toBe(100)
    expect(res.inputTokens).toBe(80)
    expect(res.outputTokens).toBe(20)
    expect(res.carriedPrefixTokens).toBe(60)
  })

  // V4.0.1 P1 §3.3 — the World State provider re-injects the latest volatile facts into the step-prompt
  // TAIL every tick (P3(d) gate-free goal-worker recall). Ordering: World State BEFORE the budget notice.
  test("worldStateProvider ON: the rendered block is threaded into the prompt tail, before the budget notice", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const provider = () => Effect.succeed("<world-state>\n## Version Control\nbranch main\n</world-state>")
    const exec = buildStepExecutor(runTurn, undefined, undefined, true, provider)
    await Effect.runPromise(
      exec(
        execInput({
          ledger: { ticks: 1, tokens: 0, cost: 8, wallclockMs: 0, startedAtMs: 0 },
          limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000, maxCost: 10 },
        }),
      ),
    )
    expect(seenPrompt).toContain("<world-state>")
    expect(seenPrompt).toContain("branch main")
    // World State rides the tail AFTER the advance instruction …
    expect(seenPrompt.indexOf("<world-state>")).toBeGreaterThan(seenPrompt.indexOf("Advance goal"))
    // … and BEFORE the (more volatile) budget notice (most volatile content stays last).
    expect(seenPrompt.indexOf("<world-state>")).toBeLessThan(seenPrompt.indexOf("BUDGET NOTICE"))
  })

  test("worldStateProvider omitted ⇒ no World State block (byte-for-byte pre-V4.0.1)", async () => {
    let seenPrompt = ""
    const runTurn: SubagentTurnRunner = (input) => {
      seenPrompt = input.prompt
      return Effect.succeed(turnFrom({ ok: true }))
    }
    const exec = buildStepExecutor(runTurn, undefined, undefined, false)
    await Effect.runPromise(exec(execInput()))
    expect(seenPrompt).not.toContain("<world-state>")
  })

  test("a defect in the World State provider never fails the tick (default-safe: '' ⇒ turn still runs)", async () => {
    let ran = false
    const runTurn: SubagentTurnRunner = () => {
      ran = true
      return Effect.succeed(turnFrom({ ok: true, tokensUsed: 7 }))
    }
    // The provider itself is default-safe in production; here it returns "" (as refreshWorldState does on
    // any defect) and the tick proceeds normally.
    const exec = buildStepExecutor(runTurn, undefined, undefined, false, () => Effect.succeed(""))
    const res = await Effect.runPromise(exec(execInput()))
    expect(ran).toBe(true)
    expect(res.tokensUsed).toBe(7)
    expect(res.critical).toBeUndefined()
  })
})

describe("V3.9 §E F3 wiring — plan bridge (worker plan edits reach the goal plan doc)", () => {
  const roots: string[] = []
  // I33-1: the structural plan now lives in the DocumentStore authority reached via session-state's
  // configured root (plan-store). Configure a fresh state dir per case so the child session's
  // getPlan/setPlan (used by seedChildPlan/mirrorChildPlan) has a plan-store root.
  beforeEach(() => {
    AgentGateway.DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "deepagent-f3-state-")))
  })
  const step = (id: string, status: PlanStep["status"]): PlanStep => ({
    step_id: id,
    title: id,
    status,
    acceptance: null,
    assigned_agent: null,
    evidence: [],
    note: null,
  })
  // Persist a plan doc exactly as the plan tool does (body = JSON PlanDoc, scope run:<sessionId>).
  const putGoalPlan = (store: DocumentStore, sessionId: string, steps: PlanStep[]): string => {
    const plan = createPlanDoc(sessionId, "reach goal", steps)
    return store.upsert({
      type: "plan",
      scope: planScope(sessionId),
      description: `plan ${sessionId}`,
      idSlug: `plan-${sessionId}`,
      body: JSON.stringify(plan),
      provenance: { source: "model", run_ref: planScope(sessionId) },
    }).id
  }
  const freshStore = () => {
    const root = mkdtempSync(path.join(tmpdir(), "deepagent-f3-"))
    roots.push(root)
    return new DocumentStore(root)
  }
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  test("seedChildPlan copies the goal plan into the child session's plan-state", () => {
    const store = freshStore()
    const goalSession = "goal-sess-1"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-1"
    bridge.seedChildPlan(childId)
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)
    expect(seeded).not.toBeNull()
    expect(seeded!.steps.map((s) => s.step_id)).toEqual(["a", "b"])
    expect(seeded!.steps[0].status).toBe("active")
  })

  test("mirrorChildPlan writes the worker's edited plan BACK into the goal plan doc (new version)", () => {
    const store = freshStore()
    const goalSession = "goal-sess-2"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-2"
    bridge.seedChildPlan(childId)
    const before = store.get(planDocId)!.version

    // Worker advances step a→done, b→active (as the plan tool would, via setPlan on the child session).
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)!
    const advanced: PlanDoc = {
      ...seeded,
      steps: [
        { ...seeded.steps[0], status: "done" },
        { ...seeded.steps[1], status: "active" },
      ],
      active_step_id: "b",
    }
    AgentGateway.DeepAgentSessionState.setPlan(childId, advanced)
    bridge.mirrorChildPlan(childId)

    const goalDoc = store.get(planDocId)!
    expect(goalDoc.version).toBeGreaterThan(before) // a new version was written
    const goalPlan = JSON.parse(goalDoc.body) as PlanDoc
    expect(goalPlan.steps.find((s) => s.step_id === "a")!.status).toBe("done")
    expect(goalPlan.active_step_id).toBe("b")
  })

  test("mirrorChildPlan rejects goal and step-structure rewrites while preserving status progress", () => {
    const store = freshStore()
    const planDocId = putGoalPlan(store, "goal-sess-restricted", [step("a", "active"), step("b", "pending")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-restricted"
    bridge.seedChildPlan(childId)
    const seeded = AgentGateway.DeepAgentSessionState.getPlan(childId)!
    AgentGateway.DeepAgentSessionState.setPlan(childId, {
      ...seeded,
      goal: "rewritten goal",
      steps: [
        { ...seeded.steps[0], title: "rewritten title", status: "done" },
        { ...seeded.steps[1], status: "active" },
        step("injected", "pending"),
      ],
      active_step_id: "b",
    })

    bridge.mirrorChildPlan(childId)
    const mirrored = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(mirrored.goal).toBe("reach goal")
    expect(mirrored.steps.map((item) => item.step_id)).toEqual(["a", "b"])
    expect(mirrored.steps.map((item) => item.title)).toEqual(["a", "b"])
    expect(mirrored.steps.map((item) => item.status)).toEqual(["done", "active"])
    expect(mirrored.active_step_id).toBe("b")
  })

  test("mirrorChildPlan is a no-op version-wise when the worker changed nothing (idempotency-safe)", () => {
    const store = freshStore()
    const planDocId = putGoalPlan(store, "goal-sess-3", [step("a", "active")])
    const bridge = makePlanBridge({ store, planDocId, agentMode: "general" })
    const childId = "child-sess-3"
    bridge.seedChildPlan(childId)
    const before = store.get(planDocId)!.version
    // Re-set the identical plan (no status change) then mirror — must NOT bump the version (INV-4).
    AgentGateway.DeepAgentSessionState.setPlan(childId, AgentGateway.DeepAgentSessionState.getPlan(childId)!)
    bridge.mirrorChildPlan(childId)
    expect(store.get(planDocId)!.version).toBe(before)
  })

  test("buildStepExecutor with a bridge factory seeds before and mirrors after the turn", async () => {
    const store = freshStore()
    const goalSession = "goal-sess-4"
    const planDocId = putGoalPlan(store, goalSession, [step("a", "active")])
    const bridgeFor = (id: string) => makePlanBridge({ store, planDocId: id, agentMode: "general" })

    // A stub runTurn that behaves like the worker: on its turn it advances the (seeded) child plan,
    // and it reports the child session id so the executor can mirror it back.
    const childId = "child-sess-4"
    const runTurn: SubagentTurnRunner = (input) => {
      input.prepareSession?.(childId) // the real runner calls this after creating the child session
      const p = AgentGateway.DeepAgentSessionState.getPlan(childId)!
      AgentGateway.DeepAgentSessionState.setPlan(childId, {
        ...p,
        steps: [{ ...p.steps[0], status: "done" }],
        active_step_id: null,
      })
      return Effect.succeed(turnFrom({ ok: true, tokensUsed: 5, sessionID: childId }))
    }
    const exec = buildStepExecutor(runTurn, bridgeFor)
    const res = await Effect.runPromise(exec(execInput({ sessionId: goalSession, planDocId, activeStepId: "a" })))
    expect(res.critical).toBeUndefined()
    // The worker's advance is now visible in the GOAL plan doc (what the grader reads).
    const goalPlan = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(goalPlan.steps[0].status).toBe("done")
  })
})

describe("V3.9 §D/§F.3 wiring — makeGoalLoopWiring flag gate", () => {
  const input = {
    store: {} as never,
    parentSessionID: "s",
    cwd: "/tmp",
    runTurn: (() => Effect.succeed(turnFrom())) as SubagentTurnRunner,
    panelQuestion,
    diagnostics: () => Effect.succeed({ diagnostics: {} as Record<string, Diagnostic[]>, checked: true }),
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
