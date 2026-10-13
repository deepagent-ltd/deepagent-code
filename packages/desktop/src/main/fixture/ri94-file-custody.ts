import { app, utilityProcess, BrowserWindow } from "electron"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { installManagedBrowser } from "../managed-browser"
const root = process.env.DAC_BROWSER_TEST_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})
async function main() {
await app.whenReady()
const page = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<input type=file name=asset>") })
await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
const address = page.address()! as { port: number }
const child = utilityProcess.fork(process.env.DAC_BROWSER_CHILD!, [], { cwd: path.join(root, "project"),
  env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
    DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: "private-fixture",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DAC_BROWSER_TEST_ROOT: root,
    DAC_BROWSER_ORIGIN: `http://127.0.0.1:${address.port}`, NO_PROXY: "127.0.0.1,localhost,::1", NO_COLOR: "1" }, stdio: "pipe" })
child.stdout?.on("data", (data) => process.stdout.write(data))
child.stderr?.on("data", (data) => process.stderr.write(data))
const stopped = Promise.withResolvers<number | null>()
child.once("exit", stopped.resolve)
const owner: { close?: () => void; ok?: boolean } = {}
child.on("message", (message) => {
  if (message.type === "managed-browser-bootstrap-ready-v1") { owner.close = installManagedBrowser(child, "private-fixture"); return }
  if (message.type === "ri94-files-result") { owner.ok = message.ok; child.kill() }
})
const timer = setTimeout(() => child.kill(), 120000)
const code = await stopped.promise
clearTimeout(timer); owner.close?.()
await new Promise<void>((resolve) => page.close(() => resolve()))
await fs.writeFile(path.join(root, "main-result.json"), JSON.stringify({ childExit: code, windows: BrowserWindow.getAllWindows().length, ok: owner.ok }), { mode: 0o600 })
app.exit(owner.ok ? 0 : 1)

}
void main().catch(async (error) => {
  await fs.writeFile(path.join(root, "main-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 });
  app.exit(1)
})
