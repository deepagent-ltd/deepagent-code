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

  test("rejects receipt chains that do not prove semantic admission", () => {
    const value = observation()
    value.durability.argumentReceipts.find((receipt) => receipt.layer === "processor_decoded")!.validation_outcome =
      "schema_valid"
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
    ).toThrow("argument receipt chain was incomplete")
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
    durability: {
      requestReceipts: [
        {
          receipt_id: "receipt_1",
          assistant_message_id: "assistant_1",
          request_state: "dispatched",
          final_offered_tool_ids: ["plan"],
          call_ids: ["call_1"],
          tool_definition_hash: "definition_hash",
        },
      ],
      argumentReceipts: [
        receipt("ai_sdk_input", "schema_valid", "payload_hash"),
        receipt("adapter_assembly", "schema_valid", "payload_hash"),
        receipt("processor_decoded", "semantic_valid", "payload_hash"),
        receipt("raw_frame", "not_evaluated", null),
      ],
    },
  }
}

function receipt(layer: string, validationOutcome: string, payloadHash: string | null) {
  return {
    receipt_id: "receipt_1",
    layer,
    call_id: layer === "raw_frame" ? null : "call_1",
    tool_name: layer === "raw_frame" ? null : "plan",
    event_type: layer === "adapter_assembly" ? "tool-call" : layer,
    payload_hash: payloadHash,
    payload_length: payloadHash ? 120 : null,
    payload_keys: payloadHash ? ["active_step_id", "expected_plan_id", "expected_version", "operation", "steps"] : [],
    unavailable_reason: payloadHash ? null : "provider_transport_did_not_expose_raw_frame",
    validation_outcome: validationOutcome,
  }
}
