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
    providerTurns: turnReceipts("call_create"),
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
    providerTurns: turnReceipts("call_replan"),
  }
}

function turnReceipts(callID: string) {
  return [
    {
      receiptID: `receipt_${callID}`,
      requestOrdinal: 1,
      providerTurnSeq: 1,
      state: "settled",
      toolFinalOfferedIDs: ["plan"],
      toolDefinitionHash: "definition_hash",
      toolCallIDs: [callID],
    },
  ]
}
