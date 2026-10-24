/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { mkdtemp, rm } from "node:fs/promises"
import { reviewIntelligenceDraft } from "../../../src/prompt/intelligence-review"
import { useDialog } from "../../../src/ui/dialog"
import { mountIM, until } from "../../fixture/im-environment"

test("intelligence review confirmation reveals the result, cancellation exits and a replacement keeps its dialog owner", async () => {
  const root = await mkdtemp("/tmp/dac-tui-intelligence-review-")
  const results: Array<string | null> = []
  const actions = { open: () => {}, replace: () => {}, count: () => -1 }
  function Capture() {
    const dialog = useDialog()
    actions.open = () => {
      void reviewIntelligenceDraft(dialog, "Intelligence review", "Original prepared goal").then((value) => {
        results.push(value)
      })
    }
    actions.replace = () => dialog.replace(() => <text>Other permission dialog</text>)
    actions.count = () => dialog.stack.length
    return <text>Actual Agent result remains available</text>
  }
  const ui = await mountIM(
    root,
    "http://127.0.0.1:1",
    () => <box />,
    100,
    () => <Capture />,
  )
  try {
    await ui.frame("Actual Agent result remains available")
    actions.open()
    await ui.frame("Intelligence review")
    await until(() => ui.app.renderer.currentFocusedEditor instanceof TextareaRenderable, "review editor focus")
    await ui.type("Confirmed prepared goal", true)
    ui.app.mockInput.pressEnter()
    await until(() => results.length === 1, "confirmed review resolution")
    const frame = await ui.frame("Actual Agent result remains available")
    expect(results).toEqual(["Confirmed prepared goal"])
    expect(actions.count()).toBe(0)
    expect(frame).not.toContain("Intelligence review")

    actions.open()
    await ui.frame("Intelligence review")
    ui.app.mockInput.pressKey("ESCAPE")
    await until(() => results.length === 2, "cancelled review resolution")
    expect(results).toEqual(["Confirmed prepared goal", null])
    expect(actions.count()).toBe(0)

    actions.open()
    await ui.frame("Intelligence review")
    actions.replace()
    await until(() => results.length === 3, "replaced review resolution")
    await ui.frame("Other permission dialog")
    expect(results).toEqual(["Confirmed prepared goal", null, null])
    expect(actions.count()).toBe(1)
  } finally {
    ui.app.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
