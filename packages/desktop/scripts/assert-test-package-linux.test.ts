import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { inspectTestInstallers } from "./assert-test-package"

test("Linux x64 accepts only the runner's Debian amd64 filename and retains physical file guards", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-test-installer-name-"))
  const filename = path.join(directory, "deepagent-code-desktop-linux-amd64.deb")
  // Naming and physical-byte inspection only; these fixture bytes do not
  // attest Debian installability or execute any packaged runtime.
  const bytes = Buffer.alloc(512, 0x61)
  try {
    await Bun.write(filename, bytes)
    expect(await inspectTestInstallers({ directory, target: "linux-x64" })).toEqual([
      { filename: path.basename(filename), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ])
    await fs.rename(filename, path.join(directory, "deepagent-code-desktop-linux-x64.deb"))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await Bun.write(filename, bytes)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await fs.rm(path.join(directory, "deepagent-code-desktop-linux-x64.deb"))
    await Bun.write(path.join(directory, "foreign.deb"), bytes)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("Test installer target mismatch")
    await fs.rm(path.join(directory, "foreign.deb"))
    await expect(inspectTestInstallers({ directory, target: "linux-arm64" })).rejects.toThrow("Unsupported native test package target")
    await fs.link(filename, path.join(directory, "second-link"))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await fs.rm(path.join(directory, "second-link"))
    await fs.rename(filename, path.join(directory, "source-bytes"))
    await fs.symlink(path.join(directory, "source-bytes"), filename)
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await fs.rm(filename)
    await Bun.write(filename, bytes.subarray(0, 511))
    await expect(inspectTestInstallers({ directory, target: "linux-x64" })).rejects.toThrow("bounded physical file")
    await Bun.write(filename, bytes)
    expect((await inspectTestInstallers({ directory, target: "linux-x64" }))[0]?.bytes).toBe(bytes.length)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
