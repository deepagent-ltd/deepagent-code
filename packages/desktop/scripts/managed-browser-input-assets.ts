import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { Schema } from "effect"
import { compileManagedBrowserInputNative } from "./managed-browser-input-native"

const filename = "managed-browser-input-darwin.node"
const manifestFilename = "managed-browser-input.asset.json"
const assetFiles = [filename, manifestFilename, "LICENSE", "UPSTREAM.json"] as const
const include = fileURLToPath(new URL("../native/managed-browser-input/include", import.meta.url))
const source = path.resolve(include, "../darwin.mm")
const commit = "20da4aeadabc5b0a01e3fcf520f91df8285c68a2"
const inventoryFiles = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "LICENSE"] as const
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Bytes = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(32), Schema.isLessThanOrEqualTo(1_048_576))
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal("dac.managed-browser-input.darwin.v1"),
  filename: Schema.Literal(filename),
  target: Schema.Literals(["darwin-arm64", "darwin-x64"]),
  napiVersion: Schema.Literal(8),
  bytes: Bytes,
  sha256: Digest,
  sourceSha256: Digest,
  headerInventorySha: Digest,
})
const Inventory = Schema.Struct({
  schemaVersion: Schema.Literal("dac.node-api-headers.upstream.v1"),
  repository: Schema.Literal("https://github.com/nodejs/node"),
  tag: Schema.Literal("v24.18.0"),
  commit: Schema.Literal(commit),
  napiVersion: Schema.Literal(8),
  license: Schema.Struct({ identifier: Schema.Literal("MIT"), file: Schema.Literal("LICENSE") }),
  modifications: Schema.Array(Schema.Unknown),
  files: Schema.Array(Schema.Struct({
    file: Schema.Literals(inventoryFiles),
    source: Schema.String,
    url: Schema.String,
    bytes: Bytes,
    sha256: Digest,
    includes: Schema.optional(Schema.Array(Schema.String)),
  })),
})

export type ManagedBrowserInputPortableAsset = typeof Manifest.Type
type Target = ManagedBrowserInputPortableAsset["target"]

/** Build-only publisher. All inputs to clang come from the checked-in native source and headers. */
export async function prepareManagedBrowserInputAsset(input: { directory: string; target?: Target }) {
  if (process.platform !== "darwin") {
    await removeAssetFiles(path.resolve(input.directory))
    return undefined
  }
  const target = requireHostTarget(input.target)
  const identity = process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_IDENTITY?.trim()
  if (identity && identity !== "-" && !/^[0-9a-f]{40}$/i.test(identity))
    throw new Error("Managed browser input signing requires an exact certificate fingerprint")
  const inventory = readInventory()
  const sourceSha256 = digest(readPhysicalFile(source, 131_072))
  await mkdir(input.directory, { recursive: true })
  const directory = await realpath(input.directory)
  await removeAssetFiles(directory)
  const state = { published: false }
  try {
    const compiled = await compileManagedBrowserInputNative({ directory, headers: include, target })
    if (compiled.sourceSha256 !== sourceSha256)
      throw new Error("Managed browser input source changed during compilation")
    requireMachO(readPhysicalFile(compiled.path, 1_048_576), target)
    if (identity) {
      await execute(["/usr/bin/codesign", "--force", "--sign", identity, "--options", "runtime",
        ...(process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN?.trim()
          ? ["--keychain", process.env.DEEPAGENT_CODE_NATIVE_ASSET_SIGN_KEYCHAIN.trim()] : []),
        identity === "-" ? "--timestamp=none" : "--timestamp", compiled.path])
      await execute(["/usr/bin/codesign", "--verify", "--strict", compiled.path])
    }
    const body = readPhysicalFile(compiled.path, 1_048_576)
    requireMachO(body, target)
    const asset: ManagedBrowserInputPortableAsset = Object.freeze({
      schemaVersion: "dac.managed-browser-input.darwin.v1", filename, target, napiVersion: 8,
      bytes: body.length, sha256: digest(body), sourceSha256, headerInventorySha: digest(inventory.upstream),
    })
    await writeFile(path.join(directory, "LICENSE"), inventory.license, { flag: "wx", mode: 0o644 })
    await writeFile(path.join(directory, "UPSTREAM.json"), inventory.upstream, { flag: "wx", mode: 0o644 })
    await writeFile(path.join(directory, manifestFilename), JSON.stringify(asset, null, 2) + "\n", { flag: "wx", mode: 0o644 })
    const verified = await verifyManagedBrowserInputPackAsset({ directory, target })
    state.published = true
    return verified
  } finally {
    if (!state.published) await removeAssetFiles(directory)
  }
}

/** Release-build verification; runtime verification consumes only the fixed portable manifest and binary. */
export async function verifyManagedBrowserInputPackAsset(input: { directory: string; target?: Target }) {
  const target = requireHostTarget(input.target)
  const directory = await realpath(input.directory)
  const asset = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), { onExcessProperty: "error" })(
    readPhysicalFile(path.join(directory, manifestFilename), 4_096).toString("utf8"),
  )
  if (asset.target !== target) throw new Error("Managed browser input manifest target does not match the build host")
  const body = readPhysicalFile(path.join(directory, filename), 1_048_576)
  requireMachO(body, target)
  if (body.length !== asset.bytes || digest(body) !== asset.sha256)
    throw new Error("Managed browser input binary does not match its manifest")
  const inventory = readInventory()
  if (digest(readPhysicalFile(source, 131_072)) !== asset.sourceSha256 ||
    digest(inventory.upstream) !== asset.headerInventorySha ||
    !readPhysicalFile(path.join(directory, "UPSTREAM.json"), 16_384).equals(inventory.upstream) ||
    !readPhysicalFile(path.join(directory, "LICENSE"), 262_144).equals(inventory.license))
    throw new Error("Managed browser input pack asset does not match the checked-in source and header inventory")
  return Object.freeze(asset)
}

function requireHostTarget(target?: Target): Target {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64"))
    throw new Error("Managed browser input assets require a native macOS ARM or Intel build")
  const host = `darwin-${process.arch}` as Target
  if (target !== undefined && target !== host)
    throw new Error("Managed browser input target must match the build host")
  return host
}

function readInventory() {
  const upstream = readPhysicalFile(path.join(include, "UPSTREAM.json"), 16_384)
  const inventory = Schema.decodeUnknownSync(Schema.fromJsonString(Inventory))(upstream.toString("utf8"))
  if (inventory.modifications.length !== 0 || inventory.files.length !== inventoryFiles.length ||
    new Set(inventory.files.map((entry) => entry.file)).size !== inventoryFiles.length)
    throw new Error("Managed browser input headers require the fixed unmodified Node inventory")
  const entries = inventory.files.map((entry) => {
    const expectedSource = entry.file === "LICENSE" ? "LICENSE" : `src/${entry.file}`
    const body = readPhysicalFile(path.join(include, entry.file), entry.file === "LICENSE" ? 262_144 : 65_536)
    if (entry.source !== expectedSource ||
      entry.url !== `https://raw.githubusercontent.com/nodejs/node/${commit}/${expectedSource}` ||
      entry.bytes !== body.length || entry.sha256 !== digest(body))
      throw new Error("Managed browser input header does not match its official source inventory")
    if (entry.file !== "LICENSE") {
      const quoted = Array.from(body.toString("utf8").matchAll(/^\s*#\s*include\s*"([^"]+)"/gm), (match) => match[1]!)
      if (quoted.some((name) => !inventoryFiles.includes(name as typeof inventoryFiles[number]) || name === "LICENSE") ||
        quoted.toSorted().join(",") !== (entry.includes ?? []).toSorted().join(","))
        throw new Error("Managed browser input header includes leave the fixed declaration inventory")
    }
    return { file: entry.file, body }
  })
  return { upstream, license: entries.find((entry) => entry.file === "LICENSE")!.body }
}

function readPhysicalFile(filename: string, limit: number) {
  if (!path.isAbsolute(filename) || realpathSync(filename) !== filename)
    throw new Error("Managed browser input publisher requires a physical file")
  const file = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(file, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n || before.size < 1n || before.size > BigInt(limit))
      throw new Error("Managed browser input publisher file identity unavailable")
    const body = Buffer.alloc(Number(before.size))
    const observed = { bytes: 0 }
    while (observed.bytes < body.length) {
      const bytes = readSync(file, body, observed.bytes, body.length - observed.bytes, observed.bytes)
      if (!bytes) throw new Error("Managed browser input publisher file truncated")
      observed.bytes += bytes
    }
    const stamp = (value: typeof before) =>
      [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
    if (readSync(file, Buffer.alloc(1), 0, 1, body.length) !== 0 ||
      stamp(before) !== stamp(fstatSync(file, { bigint: true })) ||
      stamp(before) !== stamp(lstatSync(filename, { bigint: true })) || realpathSync(filename) !== filename)
      throw new Error("Managed browser input publisher file changed")
    return body
  } finally { closeSync(file) }
}

function requireMachO(body: Buffer, target: Target) {
  if (body.length < 32 || body.readUInt32LE(0) !== 0xfeedfacf ||
    body.readUInt32LE(4) !== (target === "darwin-arm64" ? 0x0100000c : 0x01000007) || body.readUInt32LE(12) !== 8)
    throw new Error("Managed browser input asset requires a matching native Mach-O bundle")
}

function digest(body: Buffer) {
  return createHash("sha256").update(body).digest("hex")
}

async function removeAssetFiles(directory: string) {
  await Promise.all(assetFiles.map((name) => rm(path.join(directory, name), { force: true })))
}

async function execute(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (result[0] !== 0) throw new Error(`Managed browser input signing failed: ${result[2]}`)
}
