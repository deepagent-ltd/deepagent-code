import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@deepagent-code/sdk/v2"
import { jumpToTurn, turnRailLabel } from "./helpers"

const userMessage = (id: string): UserMessage => ({ id, role: "user" }) as UserMessage

// U-NAV 验收 (c) / (e): 点击/Enter 段 → 调 scrollToMessage(对应 UserMessage, "smooth")
// 且 setActiveMessage 先同步高亮；aria-label 形如「跳到第 N 轮：<预览>」。
describe("jumpToTurn", () => {
  test("sets the active message before scrolling, with the same message", () => {
    const calls: string[] = []
    const target = userMessage("msg-2")

    jumpToTurn(target, {
      setActiveMessage: (m) => calls.push(`active:${m?.id}`),
      scrollToMessage: (m, behavior) => calls.push(`scroll:${m.id}:${behavior}`),
    })

    expect(calls).toEqual(["active:msg-2", "scroll:msg-2:smooth"])
  })
})

describe("turnRailLabel", () => {
  test("uses the 1-based turn number and the preview title", () => {
    expect(turnRailLabel(0, { title: "Fix login" })).toBe("跳到第 1 轮：Fix login")
    expect(turnRailLabel(4, { title: "Add tests", body: "x" })).toBe("跳到第 5 轮：Add tests")
  })

  test("falls back to body, then to a bare turn number", () => {
    expect(turnRailLabel(1, { body: "only body" })).toBe("跳到第 2 轮：only body")
    expect(turnRailLabel(2, {})).toBe("跳到第 3 轮")
  })
})
