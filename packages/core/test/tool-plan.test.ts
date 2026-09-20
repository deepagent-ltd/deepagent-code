import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import * as SessionState from "../src/deepagent/session-state"
import * as PlanStore from "../src/deepagent/plan-store"
import { DocumentStore } from "../src/deepagent/document-store"
import { PlanWriteTool } from "../src/tool/plan"
import { ToolOutputStore } from "../src/tool-output-store"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { testEffect } from "./lib/effect"
import { tmpRoot } from "./fixture/tmpdir"

// The V2 plan-gate deadlock repair: the strict gate blocks mutating tools until the model
// commits a plan, and the block copy tells the model to call the `plan` tool — which never
// existed in the V2 builtin set. This pins the closed loop at the tool layer: register →
// materialize sees `plan` → a create commit lands in the PlanStore the gate's getPlan reads
// → the session-state latch the gate consults binds to that plan.

let stateDir: string
const sid = "ses_v2_plan_tool_deadlock_repair"

beforeEach(() => {
  stateDir = mkdtempSync(tmpRoot())
  SessionState.configure(stateDir)
})
afterEach(() => {
  DocumentStore.__resetSharedRegistryForTests()
  rmSync(stateDir, { recursive: true, force: true })
})

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input: ToolOutputStore.BoundInput) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))
const it = testEffect(Layer.provideMerge(PlanWriteTool.layer, registry))
const identity = {
  agent: "build" as never,
  assistantMessageID: "msg_plan_tool" as never,
}
const settlePlan = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const service = yield* ToolRegistry.Service
    const materialized = yield* service.materialize()
    return yield* materialized.settle({
      sessionID: sid as never,
      ...identity,
      call: { type: "tool-call", id: name, name: "plan", input } as never,
    })
  })

describe("PlanWriteTool (V2 builtin plan)", () => {
  it.effect("materialize advertises the plan tool", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize()
      expect(materialized.definitions.map((definition) => definition.name)).toContain("plan")
    }),
  )

  it.effect("create commits the authority doc and arms the gate-visible plan", () =>
    Effect.gen(function* () {
      // The gate seeds the session state on its first block; mirror that ordering so the
      // tool's bindPlan finds the latch to bind (bindPlan is a no-op without state).
      SessionState.getOrCreate(sid, "high")
      yield* settlePlan("call-plan-create", {
        operation: "create",
        expected_plan_id: null,
        expected_version: null,
        goal: "build the snapshot coordinator",
        steps: [{ title: "scaffold the package", status: "active" }],
      })

      // The authority doc the gate's getPlan reads now exists with the committed goal.
      const committed = PlanStore.getPlanDoc(sid)
      expect(committed?.goal).toBe("build the snapshot coordinator")
      expect(committed?.steps).toHaveLength(1)
      expect(committed?.steps[0]?.status).toBe("active")

      // The session-state binding the gate consults: bindPlan (called by the tool) makes
      // getPlan return the live plan, so the gate's `plan == null` branch stops firing.
      expect(SessionState.getPlan(sid)?.goal).toBe("build the snapshot coordinator")
    }),
  )

  it.effect("advance with a stale version settles as a coached conflict, never a die", () =>
    Effect.gen(function* () {
      yield* settlePlan("call-plan-create-2", {
        operation: "create",
        goal: "goal two",
        steps: [{ title: "only step", status: "active" }],
      })
      const doc = PlanStore.getPlanDoc(sid)
      expect(doc).not.toBeNull()

      // A wrong precondition must settle as a coached conflict output (the model can
      // retry), not a defect that kills the drain.
      const conflicted = yield* settlePlan("call-plan-advance", {
        operation: "advance",
        expected_plan_id: doc!.plan_id,
        expected_version: 999,
        steps: [],
      })
      expect(JSON.stringify(conflicted)).toContain("expected_plan_id")
    }),
  )
})
