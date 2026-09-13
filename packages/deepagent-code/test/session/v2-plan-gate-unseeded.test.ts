import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { V2PlanGate } from "@/session/v2-plan-gate"

// The V2 plan gate must work on sessions that never seeded DeepAgentSessionState (the V2 path
// never runs the V1 ensureSessionStateForRun): the latch seeds on the first block so the
// consecutive-block grace release arms. Before the seed, recordPlanGateBlock no-oped forever —
// ablation runs hit 102 consecutive blocks and 0 releases. Core V2 now carries the plan tool, but
// unseeded gate state must still arm the runtime escape instead of relying on model cooperation.

const sessionID = "ses_v2_gate_unseeded"
const staleSessionID = "ses_v2_gate_stale"
const retrievalHeadedMutations = [
  `grep -n "IndexExpression" parser/parser.go > /tmp/plan-gate-output`,
  "find . -delete",
  `grep -n "IndexExpression" parser/parser.go | tee /tmp/plan-gate-output`,
]

const flags = RuntimeFlags.layer({ strictPlanGate: true })
const gate = () => {
  const gateway = AgentGateway.runtimeLayer({
    baseDir: mkdtempSync(path.join(os.tmpdir(), "deepagent-v2-plan-gate-")),
    durableLearning: false,
  })
  return V2PlanGate.layer.pipe(Layer.provide(flags), Layer.provide(gateway), Layer.merge(gateway))
}

const mutating = { sessionID, toolName: "write", args: { file_path: "/app/a.go", content: "x" } }

describe("V2 plan gate on unseeded sessions", () => {
  test("blocks, then releases once after the consecutive-block limit, then registers an implicit plan", async () => {
    const { decisions, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT
        const out = []
        for (let i = 0; i <= limit + 1; i++) out.push(yield* decide(mutating))
        const runtime = yield* AgentGateway.Runtime
        const registered = runtime.withStorage(() => AgentGateway.DeepAgentSessionState.getPlan(sessionID))
        return { decisions: out, plan: registered }
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )

    const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT
    expect(limit).toBe(2)
    // first `limit` calls: held with the compact plan template
    for (const decision of decisions.slice(0, limit)) expect(decision.kind).toBe("block")
    // the next one: released ONCE with the strong reminder
    const released = decisions[limit]
    expect(released?.kind).toBe("pass")
    expect(released?.kind === "pass" && released.reminder).toContain("Plan gate released")
    // G1: after the release reset, the next low-risk edit gets a runtime-registered implicit plan
    // instead of re-entering the block loop — the session must make forward progress.
    const implicit = decisions[limit + 1]
    expect(implicit?.kind).toBe("pass")
    expect(implicit?.kind === "pass" && implicit.reminder).toContain("runtime plan")
    expect(plan).not.toBeNull()
    expect(plan?.steps).toHaveLength(1)
    expect(plan?.steps[0]?.status).toBe("active")
  })

  test("quoted retrieval passes through the core classifier", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        return yield* decide({
          sessionID,
          toolName: "bash",
          args: { command: `grep -n "IndexExpression\\|IsRange\\|COLON" parser/parser.go` },
        })
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )
    expect(decisions.kind).toBe("pass")
  })

  test("retrieval-headed mutations remain gated", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        return yield* Effect.forEach(retrievalHeadedMutations, (command, index) =>
          decide({
            sessionID: `${sessionID}_retrieval_mutation_${index}`,
            toolName: "bash",
            args: { command },
          }),
        )
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )
    expect(decisions.map((decision) => decision.kind)).toEqual(["block", "block", "block"])
  })

  test("stale latches share the core grace limit", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AgentGateway.Runtime
        runtime.withStorage(() => {
          AgentGateway.DeepAgentSessionState.getOrCreate(staleSessionID, "high")
          AgentGateway.DeepAgentSessionState.markPlanStale(staleSessionID, "validation_failed")
        })
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        const out = []
        for (let i = 0; i <= AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT; i++)
          out.push(yield* decide({ ...mutating, sessionID: staleSessionID }))
        return out
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )

    expect(AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT).toBe(2)
    expect(decisions.map((decision) => decision.kind)).toEqual(["block", "block", "pass"])
    expect(decisions[2].kind === "pass" && decisions[2].reminder).toContain("released ONCE")
  })

  test("G1: a seeded session's low-risk first edit passes with an implicit plan, no block round", async () => {
    const firstEditSession = "ses_v2_gate_implicit_first"
    const { decision, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AgentGateway.Runtime
        runtime.withStorage(() => AgentGateway.DeepAgentSessionState.getOrCreate(firstEditSession, "high"))
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        const decision = yield* decide({
          sessionID: firstEditSession,
          toolName: "edit",
          args: { filePath: "/app/parser/parser.go", oldString: "a", newString: "b" },
        })
        const plan = runtime.withStorage(() => AgentGateway.DeepAgentSessionState.getPlan(firstEditSession))
        return { decision, plan }
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )
    // The single edit goes straight through — the provider round the old gate spent on "call the
    // plan tool first" is gone. The plan store still carries the one-step audit artifact.
    expect(decision.kind).toBe("pass")
    expect(decision.kind === "pass" && decision.reminder).toContain("runtime plan")
    expect(plan?.steps).toHaveLength(1)
    expect(plan?.steps[0]?.status).toBe("active")
    expect(plan?.goal).toContain("parser.go")
  })

  test("G1: a mutating bash command still takes the block path (no implicit plan for shells)", async () => {
    const bashSession = "ses_v2_gate_implicit_bash"
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* AgentGateway.Runtime
        runtime.withStorage(() => AgentGateway.DeepAgentSessionState.getOrCreate(bashSession, "high"))
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        return yield* decide({
          sessionID: bashSession,
          toolName: "bash",
          args: { command: "echo x > /app/a.go" },
        })
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )
    // Shell mutations stay behind the explicit-plan requirement: command risk is not inferable
    // from the tool name, so the implicit plan does not apply.
    expect(decision.kind).toBe("block")
  })
})
