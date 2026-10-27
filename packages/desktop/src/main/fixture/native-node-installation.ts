import { app, utilityProcess } from "electron"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import path from "node:path"

const root = process.env.DAC_NATIVE_NODE_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  if (process.platform === "win32" && !process.env.SystemRoot)
    throw new Error("Windows utility fixture requires SystemRoot")
  // Electron replaces this environment; Windows still needs its OS runtime root.
  const child = utilityProcess.fork(process.env.DAC_NATIVE_NODE_ENTRY!, [], {
    env: {
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
    stdio: "pipe",
  })
  const output = { stdout: "", stderr: "" }
  const stage = {
    phase: "waiting-spawn",
    utilityPID: 0,
    code: undefined as number | undefined,
    stdoutEnded: false,
    stderrEnded: false,
    record: false,
  }
  const persist = () => writeFileSync(path.join(root, "utility-result.json"), JSON.stringify({ ...stage, ...output }))
  const record = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    persist()
    console.error(
      "NATIVE_NODE_FIXTURE_TIMEOUT",
      JSON.stringify({
        ...stage,
        stdoutBytes: Buffer.byteLength(output.stdout),
        stderrBytes: Buffer.byteLength(output.stderr),
      }),
    )
    child.kill()
    app.exit(3)
  }, 15_000)
  child.once("spawn", () => {
    stage.utilityPID = child.pid ?? 0
    stage.phase = "waiting-exit"
  })
  child.stdout?.on("data", (bytes: Buffer) => {
    output.stdout += bytes.toString()
    if (Buffer.byteLength(output.stdout) > 32_768) {
      child.kill()
      app.exit(4)
    }
    if (output.stdout.endsWith("\n")) {
      stage.record = true
      record.resolve()
    }
  })
  child.stdout?.once("end", () => {
    stage.stdoutEnded = true
  })
  child.stderr?.on("data", (bytes: Buffer) => {
    output.stderr += bytes.toString()
    if (Buffer.byteLength(output.stderr) > 32_768) {
      child.kill()
      app.exit(4)
    }
  })
  child.stderr?.once("end", () => {
    stage.stderrEnded = true
  })
  const code = await new Promise<number>((resolve) => child.once("exit", resolve))
  stage.code = code
  // Utility exit can precede delivery of this fixture's one complete JSON record.
  if (code === 0 || code === 2) {
    stage.phase = "waiting-record"
    await record.promise
  }
  clearTimeout(timer)
  stage.phase = "completed"
  await fs.writeFile(path.join(root, "utility-result.json"), JSON.stringify({ ...stage, code, ...output }))
  app.exit(0)
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
