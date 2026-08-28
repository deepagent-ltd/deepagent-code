import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@deepagent-code/sdk/v2/client"
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage } from "./sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticAdd replaces an existing placeholder with the same client ID", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }
    const replacement = { ...userMessage("msg_1", sessionID), time: { created: 2 } }

    applyOptimisticAdd(draft, {
      sessionID,
      message: replacement,
      parts: [textPart("prt_1", sessionID, replacement.id)],
    })

    expect(draft.message[sessionID]).toEqual([replacement])
    expect(draft.part.msg_1?.map((part) => part.id)).toEqual(["prt_1"])
  })

  test("applyOptimisticAdd does not restore a placeholder after its canonical steer arrives", () => {
    const sessionID = "ses_1"
    const draft = {
      message: {
        [sessionID]: [
          {
            ...userMessage("msg_server", sessionID),
            metadata: {
              deepagent: {
                promptAdmission: {
                  clientMessageID: "msg_client",
                },
              },
            },
          },
        ],
      },
      part: {
        msg_client: [textPart("prt_client", sessionID, "msg_client")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_client", sessionID),
      parts: [textPart("prt_client", sessionID, "msg_client")],
    })

    expect(draft.message[sessionID]?.map((message) => message.id)).toEqual(["msg_server"])
    expect(draft.part.msg_client).toBeUndefined()
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("mergeOptimisticPage replaces a client placeholder with its canonical steer", () => {
    const sessionID = "ses_1"
    const canonical = {
      ...userMessage("msg_server", sessionID),
      metadata: {
        deepagent: {
          promptAdmission: {
            clientMessageID: "msg_client",
          },
        },
      },
    }
    const page = mergeOptimisticPage(
      {
        session: [canonical],
        part: [{ id: canonical.id, part: [textPart("prt_server", sessionID, canonical.id)] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_client", sessionID),
          parts: [textPart("prt_client", sessionID, "msg_client")],
        },
      ],
    )

    expect(page.session.map((message) => message.id)).toEqual(["msg_server"])
    expect(page.part.map((item) => item.id)).toEqual(["msg_server"])
    expect(page.confirmed).toEqual(["msg_client"])
  })
})
