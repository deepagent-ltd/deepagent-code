/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { DialogSelect } from "../../../src/ui/dialog-select"
import { useDialog } from "../../../src/ui/dialog"
import { mountIM } from "../../fixture/im-environment"
import { links, selectMenu } from "../../fixture/im-media-batch-receiver"
import { TextRenderable, type Renderable } from "@opentui/core"

test("receiver QA selects a decorated group and a clipped attachment across deferred real menu focus", async () => {
  const root = await mkdtemp("/tmp/dac-im-receiver-menu-")
  const actions: string[] = []
  function Initial() {
    const dialog = useDialog()
    return <DialogSelect title="Original groups" options={[{ title: "@ Original group", value: "group" }]}
      onSelect={() => {
        actions.push("group")
        dialog.replace(() => <DialogSelect title="Original attachments" options={Array.from({ length: 30 }, (_, index) => ({
          title: `Attachment details · original-file-${index}`, value: String(index),
        }))} onSelect={(item) => { actions.push(item.value) }} />)
      }} />
  }
  const ui = await mountIM(root, "http://127.0.0.1:9", () => <Initial />, 80)
  try {
    await selectMenu(ui.app, "Original group", Date.now() + 3000)
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).not.toContain("Attachment details · original-file-29")
    // No frame helper or fixed sleep grants the second menu its input focus.
    await selectMenu(ui.app, "Attachment details · original-file-29", Date.now() + 3000)
    expect(actions).toEqual(["group", "29"])
  } catch (error) {
    function titles(node: Renderable): { text: string; attributes: number }[] {
      return [...(node instanceof TextRenderable ? [{ text: node.plainText, attributes: node.attributes }] : []),
        ...node.getChildren().flatMap(titles)]
    }
    console.log("RECEIVER_QA_MENU_DIAGNOSTIC", JSON.stringify({ actions, titles: titles(ui.app.renderer.root),
      focus: ui.app.renderer.currentFocusedEditor?.plainText, frame: ui.app.captureCharFrame() }))
    throw error
  } finally {
    ui.app.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
  expect(ui.app.renderer.isDestroyed).toBe(true)
}, 10_000)

test("typing an absent option cannot satisfy the receiver QA oracle with the search text itself", async () => {
  const root = await mkdtemp("/tmp/dac-im-receiver-menu-")
  const actions: string[] = []
  const ui = await mountIM(root, "http://127.0.0.1:9", () => <DialogSelect title="Original attachments"
    options={[{ title: "Attachment details · original", value: "original" }]}
    onSelect={(item) => { actions.push(item.value) }} />, 80)
  try {
    await expect(selectMenu(ui.app, "Attachment details · absent", Date.now() + 400))
      .rejects.toThrow("Original filtered menu option did not become visible")
    expect(actions).toEqual([])
  } finally {
    ui.app.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
  expect(ui.app.renderer.isDestroyed).toBe(true)
}, 10_000)

test("receiver QA observes a real nested anchor from OpenTUI text-node styles", async () => {
  const root = await mkdtemp("/tmp/dac-im-receiver-menu-")
  const url = "http://127.0.0.1:9/view/controlled-fixture"
  const ui = await mountIM(root, "http://127.0.0.1:9", () => <box><text><a href={url}>Open image link</a></text></box>, 80)
  try {
    const deadline = Date.now() + 2000
    while (!ui.app.captureCharFrame().includes("Open image link") && Date.now() < deadline) {
      await ui.app.renderOnce()
      await Bun.sleep(10)
    }
    expect(ui.app.captureCharFrame()).toContain("Open image link")
    expect(links(ui.app.renderer.root)).toContain(url)
  } finally {
    ui.app.renderer.destroy()
    await rm(root, { recursive: true, force: true })
  }
  expect(ui.app.renderer.isDestroyed).toBe(true)
}, 10_000)
