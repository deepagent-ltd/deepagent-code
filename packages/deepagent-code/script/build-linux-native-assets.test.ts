import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { buildLinuxNativeAssets, inspectLinuxNativeAssets, linuxNativeCargoInvocation, LINUX_NATIVE_DEV_MANIFEST, LINUX_NATIVE_DEV_DOMAIN, type LinuxNativeDevManifest, type LinuxNativeTarget } from "./build-linux-native-assets"

const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor", "bun-command-runtime"]
const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex")
async function fixture(target: LinuxNativeTarget = "linux-x64") {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-linux-dev-asset-core-"))
  const elf = Buffer.alloc(128)
  elf.writeUInt32LE(0x464c457f, 0)
  elf[4] = 2; elf[5] = 1; elf[6] = 1
  elf.writeUInt16LE(2, 16); elf.writeUInt16LE(target === "linux-x64" ? 62 : 183, 18); elf.writeUInt32LE(1, 20)
  elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56)
  elf.writeUInt32LE(1, 64); elf.writeUInt32LE(5, 68); elf.writeBigUInt64LE(128n, 96); elf.writeBigUInt64LE(128n, 104)
  await Promise.all(names.map((name) => fs.writeFile(path.join(directory, name), elf, { mode: 0o755 })))
  await fs.mkdir(path.join(directory, "linux-native-licenses"))
  await fs.writeFile(path.join(directory, "linux-native-licenses/NOTICE"), "fixture provenance\n", { mode: 0o644 })
  const licenses = await Promise.all(["LICENSE", "NOTICE", "UPSTREAM.json"].map(async (name) => {
    const filename = `linux-native-licenses/work-file-helper.${name}`
    await fs.copyFile(path.resolve(import.meta.dirname, "../../work-file-helper", name), path.join(directory, filename))
    await fs.chmod(path.join(directory, filename), 0o644)
    const body = await fs.readFile(path.join(directory, filename))
    return { path: filename, bytes: body.length, sha256: digest(body) }
  }))
  const manifest = { schemaVersion: LINUX_NATIVE_DEV_DOMAIN, target,
    sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), runtimeVersion: "fixture-only",
    source: [{ path: "packages/work-file-helper/Cargo.lock", bytes: 1, sha256: digest("x") }],
    tools: ["cargo", "rustc", "readelf", "ldconfig", "dpkg-query", "git"].map((name) => ({ name, bytes: 1, sha256: digest(name), version: "fixture tool metadata; not executed" })),
    assets: names.map((name) => ({ path: `packages/work-file-helper/bin/${target}/${name}`, bytes: elf.length, sha256: digest(elf) })),
    licenses: [{ path: "linux-native-licenses/NOTICE", bytes: Buffer.byteLength("fixture provenance\n"), sha256: digest("fixture provenance\n") }, ...licenses] } satisfies LinuxNativeDevManifest
  const write = () => fs.writeFile(path.join(directory, LINUX_NATIVE_DEV_MANIFEST), CanonicalJson.stringify(manifest), { mode: 0o644 })
  await write()
  return { directory, manifest, write }
}

test("non-Linux host refuses physical build before any output, tool or payload exists", async () => {
  if (process.platform === "linux") return
  const directory = await fs.mkdtemp("/tmp/dac-linux-dev-asset-guard-")
  try {
    await expect(buildLinuxNativeAssets({ destination: path.join(directory, "assets") })).rejects.toThrow("native Linux")
    expect(await fs.readdir(directory)).toEqual([])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("actual ELF file cohort accepts both native target headers and preserves exact data-only hash", async () => {
  for (const target of ["linux-x64", "linux-arm64"] as const) {
    const value = await fixture(target)
    try {
      const hash = digest(CanonicalJson.stringify(value.manifest))
      const verified = await inspectLinuxNativeAssets({ directory: value.directory, target, expectedManifestHash: hash })
      expect(verified.manifestHash).toBe(hash)
      expect(verified.manifest).toEqual(value.manifest)
      expect(verified.files).toHaveLength(9)
      expect(verified.manifest).not.toHaveProperty("signature")
      expect(verified.manifest).not.toHaveProperty("runtimeAuthority")
    } finally { await fs.rm(value.directory, { recursive: true, force: true }) }
  }
})

test("captured Cargo invocation uses actual compiler and one three-bin target directory, never Rustup argv0", () => {
  for (const target of ["linux-x64", "linux-arm64"] as const) {
    const result = linuxNativeCargoInvocation({ cargo: "/toolchain/bin/cargo", rustc: "/toolchain/bin/rustc", target, targetDirectory: "/owned/cargo", environment: { PATH: "/original/path", RUSTC: "/wrong/compiler", CARGO_TARGET_DIR: "/old/target" } })
    expect(result.args).toEqual(["build", "--locked", "--release", "--bin", "deepagent-work-file-helper", "--bin", "deepagent-work-storage-cleanup", "--bin", "deepagent-work-process-supervisor", "--target", target === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu"])
    expect(result.env.RUSTC).toBe("/toolchain/bin/rustc")
    expect(result.env.CARGO_TARGET_DIR).toBe("/owned/cargo")
    expect(Object.entries(result.env)).toContainEqual(["PATH", "/original/path"])
    expect(result.rustTarget).toBe(target === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu")
  }
  expect(() => linuxNativeCargoInvocation({ cargo: "/toolchain/bin/rustup", rustc: "/toolchain/bin/rustc", target: "linux-x64", targetDirectory: "/owned/cargo" })).toThrow("actual absolute")
  expect(() => linuxNativeCargoInvocation({ cargo: "/toolchain/bin/cargo", rustc: "/toolchain/bin/rustup", target: "linux-x64", targetDirectory: "/owned/cargo" })).toThrow("actual absolute")
  expect(() => linuxNativeCargoInvocation({ cargo: "cargo", rustc: "/toolchain/bin/rustc", target: "linux-x64", targetDirectory: "/owned/cargo" })).toThrow("actual absolute")
  expect(() => linuxNativeCargoInvocation({ cargo: "/toolchain/bin/cargo", rustc: "/toolchain/bin/rustc", target: "linux-x64", targetDirectory: "/owned/cargo", environment: { RUSTC_WRAPPER: "/unrecorded/wrapper" } })).toThrow("uncaptured")
})

test("component provenance requires all original license files and only optional captured Rustup metadata", async () => {
  const value = await fixture()
  try {
    value.manifest.tools.push({ name: "rustup", bytes: 1, sha256: digest("rustup"), version: "fixture dispatcher metadata; not executed" })
    await value.write()
    expect((await inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).manifest.tools).toHaveLength(7)
    value.manifest.licenses = value.manifest.licenses.filter((entry) => !entry.path.endsWith("UPSTREAM.json"))
    await value.write()
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow()
    value.manifest.tools.push({ name: "custom", bytes: 1, sha256: digest("custom"), version: "not permitted" })
    const body = await fs.readFile(path.join(value.directory, "linux-native-licenses/work-file-helper.UPSTREAM.json"))
    value.manifest.licenses.push({ path: "linux-native-licenses/work-file-helper.UPSTREAM.json", bytes: body.length, sha256: digest(body) })
    await value.write()
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("provenance")
  } finally { await fs.rm(value.directory, { recursive: true, force: true }) }
})

test("fixed four assets fail on absent supervisor, byte change, wrong ABI, unsafe mode and physical alias", async () => {
  const value = await fixture()
  const filename = path.join(value.directory, names[2]!)
  const original = await fs.readFile(filename)
  try {
    await fs.rm(filename)
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow()
    await fs.writeFile(filename, original, { mode: 0o755 })
    const changed = Buffer.from(original); changed[127] = 7
    await fs.writeFile(filename, changed)
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("differs")
    const foreign = Buffer.from(original); foreign.writeUInt16LE(183, 18)
    await fs.writeFile(filename, foreign)
    value.manifest.assets[2] = { ...value.manifest.assets[2]!, sha256: digest(foreign) }
    await value.write()
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("matching native ELF64")
    await fs.writeFile(filename, original)
    value.manifest.assets[2] = { ...value.manifest.assets[2]!, sha256: digest(original) }; await value.write()
    await fs.chmod(filename, 0o777)
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("private regular")
    await fs.chmod(filename, 0o755)
    await fs.link(filename, path.join(value.directory, "foreign-link"))
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("private regular")
    await fs.rm(path.join(value.directory, "foreign-link")); await fs.rename(filename, path.join(value.directory, "real-image"))
    await fs.symlink("real-image", filename)
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("physical files")
  } finally { await fs.rm(value.directory, { recursive: true, force: true }) }
})

test("data inventory rejects stale signed receipt, unknown grant fields, crossed target and declared over-budget copies", async () => {
  const value = await fixture()
  try {
    await fs.writeFile(path.join(value.directory, "node.js.native-installation.json"), "old", { mode: 0o644 })
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("installation receipt")
    await fs.rm(path.join(value.directory, "node.js.native-installation.json"))
    await fs.writeFile(path.join(value.directory, LINUX_NATIVE_DEV_MANIFEST), CanonicalJson.stringify({ ...value.manifest, signature: "fake" }))
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow()
    await value.write()
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-arm64" })).rejects.toThrow("cohort")
    value.manifest.assets.forEach((entry) => { entry.bytes = 268_435_456 })
    await value.write()
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow("over budget")
  } finally { await fs.rm(value.directory, { recursive: true, force: true }) }
})
