/**
 * activity progress projection — spec §7.2 App projection deterministic regression tests (scenarios 18-29,
 * timeline-layer subset: 18, 19, 26, 27, 28, 29).
 *
 * Harness/fixture style mirrors ./message-timeline.data.test.ts (same `@deepagent-code/ui/message-part`
 * mock, same `Timeline.constructMessageRows` invocation shape).
 *
 * Fix-E (spec §5 Fix-E — per-Activity latest-revision convergence) is RESTORED here: commit
 * 1ae96499 ("fix(app): preserve activity progress history") had removed it, but the adjudicated
 * decision is to converge to the latest revision (hide superseded older revisions). These tests
 * assert the spec-compliant convergence behavior.
 */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@deepagent-code/sdk/client"
import type { TimelineRow } from "./message-timeline.data"

mock.module("@deepagent-code/ui/message-part", () => ({
  groupParts: (refs: { messageID: string; part: Part }[]) =>
    refs.map((item) => ({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: { messageID: item.messageID, partID: item.part.id },
    })),
  renderable: (part: Part, showReasoningSummaries = true) =>
    part.type !== "reasoning" || showReasoningSummaries,
}))

afterAll(() => mock.restore())

// ---------------------------------------------------------------------------
// Precise incident fixture (docs/activity-progress-projection.md §2.1/§2.2):
//   activity  a6d06b2a...c5e5a9
//   revision 8  msg_ff200fab7001lSTuDLJcykJfn6  reasoning prt_ff2010818001nSfs68M6HUBq2E
//               + tool call tool_sd47zQa3WQeOSa1BKPhv6mF1 (bash, ordinal 548)
//   revision 9  msg_ff2015000001RBapgqkQdqoqQI  reasoning prt_ff2015c8e00132UPp8LegJCQQ0
//               + tool call tool_ZSTCdihDT0jY74tJVeAZLZ45 (bash, ordinal 549)
//   revision 10 msg_ff2019410001interrupted      zero renderable parts, state=interrupted
// Both reasoning texts are 1,668 chars and byte-identical (SHA-256 5bc40233...d37b).
// ---------------------------------------------------------------------------

const INCIDENT_ACTIVITY = "a6d06b2a82ef234ab9dc71e3fd940292a21b34f4732f28aa19ba8416c4c5e5a9"
// Representative verbatim-identical reasoning body (real incident text is 1,668 chars).
const INCIDENT_REASONING = `Check the stress log tail and whether w70_stress is still running. ${"user0/user1/user3 FINAL observed; user2 FINAL still missing. ".repeat(20)}`.trim()

const user = {
  id: "msg_user_incident",
  sessionID: "ses_00000000000000000000000000",
  role: "user",
  agent: "build",
  model: { providerID: "deepseek", modelID: "deepseek-chat" },
  time: { created: 1 },
} as UserMessage

const assistant = (id: string, activityProgress?: AssistantMessage["activityProgress"]) =>
  ({
    id,
    sessionID: user.sessionID,
    parentID: user.id,
    role: "assistant",
    mode: "build",
    agent: "build",
    modelID: "deepseek-chat",
    providerID: "deepseek",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
    finish: "tool-calls",
    activityProgress,
  }) as AssistantMessage

const reasoningPart = (messageID: string, id: string, text: string) =>
  ({ id, sessionID: user.sessionID, messageID, type: "reasoning", text }) as Part

const toolPart = (messageID: string, id: string, callID: string, command: string) =>
  ({
    id,
    sessionID: user.sessionID,
    messageID,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "completed",
      input: { command },
      output: command,
      title: command,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as Part

const legacyMarkerPart = (
  messageID: string,
  id: string,
  text: string,
  marker: { activity_id: string; revision: number; state: string },
) =>
  ({
    id,
    sessionID: user.sessionID,
    messageID,
    type: "text",
    text,
    metadata: { deepagent_activity_progress: marker },
  }) as Part

const partIDs = (rows: TimelineRow.TimelineRow[]): string[] =>
  rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : []))

describe("activity progress projection §7.2 App projection — incident fixture (timeline layer)", () => {
  test("18: precise incident fixture — revision 8/9 reasoning+tool with identical reasoning", async () => {
    const { Timeline } = await import("./message-timeline.data")
    // Spec §7.2 (18): with Fix-E restored, the App shows ONLY the latest revision's (9) renderable
    // parts; the superseded revision 8 (identical reasoning + earlier tool) is hidden.
    const msg8 = assistant("msg_ff200fab7001lSTuDLJcykJfn6", {
      activityID: INCIDENT_ACTIVITY,
      revision: 8,
      state: "progress",
    })
    const msg9 = assistant("msg_ff2015000001RBapgqkQdqoqQI", {
      activityID: INCIDENT_ACTIVITY,
      revision: 9,
      state: "progress",
    })
    const parts = new Map<string, Part[]>([
      [
        msg8.id,
        [
          reasoningPart(msg8.id, "prt_ff2010818001nSfs68M6HUBq2E", INCIDENT_REASONING),
          toolPart(msg8.id, "prt_tool_rev8", "tool_sd47zQa3WQeOSa1BKPhv6mF1", "tail stress.log; pgrep w70_stress"),
        ],
      ],
      [
        msg9.id,
        [
          // Verbatim-identical reasoning text (SHA-256 match in the real incident).
          reasoningPart(msg9.id, "prt_ff2015c8e00132UPp8LegJCQQ0", INCIDENT_REASONING),
          toolPart(msg9.id, "prt_tool_rev9", "tool_ZSTCdihDT0jY74tJVeAZLZ45", "tail stress.log; wait user2 FINAL"),
        ],
      ],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], [msg8, msg9], 0, true, "idle", false)
    const visible = partIDs(rows)

    // Text/reasoning converge to the latest revision (9); superseded revision 8's reasoning
    // is hidden. Tool parts are ONE-SHOT call evidence (distinct call IDs here) and are NOT
    // revision convergence subjects — both tool calls stay visible regardless of revision.
    expect(visible).toContain("prt_ff2015c8e00132UPp8LegJCQQ0")
    expect(visible).toContain("prt_tool_rev9")
    expect(visible).toContain("prt_tool_rev8")
    expect(visible).not.toContain("prt_ff2010818001nSfs68M6HUBq2E")
  })

  test("19: terminal revision 10 has zero parts and state=interrupted", async () => {
    const { Timeline } = await import("./message-timeline.data")
    // Spec §7.2 (19): with Fix-E restored, once the zero-part terminal revision 10 (interrupted)
    // arrives, it supersedes revisions 8/9 (terminal beats non-terminal), so 8/9 are fully hidden;
    // the zero-part terminal contributes no part rows of its own. The interrupted TurnDivider
    // contract stays driven by MessageAbortedError (existing UI preserved).
    const msg8 = assistant("msg_ff200fab7001lSTuDLJcykJfn6", {
      activityID: INCIDENT_ACTIVITY,
      revision: 8,
      state: "progress",
    })
    const msg9 = assistant("msg_ff2015000001RBapgqkQdqoqQI", {
      activityID: INCIDENT_ACTIVITY,
      revision: 9,
      state: "progress",
    })
    const msg10 = assistant("msg_ff2019410001interrupted", {
      activityID: INCIDENT_ACTIVITY,
      revision: 10,
      state: "interrupted",
      terminalReason: "user_abort",
    })
    const parts = new Map<string, Part[]>([
      [
        msg8.id,
        [
          reasoningPart(msg8.id, "prt_ff2010818001nSfs68M6HUBq2E", INCIDENT_REASONING),
          toolPart(msg8.id, "prt_tool_rev8", "tool_sd47zQa3WQeOSa1BKPhv6mF1", "tail stress.log"),
        ],
      ],
      [
        msg9.id,
        [
          reasoningPart(msg9.id, "prt_ff2015c8e00132UPp8LegJCQQ0", INCIDENT_REASONING),
          toolPart(msg9.id, "prt_tool_rev9", "tool_ZSTCdihDT0jY74tJVeAZLZ45", "tail stress.log again"),
        ],
      ],
      // revision 10: zero parts on purpose (provider-backed interrupted row).
      [msg10.id, []],
    ])

    const rows = Timeline.constructMessageRows(
      user,
      (id) => parts.get(id) ?? [],
      [msg8, msg9, msg10],
      0,
      true,
      "idle",
      false,
    )
    const visible = partIDs(rows)

    // Revision 8/9 text/reasoning are hidden once the terminal revision 10 arrives; the tool
    // parts remain as one-shot call evidence (they are not revision convergence subjects).
    expect(visible).toEqual(["prt_tool_rev8", "prt_tool_rev9"])
    // The zero-part terminal message contributes no part rows ...
    expect(rows.some((row) => row._tag === "AssistantPart" && row.group.key.includes(msg10.id))).toBe(false)
    // ... and (without a MessageAbortedError) no extra "interrupted" divider is synthesized:
    // the existing interrupted UI contract is driven solely by MessageAbortedError.
    expect(rows.filter((row) => row._tag === "TurnDivider" && row.label === "interrupted")).toEqual([])
  })

  test("26: a message with multiple reasoning/text/tool parts is shown or hidden as a whole group", async () => {
    const { Timeline } = await import("./message-timeline.data")
    // DEV-407008-E3: spec §7.2 (26) requires whole-group show/hide and forbids hiding only the
    // part whose text matches a marker. Fix-E removal means NOTHING is hidden today, which
    // trivially satisfies "no partial hiding": every part of the group is rendered together.
    const message = assistant("msg_group", {
      activityID: "activity-group",
      revision: 3,
      state: "progress",
    })
    const parts = new Map<string, Part[]>([
      [
        message.id,
        [
          reasoningPart(message.id, "prt_group_reasoning", INCIDENT_REASONING),
          legacyMarkerPart(message.id, "prt_group_marker", `revision 3`, {
            activity_id: "activity-group",
            revision: 3,
            state: "progress",
          }),
          {
            id: "prt_group_text",
            sessionID: user.sessionID,
            messageID: message.id,
            type: "text",
            text: INCIDENT_REASONING, // same body as the reasoning part — must NOT be singled out
          } as Part,
          toolPart(message.id, "prt_group_tool", "call_group", "ls -la"),
        ],
      ],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], [message], 0, true, "idle", false)
    const visible = partIDs(rows)

    // Whole-group visibility: all four parts render; no part is individually hidden.
    expect(visible).toEqual(["prt_group_reasoning", "prt_group_marker", "prt_group_text", "prt_group_tool"])
  })

  test("27: identical reasoning text in two different Activities shows in both (no cross-activity dedup)", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const first = assistant("msg_activity_a", { activityID: "activity-A", revision: 0, state: "progress" })
    const second = assistant("msg_activity_b", { activityID: "activity-B", revision: 0, state: "progress" })
    const parts = new Map<string, Part[]>([
      [first.id, [reasoningPart(first.id, "prt_reasoning_A", INCIDENT_REASONING)]],
      // Byte-identical reasoning text in a DIFFERENT activity.
      [second.id, [reasoningPart(second.id, "prt_reasoning_B", INCIDENT_REASONING)]],
    ])

    const rows = Timeline.constructMessageRows(
      user,
      (id) => parts.get(id) ?? [],
      [first, second],
      0,
      true,
      "idle",
      false,
    )
    const visible = partIDs(rows)

    // Both activities keep their reasoning — content-hash dedup across activities never happens.
    expect(visible).toEqual(["prt_reasoning_A", "prt_reasoning_B"])
  })

  test("28: legacy server with text-metadata markers only (no computed projection)", async () => {
    const { Timeline } = await import("./message-timeline.data")
    // Spec §7.2 (28): with Fix-E restored, legacy text-metadata markers (no computed
    // `activityProgress` on messages) still converge per the old rules — the latest revision wins.
    const first = assistant("msg_legacy_0")
    const second = assistant("msg_legacy_1")
    const parts = new Map<string, Part[]>([
      [
        first.id,
        [
          legacyMarkerPart(first.id, "prt_legacy_marker_0", "revision 0", {
            activity_id: "activity-legacy",
            revision: 0,
            state: "progress",
          }),
        ],
      ],
      [
        second.id,
        [
          legacyMarkerPart(second.id, "prt_legacy_marker_1", "revision 1", {
            activity_id: "activity-legacy",
            revision: 1,
            state: "progress",
          }),
        ],
      ],
    ])

    const rows = Timeline.constructMessageRows(
      user,
      (id) => parts.get(id) ?? [],
      [first, second],
      0,
      false,
      "idle",
      false,
    )
    const visible = partIDs(rows)

    // Legacy markers converge: the latest revision (1) is shown, the superseded revision (0) hidden.
    expect(visible).toEqual(["prt_legacy_marker_1"])
  })

  test("29: message projection vs legacy marker conflict — projection source wins; diagnostic status", async () => {
    const { Timeline } = await import("./message-timeline.data")
    // Spec §7.2 (29): with Fix-E restored, the message-owned projection wins over a conflicting
    // legacy text marker, and a projection-conflict diagnostic is emitted (console.error).
    const errorSpy = spyOn(console, "error")
    try {
      const message = assistant("msg_conflict", {
        activityID: "activity-conflict",
        revision: 9, // message-owned projection says revision 9
        state: "progress",
      })
      const parts = new Map<string, Part[]>([
        [
          message.id,
          [
            // Legacy marker disagrees: same activity but revision 8.
            legacyMarkerPart(message.id, "prt_conflict_marker", "revision 8", {
              activity_id: "activity-conflict",
              revision: 8,
              state: "progress",
            }),
            reasoningPart(message.id, "prt_conflict_reasoning", INCIDENT_REASONING),
          ],
        ],
      ])

      const rows = Timeline.constructMessageRows(
        user,
        (id) => parts.get(id) ?? [],
        [message],
        0,
        true,
        "idle",
        false,
      )
      const visible = partIDs(rows)

      // The owning message's parts are rendered (projection-bearing message is not dropped).
      expect(visible).toEqual(["prt_conflict_marker", "prt_conflict_reasoning"])
      // The projection-vs-legacy-marker conflict is diagnosed at the timeline layer.
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
