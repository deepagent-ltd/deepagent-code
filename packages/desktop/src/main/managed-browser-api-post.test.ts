import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputFixtureDefine } from "./fixture/managed-browser-input-build"
import { Schema } from "effect"
import { Hash } from "@deepagent-code/core/util/hash"

const actual = process.env.DAC_BROWSER_API_POST_ACTUAL === "1" ? test : test.skip

actual("actual explicit API POST: sealed request, digest-only capacity, redirects and cancelled custody through original Main/NativeHost", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-api-post-"))
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
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-api-post.ts")],
    target: "node", splitting: true, conditions: ["node"], external: ["electron", "bun", "jsonc-parser", "@lydell/node-pty"], outdir: root,
    naming: "main.mjs", sourcemap: "external", define: await managedBrowserInputFixtureDefine(root) })
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
  console.log("BROWSER_API_POST_CAPTURED", root)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root, DAC_BROWSER_API_ROOT: root }, stdout: "pipe", stderr: "pipe", timeout: 65_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("BROWSER_API_POST_EVIDENCE", root)
  const failure = await Bun.file(path.join(root, "utility-failure.json")).exists()
    ? await Bun.file(path.join(root, "utility-failure.json")).json()
    : await Bun.file(path.join(root, "failure.json")).exists() ? await Bun.file(path.join(root, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.childExit).toBe(0)
  expect(result.result.node).toBe(managedBrowserInputRuntime.nodeVersion)
  expect(result.result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect(result.result.profile).toBe("managed-public-api-v1")
  expect(result.result.posted.status).toBe(200)
  expect(result.result.posted.text).toBe('{"accepted":true}')
  expect(result.result.large).toEqual({ version: 1, status: 200, contentType: "text/plain", bytes: 65536, sha256: Hash.sha256("r".repeat(65536)) })
  expect(result.result.actions).toHaveLength(9)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "unknown")).toHaveLength(3)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "failed")).toHaveLength(1)
  expect(result.result.actions.filter((action: { outcome: string }) => action.outcome === "pending")).toEqual([])
  expect(result.result.blocked).toEqual(["BROWSER_NETWORK_DENIED", ...Array(3).fill("BROWSER_SCOPE_DENIED")])
  expect(result.result.redirectCode).toBe("BROWSER_UNKNOWN")
  expect(result.result.oversizedCode).toBe("BROWSER_UNKNOWN")
  expect(result.result.cancelledCode).toBe("BROWSER_UNKNOWN")
  expect(result.result.staleCode).toBe("BROWSER_STALE_TARGET")
  expect(result.result.controlState).toBe("stopped")
  expect(result.result.stopConfirmed).toBe(true)
  expect(result.result.closed).toBe(true)
  expect(result.result.readAndExactWrites).toBe(0)
  expect(result.result.providerCalls).toBe(0)
  expect(result.facts.page).toEqual(["GET /", "POST /api?slot=1", "POST /large", "POST /redirect", "POST /oversize", "POST /held"])
  expect(result.facts.bodies).toEqual([
    ...[Buffer.from('{"value":"Unicode 原请求"}'), Buffer.from("x".repeat(65536)), ...Array(3).fill(Buffer.from('{"value":"Unicode 原请求"}'))]
      .map((body) => ({ bytes: body.length, sha256: Hash.sha256(body) })),
  ])
  expect(result.facts.pageProbes).toBe(1)
  expect(result.facts.doh.filter((type: number) => type === 1)).toHaveLength(6)
  expect(result.facts.doh.filter((type: number) => type === 28)).toHaveLength(6)
  expect(result.facts.sni).toContain("cloudflare-dns.com")
  expect(result.facts.sni).toContain("positive.example.com")
  expect(result.facts.connects.every((value: string) => ["1.1.1.1:443", "93.184.216.34:443"].includes(value))).toBe(true)
  expect(result.facts.proxyAuthenticated.every(Boolean)).toBe(true)
  expect(result.facts.authLeak).toBe(false)
  expect(result.windows).toBe(0)
  expect(result.remainingPeerSockets).toBe(0)
}, 80_000)
