import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { buildLinuxNativeAssets, inspectLinuxNativeAssets, linuxNativeCargoInvocation, linuxNativeCopyrightCopy, linuxNativeCopyrightMetadata, linuxNativeImageRejection, linuxNativePackageOwnership, linuxNativePackageProvenance, LINUX_NATIVE_DEV_MANIFEST, LINUX_NATIVE_DEV_DOMAIN, type LinuxNativeDevManifest, type LinuxNativeTarget } from "./build-linux-native-assets"

const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "deepagent-work-process-supervisor", "bun-command-runtime"]
const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex")

test("package provenance diagnostics preserve unique-owner refusal and bounded system paths", () => {
  const logical = "/lib64/ld-linux-x86-64.so.2"
  const canonical = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
  expect(linuxNativePackageProvenance({ logical, canonical, output: `libc6:amd64: ${logical}\n` })).toBe("libc6")
  expect(() => linuxNativePackageProvenance({ logical, canonical, output: `libc6:amd64: ${logical}\nlibc6:amd64: ${canonical}\n` }))
    .toThrow(`logical=${logical}, canonical=${canonical}, records=2`)
  expect(() => linuxNativePackageProvenance({ logical, canonical, output: `libc6:amd64: ${logical}\nforeign: ${canonical}\n` }))
    .toThrow("unambiguous package provenance")
  expect(() => linuxNativePackageProvenance({ logical, canonical, output: "untrusted ownership" })).toThrow("records=1")
  expect(() => linuxNativePackageProvenance({ logical: "/private/credential", canonical: "/usr/lib/unsafe\nvalue", output: "invalid" }))
    .toThrow("logical=unavailable, canonical=unavailable, records=1")
  expect(() => linuxNativePackageProvenance({ logical: `/lib/${"a".repeat(513)}`, canonical, output: "invalid" }))
    .toThrow(`logical=unavailable, canonical=${canonical}, records=1`)
  expect(() => linuxNativePackageProvenance({ logical, canonical, output: Array.from({ length: 200 }, () => `libc6:amd64: ${logical}`).join("\n") }))
    .toThrow("records=129")
})

test("canonical package ownership uses physical metadata and only falls back for an unregistered path", async () => {
  const logical = "/lib64/ld-linux-x86-64.so.2"
  const canonical = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
  const queries: string[] = []
  const owner = await linuxNativePackageOwnership({ logical, canonical, query: async (source) => {
    queries.push(source)
    return `libc6:amd64: ${source}\n`
  } })
  expect(owner).toBe("libc6")
  expect(queries).toEqual([canonical])
  queries.length = 0
  expect(await linuxNativePackageOwnership({ logical, canonical, query: async (source) => {
    queries.push(source)
    if (source === canonical) throw new Error(`Linux dpkg-query operation failed (1); dpkg-query: no path found matching pattern ${canonical}\n`)
    return `libc6:amd64: ${source}\n`
  } })).toBe("libc6")
  expect(queries).toEqual([canonical, logical])
  for (const message of ["Linux build tool output exceeds its bound", `Linux dpkg-query operation failed (2); dpkg-query: no path found matching pattern ${canonical}\n`, `Linux dpkg-query operation failed (1); dpkg-query: no path found matching pattern ${logical}\n`]) {
    queries.length = 0
    await expect(linuxNativePackageOwnership({ logical, canonical, query: async (source) => { queries.push(source); throw new Error(message) } })).rejects.toThrow(message)
    expect(queries).toEqual([canonical])
  }
  queries.length = 0
  await expect(linuxNativePackageOwnership({ logical, canonical, query: async (source) => {
    queries.push(source)
    return `libc6:amd64: ${source}\nforeign: ${source}\n`
  } })).rejects.toThrow("unambiguous package provenance")
  expect(queries).toEqual([canonical])
})

async function fixture(target: LinuxNativeTarget = "linux-x64") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-dev-asset-core-")))
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-dev-asset-guard-"))
  try {
    await expect(buildLinuxNativeAssets({ destination: path.join(directory, "assets") })).rejects.toThrow("native Linux")
    expect(await fs.readdir(directory)).toEqual([])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

// These physical Linux-asset fixtures require real POSIX permission and no-follow semantics.
test.skipIf(process.platform === "win32")("closed image rejection retains hardlink refusal and reveals only fixed copyright metadata", async () => {
  const value = await fixture()
  const filename = path.join(value.directory, names[2]!)
  try {
    await fs.link(filename, path.join(value.directory, "private-credential-link"))
    const stats = await fs.stat(filename, { bigint: true })
    const message = "Linux assets require bounded private regular files; kind=image, predicate=nlink"
    await expect(inspectLinuxNativeAssets({ directory: value.directory, target: "linux-x64" })).rejects.toThrow(message)
    expect(linuxNativeImageRejection({ filename, stats, maximum: 1_048_576, executable: true })).toBe(message)
    expect(linuxNativeImageRejection({ filename: "/usr/share/doc/gcc-14-base/copyright", stats, maximum: 1_048_576, executable: false }))
      .toBe(`Linux assets require bounded private regular files; kind=copyright, package=gcc-14-base, predicate=nlink, bytes=${stats.size}, nlink=2, maximum=1048576, mode=0o${stats.mode.toString(8)}`)
    for (const unsafe of ["/private/credential", "/usr/share/doc/../credential/copyright", "/usr/share/doc/gcc-14-base/copyright\nsecret", "/usr/share/doc/gcc-14-base/copyright\n", `/usr/share/doc/${"a".repeat(129)}/copyright`]) {
      expect(linuxNativeImageRejection({ filename: unsafe, stats, maximum: 1_048_576, executable: false })).toBe(message)
    }
    await fs.rm(path.join(value.directory, "private-credential-link"))
    expect(linuxNativeImageRejection({ filename, stats: await fs.stat(filename, { bigint: true }), maximum: 1_048_576, executable: true })).toBeUndefined()
  } finally { await fs.rm(value.directory, { recursive: true, force: true }) }
})

test("copyright metadata requires its canonical package owner and one registered complete digest", async () => {
  const canonical = "/usr/share/doc/gcc-14-base/copyright"
  const ownership = `gcc-14-base:amd64: ${canonical}\n`
  const registered = `${"a".repeat(32)}  ${canonical.slice(1)}\n`
  const queries: string[][] = []
  expect(await linuxNativeCopyrightMetadata({ canonical, query: async (args) => {
    queries.push(args)
    return args[0] === "-S" ? ownership : registered
  } })).toEqual({ ownership, registered, md5: "a".repeat(32) })
  expect(queries).toEqual([["-S", canonical], ["--control-show", "gcc-14-base:amd64", "md5sums"]])
  for (const output of [`foreign:amd64: ${canonical}\n`, `${ownership}${ownership}`, `gcc-14-base:amd64: /usr/share/doc/foreign/copyright\n`]) {
    await expect(linuxNativeCopyrightMetadata({ canonical, query: async () => output })).rejects.toThrow("exact registered package owner")
  }
  for (const output of [registered + registered, `${"a".repeat(32)}  usr/share/doc/foreign/copyright\n`, registered + "invalid metadata\n"]) {
    await expect(linuxNativeCopyrightMetadata({ canonical, query: async (args) => args[0] === "-S" ? ownership : output })).rejects.toThrow("Linux copyright")
  }
  await expect(linuxNativeCopyrightMetadata({ canonical: canonical + "\n", query: async () => { throw new Error("query must not run") } })).rejects.toThrow("fixed canonical package path")
  await expect(linuxNativeCopyrightMetadata({ canonical: "/private/credential", query: async () => { throw new Error("query must not run") } })).rejects.toThrow("fixed canonical package path")
})

test.skipIf(process.platform === "win32")("registered writable copyright copies exact bytes privately while generic assets and source changes remain refused", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-copyright-copy-")))
  const source = path.join(directory, "copyright")
  const destination = path.join(directory, "private.copyright")
  const body = Buffer.from("complete registered copyright\n")
  const md5 = createHash("md5").update(body).digest("hex")
  try {
    await fs.writeFile(source, body, { mode: 0o777 })
    await fs.chmod(source, 0o777)
    const copied = await linuxNativeCopyrightCopy({ source, destination, md5 })
    expect(await fs.readFile(destination)).toEqual(body)
    expect(copied.bytes).toBe(body.length)
    expect(copied.sha256).toBe(digest(body))
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o644)
    expect((await fs.stat(destination)).nlink).toBe(1)
    expect((await fs.stat(source)).mode & 0o777).toBe(0o777)
    expect(linuxNativeImageRejection({ filename: source, stats: await fs.stat(source, { bigint: true }), maximum: 1_048_576, executable: false }))
      .toBe("Linux assets require bounded private regular files; kind=image, predicate=writable")
    await copied.sourceCurrent()
    await expect(linuxNativeCopyrightCopy({ source, destination: path.join(directory, "wrong-digest"), md5: "0".repeat(32) })).rejects.toThrow("registered package content")
    expect((await fs.readdir(directory)).toSorted()).toEqual(["copyright", "private.copyright"])
    await fs.link(source, path.join(directory, "alias"))
    await expect(linuxNativeCopyrightCopy({ source, destination: path.join(directory, "hardlink"), md5 })).rejects.toThrow("singlelink")
    await fs.rm(path.join(directory, "alias"))
    await fs.writeFile(source, "changed content\n")
    await expect(copied.sourceCurrent()).rejects.toThrow("registered package content")
    expect(await fs.readFile(destination)).toEqual(body)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test.skipIf(process.platform === "win32")("actual ELF file cohort accepts both native target headers and preserves exact data-only hash", async () => {
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

test.skipIf(process.platform === "win32")("component provenance requires all original license files and only optional captured Rustup metadata", async () => {
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

test.skipIf(process.platform === "win32")("fixed four assets fail on absent supervisor, byte change, wrong ABI, unsafe mode and physical alias", async () => {
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

test.skipIf(process.platform === "win32")("data inventory rejects stale signed receipt, unknown grant fields, crossed target and declared over-budget copies", async () => {
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
