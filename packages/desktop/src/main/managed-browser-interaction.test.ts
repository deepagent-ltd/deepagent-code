import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"
import { prepareManagedBrowserInputAsset } from "../../scripts/managed-browser-input-assets"

const actual = process.env.DAC_BROWSER_PUBLIC_INTERACTION_ACTUAL === "1" ? test : test.skip

actual("actual public interaction: static form and lifecycle-bounded dynamic renderer through Main/NativeHost and private TLS/DoH", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-public-interaction-"))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "project"), { mode: 0o700 })
  for (const args of [
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Private Browser Assembly CA"],
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server-key.pem", "-out", "server.csr", "-subj", "/CN=positive.example.com"],
  ]) {
    const command = Bun.spawnSync(["openssl", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" })
    expect(command.exitCode).toBe(0)
  }
  await fs.writeFile(path.join(root, "server.ext"), "subjectAltName=DNS:positive.example.com,DNS:cloudflare-dns.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
  const certificate = Bun.spawnSync(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem",
    "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext"], { cwd: root, stdout: "ignore", stderr: "ignore" })
  expect(certificate.exitCode).toBe(0)
  await Promise.all([fs.chmod(path.join(root, "ca-key.pem"), 0o600), fs.chmod(path.join(root, "server-key.pem"), 0o600)])
  await fs.symlink(path.resolve(import.meta.dir, "../../../deepagent-code/node_modules"), path.join(root, "node_modules"), "dir")
  const inputAsset = await prepareManagedBrowserInputAsset({ directory: path.join(root, "managed-browser-input") })
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-interaction.ts")],
    target: "node", splitting: true, conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], outdir: root,
    naming: "main.mjs", sourcemap: "external", define: { __DAC_MANAGED_BROWSER_INPUT_ASSET__: inputAsset ? JSON.stringify(inputAsset) : "undefined" } })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  const repository = path.resolve(import.meta.dir, "../../../..")
  const sources = new Map<string, string>()
  const maps = Schema.Struct({ sources: Schema.Array(Schema.String), sourcesContent: Schema.Array(Schema.NullOr(Schema.String)) })
  for (const map of build.outputs.filter((value) => value.path.endsWith(".map"))) {
    const parsed = Schema.decodeUnknownSync(maps)(await Bun.file(map.path).json())
    parsed.sources.forEach((value, index) => {
      const absolute = path.resolve(path.dirname(map.path), value)
      const contents = parsed.sourcesContent[index]
      if (!absolute.startsWith(repository + "/packages/") || absolute.includes("/node_modules/") || contents == null) return
      sources.set(absolute, Hash.sha256(contents))
    })
  }
  const snapshot = await Promise.all(Array.from(sources, async ([filename, hash]) => ({
    path: path.relative(repository, filename), sha256: hash, current: Hash.sha256(await fs.readFile(filename)),
  })))
  const drift = snapshot.filter((value) => value.sha256 !== value.current)
  expect(drift).toEqual([])
  await fs.writeFile(path.join(root, "source-cohort.json"), JSON.stringify({ evidence: "actual compiled sourcemap sourcesContent",
    checked: snapshot.length, drift, sources: snapshot }, null, 2))
  console.log("PUBLIC_BROWSER_INTERACTION_CAPTURED", root)
  const modes = process.env.DAC_BROWSER_INTERACTION_MODE === "dynamic" ? ["dynamic"] as const : ["static", "dynamic"] as const
  for (const pageMode of modes) {
    const caseRoot = path.join(root, pageMode)
    await fs.mkdir(caseRoot, { mode: 0o700 })
    await fs.mkdir(path.join(caseRoot, "project"), { mode: 0o700 })
    await Promise.all(["server-key.pem", "server.pem", "ca.pem"].map((file) => fs.copyFile(path.join(root, file), path.join(caseRoot, file))))
    const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
      cwd: caseRoot, env: { PATH: process.env.PATH, HOME: caseRoot, TMPDIR: caseRoot, XDG_CONFIG_HOME: caseRoot, XDG_DATA_HOME: caseRoot,
        XDG_CACHE_HOME: caseRoot, DAC_BROWSER_PUBLIC_ROOT: caseRoot, DAC_BROWSER_PAGE_MODE: pageMode },
      stdout: "pipe", stderr: "pipe", timeout: 65_000,
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await fs.writeFile(path.join(caseRoot, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
    console.log("PUBLIC_BROWSER_INTERACTION_EVIDENCE", caseRoot)
  const failure = await Bun.file(path.join(caseRoot, "utility-failure.json")).exists()
    ? await Bun.file(path.join(caseRoot, "utility-failure.json")).json()
    : await Bun.file(path.join(caseRoot, "failure.json")).exists() ? await Bun.file(path.join(caseRoot, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  const result = await Bun.file(path.join(caseRoot, "result.json")).json()
  expect(result.childExit).toBe(0)
  expect(result.result.node).toBe(managedBrowserInputRuntime.nodeVersion)
  expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect(result.result.profile).toBe("managed-public-interaction-v1")
  expect(result.result.actions).toHaveLength(pageMode === "dynamic" ? 34 : 25)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "unknown")).toHaveLength(pageMode === "dynamic" ? 4 : 3)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "failed")).toHaveLength(pageMode === "dynamic" ? 1 : 0)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "pending")).toEqual([])
  expect(result.result.pageMode).toBe(pageMode)
  expect(result.result.snapshotText).toContain(pageMode === "dynamic" ? "Dynamic rendered" : "Public interaction Manager")
  expect(result.result.settledText).toContain("Form accepted")
  expect(result.result.idle.before).toBe(result.result.idle.after)
  expect(result.result.idle.extraHTTP).toBe(0)
  expect(result.result.idle.failed).toBeUndefined()
  expect(result.result.image.mime).toBe("image/png")
  expect(result.result.image.bytes).toBeGreaterThan(1000)
  expect(result.result.image.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(result.result.deniedCode).toBe("BROWSER_NETWORK_DENIED")
  expect(result.result.controlState).toBe("stopped")
  expect(result.result.stopConfirmed).toBe(true)
  expect(result.result.closed).toBe(true)
  expect(result.result.readAndExactCancelWrites).toBe(0)
  expect(result.result.providerCalls).toBe(0)
  expect(result.facts.page).toEqual(pageMode === "dynamic" ? ["GET /", "GET /api", "POST /submit", "GET /redirect303", "POST /submit", "GET /accepted", "GET /redirect307", "POST /submit", "GET /oversize", "GET /accepted", "GET /aba", "GET /held", "POST /submit"] : ["GET /", "POST /submit", "GET /redirect303", "POST /submit", "GET /accepted", "GET /redirect307", "POST /submit", "GET /oversize", "GET /accepted", "GET /slow"])
  expect(result.facts.bodies).toHaveLength(pageMode === "dynamic" ? 4 : 3)
  expect(result.facts.bodies.map((value: string) => new URLSearchParams(value).get("name"))).toEqual(pageMode === "dynamic" ? ["原生交互 Unicode", "redirect303", "redirect307", "held"] : ["原生交互 Unicode", "redirect303", "redirect307"])
  expect(result.facts.lateProbes).toBe(pageMode === "dynamic" ? 1 : 0)
  expect(result.result.isolated).toEqual(Array(4).fill("BROWSER_SCOPE_DENIED"))
  expect(result.result.redirectCode).toBe("BROWSER_UNKNOWN")
  expect(result.result.oversizedCode).toBe("BROWSER_UNKNOWN")
  if (pageMode === "dynamic") expect(result.result.abaCode).toBe("BROWSER_STALE_TARGET")
  expect(new URLSearchParams(result.facts.bodies[0]).get("name")).toBe("原生交互 Unicode")
  expect(result.facts.doh.filter((type: number) => type === 1)).toHaveLength(pageMode === "dynamic" ? 14 : 11)
  expect(result.facts.doh.filter((type: number) => type === 28)).toHaveLength(pageMode === "dynamic" ? 14 : 11)
  expect(result.facts.sni).toContain("cloudflare-dns.com")
  expect(result.facts.sni).toContain("positive.example.com")
  expect(result.facts.connects.every((value: string) => ["1.1.1.1:443", "93.184.216.34:443"].includes(value))).toBe(true)
  expect(result.facts.proxyAuthenticated.every(Boolean)).toBe(true)
  expect(result.facts.authLeak).toBe(false)
  expect(result.facts.debuggerListeners).toEqual(Array(pageMode === "dynamic" ? 30 : 23).fill(2))
  expect(result.windows).toBe(0)
  expect(result.remainingPeerSockets).toBe(0)
  }
}, 140_000)
