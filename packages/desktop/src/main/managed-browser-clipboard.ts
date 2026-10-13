import { clipboard, dialog } from "electron"
import type { BrowserWindow } from "electron"
import { createHash } from "node:crypto"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"

const lease = { active: false }

type ClipboardInput = {
  control: BrowserSchema.Control
  action: BrowserSchema.Action
  window: BrowserWindow
  current: () => Promise<void>
  observe: () => Promise<void>
}

/** The returned closure only releases a lease; it cannot authorize an OS operation. */
export function createManagedBrowserClipboardConfirmation(fail: (code: BrowserSchema.Error["code"]) => never) {
  const confirm = dialog.showMessageBox.bind(dialog)
  return async (input: ClipboardInput) => {
    const command = input.action.command
    if ((command.type !== "clipboard.read" && command.type !== "clipboard.write") ||
      !BrowserSchema.allowsClipboard(input.control, command)) return fail("BROWSER_SCOPE_DENIED")
    if (command.type === "clipboard.write" && (!command.text.isWellFormed() ||
      Buffer.byteLength(command.text, "utf8") > BrowserSchema.MAX_CLIPBOARD_WRITE_BYTES)) return fail("BROWSER_OUTPUT_LIMIT")
    if (lease.active) return fail("BROWSER_CAPACITY")
    lease.active = true
    const controller = new AbortController()
    const close = () => controller.abort()
    const timer = setTimeout(close, Math.max(1, input.action.deadline - Date.now()))
    input.window.once("closed", close)
    const state = { released: false }
    const release = () => {
      if (state.released) return
      state.released = true
      clearTimeout(timer)
      input.window.removeListener("closed", close)
      lease.active = false
    }
    try {
      await input.current()
      await input.observe()
      if (input.window.isDestroyed() || controller.signal.aborted) return fail("BROWSER_CANCELLED")
      input.window.show()
      const writeHash = command.type === "clipboard.write" ? createHash("sha256").update(command.text).digest("hex") : undefined
      const selection = await confirm(input.window, { type: "warning", buttons: ["Cancel", "Allow once"],
        defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal, title: "DeepAgent · Browser clipboard",
        checkboxLabel: command.type === "clipboard.read" ? "I approve sending this desktop clipboard text to this Agent once."
          : "I approve replacing this desktop clipboard text once.", checkboxChecked: false,
        message: command.type === "clipboard.read" ? "Read desktop clipboard text once?" : "Replace desktop clipboard text once?",
        detail: `${input.control.scope.directory}\n${input.control.origin}\n${command.type === "clipboard.read"
          ? `Return at most ${BrowserSchema.MAX_CLIPBOARD_READ_BYTES} UTF-8 bytes to this Agent.`
          : `${Buffer.byteLength(command.text, "utf8")} UTF-8 bytes · SHA-256 ${writeHash}\n${command.text.slice(0, 512)}`}\nApproval expires: ${new Date(input.action.deadline).toISOString()}`,
      }).catch(() => fail(controller.signal.aborted ? "BROWSER_CANCELLED" : "BROWSER_DRIVER_UNAVAILABLE"))
      if (selection.response !== 1 || selection.checkboxChecked !== true || controller.signal.aborted)
        return fail("BROWSER_SCOPE_DENIED")
      await input.current()
      await input.observe()
      if (input.window.isDestroyed() || controller.signal.aborted || Date.now() >= input.action.deadline)
        return fail("BROWSER_CANCELLED")
      return release
    } catch (error) {
      release()
      throw error
    }
  }
}

/** All actual managers in this Main process share the clipboard lease. */
export function createManagedBrowserClipboard(fail: (code: BrowserSchema.Error["code"]) => never) {
  const read = clipboard.readText.bind(clipboard)
  const write = clipboard.writeText.bind(clipboard)
  const confirm = createManagedBrowserClipboardConfirmation(fail)
  return async (input: ClipboardInput & { dispatched: () => void }): Promise<typeof BrowserSchema.ClipboardResult.Type> => {
    if (!BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE) return fail("BROWSER_DRIVER_UNAVAILABLE")
    const release = await confirm(input)
    try {
      const command = input.action.command
      if (command.type !== "clipboard.read" && command.type !== "clipboard.write") return fail("BROWSER_SCOPE_DENIED")
      const writeHash = command.type === "clipboard.write" ? createHash("sha256").update(command.text).digest("hex") : undefined
      input.dispatched()
      if (command.type === "clipboard.write") write(command.text)
      const text = read()
      if (!text.isWellFormed() || Buffer.byteLength(text, "utf8") > (command.type === "clipboard.read"
        ? BrowserSchema.MAX_CLIPBOARD_READ_BYTES : BrowserSchema.MAX_CLIPBOARD_WRITE_BYTES)) return fail("BROWSER_OUTPUT_LIMIT")
      const sha256 = createHash("sha256").update(text).digest("hex")
      if (command.type === "clipboard.write" && sha256 !== writeHash) return fail("BROWSER_UNKNOWN")
      await input.current()
      await input.observe()
      return command.type === "clipboard.read" ? { direction: "read", text, bytes: Buffer.byteLength(text, "utf8"), sha256 }
        : { direction: "write", bytes: Buffer.byteLength(text, "utf8"), sha256 }
    } finally {
      release()
    }
  }
}
