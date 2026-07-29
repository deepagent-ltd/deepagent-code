import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { SessionReminders } from "../../src/session/reminders"

// Plan status is trusted runtime control. It must stay out of durable history and travel in the same
// ephemeral tail as round context. The stable system prompt assigns that tag its control semantics,
// and the full system + durable-history prefix stays byte-identical when the plan advances.

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const user = (sessionID: string, metadata?: Record<string, unknown>) =>
  ({
    id: "msg_plan_status_cache",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "deepagent", modelID: "deepseek-deepseek-v4-flash" },
    metadata,
  }) as any

const model = () =>
  ({
    id: "deepseek-deepseek-v4-flash",
    providerID: "deepagent",
    api: { id: "deepseek-deepseek-v4-flash", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
    name: "deepseek-deepseek-v4-flash",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, input: 128_000, output: 32_000 },
    status: "active",
    options: {},
    headers: {},
  }) as any

async function prepare(sessionID: string, messages: any[], metadata?: Record<string, unknown>) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: user(sessionID, metadata),
      sessionID,
      model: model(),
      agent: { name: "build", mode: "primary", prompt: "generic agent prompt", options: {}, permission: [] } as any,
      system: ["You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."],
      messages,
      tools: {},
      provider: { id: "deepagent", options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  )
}

const continueRound = { deepagent: { round_control: { action: "continue" } } }

// Seed a plan into DeepAgent session state so renderPlanStatus has something to render. `done` steps
// are marked done; the rest pending, with the first pending step active — matching a real in-progress
// plan. Recording mutations bumps the count that renderPlanStatus embeds (the cache-buster we moved).
function seedPlan(sessionID: string, doneCount: number, total: number, mutations: number) {
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
  const steps = Array.from({ length: total }, (_, i) => ({
    step_id: `step_${i + 1}`,
    title: `Step ${i + 1}`,
    status: i < doneCount ? ("done" as const) : ("pending" as const),
  }))
  const activeStep = steps.find((s) => s.status === "pending")
  const plan = AgentGateway.DeepAgentPlanController.buildPlanFromInput(sessionID, {
    goal: "ship the feature",
    steps,
    ...(activeStep ? { active_step_id: activeStep.step_id } : {}),
  })
  AgentGateway.DeepAgentSessionState.setPlan(sessionID, plan)
  for (let i = 0; i < mutations; i++) AgentGateway.DeepAgentSessionState.recordMutation(sessionID)
}

const runtimeContext = (prepared: { messages: any[] }): string =>
  prepared.messages.find(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("<deepagent-round-context>"),
  )?.content ?? ""

const stableMessages = (prepared: { messages: any[] }) =>
  prepared.messages.filter(
    (message) =>
      !(
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("<deepagent-round-context>")
      ),
  )

const durableUserHistory = (prepared: { messages: any[] }): string =>
  stableMessages(prepared)
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")

describe("plan-status prompt-cache fix", () => {
  test("renderPlanStatus returns the snapshot text in high mode with a plan", () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_render_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 0)
    const status = SessionReminders.renderPlanStatus(sessionID)
    expect(status).not.toBeNull()
    expect(status!).toContain("<plan-status>")
    expect(status!).toContain("Current plan (1/3 done)")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("renderPlanStatus is null in lightweight/general mode", () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })
    const sessionID = `ses_planstatus_general_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 0)
    expect(SessionReminders.renderPlanStatus(sessionID)).toBeNull()
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("renderPlanStatus is null when there is no plan", () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_noplan_${crypto.randomUUID()}`
    AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
    expect(SessionReminders.renderPlanStatus(sessionID)).toBeNull()
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("does not send first-round plan telemetry for a non-orchestrated task", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_noop_${crypto.randomUUID()}`
    seedPlan(sessionID, 0, 2, 0)
    const prepared = await prepare(sessionID, [{ role: "user", content: "fix one typo" }])
    expect(runtimeContext(prepared)).toBe("")
    expect(JSON.stringify(prepared.messages.filter((message) => message.role === "user"))).not.toContain("plan-status")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("plan-status stays in the ephemeral runtime tail, not durable history", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_tail_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 2)
    const prepared = await prepare(
      sessionID,
      [
        { role: "user", content: "implement the parser" },
        { role: "assistant", content: "working on it" },
      ],
      continueRound,
    )
    expect(runtimeContext(prepared)).toContain("<plan-status>")
    expect(runtimeContext(prepared)).toContain("Current plan (1/3 done)")
    expect(durableUserHistory(prepared)).not.toContain("<plan-status>")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("stable base prompt and history remain unchanged while runtime plan state advances", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_prefix_${crypto.randomUUID()}`
    const history = [
      { role: "user", content: "implement the parser" },
      { role: "assistant", content: "step 1" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: { type: "text", value: "ok" } }] },
    ] as any[]

    // Step A: 1/3 done, 2 mutations.
    seedPlan(sessionID, 1, 3, 2)
    const stepA = await prepare(sessionID, history, continueRound)

    // Step B: same history prefix, but plan advanced to 2/3 done and mutation count changed — the exact
    // per-step churn that previously busted the cache when written onto the user anchor.
    seedPlan(sessionID, 2, 3, 5)
    const stepB = await prepare(sessionID, history, continueRound)

    expect(JSON.stringify(stableMessages(stepB))).toBe(JSON.stringify(stableMessages(stepA)))
    expect(runtimeContext(stepA)).toContain("1/3 done")
    expect(runtimeContext(stepB)).toContain("2/3 done")
    expect(stepA.messages.at(-1)?.content).toBe(runtimeContext(stepA))
    expect(stepA.messages.length).toBe(history.length + 1 /* stable system */ + 1 /* runtime tail */)
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("plan-status shares one runtime tail with round context", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_single_tail_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 2, 1)
    const prepared = await prepare(sessionID, [{ role: "user", content: "do it" }], continueRound)
    expect(runtimeContext(prepared)).toContain("deepagent-round-context")
    expect(runtimeContext(prepared)).toContain("<plan-status>")
    const runtimeMessages = prepared.messages.filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith("<deepagent-round-context>"),
    )
    expect(runtimeMessages).toHaveLength(1)
    expect(prepared.messages.at(-1)).toBe(runtimeMessages[0])
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })
})

// V4.1 §S3.1 — the goal plan HOT-EDIT (§S2) cache contract. A user revising a running goal's plan
// (loop.applyPlanEdit writes the durable doc; the next tick's seedChildPlan mirrors it into the
// worker's plan-state that renderPlanStatus reads) changes only the ephemeral runtime tail. It must
// never leak onto a durable user-history anchor.
describe("V4.1 §S3.1 — goal plan hot-edit stays runtime-tail scoped", () => {
  // Apply a user plan revision the way the goal bridge surfaces it to the prompt on the next tick: the
  // reconciled PlanDoc is set into the session's plan-state (getPlan/setPlan), which is renderPlanStatus's
  // source of truth. Mirrors buildPlanFromInput → setPlan, the seedChildPlan path in goal-loop-wiring.
  const applyEdit = (sessionID: string, revised: Parameters<typeof AgentGateway.DeepAgentPlanController.buildPlanFromInput>[1]) => {
    const prior = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
    const plan = AgentGateway.DeepAgentPlanController.buildPlanFromInput(sessionID, revised, prior as never)
    AgentGateway.DeepAgentSessionState.setPlan(sessionID, plan)
  }

  test("a plan edit changes runtime status but leaves base prompt and history byte-identical", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planedit_prefix_${crypto.randomUUID()}`
    const history = [
      { role: "user", content: "drive the goal" },
      { role: "assistant", content: "ticking" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: { type: "text", value: "ok" } }] },
    ] as any[]

    // Before the edit: a 3-step plan, first done.
    seedPlan(sessionID, 1, 3, 2)
    const before = await prepare(sessionID, history, continueRound)
    expect(runtimeContext(before)).toContain("Current plan (1/3 done)")

    // User hot-edits: re-open step 1 (done→pending), rename it, and drop a step — the exact structural
    // churn a running-goal edit produces. Reflected through the plan-state render path.
    applyEdit(sessionID, {
      goal: "ship the feature",
      steps: [
        { step_id: "step_1", title: "reworked step", status: "pending" },
        { step_id: "step_2", title: "Step 2", status: "pending" },
      ],
    })
    const after = await prepare(sessionID, history, continueRound)

    expect(runtimeContext(after)).toContain("Current plan (0/2 done)")
    expect(runtimeContext(after)).toContain("reworked step")
    expect(JSON.stringify(stableMessages(after))).toBe(JSON.stringify(stableMessages(before)))
    expect(after.messages.length).toBe(before.messages.length)
    expect(durableUserHistory(after)).not.toContain("reworked step")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("recordCacheHitOutcome stays healthy (no false break signal) across a plan edit", () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planedit_cachehit_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 1)
    // Turn 1 baselines: cache write, no reads (first turn is always a write).
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, { input: 500, cache: { read: 0, write: 1180 } })).not.toThrow()

    // Cache telemetry remains diagnostic-only across the plan edit.
    applyEdit(sessionID, { goal: "ship the feature", steps: [{ step_id: "step_1", title: "reworked", status: "pending" }] })
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, { input: 12, cache: { read: 1180, write: 0 } })).not.toThrow()
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })
})

// Response-side cache-hit monitor: a pure, diagnostic-only function (never throws). We can't assert on
// the log line directly, but we can assert it runs without error across the scenarios it guards, and
// that the first call of a session only baselines (no comparison). This locks in the "never blocks a
// turn" contract for the billing-signal probe.
describe("recordCacheHitOutcome (response-side monitor)", () => {
  const tokens = (input: number, read: number, write = 0) => ({ input, cache: { read, write } })

  test("first call baselines without throwing; subsequent calls compare without throwing", () => {
    const sessionID = `ses_cachehit_${crypto.randomUUID()}`
    // Turn 1: cache write, zero reads (normal on the first turn) — baseline only.
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, tokens(500, 0, 1180))).not.toThrow()
    // Turn 2: strong cache read (healthy) — no warning path, no throw.
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, tokens(12, 1180))).not.toThrow()
    // Turn 3: collapsed hit ratio with a non-shrinking prompt (the break signature) — warns, never throws.
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, tokens(1180, 12))).not.toThrow()
  })

  test("handles zero/empty usage safely", () => {
    const sessionID = `ses_cachehit_zero_${crypto.randomUUID()}`
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, tokens(0, 0, 0))).not.toThrow()
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, tokens(0, 0, 0))).not.toThrow()
  })
})
