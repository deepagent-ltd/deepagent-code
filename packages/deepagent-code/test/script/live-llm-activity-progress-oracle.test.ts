import { describe, expect, test } from "bun:test"
import { assertActivityProgressObservation } from "../../script/live-llm/activity-progress-oracle"

const triggerText = "Read the fixtures in order"
const steerText = "Include MARKER exactly once"

describe("activity progress live oracle", () => {
  test("accepts one trigger and steer with contiguous progress-to-final durability", () => {
    expect(() =>
      assertActivityProgressObservation({
        caseName: "activity",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        observation: observation(),
      }),
    ).not.toThrow()
  })

  test("rejects a text sibling without its durable progress marker", () => {
    const value = observation()
    Reflect.deleteProperty(value.durability.activityTextParts[1]!.data, "metadata")
    expect(() =>
      assertActivityProgressObservation({
        caseName: "missing-marker",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        observation: value,
      }),
    ).toThrow("lacked the durable progress marker")
  })

  test("rejects settled progress without one matching terminal receipt", () => {
    const value = observation()
    value.durability.legacyActivityTerminals = []
    expect(() =>
      assertActivityProgressObservation({
        caseName: "missing-terminal",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        observation: value,
      }),
    ).toThrow("lacked matching runs and terminal receipts")
  })

  test("accepts V2 activity, input, provider, and tool-effect authorities without V1 rows", () => {
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-activity",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: v2Observation(),
      }),
    ).not.toThrow()
  })

  test("rejects a V2 steer that was never promoted into the activity", () => {
    const value = v2Observation()
    value.durability.v2.activityInputs = value.durability.v2.activityInputs.slice(0, 1)
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-missing-steer",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: value,
      }),
    ).toThrow("activity inputs did not cover trigger and steer")
  })

  test("rejects a V2 tool call without its exact durable terminal effect", () => {
    const value = v2Observation()
    value.durability.v2.toolEffects = value.durability.v2.toolEffects.slice(0, 1)
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-missing-effect",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: value,
      }),
    ).toThrow("lacked a matching durable tool effect")
  })

  test("rejects a provider tool call that was omitted from observed terminal effects", () => {
    const value = v2Observation()
    value.durability.v2.providerReceipts[2]!.toolCalls.push({ id: "unobserved_call", name: "read" })
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-unobserved-tool",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: value,
      }),
    ).toThrow("tool calls did not match V2 admissions")
  })

  test("rejects a V2 provider receipt without its exact attempt binding", () => {
    const value = v2Observation()
    value.durability.v2.providerAttempts = value.durability.v2.providerAttempts.slice(0, 2)
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-missing-attempt",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: value,
      }),
    ).toThrow("provider receipt lacked its exact attempt")
  })

  test("rejects an unknown V2 provider outcome even when a tool terminal was recorded", () => {
    const value = v2Observation()
    value.durability.v2.providerReceipts[0]!.state = "indeterminate_after_crash"
    value.durability.v2.providerAttempts[0]!.state = "indeterminate_after_crash"
    expect(() =>
      assertActivityProgressObservation({
        caseName: "v2-provider-unknown",
        triggerText,
        steerText,
        marker: "MARKER",
        expectedTools: ["read", "read"],
        authority: "v2",
        observation: value,
      }),
    ).toThrow("provider receipt lacked its exact attempt or terminal state")
  })
})

function v2Observation() {
  const value = observation()
  return {
    ...value,
    newTools: [
      { id: "call_0", name: "read", status: "completed" },
      { id: "call_1", name: "read", status: "completed" },
    ],
    durability: {
      ...value.durability,
      activityAdmissions: [],
      legacyActivities: [],
      legacyActivityRuns: [],
      legacyActivityTerminals: [],
      legacyActivityAdmissions: [],
      activityProgress: [],
      requestReceipts: [],
      v2: {
        inputs: [
          { id: "user_turn", delivery: "steer", admitted_seq: 1, promoted_seq: 1 },
          { id: "user_steer", delivery: "steer", admitted_seq: 2, promoted_seq: 2 },
        ],
        activities: [
          { activity_id: "activity_1", ordinal: 0, trigger_input_id: "user_turn", state: "settled", settled_at: 4 },
        ],
        activityInputs: [
          { activity_id: "activity_1", input_id: "user_turn", ordinal: 0, admitted_seq: 1, role: "trigger" },
          { activity_id: "activity_1", input_id: "user_steer", ordinal: 1, admitted_seq: 2, role: "steer" },
        ],
        providerAttempts: [0, 1, 2].map((index) => ({
          attempt_id: `attempt_${index}`,
          activity_id: "activity_1",
          provider_turn_seq: index + 1,
          owner_token: "process:owner",
          state: "settled",
        })),
        providerReceipts: [0, 1, 2].map((index) => ({
          receipt_id: `receipt_${index}`,
          activity_id: "activity_1",
          request_ordinal: index + 1,
          provider_turn_seq: index + 1,
          provider_attempt_id: `attempt_${index}`,
          owner_token: "process:owner",
          state: "settled",
          toolCalls: index < 2 ? [{ id: `call_${index}`, name: "read" }] : [],
        })),
        toolAdmissions: [0, 1].map((index) => ({
          receipt_id: `receipt_${index}`,
          provider_attempt_id: `attempt_${index}`,
          tool_call_id: `call_${index}`,
          tool_name: "read",
        })),
        toolEffects: [0, 1].map((index) => ({
          receipt_id: `receipt_${index}`,
          provider_attempt_id: `attempt_${index}`,
          tool_call_id: `call_${index}`,
          tool_name: "read",
          state: "settled",
        })),
      },
    },
  }
}

function observation() {
  return {
    users: [{ id: "user_turn", text: triggerText }, { id: "user_steer", text: steerText }],
    steering: [
      {
        id: "user_steer",
        delivery: "steer",
        activeBeforeAdmission: true,
        pendingAfterAdmission: true,
        consumedAfterAdmission: true,
      },
    ],
    assistantTurns: 3,
    finalText: "done MARKER",
    newTools: [
      { name: "read", status: "completed" },
      { name: "read", status: "completed" },
    ],
    providerErrors: [],
    durability: {
      activityAdmissions: [
        { admission_id: "admission_turn", delivery: "turn", admitted_message_id: "user_turn" },
        { admission_id: "admission_steer", delivery: "steer", admitted_message_id: "user_steer" },
      ],
      legacyActivities: [
        {
          activity_id: "activity_1",
          owner_token: "123:owner",
          state: "settled",
          terminal_reason: "assistant_completed",
        },
      ],
      legacyActivityRuns: [
        {
          run_id: "run_1",
          activity_id: "activity_1",
          owner_token: "123:owner",
          state: "completed",
          terminal_reason: "assistant_completed",
        },
      ],
      legacyActivityTerminals: [
        {
          activity_id: "activity_1",
          state: "settled",
          reason_code: "assistant_completed",
          source: "provider_final",
          run_id: "run_1",
          progress_revision: 2,
          membership_ordinal: 1,
          owner_token: "123:owner",
        },
      ],
      legacyActivityAdmissions: [
        {
          activity_id: "activity_1",
          admission_id: "admission_turn",
          ordinal: 0,
          role: "trigger",
        },
        {
          activity_id: "activity_1",
          admission_id: "admission_steer",
          ordinal: 1,
          role: "steer",
        },
      ],
      activityProgress: [0, 1, 2].map((revision) => ({
        activity_id: "activity_1",
        revision,
        assistant_message_id: `assistant_${revision}`,
        provider_receipt_id: `receipt_${revision}`,
        input_membership_ordinal: revision === 0 ? 0 : 1,
        state: revision === 2 ? "final" : "progress",
      })),
      activityTextParts: [0, 1, 2].flatMap((revision) =>
        ["first", "second"].map((text, index) => ({
          id: `part_${revision}_${index}`,
          message_id: `assistant_${revision}`,
          data: {
            type: "text",
            text,
            metadata: {
              deepagent_activity_progress: {
                activity_id: "activity_1",
                revision,
                state: revision === 2 ? "final" : "progress",
              },
            },
          },
        })),
      ),
      requestReceipts: [0, 1, 2].map((revision) => ({
        receipt_id: `receipt_${revision}`,
        request_state: "dispatched",
      })),
    },
  }
}
