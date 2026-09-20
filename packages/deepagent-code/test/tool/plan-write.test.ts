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

  // F-7 regression (GLM 5.x): the tolerant schema decodes "null"/stringified numbers, and the
  // normalization layer converts them — but the built payload must carry the CONVERTED values,
  // not the raw ones. The raw leak made the model's protocol-correct self-correction
  // (expected_version "0" → "null") still fail create's requirePlanWriteExpected(null-only)
  // precondition, burning the whole two-attempt budget (wazero c2-fullon-seed1).
  test("threads GLM-stringified nulls through the built payload, not just the schema", () => {
    const params = decode({
      operation: "create",
      expected_plan_id: "null",
      expected_version: "null",
      goal: "ship the provider migration",
      steps: [{ title: "Inspect the provider boundary", status: "active" }],
    })

    const normalized = normalizeModelPlanWrite(params, null, null)
    expect(normalized.expected_version).toBeNull()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, null, null)
    expect(next.steps[0]!.status).toBe("active")
  })

  // F-10 regression (GLM smoke 2026-09-03): GLM omits semantically-meaningless fields — a create
  // with ONLY goal+steps is legal, absent expected_* reads as null, and must not die on the
  // required-field schema rejection (that path has no correction payload and burned the budget).
  test("a create that omits expected_* entirely is a valid plan write", () => {
    const params = decode({
      goal: "ship the provider migration",
      steps: [{ title: "Inspect the provider boundary", status: "active" }],
    })

    const normalized = normalizeModelPlanWrite(params, null, null)
    expect(normalized.expected_plan_id).toBeNull()
    expect(normalized.expected_version).toBeNull()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, null, null)
    expect(next.steps).toHaveLength(1)
  })

  test("a stringified advance version is coerced before the authority CAS precondition", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: "2",
      active_step_id: "null",
      steps: previous.steps.map((step) => ({ step_id: step.step_id, status: step.status })),
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect(normalized.expected_version).toBe(ref.version)
    // F-12: the pointer is advisory — a "null" string drops out and the controller derives
    // the still-active step from statuses
    expect("active_step_id" in normalized).toBeFalse()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, previous, ref)
    expect(next.active_step_id).toBe(previous.active_step_id)
  })

  // F-9 regression (wazero smoke 2026-09-03): "omit to retain" resurrected the previous active
  // pointer when the advance marked the LAST step done, so invalid_active_step burned the whole
  // two-attempt budget and a completed plan could never be closed. All-done now lands as a legal
  // terminal state: active_step_id null.
  test("an advance that completes every step closes the plan with a null active pointer", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      steps: previous.steps.map((step, index) => ({
        step_id: step.step_id,
        status: index === 0 ? "done" : "done",
      })),
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    // the pointer key is ABSENT on omit — the controller derives the terminal null from statuses
    expect("active_step_id" in normalized).toBeFalse()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, previous, ref)
    expect(next.steps.every((step) => step.status === "done")).toBeTrue()
    expect(next.active_step_id).toBeNull()
  })

  // F-11 regression (GLM smoke 2026-09-03): an advance whose operation field is omitted but whose
  // payload is unambiguous (expected precondition + known step IDs) must infer advance, and the
  // step hand-off (A done, B active, pointer omitted) must derive B — the old retain rule kept A
  // and died invalid_active_step.
  test("an operation-less advance with a precondition is inferred and hands off the active step", () => {
    const params = decode({
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      steps: [
        { step_id: previous.steps[0]!.step_id, status: "done" },
        { step_id: previous.steps[1]!.step_id, status: "active" },
      ],
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect(normalized.operation).toBe("advance")
    expect("active_step_id" in normalized).toBeFalse()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, previous, ref)
    expect(next.steps[0]!.status).toBe("done")
    expect(next.active_step_id).toBe(previous.steps[1]!.step_id)
  })

  test("ignores an incident-shaped replan's invented active ID and derives it from the statuses", () => {
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
      active_step_id: "step_invented_by_the_model",
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect("active_step_id" in normalized ? normalized.active_step_id : undefined).toBeUndefined()
    expect(normalized.steps[0]?.status).toBe("active")
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

  // Step ids are a SERVER-OWNED anchor for runtime evidence, so a model-invented one is not a
  // protocol error: the step is new, and the controller mints its id. Rejecting this ended whole
  // sessions in the full-roster sweep (a model that named a new step `step_snap_types`).
  test("treats an unknown explicit replan step ID as a NEW step instead of rejecting it", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "attempt to replace a step",
      goal: previous.goal,
      steps: [{ step_id: "model_chosen_new", title: "new step", status: "active" }],
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect(normalized.steps.map((step) => step.title)).toEqual(["new step"])
    // The invented id must NOT reach the plan: identity is recovered from content, and an unmatched
    // step is new, so the controller allocates for it.
    expect(normalized.steps[0]?.step_id).toBeUndefined()
  })

  // The evidence anchor is the whole point of step identity: a step the model resends with the SAME
  // wording is the same step and keeps its runtime proof; rewording it makes it a new step, so it
  // must NOT inherit evidence it did not earn.
  test("recovers identity by content so evidence survives, and rewording drops it", () => {
    const retained = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "keep the inspected step as it is",
      goal: previous.goal,
      steps: previous.steps.map((step) => ({
        title: step.title,
        status: step.status,
        acceptance: step.acceptance ?? undefined,
      })),
    })
    const kept = normalizeModelPlanWrite(retained, previous, ref)
    expect(kept.steps[0]?.step_id).toBe(previous.steps[0]?.step_id)

    const reworded = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "reword the first step",
      goal: previous.goal,
      steps: previous.steps.map((step, index) =>
        index === 0
          ? { title: "something else entirely", status: step.status, acceptance: step.acceptance ?? undefined }
          : { title: step.title, status: step.status, acceptance: step.acceptance ?? undefined },
      ),
    })
    const fresh = normalizeModelPlanWrite(reworded, previous, ref)
    expect(fresh.steps[0]?.step_id).toBeUndefined()
  })

  test("ignores a replan active pointer — the server derives it from the statuses", () => {
    const params = decode({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      replan_reason: "validate active identity",
      goal: previous.goal,
      steps: [{ title: previous.steps[0]!.title, status: "active" }],
      active_step_id: previous.active_step_id,
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect("active_step_id" in normalized ? normalized.active_step_id : undefined).toBeUndefined()
    expect(normalized.steps[0]?.status).toBe("active")
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
    // Accepted and DROPPED: the server owns step identity on create too.
    const created = normalizeModelPlanWrite(create, null, null)
    expect(created.steps[0]?.step_id).toBeUndefined()

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

  test("F-13: a create active pointer is ignored — null and an invented id behave the same", () => {
    const nullPointer = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      steps: [{ title: "create step", status: "pending" }],
      active_step_id: null,
    })
    expect(() => normalizeModelPlanWrite(nullPointer, null, null)).not.toThrow()

    const realPointer = decode({
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: previous.goal,
      steps: [{ title: "create step", status: "pending" }],
      active_step_id: "step_invented",
    })
    // Server-owned: whatever pointer the model sends, it is dropped and derived from the statuses.
    const built = normalizeModelPlanWrite(realPointer, null, null)
    expect("active_step_id" in built ? built.active_step_id : undefined).toBeUndefined()
  })

  test("ignores an explicit active ID on replan", () => {
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

    // The pointer is dropped; identity itself is recovered from the content the model sent.
    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect("active_step_id" in normalized ? normalized.active_step_id : undefined).toBeUndefined()
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

    // The goal is EDITABLE now (a long-horizon task may reframe its objective)…
    expect(next.goal).toBe("finish the provider migration")
    // …while assumptions stay server-owned on advance unless the payload supplies them.
    expect(next.assumptions).toEqual(["model supplied a different assumption"])
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

  test("defaults an omitted goal to the authoritative value; an omitted active pointer derives from statuses", () => {
    const params = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      steps: [{ step_id: "s1", status: "active" }],
    })

    const normalized = normalizeModelPlanWrite(params, previous, ref)
    expect(normalized.goal).toBe(previous.goal)
    // F-11: omit no longer retains the old pointer at the tool layer — the controller derives it
    // from the built statuses, which keeps s1 active here.
    expect("active_step_id" in normalized).toBeFalse()
    const next = buildPlanFromWriteInput(previous.session_id, normalized, previous, ref)
    expect(next.active_step_id).toBe(previous.active_step_id)
  })

  test("advance tolerates duplicate ids (last write wins) and unmatched ids (not an update)", () => {
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
    // The last instruction for a step wins; nothing is rejected.
    expect(normalizeModelPlanWrite(duplicate, previous, ref).steps[0]?.status).toBe("active")

    const unknown = decode({
      operation: "advance",
      expected_plan_id: previous.plan_id,
      expected_version: ref.version,
      goal: previous.goal,
      steps: [{ step_id: "s3", status: "done" }],
      active_step_id: null,
    })
    // `advance` patches statuses of EXISTING steps, so an unmatched id changes nothing — it cannot
    // invent a step here (that is what replan is for).
    expect(normalizeModelPlanWrite(unknown, previous, ref).steps.map((step) => step.status)).toEqual(
      previous.steps.map((step) => step.status),
    )
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
    expect("active_step_id" in createRetry ? createRetry.active_step_id : undefined).toBeUndefined()
    expect(create).toContain("Do not invent a future server ID")
    expect(replanRetry.expected_plan_id).toBe(previous.plan_id)
    expect(replanRetry.expected_version).toBe(ref.version)
    expect(replanRetry.steps.map((step) => step.acceptance)).toEqual(
      previous.steps.map((step) => step.acceptance ?? undefined),
    )
    // The example payload must not show ids: the prose says they are ignored, and the model copies
    // what it is shown.
    expect(replanRetry.steps.every((step) => !("step_id" in step))).toBe(true)
    expect(replan).toContain("Do not send step_id or active_step_id")
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

    // The correction payload carries content only — never an id, nullable fields omitted.
    expect(retry.steps).toEqual([
      {
        title: authority.steps[0]!.title,
        status: authority.steps[0]!.status,
      },
    ])
    expect(retry.steps.every((step) => !("step_id" in step))).toBe(true)
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
