import { app, utilityProcess } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

const root = process.env.DAC_NATIVE_NODE_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
await app.whenReady()
const child = utilityProcess.fork(process.env.DAC_NATIVE_NODE_ENTRY!, [], {
  env: { HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
  stdio: "pipe",
})
const output = { stdout: "", stderr: "" }
const record = Promise.withResolvers<void>()
const timer = setTimeout(() => { child.kill(); app.exit(3) }, 15_000)
child.stdout?.on("data", (bytes: Buffer) => {
  output.stdout += bytes.toString()
  if (Buffer.byteLength(output.stdout) > 32_768) { child.kill(); app.exit(4) }
  if (output.stdout.endsWith("\n")) record.resolve()
})
child.stderr?.on("data", (bytes: Buffer) => {
  output.stderr += bytes.toString()
  if (Buffer.byteLength(output.stderr) > 32_768) { child.kill(); app.exit(4) }
})
const code = await new Promise<number>((resolve) => child.once("exit", resolve))
// Utility exit can precede delivery of this fixture's one complete JSON record.
if (code === 0 || code === 2) await record.promise
clearTimeout(timer)
await fs.writeFile(path.join(root, "utility-result.json"), JSON.stringify({ code, ...output }))
app.exit(0)
}

void main().catch((error) => { console.error(error); app.exit(1) })
