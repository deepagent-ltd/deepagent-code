import { describe, expect, test } from "bun:test"
import { resolveActiveTurnId } from "./helpers"

// U-NAV 验收 (d) / (f): 滚动时当前轮自动高亮；与 hash/点击跳转共用一套 active 状态，
// 互不打架。resolveActiveTurnId 是 turn-rail 高亮的单一真相源：
//   - 用户刚点击/经 hash 固定某轮（pinnedFresh）→ 用固定的 turn；
//   - 否则跟随滚动位置算出的 turn；
//   - 都没有时回落到固定 id。
describe("resolveActiveTurnId", () => {
  test("prefers a freshly pinned turn (click / hash jump)", () => {
    expect(resolveActiveTurnId({ pinnedId: "pinned", pinnedFresh: true, scrollId: "scrolled" })).toBe("pinned")
  })

  test("follows scroll position once the pin is stale (free scrolling)", () => {
    expect(resolveActiveTurnId({ pinnedId: "pinned", pinnedFresh: false, scrollId: "scrolled" })).toBe("scrolled")
  })

  test("follows scroll position when nothing is pinned", () => {
    expect(resolveActiveTurnId({ pinnedId: undefined, pinnedFresh: false, scrollId: "scrolled" })).toBe("scrolled")
  })

  test("falls back to the pinned id when there is no scroll position yet", () => {
    expect(resolveActiveTurnId({ pinnedId: "pinned", pinnedFresh: false, scrollId: undefined })).toBe("pinned")
  })

  test("is undefined when there is neither a pin nor a scroll position", () => {
    expect(resolveActiveTurnId({ pinnedId: undefined, pinnedFresh: true, scrollId: undefined })).toBeUndefined()
  })
})
