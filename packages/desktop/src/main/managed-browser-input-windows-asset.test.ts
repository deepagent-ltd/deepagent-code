import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import {
  inspectWindowsInputPE,
  publishWindowsInputCandidate,
  requireWindowsInputPE,
  verifyWindowsInputPackAsset,
  windowsInputSourceCensus,
} from "../../scripts/managed-browser-input-windows-assets"
import { compileWindowsInputNative } from "../../scripts/managed-browser-input-windows-native"
import { selectWindowsInputCandidate } from "./managed-browser-input-windows-asset"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"

const fixture = await Bun.file(fileURLToPath(new URL("./fixtures/windows-input-pe.fixture.json", import.meta.url))).json() as {
  bytes: number
  sha256: string
  base64: string
  layout: { pe: number; optional: number; exports: number; exportRVA: number; addressTable: number; nameTable: number;
    ordinalTable: number; name0: number; name0RVA: number; sections: { headerOffset: number; rva: number; rawBytes: number; rawOffset: number }[] }
}
const original = Buffer.from(fixture.base64, "base64")
const owned: string[] = []
async function directory() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dac-win-input-asset-test-")))
  owned.push(root)
  return root
}
afterEach(async () => { await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
function changed(write: (value: DataView, body: Buffer) => void) {
  const body = Buffer.from(original)
  write(new DataView(body.buffer, body.byteOffset, body.byteLength), body)
  return body
}
async function candidate(root: string) {
  return publishWindowsInputCandidate({ directory: root, body: original, source: windowsInputSourceCensus() })
}

test("actual compiled two-export PE fixture and all pinned NAPI declarations are inventoried", () => {
  expect(original.length).toBe(fixture.bytes)
  expect(createHash("sha256").update(original).digest("hex")).toBe(fixture.sha256)
  expect(requireWindowsInputPE(original)).toEqual({ machine: "x64", exports: ["napi_register_module_v1", "node_api_module_get_api_version_v1"] })
  expect(windowsInputSourceCensus().headers.map((header) => path.basename(header.path)).toSorted()).toEqual(
    ["LICENSE", "js_native_api.h", "js_native_api_types.h", "node_api.h", "node_api_types.h"],
  )
})

test("wrong architecture, executable instead of DLL, and truncated physical bytes are refused", () => {
  expect(() => requireWindowsInputPE(changed((view) => view.setUint16(fixture.layout.pe + 4, 0xaa64, true)))).toThrow("WINDOWS_INPUT_PE_TARGET")
  expect(() => requireWindowsInputPE(changed((view) => view.setUint16(fixture.layout.pe + 22, 0, true)))).toThrow("WINDOWS_INPUT_PE_TARGET")
  expect(() => requireWindowsInputPE(original.subarray(0, 511))).toThrow("WINDOWS_INPUT_PE_SIZE")
  expect(() => requireWindowsInputPE(original.subarray(0, original.length - 1))).toThrow("WINDOWS_INPUT_PE_SECTION")
})

test("overflowed RVA, overlapping physical sections, and ordinal outside functions are refused", () => {
  expect(() => requireWindowsInputPE(changed((view) => view.setUint32(fixture.layout.sections[0].headerOffset + 12, 0xffff_ff00, true)))).toThrow("WINDOWS_INPUT_PE_SECTION")
  expect(() => requireWindowsInputPE(changed((view) => view.setUint32(fixture.layout.sections[1].headerOffset + 20, fixture.layout.sections[0].rawOffset, true)))).toThrow("WINDOWS_INPUT_PE_SECTION")
  expect(() => requireWindowsInputPE(changed((view) => view.setUint16(fixture.layout.ordinalTable, 0xffff, true)))).toThrow("WINDOWS_INPUT_PE_EXPORTS")
})

test("forwarded NAPI symbol and non-executable target are refused", () => {
  expect(() => requireWindowsInputPE(changed((view) => view.setUint32(fixture.layout.addressTable, fixture.layout.exportRVA, true)))).toThrow("WINDOWS_INPUT_PE_EXPORT_CODE")
  expect(() => requireWindowsInputPE(changed((view) => view.setUint32(fixture.layout.sections[0].headerOffset + 36, 0x4000_0040, true)))).toThrow("WINDOWS_INPUT_PE_EXPORT_CODE")
})

test("export names cannot cross a raw section boundary or alias the same NAPI name", () => {
  expect(() => requireWindowsInputPE(changed((view, body) => {
    const section = fixture.layout.sections[1]
    view.setUint32(fixture.layout.nameTable, section.rva + section.rawBytes - 1, true)
    body[section.rawOffset + section.rawBytes - 1] = 0x61
  }))).toThrow("WINDOWS_INPUT_PE_EXPORT_NAME")
  expect(() => requireWindowsInputPE(changed((view) => view.setUint32(fixture.layout.nameTable + 4, fixture.layout.name0RVA, true)))).toThrow("WINDOWS_INPUT_PE_EXPORTS")
})

test("unexpected valid ASCII export cannot impersonate the standard NAPI entry", () => {
  const body = changed((_, data) => { data[fixture.layout.name0] = 0x61 })
  expect(inspectWindowsInputPE(body).exports[0]).toStartWith("aapi_")
  expect(() => requireWindowsInputPE(body)).toThrow("WINDOWS_INPUT_PE_EXPORTS")
})

test("exclusive publication returns only an unqualified candidate and readback is exact", async () => {
  const root = await directory()
  const asset = await candidate(root)
  expect(asset.runtimeQualification).toBe("unverified")
  expect(asset).toMatchObject(managedBrowserInputRuntime)
  expect(asset.bytes).toBe(original.length)
  expect(await readFile(asset.path)).toEqual(original)
  expect(await verifyWindowsInputPackAsset({ directory: root })).toEqual(asset)
  expect(Object.isFrozen(asset)).toBe(true)
  expect(selectWindowsInputCandidate(asset).status).toBe("unavailable")
})

test("first-file collision preserves an existing asset and never creates a manifest", async () => {
  const root = await directory()
  const filename = path.join(root, "managed-browser-input-windows.node")
  await writeFile(filename, "old-candidate-evidence")
  await expect(candidate(root)).rejects.toThrow("EEXIST")
  expect(await readFile(filename, "utf8")).toBe("old-candidate-evidence")
  expect(await Bun.file(path.join(root, "managed-browser-input-windows.asset.json")).exists()).toBe(false)
})

test("second-file collision removes only its own asset and preserves the prior manifest", async () => {
  const root = await directory()
  const manifest = path.join(root, "managed-browser-input-windows.asset.json")
  await writeFile(manifest, "old-manifest-evidence")
  await expect(candidate(root)).rejects.toThrow("EEXIST")
  expect(await readFile(manifest, "utf8")).toBe("old-manifest-evidence")
  expect(await Bun.file(path.join(root, "managed-browser-input-windows.node")).exists()).toBe(false)
})

test("source drift is refused before creating either artifact", async () => {
  const root = await directory()
  await expect(publishWindowsInputCandidate({ directory: root, body: original,
    source: { ...windowsInputSourceCensus(), sourceSha256: "0".repeat(64) } })).rejects.toThrow("WINDOWS_INPUT_ASSET_SOURCE")
  expect(await Bun.file(path.join(root, "managed-browser-input-windows.node")).exists()).toBe(false)
})

test("caller mutation after publication begins does not alter validated bytes or manifest", async () => {
  const root = await directory()
  const input = Buffer.from(original)
  const publishing = publishWindowsInputCandidate({ directory: root, body: input, source: windowsInputSourceCensus() })
  input.fill(0)
  const asset = await publishing
  expect(await readFile(asset.path)).toEqual(original)
  expect(asset.sha256).toBe(fixture.sha256)
})

test("a changed body with intact valid exports is rejected by the manifest hash", async () => {
  const root = await directory()
  const asset = await candidate(root)
  const body = Buffer.from(original)
  body[original.length - 1] = 1
  await writeFile(asset.path, body)
  await expect(verifyWindowsInputPackAsset({ directory: root })).rejects.toThrow("WINDOWS_INPUT_ASSET_HASH")
})

test("unknown manifest fields and fake qualification cannot enter the publisher contract", async () => {
  const root = await directory()
  const asset = await candidate(root)
  const manifest = path.join(root, "managed-browser-input-windows.asset.json")
  await writeFile(manifest, JSON.stringify({ ...asset, path: undefined, runtimeQualification: "passed" }))
  await expect(verifyWindowsInputPackAsset({ directory: root })).rejects.toThrow()
  await writeFile(manifest, JSON.stringify({ ...asset, path: undefined, qualifiedByCaller: true }))
  await expect(verifyWindowsInputPackAsset({ directory: root })).rejects.toThrow()
  expect(selectWindowsInputCandidate(undefined).status).toBe("unavailable")
  expect(selectWindowsInputCandidate({ ...asset, runtimeQualification: "passed" } as unknown as typeof asset).status).toBe("unavailable")
})

test("asset symlink and multiply linked file are refused without deleting external evidence", async () => {
  const root = await directory()
  const asset = await candidate(root)
  const external = path.join(await directory(), "existing.node")
  await writeFile(external, original)
  await rm(asset.path)
  await symlink(external, asset.path)
  await expect(verifyWindowsInputPackAsset({ directory: root })).rejects.toThrow("WINDOWS_INPUT_ASSET_PATH")
  await rm(asset.path)
  await link(external, asset.path)
  await expect(verifyWindowsInputPackAsset({ directory: root })).rejects.toThrow("WINDOWS_INPUT_ASSET_IDENTITY")
  expect(await readFile(external)).toEqual(original)
})

test("aliased directory and native compile on the wrong host stay closed", async () => {
  const root = await directory()
  const alias = path.join(await directory(), "alias")
  await symlink(root, alias)
  await expect(candidate(alias)).rejects.toThrow("WINDOWS_INPUT_ASSET_PATH")
  if (process.platform === "win32" && process.arch === "x64") return
  await expect(compileWindowsInputNative({ directory: root, compiler: { path: "unused", sha256: "0".repeat(64) },
    electronImportLibrary: { path: "unused", sha256: "0".repeat(64) } })).rejects.toThrow("WINDOWS_INPUT_NATIVE_BUILD_REQUIRED")
})
