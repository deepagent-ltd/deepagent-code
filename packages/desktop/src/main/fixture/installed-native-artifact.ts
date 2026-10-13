import { app, utilityProcess } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

const root = process.env.DAC_INSTALLED_ARTIFACT_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const module = path.join(process.resourcesPath, "app.asar.unpacked/out/main/chunks/node.js")
  const child = utilityProcess.fork(module, [], {
    env: { HOME: root, TMPDIR: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    stdio: "pipe",
  })
  const output = { stdout: "", stderr: "" }
  const timer = setTimeout(() => {
    child.kill()
    app.exit(3)
  }, 15_000)
  child.stdout?.on("data", (bytes: Buffer) => {
    output.stdout += bytes.toString()
    if (Buffer.byteLength(output.stdout) > 32_768) {
      child.kill()
      app.exit(4)
    }
  })
  child.stderr?.on("data", (bytes: Buffer) => {
    output.stderr += bytes.toString()
    if (Buffer.byteLength(output.stderr) > 32_768) {
      child.kill()
      app.exit(4)
    }
  })
  child.on("exit", (code) => {
    clearTimeout(timer)
    void fs
      .writeFile(path.join(root, "installed-result.json"), JSON.stringify({ code, ...output }))
      .then(() => app.exit(0))
  })
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
