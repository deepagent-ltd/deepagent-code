import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  buildPlanFromWriteInput,
  PlanConflictError,
  type PlanDoc,
  type PlanExpected,
} from "@deepagent-code/core/deepagent/plan-controller"
import {
  normalizeModelPlanWrite,
  PlanWriteParameters,
  renderModelPlanCorrection,
  renderModelPlanSuccess,
  renderPlanRetryBase,
} from "../../src/tool/plan-write"

const previous: PlanDoc = {
  plan_id: "plan_incident",
  session_id: "ses_incident",
  goal: "finish the provider migration",
  assumptions: ["the current branch is clean"],
  active_step_id: "s1",
  created_at: "2026-08-09T00:00:00.000Z",
  steps: [
    {
      step_id: "s1",
      title: "Inspect the provider boundary",
      status: "active",
      acceptance: "the boundary has a passing regression test",
      assigned_agent: "researcher",
      note: null,
      evidence: ["validation:provider-boundary"],
    },
    {
      step_id: "s2",
      title: "Implement the server-side merge",
      status: "pending",
      acceptance: "the model can advance without changing identity fields",
      assigned_agent: "implementer",
      note: null,
      evidence: [],
    },
  ],
}

const ref: PlanExpected = {
  plan_id: previous.plan_id,
  doc_id: "doc_incident",
  version: 2,
}

const decode = (input: unknown) => Schema.decodeUnknownSync(PlanWriteParameters)(input)

describe("model plan advance normalization", () => {
  test("keeps create goal and title requirements at the semantic boundary", () => {
    const missingGoal = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      steps: [{ status: "pending", title: "Inspect the provider boundary" }],
    })
    expect(() =>
      buildPlanFromWriteInput(previous.session_id, normalizeModelPlanWrite(missingGoal, null, null), null, null),
    ).toThrow("empty_goal")

    const missingTitle = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      steps: [{ status: "pending" }],
    })
    expect(() =>
      buildPlanFromWriteInput(previous.session_id, normalizeModelPlanWrite(missingTitle, null, null), null, null),
    ).toThrow("empty_title")
  })

  test("allocates create step IDs before deriving the active step", () => {
    const params = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: "ship the provider migration",
      steps: [
        { title: "Inspect the provider boundary", status: "done" },
        { title: "Implement the server-side merge", status: "active" },
      ],
    })

    const normalized = normalizeModelPlanWrite(params, null, null)
    const next = buildPlanFromWriteInput(previous.session_id, normalized, null, null)

    expect("active_step_id" in normalized).toBeFalse()
    expect(next.steps.every((step) => step.step_id.startsWith("step_"))).toBeTrue()
    expect(next.active_step_id).toBe(next.steps[1]!.step_id)
  })

  test("rejects an incident-shaped replan that invents an active ID", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "the implementation boundary changed after inspection",
      goal: previous.goal,
      steps: [
        {
          title: "Implement the corrected provider boundary",
          status: "active",
          acceptance: "the boundary has a passing regression test and preserves every provider contract",
        },
        {
          title: "Run the complete provider regression matrix",
          status: "pending",
          acceptance: "all supported providers pass schema, semantic, retry, and recovery coverage",
        },
      ],
      active_step_id: "g5",
    })

    expect(() => normalizeModelPlanWrite(params, previous, ref)).toThrow("unsafe_step_identity")
  })

  test("fills hidden retained-step identity fields from the authoritative replan", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "refresh statuses without changing retained identities",
      goal: previous.goal,
      steps: previous.steps.map((step) => ({ step_id: step.step_id, status: step.status })),
    })

    const next = buildPlanFromWriteInput(
      previous.session_id,
      normalizeModelPlanWrite(params, previous, ref),
      previous,
      ref,
    )
    expect(
      next.steps.map((step) => ({
        title: step.title,
        acceptance: step.acceptance,
        assigned_agent: step.assigned_agent,
      })),
    ).toEqual(
      previous.steps.map((step) => ({
        title: step.title,
        acceptance: step.acceptance,
        assigned_agent: step.assigned_agent,
      })),
    )
  })

  test("rejects an unknown explicit replan step ID instead of treating it as new", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "attempt to replace a step",
      goal: previous.goal,
      steps: [{ step_id: "model_chosen_new", title: "new step", status: "active" }],
    })

    expect(() => normalizeModelPlanWrite(params, previous, ref)).toThrow("unsafe_step_identity")
  })

  test("rejects a replan active pointer even when it matches current authority", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "validate active identity",
      goal: previous.goal,
      steps: [{ title: previous.steps[0]!.title, status: "active" }],
      active_step_id: previous.active_step_id,
    })

    expect(() => normalizeModelPlanWrite(params, previous, ref)).toThrow("unsafe_step_identity")
  })

  test("rejects model-created IDs on create and keeps replan assumptions when omitted", () => {
    const create = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      assumptions: ["new assumption"],
      steps: [{ step_id: "model_chosen", title: "create step", status: "active" }],
      active_step_id: "model_chosen",
    })
    expect(() => normalizeModelPlanWrite(create, null, null)).toThrow("unsafe_step_identity")

    const replan = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "retain assumptions unless explicitly cleared",
      goal: previous.goal,
      steps: previous.steps.map((step) => ({ step_id: step.step_id, title: step.title, status: step.status })),
    })
    expect(normalizeModelPlanWrite(replan, previous, ref).assumptions).toEqual([...previous.assumptions])
    const clear = decode({
      ...replan,
      assumptions: [],
    })
    expect(normalizeModelPlanWrite(clear, previous, ref).assumptions).toEqual([])
  })

  test("allocates IDs for new replan steps and derives the active pointer after allocation", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "add final validation after implementation",
      goal: previous.goal,
      steps: [
        { step_id: "s1", status: "done" },
        { step_id: "s2", status: "pending" },
        { title: "Run the provider regression matrix", status: "active" },
      ],
    })

    const next = buildPlanFromWriteInput(
      previous.session_id,
      normalizeModelPlanWrite(params, previous, ref),
      previous,
      ref,
    )
    expect(next.steps.slice(0, 2).map((step) => step.step_id)).toEqual(["s1", "s2"])
    expect(next.steps[2]!.step_id).toStartWith("step_")
    expect(next.active_step_id).toBe(next.steps[2]!.step_id)
    expect(next.assumptions).toEqual(previous.assumptions)
  })

  test("rejects a supplied create active pointer even when it is null", () => {
    const params = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      steps: [{ title: "create step", status: "pending" }],
      active_step_id: null,
    })

    expect(() => normalizeModelPlanWrite(params, null, null)).toThrow("unsafe_step_identity")
  })

  test("rejects an explicit active ID before replan candidate construction", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "retain the structure but correct the active pointer",
      goal: previous.goal,
      steps: previous.steps.map((step) => ({
        step_id: step.step_id,
        title: step.title,
        status: step.status,
        acceptance: step.acceptance ?? undefined,
        assigned_agent: step.assigned_agent ?? undefined,
      })),
      active_step_id: "g5",
    })

    expect(() => normalizeModelPlanWrite(params, previous, ref)).toThrow("unsafe_step_identity")
  })

  test("accepts a replan goal change while retaining omitted hidden identity fields", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "the requested outcome changed",
      goal: "finish and validate the provider migration",
      steps: previous.steps.map((step) => ({ step_id: step.step_id, title: step.title, status: step.status })),
    })

    const next = buildPlanFromWriteInput(
      previous.session_id,
      normalizeModelPlanWrite(params, previous, ref),
      previous,
      ref,
    )
    expect(next.goal).toBe("finish and validate the provider migration")
    expect(next.steps.map((step) => ({ acceptance: step.acceptance, assigned_agent: step.assigned_agent }))).toEqual(
      previous.steps.map((step) => ({ acceptance: step.acceptance, assigned_agent: step.assigned_agent })),
    )
  })

  test("rejects multiple active create steps even when active_step_id is omitted", () => {
    const params = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      steps: [
        { title: "Inspect the provider boundary", status: "active" },
        { title: "Implement the server-side merge", status: "active" },
      ],
    })

    expect(() =>
      buildPlanFromWriteInput(previous.session_id, normalizeModelPlanWrite(params, null, null), null, null),
    ).toThrow("multiple_active_steps")
  })

  test("merges the incident-shaped full payload as a status patch", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      goal: "finish the provider migration",
      assumptions: ["model supplied a different assumption"],
      active_step_id: "s2",
      steps: [
        {
          step_id: "s1",
          title: "Use a different title",
          status: "done",
          acceptance: "a weaker acceptance",
          assigned_agent: "general",
        },
        {
          step_id: "s2",
          title: "A rewritten title",
          status: "active",
          acceptance: "another acceptance",
          assigned_agent: "researcher",
        },
      ],
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    const next = buildPlanFromWriteInput(previous.session_id, normalized, previous, ref)

    expect(next.goal).toBe(previous.goal)
    expect(next.assumptions).toEqual(previous.assumptions)
    expect(next.active_step_id).toBe("s2")
    expect(next.steps).toEqual([
      {
        ...previous.steps[0],
        status: "done",
      },
      {
        ...previous.steps[1],
        status: "active",
      },
    ])
  })

  test("preserves omitted steps and authoritative identity fields for a partial patch", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      goal: "ignored model goal",
      steps: [{ step_id: "s1", status: "done", note: "validated" }],
      active_step_id: null,
    })

    const next = buildPlanFromWriteInput(
      previous.session_id,
      normalizeModelPlanWrite(params, previous, ref),
      previous,
      ref,
    )

    expect(next.steps[0]).toMatchObject({
      step_id: "s1",
      title: previous.steps[0].title,
      status: "done",
      acceptance: previous.steps[0].acceptance,
      assigned_agent: previous.steps[0].assigned_agent,
      note: "validated",
    })
    expect(next.steps[1]).toEqual(previous.steps[1])
  })

  test("defaults omitted goal and active step to authoritative values", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      steps: [{ step_id: "s1", status: "active" }],
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect(normalized.goal).toBe(previous.goal)
    expect("active_step_id" in normalized && normalized.active_step_id).toBe(previous.active_step_id)
  })

  test("rejects duplicate and unknown step IDs before building a candidate", () => {
    const duplicate = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      goal: previous.goal,
      steps: [
        { step_id: "s1", status: "done" },
        { step_id: "s1", status: "active" },
      ],
      active_step_id: "s1",
    })
    expect(() => normalizeModelPlanWrite(duplicate, previous, ref)).toThrow("duplicate_step_id")

    const unknown = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      goal: previous.goal,
      steps: [{ step_id: "s3", status: "done" }],
      active_step_id: null,
    })
    expect(() => normalizeModelPlanWrite(unknown, previous, ref)).toThrow("unsafe_step_identity")
  })

  test("reports a stale precondition before validating step IDs against current authority", () => {
    const stale = decode({
      operation: "advance",
      expected_plan_id: "plan_before_replan",
      expected_version: ref.version - 1,
      steps: [{ step_id: "step_from_old_plan", status: "done" }],
      active_step_id: null,
    })

    expect(() => normalizeModelPlanWrite(stale, previous, ref)).toThrow(PlanConflictError)
  })

  test("returns schema-valid correction parameters with the exact model-facing field names", () => {
    const output = renderPlanRetryBase(previous, { id: ref.doc_id, version: ref.version })
    const base = JSON.parse(output.slice(output.indexOf("{"))) as Record<string, unknown>
    const retry = decode(base)

    expect(output).toContain(`"expected_plan_id":"${previous.plan_id}"`)
    expect(output).toContain(`"expected_version":${ref.version}`)
    expect(output).toContain('"step_id":"s1"')
    expect(output).toContain('"active_step_id":"s1"')
    expect(output).not.toContain('"plan_version"')
    expect(retry.steps).toEqual([
      { step_id: "s1", status: "active" },
      { step_id: "s2", status: "pending" },
    ])
    expect(retry.goal).toBeUndefined()
    expect(retry.assumptions).toBeUndefined()
  })

  test("preserves a blocked step note in the schema-valid correction base", () => {
    const blocked = {
      ...previous,
      active_step_id: null,
      steps: [{ ...previous.steps[0], status: "blocked" as const, note: "waiting for credentials" }],
    }
    const output = renderPlanRetryBase(blocked, { id: ref.doc_id, version: ref.version })
    const base = JSON.parse(output.slice(output.indexOf("{"))) as Record<string, unknown>

    expect(decode(base).steps).toEqual([{ step_id: "s1", status: "blocked", note: "waiting for credentials" }])
  })

  test("forbids guessing when a correction cannot supply the authoritative version", () => {
    const output = renderPlanRetryBase(previous, null)
    expect(output).toContain(`expected_plan_id=${JSON.stringify(previous.plan_id)}`)
    expect(output).toContain("expected_version is unavailable")
    expect(output).toContain("Do not guess or call advance/replan")
  })

  test("returns operation-specific create and replan corrections without future ID guesses", () => {
    const createParams = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: "ship the migration",
      steps: [{ step_id: "invented", title: "implement", status: "active" }],
      active_step_id: "invented",
    })
    const replanParams = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "change the implementation boundary",
      goal: previous.goal,
      steps: [{ step_id: "invented", title: "new step", status: "active" }],
    })
    const create = renderModelPlanCorrection(createParams, "unsafe_step_identity", null, null)
    const replan = renderModelPlanCorrection(replanParams, "unsafe_step_identity", previous, {
      id: ref.doc_id,
      version: ref.version,
    })
    const createRetry = decode(JSON.parse(create.slice(create.indexOf("{"))))
    const replanRetry = decode(JSON.parse(replan.slice(replan.indexOf("{"))))

    expect(createRetry.steps).toEqual([{ title: "implement", status: "active" }])
    expect(createRetry.active_step_id).toBeUndefined()
    expect(create).toContain("Do not invent a future server ID")
    expect(replanRetry.expected_plan_id).toBe(previous.plan_id)
    expect(replanRetry.expected_version).toBe(ref.version)
    expect(replanRetry.steps.map((step) => step.step_id)).toEqual(["s1", "s2"])
    expect(replanRetry.steps.map((step) => step.acceptance)).toEqual(
      previous.steps.map((step) => step.acceptance ?? undefined),
    )
    expect(replan).toContain("for every new step, omit step_id")
    expect(replanRetry.active_step_id).toBeUndefined()
  })

  test("omits nullable hidden identity fields from a schema-valid replan correction", () => {
    const authority = {
      ...previous,
      steps: [{ ...previous.steps[0]!, acceptance: null, assigned_agent: null }],
    }
    const params = decode({
      operation: "replan",
      expected_plan_id: authority.plan_id,
      expected_version: ref.version,
      replan_reason: "correct the plan",
      goal: authority.goal,
      steps: [{ step_id: "unknown", title: "new", status: "active" }],
    })
    const output = renderModelPlanCorrection(params, "unsafe_step_identity", authority, {
      id: ref.doc_id,
      version: ref.version,
    })
    const retry = decode(JSON.parse(output.slice(output.indexOf("{"))))

    expect(retry.steps).toEqual([
      {
        step_id: authority.steps[0]!.step_id,
        title: authority.steps[0]!.title,
        status: authority.steps[0]!.status,
      },
    ])
  })

  test("returns allocated IDs in a schema-valid success payload", () => {
    const params = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: "ship the provider migration",
      steps: [
        { title: "Inspect the provider boundary", status: "done" },
        { title: "Implement the server-side merge", status: "active" },
      ],
    })
    const created = buildPlanFromWriteInput(
      previous.session_id,
      normalizeModelPlanWrite(params, null, null),
      null,
      null,
    )
    const output = renderModelPlanSuccess(created, 1)
    const retry = decode(JSON.parse(output.slice(output.lastIndexOf("\n{") + 1)))

    expect(retry.operation).toBe("advance")
    expect(retry.expected_plan_id).toBe(created.plan_id)
    expect(retry.expected_version).toBe(1)
    expect(retry.active_step_id).toBe(created.active_step_id)
    expect(retry.steps.map((step) => step.step_id)).toEqual(created.steps.map((step) => step.step_id))
  })
})
