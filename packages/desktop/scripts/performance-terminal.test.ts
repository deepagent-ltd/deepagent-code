import { expect, test } from "bun:test"
import { createPerformanceViewport } from "./performance-terminal"

test("actual cursor delta frames preserve existing draft and expose completion only at frame end", () => {
  const viewport = createPerformanceViewport(100, 40)
  viewport.push("\x1b[?2026h\x1b[22;17H\x1b[38;2;238;238;238mqjzx\x1b[0m\x1b[?2026l")
  expect(viewport.frames()).toBe(1)
  viewport.push("\x1b[?2026h\x1b[22;21H\x1b[38;2;238;238;238mz")
  expect(viewport.frames()).toBe(1)
  viewport.push("\x1b[0m\x1b[22;22H\x1b[?25h\x1b[?2026l")
  expect(viewport.frames()).toBe(2)
  expect(viewport.text().split("\n")[21]!.slice(16, 21)).toBe("qjzxz")
})

test("split control sequences and erased dialogs cannot leave a stale title witness", () => {
  const viewport = createPerformanceViewport(30, 8)
  const wire = "\x1b[?1049h\x1b[3;4HSessions\x1b]0;not screen\x07\x1b[?2026l\x1b[3;4H\x1b[2K\x1b[5;2Hdraft\x1b[?2026l"
  for (const character of wire) viewport.push(character)
  expect(viewport.text()).not.toContain("Sessions")
  expect(viewport.text()).not.toContain("not screen")
  expect(viewport.text()).toContain("draft")
  expect(viewport.frames()).toBe(2)
})
