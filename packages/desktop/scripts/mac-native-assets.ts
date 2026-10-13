import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { NativeInstallationSchema } from "../../deepagent-code/src/installation/native-installation.schema"

/** Publisher-side inventory validation. These observations never grant runtime authority. */
export async function verifyMacNativeAssets(directory: string, runtime: string) {
  const raw = await fs.readFile(path.join(directory, "node.js.native-components.json"))
  if (raw.length > NativeInstallationSchema.COMPONENTS_LIMIT)
    throw new Error("Native Node source inventory exceeds its bound")
  const components = Schema.decodeUnknownSync(Schema.fromJsonString(NativeInstallationSchema.Components), {
    onExcessProperty: "error",
  })(raw.toString("utf8"))
  const target = components.target
  if (target !== "darwin-arm64" && target !== "darwin-x64")
    throw new Error("Native Node Mac package requires an explicit Mac target")
  const names = ["deepagent-work-file-helper", "deepagent-work-storage-cleanup", "bun-command-runtime"]
  const assets = components.components.filter((entry) => entry.path.startsWith("packages/work-file-helper/bin/"))
  if (assets.length !== names.length || new Set(assets.map((entry) => entry.path)).size !== names.length ||
    assets.some((entry) => !names.some((name) => entry.path === `packages/work-file-helper/bin/${target}/${name}`)))
    throw new Error("Native Node Mac package requires all three assets for the same target")
  await verifyImage(runtime, target)
  return {
    target,
    files: await Promise.all(assets.map((entry) =>
      verifyImage(path.join(directory, path.basename(entry.path)), target, entry))),
  }
}

async function verifyImage(filename: string, target: "darwin-arm64" | "darwin-x64",
  expected?: NativeInstallationSchema.Component) {
  if (await fs.realpath(filename) !== filename)
    throw new Error("Native Mac image requires a canonical physical path")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 32n ||
      before.size > BigInt(NativeInstallationSchema.EXECUTABLE_LIMIT) || (before.mode & 0o022n) !== 0n ||
      (before.mode & 0o111n) === 0n || (expected && before.size !== BigInt(expected.bytes)))
      throw new Error("Native Mac image is not a bounded private executable")
    const header = Buffer.alloc(32)
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
      header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== (target === "darwin-x64" ? 0x01000007 : 0x0100000c) ||
      header.readUInt32LE(12) !== 2)
      throw new Error("Native Mac image architecture does not match its component target")
    if (expected) {
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(65_536)
      const observed = { bytes: 0 }
      while (true) {
        const read = await file.read(buffer, 0, buffer.length, null)
        if (!read.bytesRead) break
        observed.bytes += read.bytesRead
        if (observed.bytes > expected.bytes) throw new Error("Native Mac image changed while reading")
        hash.update(buffer.subarray(0, read.bytesRead))
      }
      if (observed.bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
        throw new Error("Native Mac image differs from its component inventory")
    }
    const stamp = (value: typeof before) =>
      [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
    if (stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      stamp(before) !== stamp(await fs.lstat(filename, { bigint: true })) || await fs.realpath(filename) !== filename)
      throw new Error("Native Mac image changed while reading")
    return filename
  } finally {
    await file.close()
  }
}
