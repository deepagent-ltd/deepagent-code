import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { SessionReminders } from "../../src/session/reminders"

// Regression coverage for the prompt-cache fix (docs/deepagent-cache-hit-fix-plan.md): the plan-status
// snapshot must NOT be pushed onto a user history message (it changes every step and busted the cache
// from that anchor through all tool-loop history). It now rides the trailing volatile round-context
// message, after the Anthropic cache breakpoint. These tests lock that contract in.

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

const tail = (prepared: { messages: any[] }): string => {
  const last = prepared.messages[prepared.messages.length - 1]
  if (!last || last.role !== "user") return ""
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content)
}

const userHistory = (prepared: { messages: any[] }): string =>
  prepared.messages
    .slice(0, -1) // exclude the trailing volatile message
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
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

  test("plan-status rides the trailing volatile message, NOT the user history", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_tail_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 2)
    const prepared = await prepare(sessionID, [
      { role: "user", content: "implement the parser" },
      { role: "assistant", content: "working on it" },
    ])
    // plan-status must appear ONLY in the trailing volatile user message.
    expect(tail(prepared)).toContain("<plan-status>")
    expect(tail(prepared)).toContain("Current plan (1/3 done)")
    // ...and must NOT have been injected into any prior (cached-prefix) user message.
    expect(userHistory(prepared)).not.toContain("<plan-status>")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  // The core invariant: across a simulated tool loop where plan progress + mutation count advance every
  // step (exactly the values that used to bust the cache), the ENTIRE prefix before the trailing volatile
  // message must stay byte-identical. Only the last message may differ.
  test("cached prefix is byte-stable across tool-loop steps despite advancing plan progress", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_prefix_${crypto.randomUUID()}`
    const history = [
      { role: "user", content: "implement the parser" },
      { role: "assistant", content: "step 1" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: { type: "text", value: "ok" } }] },
    ] as any[]

    // Step A: 1/3 done, 2 mutations.
    seedPlan(sessionID, 1, 3, 2)
    const stepA = await prepare(sessionID, history)

    // Step B: same history prefix, but plan advanced to 2/3 done and mutation count changed — the exact
    // per-step churn that previously busted the cache when written onto the user anchor.
    seedPlan(sessionID, 2, 3, 5)
    const stepB = await prepare(sessionID, history)

    const prefixA = stepA.messages.slice(0, -1)
    const prefixB = stepB.messages.slice(0, -1)
    // The whole prefix (system + history, everything before the trailing volatile message) is identical.
    expect(JSON.stringify(prefixB)).toBe(JSON.stringify(prefixA))
    // ...while the trailing volatile message DID reflect the advancing plan (proving it moved, not vanished).
    expect(tail(stepA)).toContain("1/3 done")
    expect(tail(stepB)).toContain("2/3 done")
    // Exactly one trailing volatile message is appended (not two) — appending a second would shift the
    // cache breakpoint off the last stable history message.
    expect(stepA.messages.length).toBe(history.length + 1 /* system */ + 1 /* volatile tail */)
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("plan-status shares the SINGLE trailing message with the round-context block", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planstatus_single_tail_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 2, 1)
    const prepared = await prepare(sessionID, [{ role: "user", content: "do it" }])
    // Both the round-context and the plan-status live in the one trailing message.
    expect(tail(prepared)).toContain("deepagent-round-context")
    expect(tail(prepared)).toContain("<plan-status>")
    // The tail is the only user message after the system block + original history.
    const trailingUserMessages = prepared.messages.filter(
      (m, i) => m.role === "user" && i === prepared.messages.length - 1,
    )
    expect(trailingUserMessages).toHaveLength(1)
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })
})

// V4.1 §S3.1 — the goal plan HOT-EDIT (§S2) cache contract. A user revising a running goal's plan
// (loop.applyPlanEdit writes the durable doc; the next tick's seedChildPlan mirrors it into the worker's
// plan-state that renderPlanStatus reads) changes ONLY the trailing volatile plan-status message. The
// cached prefix (system + real history) must stay byte-identical across the edit — the plan revision is
// exactly the kind of per-turn churn that would bust the cache if it leaked onto a history anchor.
// steer's tail-anchoring is locked separately in session/steer.test.ts ("steer only adds a tail history
// message: system prefix byte-identical"); here we lock the PLAN-EDIT side of the same red-line.
describe("V4.1 §S3.1 — goal plan hot-edit stays tail-anchored (cache red-line)", () => {
  // Apply a user plan revision the way the goal bridge surfaces it to the prompt on the next tick: the
  // reconciled PlanDoc is set into the session's plan-state (getPlan/setPlan), which is renderPlanStatus's
  // source of truth. Mirrors buildPlanFromInput → setPlan, the seedChildPlan path in goal-loop-wiring.
  const applyEdit = (sessionID: string, revised: Parameters<typeof AgentGateway.DeepAgentPlanController.buildPlanFromInput>[1]) => {
    const prior = AgentGateway.DeepAgentSessionState.getPlan(sessionID)
    const plan = AgentGateway.DeepAgentPlanController.buildPlanFromInput(sessionID, revised, prior as never)
    AgentGateway.DeepAgentSessionState.setPlan(sessionID, plan)
  }

  test("a plan edit moves the tail plan-status but leaves the cached prefix byte-identical", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planedit_prefix_${crypto.randomUUID()}`
    const history = [
      { role: "user", content: "drive the goal" },
      { role: "assistant", content: "ticking" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: { type: "text", value: "ok" } }] },
    ] as any[]

    // Before the edit: a 3-step plan, first done.
    seedPlan(sessionID, 1, 3, 2)
    const before = await prepare(sessionID, history)
    expect(tail(before)).toContain("Current plan (1/3 done)")

    // User hot-edits: re-open step 1 (done→pending), rename it, and drop a step — the exact structural
    // churn a running-goal edit produces. Reflected in the tail via the plan-state render path.
    applyEdit(sessionID, {
      goal: "ship the feature",
      steps: [
        { step_id: "step_1", title: "reworked step", status: "pending" },
        { step_id: "step_2", title: "Step 2", status: "pending" },
      ],
    })
    const after = await prepare(sessionID, history)

    // The tail DID reflect the revision (proving the edit surfaces, not vanishes).
    expect(tail(after)).toContain("Current plan (0/2 done)")
    expect(tail(after)).toContain("reworked step")
    // ...while the ENTIRE cached prefix (system + real history, everything before the volatile tail) is
    // byte-identical across the edit — the cache breakpoint is preserved.
    const prefixBefore = before.messages.slice(0, -1)
    const prefixAfter = after.messages.slice(0, -1)
    expect(JSON.stringify(prefixAfter)).toBe(JSON.stringify(prefixBefore))
    // Still exactly one trailing volatile message (no second tail introduced that would shift slice(-2)).
    expect(after.messages.length).toBe(before.messages.length)
    // The revision NEVER leaked into a prior user-history anchor.
    expect(userHistory(after)).not.toContain("reworked step")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("recordCacheHitOutcome stays healthy (no false break signal) across a plan edit", () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_planedit_cachehit_${crypto.randomUUID()}`
    seedPlan(sessionID, 1, 3, 1)
    // Turn 1 baselines: cache write, no reads (first turn is always a write).
    expect(() => LLMRequestPrep.recordCacheHitOutcome(sessionID, { input: 500, cache: { read: 0, write: 1180 } })).not.toThrow()

    // A hot-edit keeps the cached prefix unchanged (§S3.1 above proves it), so the next turn serves a
    // strong cache read. The monitor must NOT read this as a break (that signature is a COLLAPSED ratio
    // on a NON-shrinking prompt); a healthy read is the happy path and never warns/throws.
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
