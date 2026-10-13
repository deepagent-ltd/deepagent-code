// Explicit signed diagnostic entry. Its CA is public and baked into the signed input;
// production Node bootstrap, transport, Root, verifier and runner are unchanged.
import tls from "node:tls"
import fs from "node:fs/promises"
import path from "node:path"

declare const DEEPAGENT_NATIVE_NODE_FIXTURE_CA: string

async function main() {
  const { app, utilityProcess } = await import("electron")
  const directory = process.env.DAC_NATIVE_NODE_WORK_DIRECTORY!
  app.setPath("userData", path.join(directory, "electron-user"))
  app.setPath("sessionData", path.join(directory, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const child = utilityProcess.fork(process.env.DAC_NATIVE_NODE_WORK_MODULE!, [], {
    cwd: process.cwd(), env: { ...process.env, DAC_NATIVE_NODE_WORK_ROLE: "utility" }, stdio: "pipe",
  })
  const output = { stdout: "", stderr: "" }
  const timer = setTimeout(() => { child.kill(); app.exit(3) }, 120000)
  child.stdout?.on("data", (bytes: Buffer) => { output.stdout += bytes.toString(); if (Buffer.byteLength(output.stdout) > 262144) { child.kill(); app.exit(4) } })
  child.stderr?.on("data", (bytes: Buffer) => { output.stderr += bytes.toString(); if (Buffer.byteLength(output.stderr) > 262144) { child.kill(); app.exit(4) } })
  child.on("exit", (code) => {
    clearTimeout(timer)
    void fs.writeFile(process.env.DAC_NATIVE_NODE_WORK_EXIT!, JSON.stringify({ code, runtime: process.versions.node,
      stdout: output.stdout, stderr: output.stderr }), { mode: 0o600 }).then(() => app.exit(code ?? 1))
  })
}

async function utility() {
  if (typeof DEEPAGENT_NATIVE_NODE_FIXTURE_CA !== "string" || !DEEPAGENT_NATIVE_NODE_FIXTURE_CA.includes("BEGIN CERTIFICATE"))
    throw new Error("The fixed signed fixture startup CA is unavailable")
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), DEEPAGENT_NATIVE_NODE_FIXTURE_CA])
  // This is the original executable module. Its first dependency captures the now-fixed
  // startup state, before any plugin or application Root is constructed.
  await import("../../../src/node")
  const { Effect, Exit, Cause, Layer, Schema } = await import("effect")
  const { AppRuntime } = await import("../../../src/effect/app-runtime")
  try {
    if (process.env.DAC_NATIVE_NODE_WORK_COMMAND) {
      const { command } = await import("../../../src/cli/cmd/operator")
      const { Database } = await import("@deepagent-code/core/database/database")
      const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
      const { FSUtil } = await import("@deepagent-code/core/fs-util")
      const { ServerAuth } = await import("../../../src/server/auth")
      const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
        action: Schema.Literals(["enroll", "approve-route"]), operationID: Schema.String,
        policyPath: Schema.optional(Schema.String), targetID: Schema.optional(Schema.String),
        snapshot: Schema.optional(Schema.String), expiresAt: Schema.optional(Schema.Int),
        expectedRevision: Schema.optional(Schema.Int), expectedRouteRevision: Schema.optional(Schema.Int),
      })), { onExcessProperty: "error" })(process.env.DAC_NATIVE_NODE_WORK_COMMAND)
      const database = Database.defaultLayer
      const exit = await Effect.runPromiseExit(command(input).pipe(
        Effect.provide(LocationIdentity.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer))),
        Effect.provide(database), Effect.provide(ServerAuth.Config.defaultLayer), Effect.scoped,
      ))
      if (Exit.isFailure(exit)) throw new Error(`Original operator command refused: ${Cause.pretty(exit.cause)}`)
      await fs.writeFile(process.env.DAC_NATIVE_NODE_WORK_COMMAND_RESULT!, JSON.stringify({ state: "completed", action: input.action }), { mode: 0o600 })
      return
    }
    const { DebugCommand } = await import("../../im/fixture/kernel-task-child-production")
    await DebugCommand.handler({ _: [], $0: "private-native-node-work" })
  } finally { await AppRuntime.dispose() }
}

if (process.env.DAC_NATIVE_NODE_WORK_ROLE === "main") void main().catch(() => process.exit(1))
if (process.env.DAC_NATIVE_NODE_WORK_ROLE !== "main") {
  try {
    await utility()
    process.stdout.write("NATIVE_NODE_WORK_PRIVATE_DONE\n", () => process.exit(0))
  } catch (error) { console.error(error); process.exitCode = 1 }
}
