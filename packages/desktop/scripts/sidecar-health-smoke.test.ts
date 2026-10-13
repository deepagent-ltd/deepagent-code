import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readSidecarSmokeDiagnostics, withSidecarSmokeCleanup } from "./sidecar-health-smoke"

test("immediate sidecar failure preserves its error, closes, emits only owned closed diagnostics, then cleans", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-smoke-immediate-diagnostic-")))
  const foreign = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-smoke-foreign-diagnostic-")))
  const logs = path.join(root, ".deepagent/code/desktop/ai.deepagent-code.desktop.dev/logs")
  const directory = path.join(logs, "20261012T221718")
  const secret = "private-payer-credential-must-never-appear"
  const records = [
    `Authorization: Bearer ${secret}`,
    `password=${secret} credential=${secret} arbitrary unrelated log ${secret}`,
    `dac-native-path-lease:singlelink:PermissionDenied:Some(5) password=${secret}`,
    `dac-native-first-load:module-private-dacl:native-image-factory.node:PermissionDenied:None token=${secret}`,
    `Error: Windows native sidecar bootstrap unavailable (receipt-current) api_key=${secret}`,
    `Error: Cannot find module 'C:\\private\\${secret}\\native-image-factory.node'`,
    `    at capture (C:\\private\\${secret}\\sidecar.js:17:9)`,
  ].join("\n")
  const state = { closed: false, presentAtReport: false, output: "", trace: [] as string[] }
  const original = new Error(`Sidecar exited before ready with code 1; private ${secret}`)
  try {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "main.log"), "Error: Original Windows native image capture is unavailable\n")
    await fs.writeFile(path.join(directory, "server.log"), records)
    await fs.writeFile(path.join(directory, "unapproved.log"), `Error: ${secret}`)
    const started = performance.now()
    await expect(withSidecarSmokeCleanup({
      root,
      run: async () => { state.trace.push("run"); throw original },
      close: async () => {
        state.trace.push("close")
        state.closed = true
        await fs.writeFile(path.join(directory, "utility.log"), "Sidecar exited before ready with code 1\n")
      },
      report: (diagnostics) => {
        state.trace.push("report")
        state.presentAtReport = existsSync(root)
        state.output = JSON.stringify(diagnostics)
      },
    })).rejects.toBe(original)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(state.trace).toEqual(["run", "close", "report"])
    expect(state.closed).toBe(true)
    expect(state.presentAtReport).toBe(true)
    expect(existsSync(root)).toBe(false)
    expect(state.output).toContain('"stage":"singlelink"')
    expect(state.output).toContain('"errno":5')
    expect(state.output).toContain('"stage":"module-private-dacl"')
    expect(state.output).toContain('"stage":"receipt-current"')
    expect(state.output).toContain('"function":"capture"')
    expect(state.output).toContain('"basename":"native-image-factory.node"')
    expect(state.output).toContain('"exitCode":1')
    expect(state.output).not.toContain(secret)
    expect(state.output).not.toContain("Bearer")
    expect(state.output).not.toContain("C:")
    expect(state.output).not.toContain("unapproved.log")

    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(foreign, "server.log"), records)
    await fs.symlink(path.join(foreign, "server.log"), path.join(directory, "server.log"))
    await expect(readSidecarSmokeDiagnostics(root)).rejects.toThrow("SMOKE_DIAGNOSTIC_FILE_REJECTED")
    await fs.rm(path.join(directory, "server.log"))
    await fs.rm(directory, { recursive: true })
    await fs.symlink(foreign, directory, process.platform === "win32" ? "junction" : "dir")
    await expect(readSidecarSmokeDiagnostics(root)).rejects.toThrow("SMOKE_DIAGNOSTIC_DIRECTORY_REJECTED")
    await fs.rm(directory)
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "server.log"), Buffer.alloc(262_145, 0x61))
    await expect(readSidecarSmokeDiagnostics(root)).rejects.toThrow("SMOKE_DIAGNOSTIC_FILE_REJECTED")
    await fs.writeFile(path.join(directory, "server.log"), records)
    await Promise.all(Array.from({ length: 16 }, (_, index) => fs.mkdir(path.join(logs, `20261012T2217${String(index).padStart(2, "0")}`))))
    await expect(readSidecarSmokeDiagnostics(root)).rejects.toThrow("SMOKE_DIAGNOSTIC_DIRECTORY_BOUND")
    await expect(withSidecarSmokeCleanup({ root, run: async () => { throw original }, close: async () => {}, report: () => { throw new Error(secret) } })).rejects.toBe(original)
    expect(existsSync(root)).toBe(false)
    expect((await fs.readFile(path.join(foreign, "server.log"), "utf8"))).toBe(records)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(foreign, { recursive: true, force: true })
  }
})
