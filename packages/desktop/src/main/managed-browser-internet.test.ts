import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"

const actual = process.env.DAC_BROWSER_INTERNET_ACTUAL === "1" ? test : test.skip
const resolverPolicy = Schema.decodeUnknownSync(Schema.Literals(["system", "cloudflare_doh_v1", "alidns_doh_v1"]))(
  process.env.DAC_BROWSER_INTERNET_RESOLVER ?? "cloudflare_doh_v1")

actual(`actual internet HTTPS through production Main/NativeHost ${resolverPolicy}, address checks, AX and PNG`, async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-internet-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "project"), { mode: 0o700 })
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  const asset = await prepareManagedBrowserInputAsset({ directory: path.join(root, "managed-browser-input") })
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-internet.ts")],
    target: "node", splitting: true, conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"],
    outdir: root, naming: "main.mjs", sourcemap: "external",
    define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: asset ? JSON.stringify(asset) : "undefined" } })
  expect(built.success, built.logs.map(String).join("\n")).toBe(true)
  const repository = path.resolve(import.meta.dir, "../../../..")
  const sources = new Map<string, string>()
  const maps = Schema.Struct({ sources: Schema.Array(Schema.String), sourcesContent: Schema.Array(Schema.NullOr(Schema.String)) })
  for (const output of built.outputs.filter((value) => value.path.endsWith(".map"))) {
    const parsed = Schema.decodeUnknownSync(maps)(await Bun.file(output.path).json())
    parsed.sources.forEach((value, index) => {
      const filename = path.resolve(path.dirname(output.path), value)
      const contents = parsed.sourcesContent[index]
      if (!filename.startsWith(repository + "/packages/") || filename.includes("/node_modules/") || contents == null) return
      sources.set(filename, Hash.sha256(contents))
    })
  }
  const snapshot = await Promise.all(Array.from(sources, async ([filename, hash]) => ({ path: path.relative(repository, filename),
    sha256: hash, current: Hash.sha256(await fs.readFile(filename)) })))
  const drift = snapshot.filter((value) => value.sha256 !== value.current)
  expect(drift).toEqual([])
  await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ checked: snapshot.length, drift, sources: snapshot }), { mode: 0o600 })
  console.log("BROWSER_INTERNET_EVIDENCE", root)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_DATA_HOME: root,
      XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, DAC_BROWSER_INTERNET_ROOT: root,
      DAC_BROWSER_INTERNET_RESOLVER: resolverPolicy },
    stdout: "pipe", stderr: "pipe", timeout: 80_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  const failure = await Bun.file(path.join(root, "typed-failure.json")).exists()
    ? await Bun.file(path.join(root, "typed-failure.json")).json()
    : await Bun.file(path.join(root, "utility-failure.json")).exists()
    ? await Bun.file(path.join(root, "utility-failure.json")).json()
    : await Bun.file(path.join(root, "main-failure.json")).exists() ? await Bun.file(path.join(root, "main-failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-1500)).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.childExit).toBe(0)
  expect(result.windows).toBe(0)
  expect(result.noPrivateTLSOrProxyOverride).toBe(true)
  expect(result.result.origin).toBe("https://example.com")
  expect(result.result.profile).toBe("managed-public-readonly-v1")
  expect(result.result.resolverPolicy).toBe(resolverPolicy)
  expect(result.result.actions).toBe(4)
  expect(result.result.exampleDomainObserved).toBe(true)
  expect(result.result.image.mime).toBe("image/png")
  expect(result.result.image.bytes).toBeGreaterThan(1000)
  expect(result.result.census).toEqual({ inputs: 0, providers: 0, work: 0 })
  expect(result.result.stopConfirmed).toBe(true)
}, 90_000)
