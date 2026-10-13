#!/usr/bin/env bun
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { Configuration } from "electron-builder"

const desktop = path.resolve(import.meta.dir, "..")

/** Fixed packed paths only. This selects an artifact; it does not claim that its
 * architecture or Main/preload/sidecar works before the original smoke runs. */
export async function inspectTestPackageExecutable(input: { directory: string; target: string }) {
  const target = new Map([
    ["darwin-arm64", { packed: "mac-arm64", platform: "darwin", arch: "arm64" }],
    ["darwin-x64", { packed: "mac", platform: "darwin", arch: "x64" }],
    ["win32-x64", { packed: "win-unpacked", platform: "win32", arch: "x64" }],
    ["linux-x64", { packed: "linux-unpacked", platform: "linux", arch: "x64" }],
  ]).get(input.target)
  if (!target) throw new Error("Unsupported native test package target")
  if (process.env.DEEPAGENT_CODE_CHANNEL && process.env.DEEPAGENT_CODE_CHANNEL !== "dev")
    throw new Error("Test package smoke requires the Dev channel")
  const directory = await fs.realpath(input.directory)
  const configuration = await import(new URL("../electron-builder.config.ts", import.meta.url).href) as { default: Configuration }
  assert.equal(configuration.default.productName, "DeepAgent Code Dev", "Test package smoke requires the Dev package")
  const executableName = target.platform === "linux" ? await (async () => {
    // Initialize only the real builder metadata. No build, targets, install,
    // asset preparation, signing or publishing is invoked.
    const { Packager, LinuxPackager } = await import("electron-builder")
    // Only these real configuration fields affect AppInfo/Linux executable
    // naming. Avoid passing asset/signing callbacks or letting normalization
    // mutate the shared configuration's files arrays during a read-only probe.
    const packager = new Packager({ projectDir: desktop, config: {
      extends: null,
      productName: configuration.default.productName,
      executableName: configuration.default.executableName,
      extraMetadata: configuration.default.extraMetadata,
      linux: configuration.default.linux,
    } })
    await packager.validateConfig()
    return new LinuxPackager(packager).executableName
  })() : "DeepAgent Code Dev"
  if (!executableName || path.basename(executableName) !== executableName)
    throw new Error("The builder executable name is invalid")
  const executableParts = target.platform === "darwin"
    ? [target.packed, "DeepAgent Code Dev.app", "Contents", "MacOS", executableName]
    : [target.packed, target.platform === "win32" ? `${executableName}.exe` : executableName]
  const resourceParts = target.platform === "darwin"
    ? [target.packed, "DeepAgent Code Dev.app", "Contents", "Resources", "app.asar"]
    : [target.packed, "resources", "app.asar"]
  for (const parts of [executableParts, resourceParts]) {
    for (const [index] of parts.entries()) {
      const candidate = path.join(directory, ...parts.slice(0, index + 1))
      const physical = await fs.lstat(candidate)
      if (physical.isSymbolicLink() || (index === parts.length - 1 ? !physical.isFile() || physical.size === 0 : !physical.isDirectory()))
        throw new Error("Test package must contain physical packed directories and files")
      if (await fs.realpath(candidate) !== candidate)
        throw new Error("Test package path is not canonical")
    }
  }
  const executable = path.join(directory, ...executableParts)
  if (target.platform !== "win32") await fs.access(executable, constants.X_OK)
  return { target: input.target, platform: target.platform, arch: target.arch, executable, resources: path.join(directory, ...resourceParts) }
}

if (import.meta.main) {
  const target = process.env.DAC_TEST_PACKAGE_TARGET
  if (!target || target !== `${process.platform}-${process.arch}`)
    throw new Error("Test package smoke requires the current native platform and architecture")
  const selected = await inspectTestPackageExecutable({ directory: path.join(desktop, "dist"), target })
  console.log("Running the original packaged sidecar smoke", { target: selected.target, executable: selected.executable })
  const child = spawn("node", ["--experimental-strip-types", path.join(desktop, "scripts", "sidecar-health-smoke.ts")], {
    cwd: desktop,
    env: { ...process.env, DEEPAGENT_CODE_DESKTOP_EXECUTABLE: selected.executable },
    stdio: "inherit",
    shell: false,
  })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0 || result.signal)
    throw new Error(`Original packaged sidecar smoke failed: code=${result.code}, signal=${result.signal ?? "none"}`)
}
