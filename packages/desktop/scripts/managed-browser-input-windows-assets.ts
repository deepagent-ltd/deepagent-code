import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { lstat, open, rm } from "node:fs/promises"
import { Schema } from "effect"
import { managedBrowserInputRuntime } from "./managed-browser-input-runtime"

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const WindowsInputAsset = Schema.Struct({
  schemaVersion: Schema.Literal("dac.managed-browser-input.win32.candidate.v1"),
  filename: Schema.Literal("managed-browser-input-windows.node"),
  target: Schema.Literal("win32-x64"),
  napiVersion: Schema.Literal(8),
  electronVersion: Schema.Literal(managedBrowserInputRuntime.electronVersion),
  nodeVersion: Schema.Literal(managedBrowserInputRuntime.nodeVersion),
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 512, maximum: 1_048_576 })),
  sha256: Digest,
  sourceSha256: Digest,
  headerInventorySha256: Digest,
  // A compiled candidate is never an enablement receipt. A later reviewed
  // publisher contract must attest runtime/source/IME/CDP and installed trust.
  runtimeQualification: Schema.Literal("unverified"),
})
export type WindowsInputPortableAsset = typeof WindowsInputAsset.Type

export function inspectWindowsInputPE(body: Uint8Array) {
  if (body.length < 512 || body.length > 1_048_576) throw new Error("WINDOWS_INPUT_PE_SIZE")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error("WINDOWS_INPUT_PE_DOS")
  const offset = view.getUint32(0x3c, true)
  if (offset < 64 || offset > 65_536 || offset + 264 > body.length ||
    view.getUint32(offset, true) !== 0x4550 || view.getUint16(offset + 4, true) !== 0x8664 ||
    !(view.getUint16(offset + 22, true) & 0x2000)) throw new Error("WINDOWS_INPUT_PE_TARGET")
  const count = view.getUint16(offset + 6, true)
  const size = view.getUint16(offset + 20, true)
  const optional = offset + 24
  if (!count || count > 32 || size < 120 || size > 512 || optional + size + count * 40 > body.length ||
    view.getUint16(optional, true) !== 0x20b || view.getUint32(optional + 108, true) < 1)
    throw new Error("WINDOWS_INPUT_PE_HEADERS")
  const headersEnd = optional + size + count * 40
  const sections = Array.from({ length: count }, (_, index) => {
    const entry = optional + size + index * 40
    const rawBytes = view.getUint32(entry + 16, true)
    const rawOffset = view.getUint32(entry + 20, true)
    const rva = view.getUint32(entry + 12, true)
    if (rawOffset + rawBytes > body.length || (rawBytes && rawOffset < headersEnd) || rva + rawBytes > 0x1_0000_0000)
      throw new Error("WINDOWS_INPUT_PE_SECTION")
    return { rva, rawBytes, rawOffset, executable: Boolean(view.getUint32(entry + 36, true) & 0x2000_0000) }
  })
  if (sections.some((left, index) => sections.slice(index + 1).some((right) => left.rawBytes && right.rawBytes &&
    ((left.rawOffset < right.rawOffset + right.rawBytes && right.rawOffset < left.rawOffset + left.rawBytes) ||
      (left.rva < right.rva + right.rawBytes && right.rva < left.rva + left.rawBytes)))))
    throw new Error("WINDOWS_INPUT_PE_SECTION")
  const physical = (rva: number, bytes: number) => {
    const section = sections.filter((section) => rva >= section.rva && rva - section.rva + bytes <= section.rawBytes)
    if (section.length !== 1) throw new Error("WINDOWS_INPUT_PE_RVA")
    return section[0].rawOffset + rva - section[0].rva
  }
  const exportRva = view.getUint32(optional + 112, true)
  const exportBytes = view.getUint32(optional + 116, true)
  if (exportBytes < 40 || exportRva + exportBytes > 0x1_0000_0000) throw new Error("WINDOWS_INPUT_PE_EXPORTS")
  const exports = physical(exportRva, exportBytes)
  const functions = view.getUint32(exports + 20, true)
  const names = view.getUint32(exports + 24, true)
  if (!names || names > 128 || functions < names || functions > 128) throw new Error("WINDOWS_INPUT_PE_EXPORTS")
  const addresses = physical(view.getUint32(exports + 28, true), functions * 4)
  const ordinals = physical(view.getUint32(exports + 36, true), names * 2)
  const table = physical(view.getUint32(exports + 32, true), names * 4)
  const observed = Array.from({ length: names }, (_, index) => {
    const ordinal = view.getUint16(ordinals + index * 2, true)
    if (ordinal >= functions) throw new Error("WINDOWS_INPUT_PE_EXPORTS")
    const address = view.getUint32(addresses + ordinal * 4, true)
    if (!address || (address >= exportRva && address < exportRva + exportBytes) ||
      !sections.some((section) => section.executable && address >= section.rva && address - section.rva < section.rawBytes))
      throw new Error("WINDOWS_INPUT_PE_EXPORT_CODE")
    physical(address, 1)
    const nameRva = view.getUint32(table + index * 4, true)
    const start = physical(nameRva, 1)
    const end = body.subarray(start, Math.min(body.length, start + 128)).indexOf(0)
    if (end < 1 || body.subarray(start, start + end).some((byte) => byte < 0x21 || byte > 0x7e))
      throw new Error("WINDOWS_INPUT_PE_EXPORT_NAME")
    physical(nameRva, end + 1)
    return new TextDecoder().decode(body.subarray(start, start + end))
  })
  if (new Set(observed).size !== observed.length) throw new Error("WINDOWS_INPUT_PE_EXPORTS")
  return Object.freeze({ machine: "x64" as const, exports: Object.freeze(observed.toSorted()) })
}

export function requireWindowsInputPE(body: Uint8Array) {
  const observed = inspectWindowsInputPE(body)
  if (observed.exports.join(",") !== "napi_register_module_v1,node_api_module_get_api_version_v1")
    throw new Error("WINDOWS_INPUT_PE_EXPORTS")
  return observed
}

export async function verifyWindowsInputPackAsset(input: { directory: string }) {
  const directory = realpathSync(input.directory)
  if (!path.isAbsolute(input.directory) || directory !== input.directory) throw new Error("WINDOWS_INPUT_ASSET_PATH")
  const asset = Schema.decodeUnknownSync(Schema.fromJsonString(WindowsInputAsset), { onExcessProperty: "error" })(
    physicalFile(path.join(directory, "managed-browser-input-windows.asset.json"), 4_096).toString("utf8"),
  )
  const body = physicalFile(path.join(directory, asset.filename), 1_048_576)
  requireWindowsInputPE(body)
  if (body.length !== asset.bytes || digest(body) !== asset.sha256) throw new Error("WINDOWS_INPUT_ASSET_HASH")
  const source = windowsInputSourceCensus()
  if (source.sourceSha256 !== asset.sourceSha256 || source.headerInventorySha256 !== asset.headerInventorySha256)
    throw new Error("WINDOWS_INPUT_ASSET_SOURCE")
  return Object.freeze({ ...asset, path: path.join(directory, asset.filename) })
}

/** Exact checked-in NAPI declarations; metadata alone cannot stand in for header bytes. */
export function windowsInputSourceCensus() {
  const include = fileURLToPath(new URL("../native/managed-browser-input/include", import.meta.url))
  const inventory = physicalFile(path.join(include, "UPSTREAM.json"), 16_384)
  const upstream = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
    schemaVersion: Schema.Literal("dac.node-api-headers.upstream.v1"),
    repository: Schema.Literal("https://github.com/nodejs/node"),
    tag: Schema.Literal("v24.18.0"),
    commit: Schema.Literal("20da4aeadabc5b0a01e3fcf520f91df8285c68a2"),
    napiVersion: Schema.Literal(8),
    modifications: Schema.Array(Schema.Never),
    files: Schema.Array(Schema.Struct({ file: Schema.String, bytes: Schema.Int, sha256: Digest })),
  })))(inventory.toString("utf8"))
  const expected = ["LICENSE", "js_native_api.h", "js_native_api_types.h", "node_api.h", "node_api_types.h"]
  if (upstream.files.map((file) => file.file).toSorted().join(",") !== expected.join(","))
    throw new Error("WINDOWS_INPUT_HEADER_INVENTORY")
  const headers = upstream.files.map((file) => {
    const body = physicalFile(path.join(include, file.file), 262_144)
    if (body.length !== file.bytes || digest(body) !== file.sha256) throw new Error("WINDOWS_INPUT_HEADER_HASH")
    return Object.freeze({ path: path.join(include, file.file), bytes: body.length, sha256: file.sha256 })
  })
  const source = fileURLToPath(new URL("../native/managed-browser-input/windows.cc", import.meta.url))
  const body = physicalFile(source, 131_072)
  return Object.freeze({ source, sourceSha256: digest(body), headerInventorySha256: digest(inventory),
    headers: Object.freeze(headers) })
}

/** Exclusive publisher boundary, never a runtime qualification or loader. */
export async function publishWindowsInputCandidate(input: {
  directory: string
  body: Uint8Array
  source: ReturnType<typeof windowsInputSourceCensus>
}) {
  const directory = realpathSync(input.directory)
  if (!path.isAbsolute(input.directory) || directory !== input.directory) throw new Error("WINDOWS_INPUT_ASSET_PATH")
  // Copy before any asynchronous publication so caller mutation cannot alter the
  // validated bytes or their manifest after this point.
  const body = Buffer.from(input.body)
  requireWindowsInputPE(body)
  const current = windowsInputSourceCensus()
  if (current.sourceSha256 !== input.source.sourceSha256 || current.headerInventorySha256 !== input.source.headerInventorySha256)
    throw new Error("WINDOWS_INPUT_ASSET_SOURCE")
  const asset = Schema.decodeUnknownSync(WindowsInputAsset)({
    schemaVersion: "dac.managed-browser-input.win32.candidate.v1", filename: "managed-browser-input-windows.node",
    target: "win32-x64", napiVersion: 8, ...managedBrowserInputRuntime, bytes: body.length,
    sha256: digest(body), sourceSha256: current.sourceSha256, headerInventorySha256: current.headerInventorySha256,
    runtimeQualification: "unverified",
  })
  const filename = path.join(directory, asset.filename)
  const manifest = path.join(directory, "managed-browser-input-windows.asset.json")
  const published: { path: string; dev: bigint; ino: bigint }[] = []
  const state = { verified: false }
  try {
    await exclusiveWrite(filename, body, published)
    await exclusiveWrite(manifest, Buffer.from(JSON.stringify(asset, null, 2) + "\n"), published)
    const result = await verifyWindowsInputPackAsset({ directory })
    state.verified = true
    return result
  } finally {
    // Only our own successful exclusive writes may be rolled back. A collision
    // never deletes the old asset/manifest, including the second-file collision.
    if (!state.verified) await Promise.all(published.map(async (file) => {
      const current = await lstat(file.path, { bigint: true }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (current?.dev === file.dev && current.ino === file.ino) await rm(file.path, { force: true })
    }))
  }
}

async function exclusiveWrite(filename: string, body: Uint8Array, owned: { path: string; dev: bigint; ino: bigint }[]) {
  const file = await open(filename, "wx", 0o600)
  try {
    const identity = await file.stat({ bigint: true })
    // Record ownership before the first write. A failed/disk-full write is still
    // our partial file, whereas an EEXIST collision never enters this ledger.
    owned.push({ path: filename, dev: identity.dev, ino: identity.ino })
    await file.writeFile(body)
    await file.sync()
  } finally { await file.close() }
}

function physicalFile(filename: string, limit: number) {
  if (!path.isAbsolute(filename) || realpathSync(filename) !== filename) throw new Error("WINDOWS_INPUT_ASSET_PATH")
  const file = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(file, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) ||
      lstatSync(filename).isSymbolicLink()) throw new Error("WINDOWS_INPUT_ASSET_IDENTITY")
    const body = Buffer.alloc(Number(before.size))
    const state = { offset: 0 }
    while (state.offset < body.length) {
      const bytes = readSync(file, body, state.offset, body.length - state.offset, state.offset)
      if (!bytes) throw new Error("WINDOWS_INPUT_ASSET_TRUNCATED")
      state.offset += bytes
    }
    if (readSync(file, Buffer.alloc(1), 0, 1, body.length)) throw new Error("WINDOWS_INPUT_ASSET_CHANGED")
    const stamp = (value: typeof before) => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":")
    if (stamp(before) !== stamp(fstatSync(file, { bigint: true })) ||
      stamp(before) !== stamp(lstatSync(filename, { bigint: true })) || realpathSync(filename) !== filename)
      throw new Error("WINDOWS_INPUT_ASSET_CHANGED")
    // Windows DACL/Authenticode and the FD-to-loader replacement boundary require
    // real installed qualification. This read-only hash is not that authority.
    return body
  } finally { closeSync(file) }
}
