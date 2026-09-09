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
  test("blocks, then releases once after the consecutive-block limit, then blocks again", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        const decide = yield* SessionRunner.CurrentToolSettleGate
        if (!decide) return yield* Effect.die("tool settle gate is not wired")
        const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT
        const out = []
        for (let i = 0; i <= limit + 1; i++) out.push(yield* decide(mutating))
        return out
      }).pipe(Effect.provide(gate()), Effect.scoped),
    )

    const limit = AgentGateway.DeepAgentPlanController.DEFAULT_GRACE_BLOCK_LIMIT
    expect(limit).toBe(2)
    // first `limit` calls: held with the compact plan template
    for (const decision of decisions.slice(0, limit)) expect(decision.kind).toBe("block")
    // the next one: released ONCE with the strong reminder
    expect(decisions[limit].kind).toBe("pass")
    expect(decisions[limit].kind === "pass" && decisions[limit].reminder).toContain("Plan gate released")
    // released call reset the counter → the next mutating call is held again
    expect(decisions[limit + 1].kind).toBe("block")
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
})
