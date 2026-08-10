import { afterAll, describe, expect, mock, test } from "bun:test"
import type { Part, UserMessage } from "@deepagent-code/sdk/v2/client"

mock.module("@deepagent-code/ui/message-part", () => ({
  groupParts: () => [],
  renderable: () => false,
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
