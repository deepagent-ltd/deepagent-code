import { afterAll, describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@deepagent-code/sdk/client"
import { mockMessagePart } from "./message-part-mock"

mockMessagePart()

afterAll(() => mock.restore())

describe("message timeline compaction", () => {
  test("renders a compaction divider for a manual compact marker", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const message = {
      id: "msg_compact",
      sessionID: "ses_1",
      role: "user",
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      time: { created: 1 },
    } as UserMessage
    const part = {
      id: "prt_compact",
      sessionID: message.sessionID,
      messageID: message.id,
      type: "compaction",
      auto: false,
      context_tokens: 4_000,
    } as Part

    const rows = Timeline.constructMessageRows(message, () => [part], [], 1, false, "idle", false)

    expect(rows).toContainEqual(
      expect.objectContaining({
        _tag: "TurnDivider",
        userMessageID: message.id,
        label: "compaction",
      }),
    )
  })

  test("keeps a legacy diff artifact as metadata without materializing an inline patch", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const message = {
      id: "msg_diff_artifact",
      sessionID: "ses_1",
      role: "user",
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      time: { created: 1 },
      summary: {
        diffs: [],
        diffArtifact: {
          id: "evtart_legacy",
          hash: "a".repeat(64),
          codec: "legacy-message-diff.v2",
          fileCount: 4_500,
          previewFileCount: 0,
          previewTruncated: true,
        },
      },
    } as UserMessage

    const rows = Timeline.constructMessageRows(message, () => [], [], 0, false, "idle", false)
    const diff = rows.find((row) => row._tag === "DiffSummary")

    expect(diff).toEqual(
      expect.objectContaining({
        _tag: "DiffSummary",
        userMessageID: message.id,
        diffs: [],
        artifact: message.summary?.diffArtifact,
      }),
    )
    expect(JSON.stringify(rows)).not.toContain('"patch"')
  })
})

describe("message timeline activity progress", () => {
  const user = {
    id: "msg_user",
    sessionID: "ses_1",
    role: "user",
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-chat" },
    time: { created: 1 },
  } as UserMessage
  const assistant = (id: string) =>
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
    }) as AssistantMessage
  const progress = (messageID: string, revision: number, state: "progress" | "final") =>
    ({
      id: `prt_${state}_${revision}`,
      sessionID: user.sessionID,
      messageID,
      type: "text",
      text: `revision ${revision}`,
      metadata: {
        deepagent_activity_progress: {
          activity_id: "activity-1",
          revision,
          state,
        },
      },
    }) as Part

  test("shows only the latest settled progress for one activity", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const messages = [assistant("msg_a0"), assistant("msg_a1")]
    const parts = new Map([
      [messages[0].id, [progress(messages[0].id, 0, "progress")]],
      [messages[1].id, [progress(messages[1].id, 1, "progress")]],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], messages, 0, false, "idle", false)
    expect(
      rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [])),
    ).toEqual(["prt_progress_1"])
  })

  test("replaces settled progress with the activity final", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const messages = [assistant("msg_a0"), assistant("msg_a1"), { ...assistant("msg_a2"), finish: "stop" }]
    const parts = new Map([
      [messages[0].id, [progress(messages[0].id, 0, "progress")]],
      [messages[1].id, [progress(messages[1].id, 1, "progress")]],
      [messages[2].id, [progress(messages[2].id, 2, "final")]],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], messages, 0, false, "idle", false)
    expect(
      rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [])),
    ).toEqual(["prt_final_2"])
  })

  test("collapses every text part in one activity across separate parent user rows", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const user2 = { ...user, id: "msg_user_2" }
    const firstAssistant = assistant("msg_cross_a0")
    const secondAssistant = { ...assistant("msg_cross_a1"), parentID: user2.id }
    const plain = (messageID: string, id: string, text: string) =>
      ({ id, sessionID: user.sessionID, messageID, type: "text", text }) as Part
    const messages = [firstAssistant, secondAssistant]
    const parts = new Map([
      [
        firstAssistant.id,
        [progress(firstAssistant.id, 0, "progress"), plain(firstAssistant.id, "prt_cross_old_plain", "old detail")],
      ],
      [
        secondAssistant.id,
        [
          progress(secondAssistant.id, 1, "progress"),
          plain(secondAssistant.id, "prt_cross_latest_plain", "latest detail"),
        ],
      ],
    ])
    const getParts = (id: string) => parts.get(id) ?? []
    const visibility = Timeline.activityProgressVisibility(messages, getParts)
    const firstRows = Timeline.constructMessageRows(
      user,
      getParts,
      [firstAssistant],
      0,
      false,
      "idle",
      false,
      visibility,
    )
    const secondRows = Timeline.constructMessageRows(
      user2,
      getParts,
      [secondAssistant],
      1,
      false,
      "idle",
      false,
      visibility,
    )
    expect(firstRows.some((row) => row._tag === "AssistantPart")).toBe(false)
    expect(
      secondRows.flatMap((row) =>
        row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [],
      ),
    ).toEqual(["prt_progress_1", "prt_cross_latest_plain"])
  })

  test("applies one revision marker to every text part in the assistant message", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const messages = [assistant("msg_multi_a0"), { ...assistant("msg_multi_a1"), finish: "stop" }]
    const plain = (messageID: string, id: string, text: string) =>
      ({ id, sessionID: user.sessionID, messageID, type: "text", text }) as Part
    const parts = new Map([
      [messages[0].id, [progress(messages[0].id, 0, "progress"), plain(messages[0].id, "prt_old_plain", "old detail")]],
      [
        messages[1].id,
        [progress(messages[1].id, 1, "final"), plain(messages[1].id, "prt_final_plain", "final detail")],
      ],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], messages, 0, false, "idle", false)

    expect(
      rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [])),
    ).toEqual(["prt_final_1", "prt_final_plain"])
  })

  test("uses the message marker to collapse reasoning-only revisions", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const messages = [
      {
        ...assistant("msg_reasoning_a0"),
        activityProgress: { activityID: "activity-reasoning", revision: 0, state: "progress" as const },
      },
      {
        ...assistant("msg_reasoning_a1"),
        activityProgress: { activityID: "activity-reasoning", revision: 1, state: "progress" as const },
      },
    ]
    const reasoning = (messageID: string, id: string) =>
      ({ id, sessionID: user.sessionID, messageID, type: "reasoning", text: id }) as Part
    const parts = new Map([
      [messages[0].id, [reasoning(messages[0].id, "prt_reasoning_old")]],
      [messages[1].id, [reasoning(messages[1].id, "prt_reasoning_latest")]],
    ])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], messages, 0, true, "idle", false)

    expect(
      rows.flatMap((row) => (row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [])),
    ).toEqual(["prt_reasoning_latest"])
  })

  test("keeps an older tool revision visible when the latest terminal message has no renderable parts", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const old = {
      ...assistant("msg_tool_old"),
      activityProgress: { activityID: "activity-tool", revision: 0, state: "progress" as const },
    }
    const terminal = {
      ...assistant("msg_tool_terminal"),
      activityProgress: { activityID: "activity-tool", revision: 1, state: "final" as const },
    }
    const tool = {
      id: "prt_tool_old",
      sessionID: user.sessionID,
      messageID: old.id,
      type: "tool",
      callID: "call-old",
      tool: "bash",
      state: { status: "completed", input: {}, output: "pending", title: "poll", time: { start: 1, end: 2 } },
    } as Part
    const parts = new Map([[old.id, [tool]]])
    const visibility = Timeline.activityProgressVisibility([old, terminal], (id) => parts.get(id) ?? [])

    const rows = Timeline.constructMessageRows(user, (id) => parts.get(id) ?? [], [old], 0, true, "idle", false, visibility)

    // Tool parts are one-shot evidence of the calls made, not revisioned streaming output:
    // the activity progress projection per-activity convergence applies to text/reasoning only, so an older
    // revision's tool call stays visible even when the terminal revision carries no parts.
    expect(rows.some((row) => row._tag === "AssistantPart")).toBe(true)
  })
})
