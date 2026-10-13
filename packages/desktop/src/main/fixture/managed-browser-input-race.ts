import { app, BrowserWindow } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { createManagedBrowserActions } from "../managed-browser-actions"

const root = process.argv[2]!
app.setPath("userData", path.join(root, "profile"))
app.on("window-all-closed", () => {})

async function main() {
  await mkdir(path.join(root, "profile"), { recursive: true })
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  const contents = window.webContents
  const cases: Array<{ operation: string; injection: number; dispatched: number; error: string; value: string }> = []
  try {
    await contents.loadURL("data:text/html," + encodeURIComponent('<label>Entry<input value="before"></label><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>'))
    contents.debugger.attach("1.3")
    await contents.debugger.sendCommand("Page.enable")
    await contents.debugger.sendCommand("Accessibility.enable")
    const state = { checks: 0, inject: 0, mutationCheck: 0, dispatched: 0 }
    const helper = createManagedBrowserActions({
      send: (method, params) => {
        if (method === "DOM.focus" || method.startsWith("Input.") ||
          (method === "Runtime.callFunctionOn" && params?.userGesture === true) || method === "Runtime.evaluate") {
          if (!state.mutationCheck) state.mutationCheck = state.checks
        }
        return contents.debugger.sendCommand(method, params)
      },
      current: async () => {
        state.checks++
        if (state.checks === state.inject) {
          // This is an admission wait at the actual dispatch boundary, not a fake CDP
          // implementation: Chromium still performs every observation and normal input.
          await Promise.resolve()
          helper.invalidate()
        }
      },
      generation: () => 1,
      fail: (code) => { throw new Error(code) },
      dispatched: () => { state.dispatched++ },
    })
    const snapshot = () => helper.snapshot({ type: "snapshot", tabID: "race", generation: 1 })
    const command = (page: Awaited<ReturnType<typeof snapshot>>, operation: "fill" | "select" | "evaluate"): BrowserSchema.Command => {
      const base = { tabID: "race", generation: 1, frameID: page.frameID, observationRevision: page.observationRevision }
      if (operation === "evaluate") return { ...base, type: "evaluate", source: "return 42", argsJSON: "{}",
        scriptHash: createHash("sha256").update("return 42").digest("hex") }
      const ref = page.refs?.find((value) => value.name === (operation === "fill" ? "Entry" : "Choice"))?.ref
      if (!ref) throw new Error("Actual Chromium reference missing")
      return operation === "fill" ? { ...base, type: "fill", ref, text: "normal" }
        : { ...base, type: "select", ref, values: ["b"] }
    }
    const execute = async (value: BrowserSchema.Command) => {
      if (value.type === "evaluate") return helper.evaluate(value, Date.now() + 5000)
      if (value.type !== "fill" && value.type !== "select") throw new Error("Unsupported fixture command")
      return helper.execute(value)
    }
    for (const operation of ["fill", "select", "evaluate"] as const) {
      const normal = command(await snapshot(), operation)
      Object.assign(state, { checks: 0, inject: 0, mutationCheck: 0, dispatched: 0 })
      await execute(normal)
      if (state.dispatched < 1 || state.mutationCheck < 1) throw new Error("Normal Chromium operation not dispatched")
      const injection = state.mutationCheck
      await contents.executeJavaScript('document.querySelector("input").value="before";document.querySelector("select").value="a";document.activeElement.blur()')
      const raced = command(await snapshot(), operation)
      Object.assign(state, { checks: 0, inject: injection, mutationCheck: 0, dispatched: 0 })
      const error = await execute(raced).then(() => "", (error: unknown) => error instanceof Error ? error.message : "untyped")
      cases.push({ operation, injection, dispatched: state.dispatched, error,
        value: await contents.executeJavaScript(operation === "select" ? 'document.querySelector("select").value'
          : 'document.querySelector("input").value') })
      await helper.release()
    }
    Object.assign(state, { checks: 0, inject: 0, mutationCheck: 0, dispatched: 0 })
    const prior = command(await snapshot(), "fill")
    const injection = state.checks
    Object.assign(state, { checks: 0, inject: injection, mutationCheck: 0, dispatched: 0 })
    const error = await snapshot().then(() => "", (error: unknown) => error instanceof Error ? error.message : "untyped")
    Object.assign(state, { inject: 0 })
    const old = await execute(prior).then(() => "", (error: unknown) => error instanceof Error ? error.message : "untyped")
    if (old !== "BROWSER_STALE_TARGET") throw new Error("Snapshot race left an old target usable")
    cases.push({ operation: "snapshot", injection, dispatched: state.dispatched, error,
      value: await contents.executeJavaScript('document.querySelector("input").value') })
    await execute(command(await snapshot(), "fill"))
    await writeFile(path.join(root, "result.json"), JSON.stringify({ cases, runtime: {
      electron: process.versions.electron, node: process.versions.node, arch: process.arch,
    }, externalRequests: 0, provider: 0, clipboard: 0 }))
  } finally {
    window.destroy()
  }
}

main().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1) })
