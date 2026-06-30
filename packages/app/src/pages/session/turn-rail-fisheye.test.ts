import { describe, expect, test } from "bun:test"
import { turnRailSegmentWidth } from "./helpers"

// 鱼眼放大曲线：鼠标停留的段最长，临近段按距离线性递减回到基准宽度，
// 超出半径的段保持基准。无 hover 时全部基准（颜色不变，只长度变 → 见组件）。
describe("turnRailSegmentWidth", () => {
  const base = 8
  const peak = 28
  const radius = 3

  test("all segments stay at base width when nothing is hovered", () => {
    for (const index of [0, 1, 2, 3]) {
      expect(turnRailSegmentWidth({ index, hoverIndex: null })).toBe(base)
    }
  })

  test("hovered segment grows to the peak width", () => {
    expect(turnRailSegmentWidth({ index: 5, hoverIndex: 5 })).toBe(peak)
  })

  test("neighbours shrink linearly with distance", () => {
    // distance 1 of 3, then 2 of 3.
    expect(turnRailSegmentWidth({ index: 4, hoverIndex: 5 })).toBe(Math.round(peak - (peak - base) * (1 / radius)))
    expect(turnRailSegmentWidth({ index: 3, hoverIndex: 5 })).toBe(Math.round(peak - (peak - base) * (2 / radius)))
    expect(turnRailSegmentWidth({ index: 6, hoverIndex: 5 })).toBe(Math.round(peak - (peak - base) * (1 / radius)))
  })

  test("segments at the radius edge return to base", () => {
    expect(turnRailSegmentWidth({ index: 2, hoverIndex: 5 })).toBe(base)
    expect(turnRailSegmentWidth({ index: 8, hoverIndex: 5 })).toBe(base)
  })

  test("segments beyond the radius stay at base", () => {
    expect(turnRailSegmentWidth({ index: 0, hoverIndex: 5 })).toBe(base)
    expect(turnRailSegmentWidth({ index: 12, hoverIndex: 5 })).toBe(base)
  })

  test("magnification decreases monotonically away from the hovered segment", () => {
    const widths = [5, 6, 7, 8, 9].map((index) => turnRailSegmentWidth({ index, hoverIndex: 5 }))
    // index 5 is the peak; each step further is <= the previous.
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1])
    }
  })
})

import { turnRailIndexFromPointer } from "./helpers"

// 指针 Y → 段索引的几何映射：整条 ticks 区按段数等分成无间隙的命中带，
// 这样鼠标落在刻度之间的 gap、或被放大的刻度周围，都能稳定判定到唯一一段，
// 鱼眼不会因为跨越 gap 而塌掉。
describe("turnRailIndexFromPointer", () => {
  const railTop = 100
  const railHeight = 200 // 4 段 → 每带 50px
  const count = 4

  test("maps each band to its segment", () => {
    expect(turnRailIndexFromPointer({ pointerY: 110, railTop, railHeight, count })).toBe(0)
    expect(turnRailIndexFromPointer({ pointerY: 160, railTop, railHeight, count })).toBe(1)
    expect(turnRailIndexFromPointer({ pointerY: 210, railTop, railHeight, count })).toBe(2)
    expect(turnRailIndexFromPointer({ pointerY: 290, railTop, railHeight, count })).toBe(3)
  })

  test("the gap between ticks still resolves to a segment (no drop)", () => {
    // 任意带内的点（含刻度间空隙）都落在该带的段上。
    expect(turnRailIndexFromPointer({ pointerY: 149, railTop, railHeight, count })).toBe(0)
    expect(turnRailIndexFromPointer({ pointerY: 151, railTop, railHeight, count })).toBe(1)
  })

  test("clamps positions above the band to the first segment", () => {
    expect(turnRailIndexFromPointer({ pointerY: 80, railTop, railHeight, count })).toBe(0)
  })

  test("clamps positions below the band to the last segment", () => {
    expect(turnRailIndexFromPointer({ pointerY: 999, railTop, railHeight, count })).toBe(count - 1)
  })

  test("returns null when there are no segments", () => {
    expect(turnRailIndexFromPointer({ pointerY: 150, railTop, railHeight, count: 0 })).toBeNull()
  })

  test("degenerate zero-height rail resolves to the first segment", () => {
    expect(turnRailIndexFromPointer({ pointerY: 150, railTop, railHeight: 0, count })).toBe(0)
  })
})
