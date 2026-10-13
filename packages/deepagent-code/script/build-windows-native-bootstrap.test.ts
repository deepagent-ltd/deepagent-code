import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { copyWindowsWorkBuildImage } from "./build-windows-native-bootstrap"

// These are data-only PE fixtures. No Cargo, Windows image or installed runtime is executed.
async function fixture(
  name: Parameters<typeof copyWindowsWorkBuildImage>[0]["name"] = "deepagent-work-process-supervisor.exe",
  architecture: Parameters<typeof copyWindowsWorkBuildImage>[0]["architecture"] = "x64",
) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-windows-build-copy-")))
  const staging = path.join(directory, "published")
  const cargoDirectory = path.join(directory, "cargo")
  await fs.mkdir(staging)
  await fs.mkdir(path.join(cargoDirectory, "release/deps"), { recursive: true })
  const bytes = Buffer.alloc(128)
  bytes.write("MZ", 0, "ascii")
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write("PE\0\0", 64, "ascii")
  bytes.writeUInt16LE(architecture === "arm64" ? 0xaa64 : 0x8664, 68)
  bytes[127] = 7
  const source = path.join(cargoDirectory, "release", name)
  await fs.writeFile(source, bytes, { flag: "wx" })
  return {
    directory, bytes,
    alias: path.join(cargoDirectory, "release/deps/deepagent_work_process_supervisor-0123456789abcdef.exe"),
    output: path.join(staging, name),
    input: { name, source, staging, cargoDirectory, architecture },
  }
}

test.each([
  ["deepagent-work-process-supervisor.exe", "x64"],
  ["deepagent-work-process-supervisor.exe", "arm64"],
  ["bun-command-runtime.exe", "x64"],
  ["bun-command-runtime.exe", "arm64"],
] as const)("single-link %s %s publishes exact bytes and hash exclusively", async (name, architecture) => {
  const value = await fixture(name, architecture)
  try {
    const result = await copyWindowsWorkBuildImage(value.input)
    expect(result).toEqual({
      path: `packages/work-file-helper/bin/win32-${architecture}/${name}`,
      bytes: value.bytes.length,
      sha256: createHash("sha256").update(value.bytes).digest("hex"),
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(await fs.readFile(value.output)).toEqual(value.bytes)
    const published = await fs.lstat(value.output, { bigint: true })
    const original = await fs.lstat(value.input.source, { bigint: true })
    expect(published.isFile()).toBe(true)
    expect(published.isSymbolicLink()).toBe(false)
    expect(published.nlink).toBe(1n)
    expect(published.size).toBe(BigInt(value.bytes.length))
    expect(published.ino).not.toBe(original.ino)
    await expect(copyWindowsWorkBuildImage(value.input)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await fs.readFile(value.output)).toEqual(value.bytes)
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test.each([
  "deepagent_work_process_supervisor-0123456789abcdef.exe",
  "deepagent_work_process_supervisor.exe",
])("the unique same-inode Cargo supervisor alias %s remains build-only and publishes one link", async (name) => {
  const value = await fixture()
  const filename = path.join(value.input.cargoDirectory, "release/deps", name)
  try {
    await fs.link(value.input.source, filename)
    const source = await fs.lstat(value.input.source, { bigint: true })
    const alias = await fs.lstat(filename, { bigint: true })
    expect(source.nlink).toBe(2n)
    expect(alias.nlink).toBe(2n)
    expect(alias.dev).toBe(source.dev)
    expect(alias.ino).toBe(source.ino)
    const result = await copyWindowsWorkBuildImage(value.input)
    expect(result.sha256).toBe(createHash("sha256").update(value.bytes).digest("hex"))
    expect(await fs.readFile(value.output)).toEqual(value.bytes)
    const published = await fs.lstat(value.output, { bigint: true })
    expect(published.nlink).toBe(1n)
    expect(published.ino).not.toBe(source.ino)
    expect((await fs.lstat(value.input.source, { bigint: true })).nlink).toBe(2n)
    expect((await fs.lstat(filename, { bigint: true })).ino).toBe(source.ino)
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test.each([
  ["foreign-MSVC-alias", "cargo_alias_ino"],
  ["mixed-MSVC-and-GNU-aliases", "cargo_alias_multiple"],
] as const)("fixed Cargo %s fails the closed %s predicate before publication", async (kind, predicate) => {
  const value = await fixture()
  try {
    await fs.link(value.input.source, kind === "mixed-MSVC-and-GNU-aliases" ? value.alias : path.join(value.directory, "foreign-link"))
    await fs.writeFile(path.join(value.input.cargoDirectory, "release/deps/deepagent_work_process_supervisor.exe"), value.bytes, { flag: "wx" })
    await expect(copyWindowsWorkBuildImage(value.input)).rejects.toThrow(
      `Windows fixed Work build image rejected: asset=${value.input.name}, predicate=${predicate}`,
    )
    expect(await fs.readdir(value.input.staging)).toEqual([])
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test.each([
  ["missing-alias", "cargo_alias_missing"],
  ["foreign-alias", "cargo_alias_ino"],
  ["multiple-aliases", "cargo_alias_multiple"],
  ["alias-symlink", "cargo_alias_file"],
  ["third-link", "source_links"],
  ["source-symlink", "source_symlink"],
  ["non-PE", "pe_magic"],
  ["wrong-ABI", "pe_abi"],
  ["bun-two-links", "source_links"],
] as const)("fixed image %s fails the closed %s predicate before publication", async (kind, predicate) => {
  const value = await fixture(kind === "bun-two-links" ? "bun-command-runtime.exe" : "deepagent-work-process-supervisor.exe")
  try {
    if (["missing-alias", "foreign-alias", "alias-symlink"].includes(kind))
      await fs.link(value.input.source, path.join(value.directory, "foreign-link"))
    if (["multiple-aliases", "third-link", "bun-two-links"].includes(kind))
      await fs.link(value.input.source, value.alias)
    if (kind === "foreign-alias") await fs.writeFile(value.alias, value.bytes, { flag: "wx" })
    if (kind === "multiple-aliases")
      await fs.writeFile(path.join(value.input.cargoDirectory, "release/deps/deepagent_work_process_supervisor-fedcba9876543210.exe"), value.bytes, { flag: "wx" })
    if (kind === "alias-symlink") await fs.symlink(value.input.source, value.alias)
    if (kind === "third-link") await fs.link(value.input.source, path.join(value.directory, "third-link"))
    if (kind === "source-symlink") {
      await fs.rename(value.input.source, value.input.source + ".original")
      await fs.symlink(value.input.source + ".original", value.input.source)
    }
    if (kind === "non-PE") {
      const bytes = Buffer.from(value.bytes)
      bytes.write("XX", 0, "ascii")
      await fs.writeFile(value.input.source, bytes)
    }
    if (kind === "wrong-ABI") {
      const bytes = Buffer.from(value.bytes)
      bytes.writeUInt16LE(0xaa64, 68)
      await fs.writeFile(value.input.source, bytes)
    }
    if (kind === "foreign-alias") {
      expect(await fs.readFile(value.alias)).toEqual(value.bytes)
      expect((await fs.lstat(value.alias, { bigint: true })).ino)
        .not.toBe((await fs.lstat(value.input.source, { bigint: true })).ino)
    }
    await expect(copyWindowsWorkBuildImage(value.input)).rejects.toThrow(
      `Windows fixed Work build image rejected: asset=${value.input.name}, predicate=${predicate}`,
    )
    expect(await fs.readdir(value.input.staging)).toEqual([])
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})

test("exclusive publication refuses an occupied destination without changing its bytes or inode", async () => {
  const value = await fixture()
  try {
    await fs.writeFile(value.output, "original occupied destination", { flag: "wx" })
    const before = await fs.lstat(value.output, { bigint: true })
    await expect(copyWindowsWorkBuildImage(value.input)).rejects.toMatchObject({ code: "EEXIST" })
    expect(await fs.readFile(value.output, "utf8")).toBe("original occupied destination")
    const after = await fs.lstat(value.output, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.nlink).toBe(1n)
    expect(after.size).toBe(before.size)
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true })
  }
})
