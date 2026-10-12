import { expect, test } from "bun:test"
import { Schema } from "effect"
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
