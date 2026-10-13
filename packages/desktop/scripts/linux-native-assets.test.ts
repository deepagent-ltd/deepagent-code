import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LINUX_NATIVE_DEV_MANIFEST, LINUX_NATIVE_DEV_DOMAIN, type LinuxNativeDevManifest } from "../../deepagent-code/script/build-linux-native-assets"
import { verifyLinuxNativeAssets } from "./linux-native-assets"

const hash = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex")
async function packageFixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-linux-dev-asset-pack-"))
  const directory = path.join(root, "resources/app.asar.unpacked/out/main/chunks")
  await fs.mkdir(directory, { recursive: true })
  const elf = Buffer.alloc(128)
  elf.writeUInt32LE(0x464c457f, 0); elf[4] = 2; elf[5] = 1; elf[6] = 1
  elf.writeUInt16LE(3, 16); elf.writeUInt16LE(62, 18); elf.writeUInt32LE(1, 20)
  const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor", "bun-command-runtime",
    "runtime-closure/lib64/ld-linux-x86-64.so.2", "runtime-closure/lib/x86_64-linux-gnu/libc.so.6", "runtime-closure/usr/lib/x86_64-linux-gnu/libc.so.6"]
  await Promise.all(names.map(async (name) => {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true })
    await fs.writeFile(path.join(directory, name), elf, { mode: 0o755 })
  }))
  await fs.mkdir(path.join(directory, "linux-native-licenses"))
  await fs.writeFile(path.join(directory, "linux-native-licenses/libc6.copyright"), "fixture copyright\n", { mode: 0o644 })
  await fs.writeFile(path.join(directory, "linux-native-licenses/NOTICE"), "fixture data-only notice\n", { mode: 0o644 })
  const licenses = await Promise.all(["LICENSE", "NOTICE", "UPSTREAM.json"].map(async (name) => {
    const filename = `linux-native-licenses/work-file-helper.${name}`
    await fs.copyFile(path.resolve(import.meta.dirname, "../../work-file-helper", name), path.join(directory, filename))
    await fs.chmod(path.join(directory, filename), 0o644)
    const body = await fs.readFile(path.join(directory, filename))
    return { path: filename, bytes: body.length, sha256: hash(body) }
  }))
  const manifest = { schemaVersion: LINUX_NATIVE_DEV_DOMAIN, target: "linux-x64", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), runtimeVersion: "fixture-only",
    source: [{ path: "packages/work-file-helper/Cargo.lock", bytes: 1, sha256: hash("source") }],
    tools: ["cargo", "rustc", "readelf", "ldconfig", "dpkg-query", "git"].map((name) => ({ name, bytes: 1, sha256: hash(name), version: "fixture; not executed" })),
    assets: names.map((name) => ({ path: `packages/work-file-helper/bin/linux-x64/${name}`, bytes: elf.length, sha256: hash(elf) })),
    licenses: [{ path: "linux-native-licenses/libc6.copyright", bytes: Buffer.byteLength("fixture copyright\n"), sha256: hash("fixture copyright\n") },
      { path: "linux-native-licenses/NOTICE", bytes: Buffer.byteLength("fixture data-only notice\n"), sha256: hash("fixture data-only notice\n") }, ...licenses] } satisfies LinuxNativeDevManifest
  const write = () => fs.writeFile(path.join(directory, LINUX_NATIVE_DEV_MANIFEST), CanonicalJson.stringify(manifest), { mode: 0o644 })
  await write()
  return { root, directory, manifest, write }
}

test("final unpacked package checks original full manifest and regular loader aliases without invoking ELF payloads", async () => {
  const value = await packageFixture()
  try {
    const result = await verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64", expectedManifestHash: hash(CanonicalJson.stringify(value.manifest)) })
    expect(result.files).toHaveLength(13)
    expect(result.manifest.assets).toHaveLength(7)
    const original = await fs.lstat(path.join(value.directory, "runtime-closure/lib/x86_64-linux-gnu/libc.so.6"))
    const alias = await fs.lstat(path.join(value.directory, "runtime-closure/usr/lib/x86_64-linux-gnu/libc.so.6"))
    expect(original.ino).not.toBe(alias.ino)
    expect(original.nlink).toBe(1); expect(alias.nlink).toBe(1)
    expect(result.manifest.schemaVersion).toBe("dac.linux-native-dev-assets.v1")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("package closure and license trees reject missing, unlisted or linked bytes and exact-manifest conflicts", async () => {
  const value = await packageFixture()
  const loader = path.join(value.directory, "runtime-closure/lib64/ld-linux-x86-64.so.2")
  const original = await fs.readFile(loader)
  try {
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64", expectedManifestHash: "f".repeat(64) })).rejects.toThrow("cohort")
    await fs.rm(loader)
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow()
    await fs.writeFile(loader, original, { mode: 0o755 })
    await fs.writeFile(path.join(value.directory, "runtime-closure/lib64/unlisted.so"), original, { mode: 0o755 })
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("unrecorded")
    await fs.rm(path.join(value.directory, "runtime-closure/lib64/unlisted.so"))
    await fs.writeFile(path.join(value.directory, "linux-native-licenses/libc6.copyright"), "wrong copyright\n")
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("license differs")
    await fs.writeFile(path.join(value.directory, "linux-native-licenses/libc6.copyright"), "fixture copyright\n")
    await fs.rename(path.join(value.directory, "runtime-closure/lib64"), path.join(value.directory, "real-lib64"))
    await fs.symlink("../real-lib64", path.join(value.directory, "runtime-closure/lib64"))
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("physical files")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})

test("package data manifest denies unsafe closure path and missing build-tool provenance", async () => {
  const value = await packageFixture()
  try {
    value.manifest.assets[4] = { ...value.manifest.assets[4]!, path: "packages/work-file-helper/bin/linux-x64/runtime-closure/lib/../foreign.so" }
    await value.write()
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("unsafe")
    value.manifest.assets[4] = { ...value.manifest.assets[4]!, path: "packages/work-file-helper/bin/linux-x64/runtime-closure/lib64/ld-linux-x86-64.so.2" }
    value.manifest.tools = value.manifest.tools.filter((tool) => tool.name !== "readelf")
    await value.write()
    await expect(verifyLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("provenance")
  } finally { await fs.rm(value.root, { recursive: true, force: true }) }
})
