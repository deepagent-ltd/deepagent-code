import { describe, expect, test } from "bun:test"
import {
  backgroundTask,
  createBackgroundSessions,
  createSessionTree,
  questionAnswers,
} from "@/cli/cmd/run/noninteractive"
import { localSessionCommand } from "@/cli/cmd/run/prompt.shared"

describe("non-interactive run helpers", () => {
  test("recognizes only the root session and its descendants", async () => {
    const sessions = new Map([
      ["child", { id: "child", parentID: "root" }],
      ["grandchild", { id: "grandchild", parentID: "child" }],
      ["unrelated", { id: "unrelated" }],
    ])
    const tree = createSessionTree("root", async (sessionID) => sessions.get(sessionID))

    expect(await tree.contains("root")).toBe(true)
    expect(await tree.contains("grandchild")).toBe(true)
    expect(await tree.contains("unrelated")).toBe(false)
    expect(await tree.contains("missing")).toBe(false)
  })

  test("tracks an admitted child before it is queryable", async () => {
    const tree = createSessionTree("root", async () => undefined)
    tree.track("child")
    expect(await tree.contains("child")).toBe(true)
  })

  test("extracts completed background task ownership", () => {
    expect(
      backgroundTask({
        messageID: "message",
        tool: "task",
        state: {
          status: "completed",
          metadata: { background: true, sessionId: "child" },
        },
      }),
    ).toEqual({ sessionID: "child", messageID: "message" })
    expect(
      backgroundTask({
        messageID: "message",
        tool: "task",
        state: { status: "completed", metadata: { sessionId: "foreground" } },
      }),
    ).toBeUndefined()
  })

  test("requires one configured answer for each question", () => {
    expect(questionAnswers(2, ["A", "B"])).toEqual([["A"], ["B"]])
    expect(questionAnswers(2, ["A"])).toBeUndefined()
    expect(questionAnswers(1, undefined)).toBeUndefined()
  })

  test("keeps the CLI alive until a settled background child triggers a later parent turn", () => {
    const background = createBackgroundSessions()
    background.admit("child", "initial-parent-message")
    background.parentAssistant("initial-parent-message")
    expect(background.pending()).toBe(true)

    background.settle("child")
    background.parentAssistant("continued-parent-message")
    expect(background.pending()).toBe(false)
  })

  test("recognizes GUI-compatible local session commands", () => {
    expect(["undo", "redo", "fork", "share", "unshare"].map((name) => localSessionCommand(`/${name}`))).toEqual([
      "undo",
      "redo",
      "fork",
      "share",
      "unshare",
    ])
    expect(localSessionCommand("/unknown")).toBeUndefined()
  })
})
