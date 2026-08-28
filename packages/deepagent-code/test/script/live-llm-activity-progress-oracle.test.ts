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
    ).toThrow("lacked one matching run and terminal receipt")
  })
})

function observation() {
  return {
    users: [{ text: triggerText }, { text: steerText }],
    steering: [
      {
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
