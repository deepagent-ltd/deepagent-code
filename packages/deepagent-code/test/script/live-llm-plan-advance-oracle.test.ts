import { describe, expect, test } from "bun:test"
import { assertPlanAdvanceObservation } from "../../script/live-llm/plan-advance-oracle"

const immutable = {
  plan_id: "plan_contract",
  goal: "Preserve Plan authority",
  assumptions: ["server owns identity"],
  active_step_id: "step_1",
  steps: [
    {
      step_id: "step_1",
      title: "First boundary",
      status: "active",
      acceptance: "first accepted",
      assigned_agent: "primary",
      note: null,
    },
    {
      step_id: "step_2",
      title: "Second boundary",
      status: "pending",
      acceptance: "second accepted",
      assigned_agent: "primary",
      note: null,
    },
  ],
} as const

describe("Plan advance live oracle", () => {
  test("accepts a minimal status patch with a complete receipt chain", () => {
    expect(() =>
      assertPlanAdvanceObservation({
        caseName: "success",
        observation: observation(),
        immutable,
        expectedVersion: 2,
        expectedActiveStepID: "step_2",
        expectedStatuses: { step_1: "done", step_2: "active" },
        expectedNotes: { step_1: null, step_2: null },
        expectedCalls: [
          {
            version: 1,
            protocol: "success",
            activeStepID: "step_2",
            statuses: { step_1: "done", step_2: "active" },
          },
        ],
      }),
    ).not.toThrow()
  })

  test("rejects model restatement of server-owned step identity", () => {
    const value = observation()
    Object.assign(value.newTools[0]!.input.steps[0]!, { title: "model replacement" })
    expect(() =>
      assertPlanAdvanceObservation({
        caseName: "identity-restatement",
        observation: value,
        immutable,
        expectedVersion: 2,
        expectedActiveStepID: "step_2",
        expectedStatuses: { step_1: "done", step_2: "active" },
        expectedCalls: [
          {
            version: 1,
            protocol: "success",
            activeStepID: "step_2",
            statuses: { step_1: "done", step_2: "active" },
          },
        ],
      }),
    ).toThrow("non-patch step field title")
  })

  test("rejects when no settled provider-turn receipt offers the plan tool", () => {
    const value = observation()
    value.providerTurns = [value.providerTurns![0]!, { ...value.providerTurns![0]!, state: "failed" }]
    value.providerTurns[0]!.state = "dispatching"
    expect(() =>
      assertPlanAdvanceObservation({
        caseName: "weak-receipt",
        observation: value,
        immutable,
        expectedVersion: 2,
        expectedActiveStepID: "step_2",
        expectedStatuses: { step_1: "done", step_2: "active" },
        expectedCalls: [
          {
            version: 1,
            protocol: "success",
            activeStepID: "step_2",
            statuses: { step_1: "done", step_2: "active" },
          },
        ],
      }),
    ).toThrow("settled provider-turn receipt for plan call call_1 was incomplete")
  })

  test("rejects a settled plan receipt from another call", () => {
    const value = observation()
    value.providerTurns![0]!.toolCallIDs = ["call_from_previous_case"]
    expect(() =>
      assertPlanAdvanceObservation({
        caseName: "wrong-call-receipt",
        observation: value,
        immutable,
        expectedVersion: 2,
        expectedActiveStepID: "step_2",
        expectedStatuses: { step_1: "done", step_2: "active" },
        expectedCalls: [
          {
            version: 1,
            protocol: "success",
            activeStepID: "step_2",
            statuses: { step_1: "done", step_2: "active" },
          },
        ],
      }),
    ).toThrow("settled provider-turn receipt for plan call call_1 was incomplete")
  })
})

function observation() {
  return {
    newTools: [
      {
        messageID: "assistant_1",
        id: "call_1",
        name: "plan",
        status: "completed",
        input: {
          operation: "advance",
          expected_plan_id: immutable.plan_id,
          expected_version: 1,
          active_step_id: "step_2",
          steps: [
            { step_id: "step_1", status: "done" },
            { step_id: "step_2", status: "active" },
          ],
        },
        metadata: { plan_protocol: "success" },
      },
    ],
    plan: {
      document: {
        ...immutable,
        active_step_id: "step_2",
        steps: immutable.steps.map((step) => ({
          ...step,
          status: step.step_id === "step_1" ? "done" : "active",
        })),
      },
      ref: { id: "doc_1", version: 2 },
    },
    providerTurns: [
      {
        receiptID: "receipt_1",
        requestOrdinal: 1,
        providerTurnSeq: 1,
        state: "settled",
        toolFinalOfferedIDs: ["plan"],
        toolDefinitionHash: "definition_hash",
        toolCallIDs: ["call_1"],
      },
    ],
  }
}
