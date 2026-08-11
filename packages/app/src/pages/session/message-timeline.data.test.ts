import { afterAll, describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@deepagent-code/sdk/v2/client"

mock.module("@deepagent-code/ui/message-part", () => ({
  groupParts: (refs: { messageID: string; part: Part }[]) =>
    refs.map((item) => ({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: { messageID: item.messageID, partID: item.part.id },
    })),
  renderable: () => true,
}))

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

  test("collapses one activity across separate parent user rows", async () => {
    const { Timeline } = await import("./message-timeline.data")
    const user2 = { ...user, id: "msg_user_2" }
    const firstAssistant = assistant("msg_cross_a0")
    const secondAssistant = { ...assistant("msg_cross_a1"), parentID: user2.id }
    const messages = [firstAssistant, secondAssistant]
    const parts = new Map([
      [firstAssistant.id, [progress(firstAssistant.id, 0, "progress")]],
      [secondAssistant.id, [progress(secondAssistant.id, 1, "progress")]],
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
    ).toEqual(["prt_progress_1"])
  })
})
