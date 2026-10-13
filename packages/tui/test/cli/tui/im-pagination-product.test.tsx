/** @jsxImportSource @opentui/solid */
import { afterAll, expect, test } from "bun:test"
import { dict } from "../../../src/i18n/en"
import { until } from "../../fixture/im-environment"
import { mountPagination, paginationInventory } from "../../fixture/im-pagination-product"

afterAll(() => { console.log("IM_PAGINATION_PRODUCT_TUI_SAFE", JSON.stringify(paginationInventory)) })

test("original TUI renders 125 distinct protected messages in 50/50/25 through scoped HTTP and Ctrl+P", async () => {
  const ui = await mountPagination()
  try {
    await ui.settled(50)
    await ui.frame(dict["tui.im.loadOlder"])
    await ui.older()
    await ui.settled(100)
    await ui.older()
    await ui.settled(125)
    expect(ui.bodies()).toEqual(Array.from({ length: 125 }, (_, index) => `a-history-${String(index + 1).padStart(3, "0")} 中文`))
    expect(new Set(ui.bodies()).size).toBe(125)
    expect(ui.app.captureCharFrame()).not.toContain(dict["tui.im.loadOlder"])
    expect(ui.state.requests.filter((request) => request.cursor !== null).map((request) => [request.cursor, request.rows]))
      .toEqual([["older-50", 50], ["older-100", 25]])
    expect(ui.state.requests.filter((request) => request.cursor === null).length).toBeGreaterThanOrEqual(1)
    expect(ui.state.requests.filter((request) => request.cursor === null).length).toBeLessThanOrEqual(2)
    expect(ui.state.requests.every((request) => request.limit === "50" && request.directory === `${ui.root}/a`)).toBe(true)
    expect(paginationInventory.writes).toBe(0)
    const before = ui.state.requests.length
    await ui.older()
    await Bun.sleep(20)
    expect(ui.state.requests).toHaveLength(before)
  } finally { await ui.close() }
}, 15_000)

test("an actual middle-page 500 clears protected TUI bodies and explicit Ctrl+R recovers history", async () => {
  const ui = await mountPagination()
  try {
    await ui.settled(50)
    ui.state.failMiddle = true
    await ui.older()
    await ui.frame(dict["tui.im.reader.unavailable"].split(". ")[0])
    await ui.settled(0)
    expect(ui.bodies()).toEqual([])
    expect(ui.state.requests.find((request) => request.cursor === "older-50")?.status).toBe(500)
    expect(ui.app.captureCharFrame()).not.toContain(dict["tui.im.loadOlder"])
    const before = ui.state.requests.length
    await Bun.sleep(100)
    expect(ui.state.requests).toHaveLength(before)
    ui.state.failMiddle = false
    await ui.refresh()
    await ui.settled(50)
    await ui.older()
    await ui.settled(100)
    await ui.older()
    await ui.settled(125)
    expect(new Set(ui.bodies()).size).toBe(125)
    expect(paginationInventory.writes).toBe(0)
  } finally { await ui.close() }
}, 15_000)

test("same-origin directory replacement retires the old held TUI page and cannot disclose its late body", async () => {
  const ui = await mountPagination()
  const gate = Promise.withResolvers<void>()
  try {
    await ui.settled(50)
    ui.state.delayed = gate.promise
    await ui.older()
    await until(() => ui.state.requests.some((request) => request.cursor === "older-50"), "old owned directory page is held")
    ui.setDirectory("b")
    await until(() => ui.state.requests.some((request) => request.directory === `${ui.root}/b`), "replacement original scope GET")
    await ui.settled(50)
    expect(ui.bodies().every((value) => value.startsWith("b-history-"))).toBe(true)
    await until(() => ui.state.delayedClosed, "retired original page request aborted")
    gate.resolve()
    await until(() => ui.state.delayedFinished, "late controlled original page finished")
    await Bun.sleep(30)
    await ui.app.renderOnce()
    expect(ui.bodies()).toEqual(Array.from({ length: 50 }, (_, index) => `b-history-${String(index + 76).padStart(3, "0")} 中文`))
    expect(ui.bodies().some((value) => value.startsWith("a-history-"))).toBe(false)
    expect(ui.sockets.size).toBe(1)
    expect([...ui.sockets][0].data.directory).toBe(`${ui.root}/b`)
    expect(paginationInventory.writes).toBe(0)
  } finally { gate.resolve(); await ui.close() }
}, 15_000)

test.each([...(["repeat", "empty", "terminal"] as const)])("a %s cursor response cannot merge or advance a protected TUI history page", async (mode) => {
  const ui = await mountPagination()
  try {
    await ui.settled(50)
    ui.state.cursorMode = mode
    await ui.older()
    await until(() => ui.state.requests.some((request) => request.cursor === "older-50"), "original repeated older response")
    await Bun.sleep(30)
    await ui.app.renderOnce()
    expect(ui.bodies()).toEqual([])
    await ui.frame(dict["tui.im.reader.unavailable"].split(". ")[0])
    expect(ui.app.captureCharFrame()).not.toContain(dict["tui.im.loadOlder"])
    expect(paginationInventory.writes).toBe(0)
  } finally { await ui.close() }
}, 15_000)
