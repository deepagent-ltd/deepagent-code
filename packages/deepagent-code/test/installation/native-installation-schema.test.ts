import { expect, test } from "bun:test"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"

const decode = Schema.decodeUnknownExit(NativeInstallationSchema.Component)
const component = (entry: string) => ({ path: entry, bytes: 1, sha256: "a".repeat(64) })

test("signed inventory retains actual Bun patch names as literal filesystem paths", async () => {
  const patches = path.resolve(import.meta.dir, "../../../../patches")
  const files = await fs.readdir(patches)
  expect(files.length).toBeGreaterThan(0)
  expect(files.some((entry) => entry.includes("%2F"))).toBe(true)
  for (const entry of files) {
    const decoded = decode(component(`patches/${entry}`))
    expect(decoded._tag).toBe("Success")
    if (decoded._tag === "Success") expect(decoded.value.path).toBe(`patches/${entry}`)
  }
})

test("signed component paths reject traversal, absolute paths and control characters", () => {
  for (const entry of [
    "",
    "/etc/key",
    "../key",
    "a/../key",
    "./key",
    "a/./key",
    "a//key",
    "a/",
    "a\\key",
    "C:/key",
    "a\0key",
    "a\nkey",
    "a\rkey",
    "a\tkey",
  ]) {
    expect({ entry, state: decode(component(entry))._tag }).toEqual({ entry, state: "Failure" })
  }
  // URL-like sequences are literal filename bytes, never decoded by the loader.
  expect(decode(component("patches/@juggleim%2Fsdk@1.9.17+native.patch"))._tag).toBe("Success")
})

const windowsFiles = () => ({
  version: 1,
  artifact: { identity: "artifact:1", hash: "a".repeat(64), bytes: 17, text: null },
  manifest: { identity: "manifest:2", hash: "b".repeat(64), bytes: 8, text: "manifest" },
  runtime: { identity: "runtime:3", hash: "c".repeat(64), bytes: 29, text: null },
  bootstrap_sha256: createHash("sha256").update('{"preloaded":true,"preload_hash":"original","path":"C:\\\\DAC\\\\日本語"}').digest("hex"),
})

test("Windows installation public facts reject every record field drift and version mismatch", () => {
  const original = windowsFiles()
  for (const name of ["artifact", "manifest", "runtime"] as const) {
    for (const change of [
      { identity: original[name].identity + ":changed" },
      { hash: "d".repeat(64) },
      { bytes: original[name].bytes + 1 },
      { text: original[name].text === null ? "" : null },
    ]) {
      expect(
        NativeInstallationSchema.sameWindowsFiles(original, {
          ...original,
          [name]: { ...original[name], ...change },
        }),
      ).toBe(false)
    }
  }
  expect(NativeInstallationSchema.sameWindowsFiles(original, { ...original, version: 2 })).toBe(false)
})

test("Windows installation public facts preserve exact clones, record slots and nullable text", () => {
  const original = windowsFiles()
  expect(NativeInstallationSchema.sameWindowsFiles(original, structuredClone(original))).toBe(true)
  for (const [left, right] of [
    ["artifact", "manifest"],
    ["artifact", "runtime"],
    ["manifest", "runtime"],
  ] as const) {
    expect(
      NativeInstallationSchema.sameWindowsFiles(original, {
        ...original,
        [left]: original[right],
        [right]: original[left],
      }),
    ).toBe(false)
  }
  const nullText = { ...original, manifest: { ...original.manifest, text: null } }
  const emptyText = { ...original, manifest: { ...original.manifest, text: "" } }
  expect(NativeInstallationSchema.sameWindowsFiles(nullText, emptyText)).toBe(false)
  expect(NativeInstallationSchema.sameWindowsFiles(emptyText, nullText)).toBe(false)
})

const decodeWindows = Schema.decodeUnknownExit(Schema.fromJsonString(NativeInstallationSchema.WindowsObservation), {
  onExcessProperty: "error",
})

test("compact Windows observation binds the exact original bootstrap digest", () => {
  const original = windowsFiles()
  const decoded = decodeWindows(JSON.stringify(original))
  expect(decoded._tag).toBe("Success")
  if (decoded._tag !== "Success") throw new Error("combined observation did not decode")
  expect(decoded.value.bootstrap_sha256).toBe(original.bootstrap_sha256)
  expect(NativeInstallationSchema.sameWindowsFiles(original, decoded.value, original.bootstrap_sha256)).toBe(true)
  const changed = { ...original, bootstrap_sha256: "f".repeat(64) }
  expect(NativeInstallationSchema.sameWindowsFiles(original, changed)).toBe(false)
  expect(NativeInstallationSchema.sameWindowsFiles(changed, changed, original.bootstrap_sha256)).toBe(false)
  expect(NativeInstallationSchema.sameWindowsFiles(original, decoded.value, "")).toBe(false)
})

test("compact Windows observation rejects old, incomplete and unexpected Native JSON", () => {
  const legacy = { ...windowsFiles() }
  Reflect.deleteProperty(legacy, "bootstrap_sha256")
  for (const input of [
    legacy,
    { ...legacy, bootstrap_description: "old full description" },
    { ...windowsFiles(), bootstrap_sha256: undefined },
    { ...windowsFiles(), bootstrap_sha256: null },
    { ...windowsFiles(), bootstrap_sha256: "" },
    { ...windowsFiles(), bootstrap_sha256: {} },
    { ...windowsFiles(), version: 2 },
    { ...windowsFiles(), unexpected: true },
  ]) expect(decodeWindows(JSON.stringify(input))._tag).toBe("Failure")
  expect(decodeWindows("{")._tag).toBe("Failure")
})

test("compact Windows observation accepts only fixed lowercase SHA-256 digests", () => {
  for (const hash of ["0".repeat(64), "a".repeat(64)]) {
    expect(decodeWindows(JSON.stringify({ ...windowsFiles(), bootstrap_sha256: hash }))._tag).toBe("Success")
  }
  for (const hash of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "é".repeat(64)]) {
    expect(decodeWindows(JSON.stringify({ ...windowsFiles(), bootstrap_sha256: hash }))._tag).toBe("Failure")
  }
})
