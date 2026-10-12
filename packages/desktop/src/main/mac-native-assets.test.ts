import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { verifyMacNativeAssets } from "../../scripts/mac-native-assets"

test.each(["darwin-arm64", "darwin-x64"] as const)("publisher verifies complete same-target %s physical images", async (target) => {
  await using fixture = await images(target)
  const verified = await verifyMacNativeAssets(fixture.directory, fixture.runtime)
  expect(verified.target).toBe(target)
  expect(verified.files.toSorted()).toEqual(fixture.assets.map((entry) => path.join(fixture.directory, path.basename(entry.path))).toSorted())
})

test("publisher rejects mislabeled, mixed, repeated, missing and changed Mac assets before sealing", async () => {
  await using fixture = await images("darwin-x64")
  await fixture.metadata("darwin-arm64", fixture.assets)
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("same target")
  await fixture.metadata("darwin-x64", fixture.assets.map((entry, index) => index === 0
    ? { ...entry, path: entry.path.replace("darwin-x64", "darwin-arm64") } : entry))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("same target")
  await fixture.metadata("darwin-x64", [fixture.assets[0]!, fixture.assets[0]!, fixture.assets[2]!])
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("same target")
  await fixture.metadata("darwin-x64", fixture.assets.slice(0, 2))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("same target")
  await fixture.metadata("darwin-x64", fixture.assets)
  await fs.writeFile(fixture.runtime, image("darwin-arm64"))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("architecture")
  await fs.writeFile(fixture.runtime, image("darwin-x64"))
  await fs.writeFile(path.join(fixture.directory, "bun-command-runtime"), Buffer.concat([image("darwin-x64"), Buffer.from("changed")]))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("bounded private executable")
  await fs.writeFile(path.join(fixture.directory, "bun-command-runtime"), image("darwin-arm64"))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("architecture")
  const changed = image("darwin-x64")
  changed[31] = 1
  await fs.writeFile(path.join(fixture.directory, "bun-command-runtime"), changed)
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("component inventory")
  await fs.writeFile(path.join(fixture.directory, "bun-command-runtime"), image("darwin-x64"))
  await fs.link(path.join(fixture.directory, "bun-command-runtime"), path.join(fixture.directory, "runtime-link"))
  await expect(verifyMacNativeAssets(fixture.directory, fixture.runtime)).rejects.toThrow("bounded private executable")
})

async function images(target: "darwin-arm64" | "darwin-x64") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mac-asset-inventory-")))
  await fs.chmod(directory, 0o700)
  const runtime = path.join(directory, "actual-helper")
  // Bounded header fixtures exercise inventory validation; they are never launched or signed.
  await fs.writeFile(runtime, image(target), { mode: 0o755 })
  const assets = await Promise.all(["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "bun-command-runtime"].map(async (name) => {
    const bytes = image(target)
    await fs.writeFile(path.join(directory, name), bytes, { mode: 0o755 })
    return { path: `packages/work-file-helper/bin/${target}/${name}`, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }
  }))
  const metadata = (target: string, entries: typeof assets) => Bun.write(path.join(directory, "node.js.native-components.json"),
    JSON.stringify({ schemaVersion: "dac.native-components.v1", target,
      sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40), components: entries }))
  await metadata(target, assets)
  return { directory, runtime, assets, metadata,
    [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }) }
}

function image(target: "darwin-arm64" | "darwin-x64") {
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(target === "darwin-x64" ? 0x01000007 : 0x0100000c, 4)
  bytes.writeUInt32LE(2, 12)
  return bytes
}
