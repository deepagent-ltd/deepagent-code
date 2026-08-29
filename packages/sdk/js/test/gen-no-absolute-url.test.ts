import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// C6-04 — the generated SDK must not bake a server host into any call. The ONLY
// absolute URL the generator emits is the overridable `baseUrl` default in the
// generated client config (consumers pass their own baseUrl to
// createDeepAgentCodeClient). Every operation path must be relative.

const genDirs = [new URL("../src/gen", import.meta.url).pathname, new URL("../src/v2/gen", import.meta.url).pathname]

const knownBaseUrlDefault = "http://localhost:4096"
// Documentation / JSDoc links the generator emits (class references), never real calls.
const docLinkHosts = ["developer.mozilla.org", "npmjs.com", "swagger.io"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const allGeneratedFiles = genDirs.flatMap(walk)

describe("C6-04 generated SDK has no absolute URLs", () => {
  test("the operation surface (sdk.gen.ts) uses only relative paths", () => {
    for (const dir of genDirs) {
      const sdkGen = join(dir, "sdk.gen.ts")
      if (!statSync(sdkGen).isFile()) continue
      const src = readFileSync(sdkGen, "utf8")
      for (const match of src.matchAll(/url:\s*"([^"]*)"/g)) {
        const url = match[1]
        expect(url.startsWith("/"), `absolute operation path: ${match[1]}`).toBe(true)
      }
    }
  })

  test("the ONLY absolute URLs across all generated files are the baseUrl defaults", () => {
    for (const file of allGeneratedFiles) {
      const src = readFileSync(file, "utf8")
      for (const match of src.matchAll(/https?:\/\/[^\s"')]+/g)) {
        const url = match[0]
        if (docLinkHosts.some((host) => url.includes(host))) continue
        expect(url, `${file} embeds an absolute URL: ${url}`).toBe(knownBaseUrlDefault)
      }
    }
  })
})
