import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { prepareWindowsNativeSidecar } from "../../../desktop/src/main/windows-native-sidecar"

const electron = createRequire(import.meta.url)("electron") as typeof Electron.CrossProcessExports
const root = process.env.DAC_NATIVE_NODE_COHORT_ROOT!
assert(path.isAbsolute(root) && path.win32.parse(root).root.toUpperCase() === "D:\\")
electron.app.setPath("userData", path.join(root, "profile", "electron-user"))
electron.app.setPath("sessionData", path.join(root, "profile", "electron-session"))
electron.app.commandLine.appendSwitch("disable-background-networking")
electron.app.on("window-all-closed", () => {})

const phase = (name: string) => fs.appendFile(path.join(root, "phases.jsonl"), `${JSON.stringify({ phase: name, at: Date.now() })}\n`)
async function main() {
  await electron.app.whenReady()
  await phase("electron-main-ready")
  const native = prepareWindowsNativeSidecar()
  assert(native, "The original Windows parent capture is required")
  try {
    const child = electron.utilityProcess.fork(fileURLToPath(new URL("./sidecar.js", import.meta.url)), [process.argv.at(-1)!], {
      env: process.env, stdio: "pipe",
    })
    const state = { closed: false, completed: false, timedOut: false }
    const closed = new Promise<number>((resolve) => child.once("exit", (code) => { state.closed = true; resolve(code) }))
    child.on("message", (message: unknown) => {
      if (state.completed || !message || typeof message !== "object" || !("type" in message) || message.type !== "dac-native-fixture-complete-v1") return
      state.completed = true
      child.kill()
    })
    const timer = setTimeout(() => { state.timedOut = true; child.kill() }, 240_000)
    try {
      const output = { stdout: "", stderr: "" }
      child.stdout?.on("data", (bytes: Buffer) => {
        output.stdout = (output.stdout + bytes.toString()).slice(-16_384)
        process.stdout.write(bytes)
      })
      child.stderr?.on("data", (bytes: Buffer) => {
        output.stderr = (output.stderr + bytes.toString()).slice(-16_384)
        process.stderr.write(bytes)
      })
      await native.bind(child)
      await phase("original-parent-receipt-bound")
      const code = await closed
      await fs.writeFile(path.join(root, "runtime-result.json"), JSON.stringify({ code, ...output }))
      assert.equal(state.completed && !state.timedOut, true, "The original Native child did not complete its fixture")
      assert.equal(code, 0, "The original Native child failed")
      await phase("native-child-exited")
    } finally {
      clearTimeout(timer)
      if (!state.closed) child.kill()
      await closed
    }
  } finally {
    native.close()
  }
}
void main().then(() => electron.app.exit(0), async (error: unknown) => {
  await phase("electron-main-failed")
  console.error(error)
  electron.app.exit(1)
})
