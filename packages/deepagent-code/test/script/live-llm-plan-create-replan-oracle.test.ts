import { describe, expect, test } from "bun:test"
import {
  assertPlanCreateObservation,
  assertPlanReplanObservation,
} from "../../script/live-llm/plan-create-replan-oracle"

const goal = "Preserve Plan authority"
const assumptions = ["server assigns IDs", "retained identity is authoritative"]
const created = {
  plan_id: "plan_created",
  goal,
  assumptions,
  active_step_id: "step_server_1",
  steps: [
    {
      step_id: "step_server_1",
      title: "Inspect authority",
      status: "active",
      acceptance: null,
      assigned_agent: null,
      note: null,
    },
    {
      step_id: "step_server_2",
      title: "Retain identity",
      status: "pending",
      acceptance: "hidden acceptance",
      assigned_agent: "researcher",
      note: null,
    },
  ],
} as const

describe("Plan create/replan live oracle", () => {
  test("accepts server-allocated create IDs and an ID-less new replan step", () => {
    expect(() =>
      assertPlanCreateObservation({
        caseName: "create",
        observation: createObservation(),
        goal,
        assumptions,
        steps: [
          { title: "Inspect authority", status: "active" },
          { title: "Retain identity", status: "pending" },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      assertPlanReplanObservation({
        caseName: "replan",
        observation: replanObservation(),
        authority: created,
        expectedVersion: 2,
        expectedActiveTitle: "Retain identity",
        expectedReason: "add verification",
        expectedStatuses: {
          "Inspect authority": "done",
          "Retain identity": "active",
          "Verify allocation": "pending",
        },
        expectedNewTitles: ["Verify allocation"],
        expectedCalls: [{ version: 1, protocol: "success" }],
      }),
    ).not.toThrow()
  })

  test("rejects a model-supplied ID for a new replan step", () => {
    const value = replanObservation()
    Object.assign(value.newTools[0]!.input.steps[2]!, { step_id: "model_chosen" })
    expect(() =>
      assertPlanReplanObservation({
        caseName: "invented-id",
        observation: value,
        authority: created,
        expectedVersion: 2,
        expectedActiveTitle: "Retain identity",
        expectedReason: "add verification",
        expectedStatuses: {
          "Inspect authority": "done",
          "Retain identity": "active",
          "Verify allocation": "pending",
        },
        expectedNewTitles: ["Verify allocation"],
        expectedCalls: [{ version: 1, protocol: "success" }],
      }),
    ).toThrow("supplied an ID for new step")
  })
})

function createObservation() {
  return {
    newTools: [
      {
        messageID: "assistant_create",
        id: "call_create",
        name: "plan",
        status: "completed",
        input: {
          operation: "create",
          expected_plan_id: null,
          expected_version: null,
          goal,
          assumptions,
          steps: [
            { title: "Inspect authority", status: "active" },
            { title: "Retain identity", status: "pending" },
          ],
        },
        metadata: { plan_protocol: "success" },
      },
    ],
    plan: { document: created, ref: { id: "doc_create", version: 1 } },
    durability: receipts("assistant_create", "call_create", "semantic_valid"),
  }
}

function replanObservation() {
  return {
    newTools: [
      {
        messageID: "assistant_replan",
        id: "call_replan",
        name: "plan",
        status: "completed",
        input: {
          operation: "replan",
          expected_plan_id: created.plan_id,
          expected_version: 1,
          replan_reason: "add verification",
          goal,
          steps: [
            { step_id: "step_server_1", status: "done" },
            { step_id: "step_server_2", status: "active" },
            { title: "Verify allocation", status: "pending" },
          ],
        },
        metadata: { plan_protocol: "success" },
      },
    ],
    plan: {
      document: {
        ...created,
        active_step_id: "step_server_2",
        steps: [
          { ...created.steps[0], status: "done" },
          { ...created.steps[1], status: "active" },
          {
            step_id: "step_server_3",
            title: "Verify allocation",
            status: "pending",
            acceptance: null,
            assigned_agent: null,
            note: null,
          },
        ],
      },
      ref: { id: "doc_replan", version: 2 },
    },
    durability: receipts("assistant_replan", "call_replan", "semantic_valid"),
  }
}

function receipts(messageID: string, callID: string, validationOutcome: string) {
  return {
    requestReceipts: [
      {
        receipt_id: `receipt_${callID}`,
        assistant_message_id: messageID,
        request_state: "dispatched",
        final_offered_tool_ids: ["plan"],
        call_ids: [callID],
        tool_definition_hash: "definition_hash",
      },
    ],
    argumentReceipts: [
      receipt("ai_sdk_input", "schema_valid", "payload_hash", callID),
      receipt("adapter_assembly", "schema_valid", "payload_hash", callID),
      receipt("processor_decoded", validationOutcome, "payload_hash", callID),
      receipt("raw_frame", "not_evaluated", null, callID),
    ],
  }
}

function receipt(layer: string, validationOutcome: string, payloadHash: string | null, callID: string) {
  return {
    receipt_id: `receipt_${callID}`,
    layer,
    call_id: layer === "raw_frame" ? null : callID,
    tool_name: layer === "raw_frame" ? null : "plan",
    event_type: layer === "adapter_assembly" ? "tool-call" : layer,
    payload_hash: payloadHash,
    payload_length: payloadHash ? 120 : null,
    payload_keys: payloadHash ? ["expected_plan_id", "expected_version", "operation", "steps"] : [],
    unavailable_reason: payloadHash ? null : "provider_transport_did_not_expose_raw_frame",
    validation_outcome: validationOutcome,
  }
}
