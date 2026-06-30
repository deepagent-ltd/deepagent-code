import { describe, expect, test } from "bun:test"
import { shouldRenderTurnRail } from "./helpers"

// U-NAV 验收 (a) / (f): N(>1) 轮显示 N 段；单轮/空会话不渲染。
// 段数恒等于轮数（一 UserMessage = 一段），由 <For each={userMessages}> 保证，
// 这里锁定「是否渲染整条」的可见性闸门。
describe("turn rail segment visibility", () => {
  test("renders one segment per turn when there are multiple turns", () => {
    expect(shouldRenderTurnRail(2)).toBe(true)
    expect(shouldRenderTurnRail(5)).toBe(true)
  })

  test("hides on a single turn", () => {
    expect(shouldRenderTurnRail(1)).toBe(false)
  })

  test("hides on an empty conversation", () => {
    expect(shouldRenderTurnRail(0)).toBe(false)
  })
})
