#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

export async function inspectTestInstallers(input: { directory: string; target: string }) {
  const expected = new Map([
    ["darwin-arm64", ["deepagent-code-desktop-mac-arm64.dmg", "deepagent-code-desktop-mac-arm64.zip"]],
    ["darwin-x64", ["deepagent-code-desktop-mac-x64.dmg", "deepagent-code-desktop-mac-x64.zip"]],
    ["linux-x64", ["deepagent-code-desktop-linux-x64.deb"]],
    ["win32-x64", ["deepagent-code-desktop-win-x64.exe"]],
  ]).get(input.target)
  if (!expected) throw new Error("Unsupported native test package target")
  const directory = await fs.realpath(input.directory)
  const actual = (await fs.readdir(directory)).filter((name) => /\.(?:dmg|zip|deb|exe)$/.test(name)).toSorted()
  if (JSON.stringify(actual) !== JSON.stringify(expected.toSorted()))
    throw new Error(`Test installer target mismatch: expected ${expected.join(", ")}`)
  return Promise.all(expected.map(async (name) => {
    const filename = path.join(directory, name)
    const opened = await fs.open(filename, "r")
    try {
      const before = await opened.stat({ bigint: true })
      const physical = await fs.lstat(filename, { bigint: true })
      if (!before.isFile() || !physical.isFile() || before.nlink !== 1n || before.size < 512n ||
        before.size > 8_589_934_592n || before.dev !== physical.dev || before.ino !== physical.ino)
        throw new Error("Test installer must be a bounded physical file")
      const digest = createHash("sha256")
      const buffer = Buffer.alloc(1_048_576)
      const bytes = { value: 0 }
      while (true) {
        const read = await opened.read(buffer, 0, buffer.length, null)
        if (!read.bytesRead) break
        bytes.value += read.bytesRead
        if (BigInt(bytes.value) > before.size) throw new Error("Test installer changed during inventory")
        digest.update(buffer.subarray(0, read.bytesRead))
      }
      const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":")
      if (BigInt(bytes.value) !== before.size || stamp(before) !== stamp(await opened.stat({ bigint: true })) ||
        stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })))
        throw new Error("Test installer changed during inventory")
      return { filename: name, bytes: bytes.value, sha256: digest.digest("hex") }
    } finally {
      await opened.close()
    }
  }))
}

if (import.meta.main) {
  const target = process.env.DAC_TEST_PACKAGE_TARGET
  if (!target) throw new Error("DAC_TEST_PACKAGE_TARGET is required")
  const files = await inspectTestInstallers({ directory: path.resolve("dist"), target })
  await Bun.write("dist/test-package-checksums.json", JSON.stringify({ version: "2.0.3", runtimeVersion: process.env.DEEPAGENT_CODE_VERSION ?? null, target, files }, null, 2) + "\n")
}
