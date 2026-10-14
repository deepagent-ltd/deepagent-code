import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { BrowserDNSMessage } from "./managed-browser-dns-message"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

const actual = process.env.DAC_BROWSER_PUBLIC_NETWORK_ACTUAL === "1" ? test : test.skip
async function build() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-public-network-build-"))
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-network.ts")],
    target: "node", external: ["electron"], outdir: directory, naming: "main.mjs" })
  if (!built.success) throw new AggregateError(built.logs, "Private browser network fixture build failed")
  return built.outputs[0]!.path
}
async function run(mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dac-browser-public-network-${mode}-`))
  await fs.chmod(root, 0o700)
  if (mode !== "public" && mode !== "doh-public") {
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Private Browser Network CA"],
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server-key.pem", "-out", "server.csr", "-subj", "/CN=positive.example.com"],
    ]) {
      const command = Bun.spawnSync(["openssl", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" })
      if (command.exitCode !== 0) throw new Error("Private certificate preparation failed")
    }
    await fs.writeFile(path.join(root, "server.ext"), `subjectAltName=DNS:*.example.com${mode.startsWith("doh-") ? ",DNS:cloudflare-dns.com,DNS:dns.alidns.com" : ""}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`)
    const signed = Bun.spawnSync(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem",
      "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "server.ext"], { cwd: root, stdout: "ignore", stderr: "ignore" })
    if (signed.exitCode !== 0) throw new Error("Private certificate signing failed")
    if (mode.startsWith("doh-")) {
      await fs.writeFile(path.join(root, "bad-server.ext"), "subjectAltName=DNS:*.example.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
      const bad = Bun.spawnSync(["openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem",
        "-CAcreateserial", "-out", "bad-server.pem", "-days", "1", "-extfile", "bad-server.ext"], { cwd: root, stdout: "ignore", stderr: "ignore" })
      if (bad.exitCode !== 0) throw new Error("Private wrong-service certificate preparation failed")
    }
    await fs.chmod(path.join(root, "server-key.pem"), 0o600); await fs.chmod(path.join(root, "ca-key.pem"), 0o600)
  }
  const startup = mode === "doh-public" ? Object.fromEntries(["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) : {}
  const spawned = Bun.spawn([managedBrowserInputFixtureExecutable, await build()], {
    cwd: root, env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root, ...startup, DAC_BROWSER_NETWORK_ROOT: root, DAC_BROWSER_NETWORK_MODE: mode }, stdout: "pipe", stderr: "pipe", timeout: 65000,
  })
  const [code, stdout, stderr] = await Promise.all([spawned.exited, new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  console.log("PUBLIC_BROWSER_NETWORK_EVIDENCE", mode, root)
  const failure = await Bun.file(path.join(root, "failure.json")).exists() ? await Bun.file(path.join(root, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-3000)).toBe(0)
  return await Bun.file(path.join(root, "result.json")).json()
}
actual("actual DNS/TLS: public-address pin, private/mixed/mapped rejection, proxy CONNECT and startup drift", async () => {
  const result = await run("dns")
  expect(result.node).toBe(managedBrowserInputRuntime.nodeVersion)
  expect(result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect([result.private, result.mixed, result.mapped, result.rebound, result.badTLS]).toEqual(Array(5).fill("BROWSER_NETWORK_DENIED"))
  expect(result.badTLSHTTP).toBe(0)
  expect(result.facts.connects).toEqual(["93.184.216.34:443", "93.184.216.34:443"])
  expect(result.facts.paths).toEqual(["/"])
  expect(result.facts.hosts).toEqual(["rebind.example.com"])
  expect(result.facts.sni).toContain("rebind.example.com")
  expect(result.facts.proxyAuthentication.every(Boolean)).toBe(true)
  expect(result.facts.leakedAuthorization).toBe(false)
  expect(result.noProxy).toHaveLength(5)
  expect(result.dnsChanged).toBe("BROWSER_DRIVER_UNAVAILABLE")
  expect(result.networksClosed.every(Boolean)).toBe(true)
  expect(result.finalNetworks.every((value: { sockets: number; requestsActive: number; responses: number; resolvers: number; operations: number; sinkSockets: number }) =>
    [value.sockets, value.requestsActive, value.responses, value.resolvers, value.operations, value.sinkSockets].every((count) => count === 0))).toBe(true)
}, 70000)

test("DNS wire codec validates the exact question, NOERROR NODATA and malformed packets", () => {
  const q = BrowserDNSMessage.question("positive.example.com", 1)
  const empty = Buffer.from(q); empty.writeUInt16BE(0x8180, 2)
  expect(BrowserDNSMessage.response(empty, "positive.example.com", 1).addresses).toEqual([])
  expect(() => BrowserDNSMessage.response(empty, "other.example.com", 1)).toThrow(BrowserDNSMessage.InvalidMessage)
  expect(() => BrowserDNSMessage.response(empty, "positive.example.com", 28)).toThrow(BrowserDNSMessage.InvalidMessage)
  for (const flags of [0x8380, 0x8182, 0x8183]) {
    const packet = Buffer.from(empty); packet.writeUInt16BE(flags, 2)
    expect(() => BrowserDNSMessage.response(packet, "positive.example.com", 1)).toThrow(BrowserDNSMessage.InvalidMessage)
  }
  expect(() => BrowserDNSMessage.response(Buffer.concat([empty, Buffer.from([0])]), "positive.example.com", 1)).toThrow(BrowserDNSMessage.InvalidMessage)
  expect(() => BrowserDNSMessage.question("invalid..example.com", 1)).toThrow(BrowserDNSMessage.InvalidMessage)
})

actual("AliDNS fixed service: original TLS broker, complete address rejection and current permit", async () => {
  const result = await run("doh-alidns")
  expect(result.doh).toEqual({ policy: "alidns_doh_v1", mixedRejected: true, serviceTLSRejected: true, currentDenied: true })
  expect(result.facts.connects).toContain("223.5.5.5:443")
  expect(result.facts.connects).not.toContain("1.1.1.1:443")
  expect(result.facts.doh.slice(0, 2).map((entry: { type: number }) => entry.type).toSorted()).toEqual([1, 28])
  expect(result.facts.doh.every((entry: { method: string; path: string; host: string; authorized: boolean }) =>
    entry.method === "POST" && entry.path === "/dns-query" && entry.host === "dns.alidns.com" && !entry.authorized)).toBe(true)
  expect(result.facts.paths).toEqual(["/"])
  expect(result.networksClosed).toEqual([true])
  expect(result.finalNetworks.every((value: { queries: number; sockets: number; requestsActive: number; operations: number }) =>
    [value.queries, value.sockets, value.requestsActive, value.operations].every((count) => count === 0))).toBe(true)
}, 70000)

actual("DoH controlled wire: two questions, CNAME and full private/mixed/malformed rejection", async () => {
  const result = await run("doh-wire")
  expect(result.doh.wireRefused).toBe(15)
  expect(result.doh.goodNames).toEqual(["valid", "cname"])
  expect(result.doh.zeroTargetAfterRejected).toBe(true)
  expect(result.doh.budgetCode).toBe("BROWSER_OUTPUT_LIMIT")
  expect(result.doh.budget.requests).toBeLessThanOrEqual(128)
  expect(result.doh.budget.maxHTTPInFlight).toBeLessThanOrEqual(8)
  expect(result.facts.doh.every((entry: { method: string; path: string; host: string; authorized: boolean }) =>
    entry.method === "POST" && entry.path === "/dns-query" && entry.host === "cloudflare-dns.com" && !entry.authorized)).toBe(true)
  expect(result.networksClosed.every(Boolean)).toBe(true)
}, 70000)

actual("DoH proxy TLS and cancel: fixed CONNECT, wrong service certificate, stream interruption", async () => {
  const result = await run("doh-proxy")
  expect(result.doh.serviceTLSRejected).toBe(true)
  expect(result.doh.cancel).toMatchObject({ stopped: true, result: "cancelled" })
  expect(result.doh.fixedServiceConnect).toBe(true)
  expect(result.facts.leakedAuthorization).toBe(false)
  expect(result.networksClosed.every(Boolean)).toBe(true)
  expect(result.finalNetworks.every((value: { httpInFlight: number; queries: number; sockets: number; requestsActive: number; operations: number }) =>
    [value.httpInFlight, value.queries, value.sockets, value.requestsActive, value.operations].every((count) => count === 0))).toBe(true)
}, 70000)

actual("DoH actual Electron: readonly AX/PNG, exact owner and system never falls back", async () => {
  const result = await run("doh-electron")
  expect(result.doh.text).toContain("IP pinned fixture")
  expect(result.doh.pngBytes).toBeGreaterThan(100)
  expect(result.doh.wrongOwnerZeroDoH).toBe(true)
  expect(result.doh.sessionFetchZeroDoH).toBe(true)
  expect(result.doh.lateOwnerZeroDoH).toBe(true)
  expect(result.doh.systemNoFallback).toBe(true)
  expect(result.networksClosed.every(Boolean)).toBe(true)
}, 70000)

actual("DoH real public: fixed Cloudflare/default CA then static HTTPS AX/PNG", async () => {
  const result = await run("doh-public")
  expect(result.public.url).toBe("https://example.com/")
  expect(result.public.text).toContain("Example Domain")
  expect(result.public.startupCAInjected).toBe(false)
  expect(result.public.facts.resolverPolicy).toBe("cloudflare_doh_v1")
  expect(result.public.facts.dohRequests).toBe(2)
  expect(result.public.facts.requests).toBe(3)
  expect(result.public.facts.resolved.a.length + result.public.facts.resolved.aaaa.length).toBeGreaterThan(0)
  expect(result.public.pngSignature).toBe("89504e470d0a1a0a")
  expect(result.networksClosed).toEqual([true])
}, 70000)
actual("actual Electron HTTPS Fetch transport: origin redirect, readonly AX/PNG, owner gate, limits and cancel", async () => {
  const result = await run("partition")
  expect(result.partition.url).toBe("https://positive.example.com/final")
  expect(result.partition.text).toContain("公网只读真实Chromium")
  expect(result.partition.text).not.toContain("SCRIPT_EXECUTED")
  expect(result.partition.cookies).toBe(0)
  expect(result.partition.pngBytes).toBeGreaterThan(100)
  expect([result.outsideRedirect, result.download]).toEqual(Array(2).fill("BROWSER_NETWORK_DENIED"))
  expect(result.large).toBe("BROWSER_OUTPUT_LIMIT")
  expect(result.wrongOwnerDenied).toBe(true)
  expect(result.lateOwnerZeroBroker).toBe(true)
  expect(result.cancel.stopped).toBe(true)
  expect(result.cancel.result).toBe("cancelled")
  expect(result.rawProtocolNoDNS).toBe(true)
  expect(result.facts.deniedTCP).toBe(0)
  expect(result.facts.dns.some((value: string) => value.startsWith("unapproved."))).toBe(false)
  expect(result.facts.paths).not.toContain("/other-owner")
  expect(result.networksClosed.every(Boolean)).toBe(true)
}, 70000)
actual("actual public HTTPS origin: default DNS and CA produce readonly AX and real PNG then close", async () => {
  const result = await run("public")
  expect(result.public.url).toBe("https://example.com/")
  expect(result.public.text).toContain("Example Domain")
  expect(result.public.startupCAInjected).toBe(false)
  expect(result.public.pngSignature).toBe("89504e470d0a1a0a")
  expect(result.public.pngBytes).toBeGreaterThan(100)
  expect(result.public.size).toEqual({ width: 1280, height: 800 })
  expect(result.public.facts.requests).toBeGreaterThan(0)
  expect(result.public.facts.connected).toBeGreaterThan(0)
  expect(result.networksClosed).toEqual([true])
  expect(result.finalNetworks[0]).toMatchObject({ sockets: 0, requestsActive: 0, responses: 0, resolvers: 0, operations: 0, sinkSockets: 0 })
}, 70000)

actual("normal HTTPS pipeline lemma: native Fetch owns request before pinned broker and fulfill", async () => {
  const result = await run("lemma")
  expect(result.lemma.text).toContain("IP pinned fixture")
  expect(result.lemma.pngBytes).toBeGreaterThan(100)
  expect(result.lemma.facts.fetchPaused).toBeGreaterThan(0)
  expect(result.lemma.facts.frameVerified).toBeGreaterThan(0)
  expect(result.lemma.facts.fulfilled).toBeGreaterThan(0)
  expect(result.lemma.wrongOwnerZeroBroker).toBe(true)
  expect(result.lemma.sessionFetchZeroBroker).toBe(true)
  expect(result.facts.paths).toEqual(["/"])
  expect(result.facts.connects).toEqual(["93.184.216.34:443"])
  expect(result.networksClosed).toEqual([true])
}, 70000)
