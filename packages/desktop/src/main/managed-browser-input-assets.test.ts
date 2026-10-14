import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareManagedBrowserInputAsset, verifyManagedBrowserInputPackAsset } from "../../scripts/managed-browser-input-assets"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"

test.skipIf(process.platform !== "darwin")("fixed Darwin input assets compile and reject pack identity and source mismatches", async () => {
  const directory = await realpath(await mkdtemp("/tmp/dac-browser-input-assets-"))
  await writeFile(path.join(directory, "keep.txt"), "unrelated")
  const asset = await prepareManagedBrowserInputAsset({ directory })
  if (!asset) throw new Error("Darwin asset unavailable")
  expect(asset.target).toBe(process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
  expect(Object.keys(asset).toSorted()).toEqual([
    "bytes", "electronVersion", "filename", "headerInventorySha", "napiVersion", "nodeVersion", "schemaVersion", "sha256", "sourceSha256", "target",
  ])
  expect(asset).toMatchObject(managedBrowserInputRuntime)
  expect(await verifyManagedBrowserInputPackAsset({ directory })).toEqual(asset)
  expect((await readdir(directory)).toSorted()).toEqual([
    "LICENSE", "UPSTREAM.json", "keep.txt", "managed-browser-input-darwin.node", "managed-browser-input.asset.json",
  ])
  const manifest = path.join(directory, "managed-browser-input.asset.json")
  const original = await readFile(manifest)
  for (const change of [
    { filename: "another.node" }, { schemaVersion: "other" }, { napiVersion: 9 }, { bytes: asset.bytes + 1 },
    { sha256: "0".repeat(64) }, { sourceSha256: "0".repeat(64) }, { headerInventorySha: "0".repeat(64) },
    { target: process.arch === "arm64" ? "darwin-x64" : "darwin-arm64" }, { path: "/tmp/arbitrary.node" },
    { electronVersion: "41.10.3" }, { nodeVersion: "0.0.0" },
  ]) {
    await writeFile(manifest, JSON.stringify({ ...asset, ...change }))
    await expect(verifyManagedBrowserInputPackAsset({ directory })).rejects.toThrow()
  }
  await writeFile(manifest, original)
  for (const name of ["UPSTREAM.json", "LICENSE", asset.filename]) {
    const filename = path.join(directory, name)
    const bytes = await readFile(filename)
    await writeFile(filename, Buffer.concat([bytes, Buffer.from("changed")]))
    await expect(verifyManagedBrowserInputPackAsset({ directory })).rejects.toThrow()
    await writeFile(filename, bytes)
  }
  const binary = path.join(directory, asset.filename)
  const bytes = await readFile(binary)
  const wrongArch = Buffer.from(bytes)
  wrongArch.writeUInt32LE(process.arch === "arm64" ? 0x01000007 : 0x0100000c, 4)
  await writeFile(binary, wrongArch)
  await expect(verifyManagedBrowserInputPackAsset({ directory })).rejects.toThrow("Mach-O")
  await writeFile(binary, bytes)
  await chmod(binary, 0o777)
  await expect(verifyManagedBrowserInputPackAsset({ directory })).rejects.toThrow("identity")
  await chmod(binary, 0o755)
  await rm(binary)
  await writeFile(path.join(directory, "foreign.node"), bytes, { mode: 0o755 })
  await symlink(path.join(directory, "foreign.node"), binary)
  await expect(verifyManagedBrowserInputPackAsset({ directory })).rejects.toThrow("physical")
  await rm(binary)
  await writeFile(binary, bytes, { mode: 0o755 })
  await expect(prepareManagedBrowserInputAsset({ directory, target: process.arch === "arm64" ? "darwin-x64" : "darwin-arm64" }))
    .rejects.toThrow("host")
  expect(await verifyManagedBrowserInputPackAsset({ directory })).toEqual(asset)
  expect(await Bun.file(path.join(directory, "keep.txt")).text()).toBe("unrelated")
  console.log("MANAGED_BROWSER_INPUT_ASSETS_EVIDENCE", directory)
}, 30_000)

test.skipIf(process.platform === "darwin")("unsupported hosts remove only fixed managed browser input assets", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-browser-input-assets-unsupported-")))
  await Promise.all(["managed-browser-input-darwin.node", "managed-browser-input.asset.json", "LICENSE", "UPSTREAM.json", "keep.txt"]
    .map((name) => writeFile(path.join(directory, name), "old")))
  expect(await prepareManagedBrowserInputAsset({ directory })).toBeUndefined()
  expect(await readdir(directory)).toEqual(["keep.txt"])
})

test.skipIf(process.platform !== "darwin")("explicit ad-hoc signing hashes the signed bundle and failed signing leaves no asset", async () => {
  const directory = await realpath(await mkdtemp("/tmp/dac-browser-input-assets-sign-"))
  await writeFile(path.join(directory, "keep.txt"), "unrelated")
  const signed = await publishInChild(directory, "-")
  expect({ code: signed.code, stderr: signed.code ? signed.stderr : null }).toEqual({ code: 0, stderr: null })
  const asset = await verifyManagedBrowserInputPackAsset({ directory })
  const signature = Bun.spawn(["/usr/bin/codesign", "--display", "--verbose=4", path.join(directory, asset.filename)],
    { stdout: "pipe", stderr: "pipe" })
  expect(await signature.exited).toBe(0)
  expect(await new Response(signature.stderr).text()).toContain("Signature=adhoc")
  const invalid = await publishInChild(directory, "invalid-name")
  expect(invalid.code).not.toBe(0)
  expect(invalid.stderr).toContain("exact certificate fingerprint")
  expect(await verifyManagedBrowserInputPackAsset({ directory })).toEqual(asset)
  const failed = await realpath(await mkdtemp("/tmp/dac-browser-input-assets-sign-failure-"))
  await writeFile(path.join(failed, "keep.txt"), "unrelated")
  const missing = await publishInChild(failed, "0".repeat(40))
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("signing failed")
  expect(await readdir(failed)).toEqual(["keep.txt"])
  expect(await verifyManagedBrowserInputPackAsset({ directory })).toEqual(asset)
  await Bun.write(path.join(directory, "sign-result.json"), JSON.stringify({
    schemaVersion: "dac.managed-browser-input.sign-proof.v1", asset,
    signature: "adhoc", invalidIdentityRejected: true, missingCertificateCleaned: true,
    fixedHeaders: true, physicalHuman: false, releaseCertificate: false,
  }, null, 2) + "\n")
  console.log("MANAGED_BROWSER_INPUT_ASSETS_SIGN_EVIDENCE", directory, "FAILURE", failed)
}, 30_000)

async function publishInChild(directory: string, identity: string) {
  const child = Bun.spawn([process.execPath, "--eval", `
    const { prepareManagedBrowserInputAsset } = await import("./scripts/managed-browser-input-assets.ts")
    await prepareManagedBrowserInputAsset({ directory: process.env.DAC_INPUT_ASSET_TEST_DIRECTORY })
  `], { cwd: path.resolve(import.meta.dir, "../.."), env: { ...process.env,
    DAC_INPUT_ASSET_TEST_DIRECTORY: directory, DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY: identity,
    DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN: "", DAC_BROWSER_INPUT_NODE_HEADERS: "/tmp/not-an-allowed-header-source" },
    stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10_000)
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  return { code: result[0], stdout: result[1], stderr: result[2] }
}
