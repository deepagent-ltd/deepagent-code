import { app, session } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import dns from "node:dns"
import dgram from "node:dgram"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import type { Duplex } from "node:stream"
import { createManagedBrowserNetwork, ManagedBrowserNetworkError } from "../managed-browser-network"

const root = process.env.DAC_BROWSER_NETWORK_ROOT!
const mode = process.env.DAC_BROWSER_NETWORK_MODE!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const result: Record<string, unknown> = { mode, node: process.versions.node, electron: process.versions.electron }
  const state = { permit: true, identity: {} as object, deadline: Date.now() + 25000, active: undefined as number | undefined,
    permitWait: undefined as Promise<void> | undefined, permitReads: 0 }
  const windows: Electron.BrowserWindow[] = []
  const networks: Awaited<ReturnType<typeof createManagedBrowserNetwork>>[] = []
  const resources: Array<() => Promise<void>> = []
  const heartbeat = setInterval(() => { void fs.writeFile(path.join(root, "live-facts.json"), JSON.stringify({ facts, networks: networks.map((network) => network.facts()) }), { mode: 0o600 }) }, 200)
  const watchdog = setTimeout(() => { void Promise.all(networks.map((network) => network.close())) }, 12000)
  const facts = { connects: [] as string[], sni: [] as string[], paths: [] as string[], hosts: [] as string[], dns: [] as string[],
    proxyAuthentication: [] as boolean[], leakedAuthorization: false, deniedTCP: 0, tlsRejected: 0,
    doh: [] as Array<{ method: string; path: string; host: string; type: number; name: string; authorized: boolean }> }
  const dnsState = { rebind: false, systemFake: false }
  const dohState = { kind: "valid" }
  const stage = async (name: string) => fs.writeFile(path.join(root, "progress.json"), JSON.stringify({ name, facts, networks: networks.map((network) => network.facts()) }), { mode: 0o600 })
  const launch = async (origins: string[], policy: "system" | "cloudflare_doh_v1" | "alidns_doh_v1" =
    mode === "doh-alidns" ? "alidns_doh_v1" : mode.startsWith("doh-") ? "cloudflare_doh_v1" : "system") => {
    const partition = session.fromPartition(`dac-public-fixture-${mode}-${networks.length}`, { cache: false })
    partition.setPermissionCheckHandler(() => false)
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.on("will-download", (event, item) => { event.preventDefault(); item.cancel() })
    const network = await createManagedBrowserNetwork({ partition, approvedOrigins: origins, resolverPolicy: policy, currentPermit: async () => {
      state.permitReads++; await state.permitWait; return state.permit
    },
      actionIdentity: () => state.identity, actionDeadline: () => state.deadline, activeContentsID: () => state.active })
    networks.push(network)
    const window = await network.createReadonlyWindow()
    windows.push(window); state.active = window.webContents.id
    return { network, window, partition }
  }
  const renew = () => { state.identity = {}; state.deadline = Date.now() + 25000 }
  const refusal = async (work: Promise<unknown>) => {
    try { await work; return "unexpected-success" }
    catch (error) { return error instanceof ManagedBrowserNetworkError ? error.code : "unexpected-error" }
  }
  try {
    if (mode === "public" || mode === "doh-public") {
      const owner = await launch(["https://example.com"])
      await owner.window.webContents.loadURL("https://example.com/")
      await owner.window.webContents.debugger.sendCommand("Accessibility.enable")
      const ax = await owner.window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes: Array<{ name?: { value?: string } }> }
      const png = await owner.window.webContents.capturePage()
      const bytes = png.toPNG()
      await fs.writeFile(path.join(root, "public.png"), bytes, { mode: 0o600 })
      result.public = { url: owner.window.webContents.getURL(), text: ax.nodes.map((node) => node.name?.value ?? "").join(" "),
        pngBytes: bytes.length, pngSignature: bytes.subarray(0, 8).toString("hex"), pngHash: createHash("sha256").update(bytes).digest("hex"),
        size: png.getSize(), facts: owner.network.facts(), defaultDNS: dns.getServers(), startupCAInjected: false }
      assert.equal(owner.window.webContents.getURL(), "https://example.com/")
      assert.ok(String((result.public as { text: string }).text).includes("Example Domain"))
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
      return
    }
    // Process-private startup CA/DNS/proxy: no OS resolver, keychain or user configuration changes.
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), await fs.readFile(path.join(root, "ca.pem"), "utf8")])
    const dnsServer = dgram.createSocket("udp4")
    dnsServer.on("message", (packet, remote) => {
      let offset = 12
      const labels: string[] = []
      while (packet[offset]) { const size = packet[offset]!; labels.push(packet.subarray(offset + 1, offset + 1 + size).toString()); offset += size + 1 }
      offset++
      const name = labels.join(".")
      const type = packet.readUInt16BE(offset)
      facts.dns.push(`${name}/${type}`)
      const privateName = name.startsWith("private.") || (name.startsWith("rebind.") && dnsState.rebind)
      const addresses = type === 1 ? dnsState.systemFake ? ["198.18.0.7"] : privateName ? ["127.0.0.1"] : name.startsWith("mixed.") ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"] : []
      const answers = addresses.map((value) => {
        const answer = Buffer.alloc(16)
        answer.writeUInt16BE(0xc00c); answer.writeUInt16BE(1, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(1, 6); answer.writeUInt16BE(4, 10)
        value.split(".").map(Number).forEach((part, index) => { answer[12 + index] = part })
        return answer
      })
      if (type === 28 && name.startsWith("mapped.")) {
        const answer = Buffer.alloc(28)
        answer.writeUInt16BE(0xc00c); answer.writeUInt16BE(28, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(1, 6); answer.writeUInt16BE(16, 10)
        answer.writeUInt16BE(0xffff, 22); answer.writeUInt16BE(0x7f00, 24); answer.writeUInt16BE(1, 26); answers.push(answer)
      }
      const header = Buffer.alloc(12)
      packet.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(answers.length, 6)
      dnsServer.send(Buffer.concat([header, packet.subarray(12, offset + 4), ...answers]), remote.port, remote.address)
    })
    await new Promise<void>((accept) => dnsServer.bind(0, "127.0.0.1", accept))
    resources.push(() => new Promise<void>((accept) => dnsServer.close(() => accept())))
    dns.setServers([`127.0.0.1:${dnsServer.address().port}`])
    const denied = http.createServer((_request, response) => response.end("denied"))
    denied.on("connection", () => facts.deniedTCP++)
    await new Promise<void>((accept) => denied.listen(0, "127.0.0.1", accept))
    const deniedAddress = denied.address()
    if (!deniedAddress || typeof deniedAddress === "string") throw new Error("Missing own address")
    resources.push(() => new Promise<void>((accept) => { denied.closeAllConnections(); denied.close(() => accept()) }))
    const sockets = new Set<Duplex>()
    const origin = https.createServer({ key: await fs.readFile(path.join(root, "server-key.pem")), cert: await fs.readFile(path.join(root, "server.pem")) }, (request, response) => {
      if (request.headers.host === "cloudflare-dns.com" || request.headers.host === "dns.alidns.com") {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const query = Buffer.concat(chunks)
          const names: string[] = []
          const position = { value: 12 }
          while (query[position.value]) { const size = query[position.value]!; names.push(query.subarray(position.value + 1, position.value + size + 1).toString()); position.value += size + 1 }
          const type = query.readUInt16BE(position.value + 1)
          facts.doh.push({ method: request.method ?? "", path: request.url ?? "", host: request.headers.host ?? "", type,
            name: names.join("."), authorized: Boolean(request.headers.authorization || request.headers.cookie || request.headers["proxy-authorization"]) })
          assert.equal(request.headers["content-type"], "application/dns-message")
          assert.equal(request.headers.accept, "application/dns-message")
          if (dohState.kind === "redirect") { response.writeHead(302, { location: "https://unapproved.example.com/dns-query" }); response.end(); return }
          if (dohState.kind === "503") { response.writeHead(503); response.end(); return }
          if (dohState.kind === "json") { response.setHeader("content-type", "application/dns-json"); response.end("{}"); return }
          response.setHeader("content-type", "application/dns-message")
          if (dohState.kind === "slow") { response.writeHead(200); response.write(Buffer.alloc(12)); return }
          response.end(dohState.kind === "large" ? Buffer.alloc(65536) : fixtureDNSResponse(query, dohState.kind))
        })().catch(() => response.destroy())
        return
      }
      facts.paths.push(request.url ?? ""); facts.hosts.push(request.headers.host ?? "")
      if (request.headers.authorization || request.headers["proxy-authorization"] || request.headers.cookie) facts.leakedAuthorization = true
      if (request.url === "/redirect") { response.writeHead(302, { location: "https://positive.example.com/final" }); response.end(); return }
      if (request.url === "/outside-redirect") { response.writeHead(302, { location: "https://unapproved.example.com/outside" }); response.end(); return }
      if (request.url === "/loop") { response.writeHead(302, { location: "/loop" }); response.end(); return }
      if (request.url === "/slow") { response.writeHead(200, { "content-type": "text/html" }); response.write("<html><body>partial"); return }
      if (request.url === "/large") { response.end(Buffer.alloc(8_388_609, 65)); return }
      if (request.url === "/download") { response.setHeader("content-disposition", "attachment; filename=blocked.txt"); response.end("blocked"); return }
      response.setHeader("content-type", "text/html;charset=utf-8")
      response.setHeader("set-cookie", "fixture=must-not-be-stored")
      response.end((mode === "dns" || mode === "lemma" || mode.startsWith("doh-")) ? "<html><body>IP pinned fixture</body></html>" : `<html><body style="background:#1c353e;color:white"><h1>公网只读真实Chromium</h1><p>IP pinned fixture</p><script>document.body.textContent='SCRIPT_EXECUTED';new WebSocket('ws://127.0.0.1:${deniedAddress.port}/ws');new RTCPeerConnection()</script><img src="http://127.0.0.1:${deniedAddress.port}/outside"><img src="https://private.example.com/private"><iframe src="https://unapproved.example.com/frame"></iframe><link rel="dns-prefetch" href="//unapproved.example.com"><link rel="preconnect" href="https://unapproved.example.com"></body></html>`)
    })
    origin.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
    origin.on("secureConnection", (socket) => facts.sni.push(socket.servername || ""))
    origin.on("tlsClientError", () => facts.tlsRejected++)
    await new Promise<void>((accept) => origin.listen(0, "127.0.0.1", accept))
    const originAddress = origin.address()
    if (!originAddress || typeof originAddress === "string") throw new Error("Missing TLS address")
    resources.push(() => new Promise<void>((accept) => { for (const socket of sockets) socket.destroy(); origin.closeAllConnections(); origin.close(() => accept()) }))
    const proxySockets = new Set<net.Socket>()
    const proxy = http.createServer((_request, response) => { response.writeHead(403); response.end() })
    proxy.on("connection", (socket) => { proxySockets.add(socket); socket.once("close", () => proxySockets.delete(socket)) })
    proxy.on("connect", (request, client, head) => {
      facts.connects.push(request.url ?? "")
      facts.proxyAuthentication.push(request.headers["proxy-authorization"] === `Basic ${Buffer.from("private:fixture").toString("base64")}`)
      const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      proxySockets.add(upstream); upstream.once("close", () => proxySockets.delete(upstream))
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy())
      client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy())
      if (request.url === "93.184.216.34:443") dnsState.rebind = true
    })
    await new Promise<void>((accept) => proxy.listen(0, "127.0.0.1", accept))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy address")
    resources.push(() => new Promise<void>((accept) => { for (const socket of proxySockets) socket.destroy(); proxy.closeAllConnections(); proxy.close(() => accept()) }))
    Object.assign(process.env, { https_proxy: `http://private:fixture@127.0.0.1:${proxyAddress.port}`, HTTPS_PROXY: "http://127.0.0.1:1", no_proxy: "", NO_PROXY: "" })
    const owner = await launch(["https://positive.example.com", "https://private.example.com", "https://mixed.example.com", "https://mapped.example.com", "https://rebind.example.com", "https://bad.example.net"])
    if (mode.startsWith("doh-")) {
      const navigate = async () => {
        renew()
        try { await owner.window.webContents.loadURL("https://positive.example.com/"); return "loaded" }
        catch { return owner.network.facts().lastCode }
      }
      if (mode === "doh-alidns") {
        assert.equal(await navigate(), "loaded")
        assert.equal(owner.network.facts().resolverPolicy, "alidns_doh_v1")
        const before = facts.paths.length
        dohState.kind = "mixed"
        assert.equal(await navigate(), "BROWSER_NETWORK_DENIED")
        assert.equal(facts.paths.length, before)
        origin.setSecureContext({ key: await fs.readFile(path.join(root, "server-key.pem")), cert: await fs.readFile(path.join(root, "bad-server.pem")) })
        dohState.kind = "valid"
        const questions = facts.doh.length
        assert.equal(await navigate(), "BROWSER_NETWORK_DENIED")
        assert.equal(facts.doh.length, questions)
        assert.equal(facts.paths.length, before)
        const connections = facts.connects.length
        state.permit = false
        assert.equal(await navigate(), "BROWSER_CANCELLED")
        assert.equal(facts.doh.length, questions)
        assert.equal(facts.connects.length, connections)
        result.doh = { policy: "alidns_doh_v1", mixedRejected: true, serviceTLSRejected: true, currentDenied: true }
        return
      }
      if (mode === "doh-wire") {
        const goodNames: string[] = []
        for (const kind of ["valid", "cname"]) { dohState.kind = kind; assert.equal(await navigate(), "loaded"); goodNames.push(kind) }
        const before = facts.paths.length
        const failures = ["private", "mixed", "mapped", "question", "id", "tc", "rcode", "truncated", "cname-loop", "pointer", "extra-private", "empty", "large", "json", "redirect"]
        for (const kind of failures) {
          dohState.kind = kind
          assert.equal(await navigate(), kind === "large" ? "BROWSER_OUTPUT_LIMIT" : "BROWSER_NETWORK_DENIED", kind)
          assert.equal(facts.paths.length, before, kind)
        }
        dohState.kind = "valid"; renew()
        const budgetStarted = owner.network.facts().requests
        const budget = { code: "" }
        for (let index = 0; index < 50; index++) {
          try { await owner.window.webContents.loadURL(`https://positive.example.com/?budget=${index}`) }
          catch { budget.code = owner.network.facts().lastCode; break }
        }
        assert.equal(budget.code, "BROWSER_OUTPUT_LIMIT")
        assert.ok(owner.network.facts().requests <= facts.doh.length + facts.paths.length)
        assert.ok(owner.network.facts().maxHTTPInFlight <= 8)
        result.doh = { wireRefused: failures.length, goodNames, zeroTargetAfterRejected: true, budgetCode: budget.code,
          budget: { ...owner.network.facts(), requests: owner.network.facts().requests - budgetStarted } }
        return
      }
      if (mode === "doh-proxy") {
        assert.equal(await navigate(), "loaded")
        const before = facts.paths.length
        const requestsBefore = facts.doh.length
        dohState.kind = "503"
        assert.equal(await navigate(), "BROWSER_NETWORK_DENIED")
        assert.ok(facts.doh.length - requestsBefore <= 2)
        assert.equal(facts.paths.length, before)
        origin.setSecureContext({ key: await fs.readFile(path.join(root, "server-key.pem")), cert: await fs.readFile(path.join(root, "bad-server.pem")) })
        dohState.kind = "valid"
        const badBefore = facts.doh.length
        assert.equal(await navigate(), "BROWSER_NETWORK_DENIED")
        assert.equal(facts.doh.length, badBefore)
        assert.equal(facts.paths.length, before)
        origin.setSecureContext({ key: await fs.readFile(path.join(root, "server-key.pem")), cert: await fs.readFile(path.join(root, "server.pem")) })
        dohState.kind = "slow"; renew()
        const slow = owner.window.webContents.loadURL("https://positive.example.com/slow-doh").catch(() => "cancelled")
        const until = Date.now() + 5000
        while (facts.doh.length === badBefore && Date.now() < until) await new Promise((accept) => setTimeout(accept, 5))
        assert.ok(facts.doh.length > badBefore)
        state.permit = false
        const stopped = await owner.network.close()
        assert.equal(stopped, true); assert.equal(facts.paths.length, before)
        result.doh = { serviceTLSRejected: true, fixedServiceConnect: facts.connects.filter((value) => value === "1.1.1.1:443").length > 0,
          cancel: { stopped, result: await slow, facts: owner.network.facts() } }
        return
      }
      assert.equal(mode, "doh-electron")
      assert.equal(await navigate(), "loaded")
      await owner.window.webContents.debugger.sendCommand("Accessibility.enable")
      const ax = await owner.window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes: Array<{ name?: { value?: string } }> }
      const png = (await owner.window.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(root, "doh.png"), png, { mode: 0o600 })
      const before = { doh: facts.doh.length, connects: facts.connects.length, paths: facts.paths.length }
      const other = await owner.network.createReadonlyWindow(); windows.push(other)
      await other.webContents.loadURL("https://positive.example.com/other-owner").catch(() => {})
      await owner.partition.fetch("https://positive.example.com/no-frame").catch(() => {})
      assert.equal(facts.doh.length, before.doh); assert.equal(facts.connects.length, before.connects)
      renew()
      const readsBefore = state.permitReads
      const release: { value?: () => void } = {}
      state.permitWait = new Promise<void>((accept) => { release.value = accept })
      const late = owner.window.webContents.loadURL("https://positive.example.com/late-owner").catch(() => "cancelled")
      const until = Date.now() + 2000
      while (state.permitReads === readsBefore && Date.now() < until) await new Promise((accept) => setTimeout(accept, 5))
      assert.ok(state.permitReads > readsBefore)
      state.active = other.webContents.id; release.value!(); state.permitWait = undefined
      assert.equal(await late, "cancelled")
      assert.equal(facts.doh.length, before.doh); assert.equal(facts.connects.length, before.connects); assert.equal(facts.paths.length, before.paths)
      renew(); dnsState.systemFake = true
      const system = await launch(["https://positive.example.com"], "system")
      await system.window.webContents.loadURL("https://positive.example.com/").catch(() => {})
      assert.equal(system.network.facts().lastCode, "BROWSER_NETWORK_DENIED")
      assert.equal(system.network.facts().dohRequests, 0)
      assert.equal(facts.doh.length, before.doh)
      result.doh = { text: ax.nodes.map((node) => node.name?.value ?? "").join(" "), pngBytes: png.length,
        wrongOwnerZeroDoH: true, sessionFetchZeroDoH: true, lateOwnerZeroDoH: true, systemNoFallback: true }
      return
    }
    if (mode === "lemma") {
      await stage("normal-pipeline-before-load")
      await owner.window.webContents.loadURL("https://positive.example.com/")
      await owner.window.webContents.debugger.sendCommand("Accessibility.enable")
      const ax = await owner.window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes: Array<{ name?: { value?: string } }> }
      const text = ax.nodes.map((node) => node.name?.value ?? "").join(" ")
      assert.ok(text.includes("IP pinned fixture"))
      const png = (await owner.window.webContents.capturePage()).toPNG()
      await fs.writeFile(path.join(root, "lemma.png"), png, { mode: 0o600 })
      const beforeDNS = facts.dns.length
      const beforeConnect = facts.connects.length
      const other = await owner.network.createReadonlyWindow(); windows.push(other)
      await other.webContents.loadURL("https://positive.example.com/wrong-owner").catch(() => {})
      await owner.partition.fetch("https://positive.example.com/no-frame").catch(() => {})
      assert.equal(facts.dns.length, beforeDNS); assert.equal(facts.connects.length, beforeConnect)
      assert.equal(facts.paths.filter((value) => value === "/wrong-owner" || value === "/no-frame").length, 0)
      result.lemma = { text, pngBytes: png.length, facts: owner.network.facts(), wrongOwnerZeroBroker: true, sessionFetchZeroBroker: true }
      return
    }
    const navigate = async (url: string) => {
      renew()
      try { await owner.window.webContents.loadURL(url); return "loaded" }
      catch { return owner.network.facts().lastCode }
    }
    if (mode === "dns") {
      result.private = await navigate("https://private.example.com/")
      result.mixed = await navigate("https://mixed.example.com/")
      result.mapped = await navigate("https://mapped.example.com/")
      assert.deepEqual([result.private, result.mixed, result.mapped], Array(3).fill("BROWSER_NETWORK_DENIED"))
      assert.equal(facts.connects.length, 0)
      dnsState.rebind = false
      assert.equal(await navigate("https://rebind.example.com/"), "loaded")
      result.rebound = await navigate("https://rebind.example.com/")
      result.badTLS = await navigate("https://bad.example.net/")
      result.badTLSHTTP = facts.hosts.filter((value) => value === "bad.example.net").length
      assert.equal(result.badTLSHTTP, 0)
      assert.equal(result.rebound, "BROWSER_NETWORK_DENIED")
      assert.equal(facts.leakedAuthorization, false)
      result.noProxy = []
      for (const value of ["positive.example.com", ".example.com", "*.example.com", "positive.example.com:443", "*"]) {
        renew(); process.env.no_proxy = value
        const next = await launch(["https://positive.example.com"])
        const before: number = facts.connects.length
        const operation = next.window.webContents.loadURL("https://positive.example.com/").catch(() => {})
        const until = Date.now() + 2000
        while (!next.network.facts().directRoutes && Date.now() < until) await new Promise((accept) => setTimeout(accept, 5))
        assert.equal(next.network.facts().directRoutes, 1)
        await next.network.close(); await operation
        assert.equal(facts.connects.length, before)
        ;(result.noProxy as string[]).push(value)
      }
      process.env.no_proxy = ""
      renew()
      const final = await launch(["https://positive.example.com"])
      dns.setServers(["127.0.0.1:1"])
      await final.window.webContents.loadURL("https://positive.example.com/").catch(() => {})
      result.dnsChanged = final.network.facts().lastCode
      assert.equal(result.dnsChanged, "BROWSER_DRIVER_UNAVAILABLE")
      result.facts = facts
      return
    }
    await stage("before-private-load")
    await owner.window.webContents.loadURL("https://positive.example.com/redirect")
    await stage("after-private-load")
    assert.equal(owner.window.webContents.getURL(), "https://positive.example.com/final")
    await owner.window.webContents.debugger.sendCommand("Accessibility.enable")
    const ax = await owner.window.webContents.debugger.sendCommand("Accessibility.getFullAXTree") as { nodes: Array<{ name?: { value?: string } }> }
    const text = ax.nodes.map((node) => node.name?.value ?? "").join(" ")
    assert.ok(text.includes("公网只读真实Chromium")); assert.ok(!text.includes("SCRIPT_EXECUTED"))
    const image = (await owner.window.webContents.capturePage()).toPNG()
    await fs.writeFile(path.join(root, "partition.png"), image, { mode: 0o600 })
    result.partition = { text, url: owner.window.webContents.getURL(), pngBytes: image.length, pngHash: createHash("sha256").update(image).digest("hex"),
      cookies: (await owner.partition.cookies.get({})).length }
    await stage("after-ax-png")
    result.outsideRedirect = await navigate("https://positive.example.com/outside-redirect")
    result.download = await navigate("https://positive.example.com/download")
    result.large = await navigate("https://positive.example.com/large")
    await stage("after-negative-navigations")
    const rawDNS = facts.dns.length
    const rawConnects = facts.connects.length
    result.post = await refusal(owner.partition.fetch("https://positive.example.com/", { method: "POST", body: "blocked" }))
    await stage("after-raw-post")
    result.noTicket = await refusal(owner.partition.fetch("https://positive.example.com/"))
    await stage("after-raw-get")
    assert.equal(facts.dns.length, rawDNS); assert.equal(facts.connects.length, rawConnects)
    result.rawProtocolNoDNS = true
    const other = await owner.network.createReadonlyWindow(); windows.push(other)
    const pathsBefore = facts.paths.length
    await other.webContents.loadURL("https://positive.example.com/other-owner").catch(() => {})
    assert.equal(facts.paths.length, pathsBefore)
    result.wrongOwnerDenied = true
    await stage("after-wrong-owner")
    renew()
    const lateBefore = { dns: facts.dns.length, connects: facts.connects.length, paths: facts.paths.length, reads: state.permitReads }
    const release: { value?: () => void } = {}
    state.permitWait = new Promise<void>((accept) => { release.value = accept })
    const late = owner.window.webContents.loadURL("https://positive.example.com/late-owner").catch(() => "cancelled")
    const lateUntil = Date.now() + 2000
    while (state.permitReads === lateBefore.reads && Date.now() < lateUntil) await new Promise((accept) => setTimeout(accept, 5))
    assert.ok(state.permitReads > lateBefore.reads)
    state.active = other.webContents.id
    release.value!(); state.permitWait = undefined
    assert.equal(await late, "cancelled")
    assert.deepEqual({ dns: facts.dns.length, connects: facts.connects.length, paths: facts.paths.length },
      { dns: lateBefore.dns, connects: lateBefore.connects, paths: lateBefore.paths })
    result.lateOwnerZeroBroker = true
    state.active = owner.window.webContents.id
    renew()
    const slow = owner.window.webContents.loadURL("https://positive.example.com/slow").catch(() => "cancelled")
    const slowUntil = Date.now() + 5000
    while (!facts.paths.includes("/slow") && Date.now() < slowUntil) await new Promise((accept) => setTimeout(accept, 5))
    await stage("slow-barrier")
    assert.ok(facts.paths.includes("/slow"))
    state.permit = false
    const stopped = await owner.network.close()
    result.cancel = { result: await slow, stopped, facts: owner.network.facts() }
    assert.equal(stopped, true); assert.equal(facts.deniedTCP, 0)
    assert.ok(!facts.dns.some((value) => value.startsWith("unapproved.")))
    result.facts = facts
  } finally {
    clearInterval(heartbeat); clearTimeout(watchdog)
    result.networksClosed = await Promise.all(networks.map((network) => network.close()))
    result.facts = facts
    result.finalNetworks = networks.map((network) => network.facts())
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    for (const close of resources.reverse()) await close()
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
  }
}
void main().then(() => app.exit(0), (error: unknown) => {
  void fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Private fixture failed", stack: error instanceof Error ? error.stack : undefined }), { mode: 0o600 }).then(() => app.exit(1))
})

function fixtureDNSResponse(question: Buffer, kind: string) {
  const query = Buffer.from(question)
  query.writeUInt16BE(0x8180, 2)
  const type = query.readUInt16BE(query.length - 4)
  const owner = Buffer.from([0xc0, 0x0c])
  const name = (value: string) => Buffer.concat([...value.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])])
  const record = (at: Buffer, kind: number, data: Buffer) => {
    const header = Buffer.alloc(10)
    header.writeUInt16BE(kind); header.writeUInt16BE(1, 2); header.writeUInt32BE(60, 4); header.writeUInt16BE(data.length, 8)
    return Buffer.concat([at, header, data])
  }
  const public4 = Buffer.from([93, 184, 216, 34])
  const answers: Buffer[] = []
  if (kind === "cname" || kind === "cname-loop") {
    answers.push(record(owner, 5, name("cdn.example.com")))
    if (kind === "cname-loop") answers.push(record(name("cdn.example.com"), 5, name("positive.example.com")))
    if (type === 1 && kind === "cname") answers.push(record(name("cdn.example.com"), 1, public4))
  }
  if (kind === "pointer") {
    const at = question.length + 12
    const pointer = Buffer.alloc(2); pointer.writeUInt16BE(0xc000 | at)
    answers.push(record(owner, 5, pointer))
  }
  if (kind === "mapped" && type === 28) {
    const mapped = Buffer.alloc(16); mapped.writeUInt16BE(0xffff, 10); mapped.set([127, 0, 0, 1], 12)
    answers.push(record(owner, 28, mapped))
  }
  if (type === 1 && !["empty", "cname", "cname-loop", "pointer"].includes(kind)) {
    answers.push(record(owner, 1, kind === "private" ? Buffer.from([127, 0, 0, 1]) : public4))
    if (kind === "mixed") answers.push(record(owner, 1, Buffer.from([127, 0, 0, 1])))
  }
  query.writeUInt16BE(answers.length, 6)
  const extras = kind === "extra-private" ? [record(owner, 1, Buffer.from([127, 0, 0, 1]))] : []
  query.writeUInt16BE(extras.length, 10)
  if (kind === "id") query.writeUInt16BE(1, 0)
  if (kind === "question") query[13] = 120
  if (kind === "tc") query.writeUInt16BE(0x8380, 2)
  if (kind === "rcode") query.writeUInt16BE(0x8182, 2)
  const result = Buffer.concat([query, ...answers, ...extras])
  return kind === "truncated" ? result.subarray(0, result.length - 1) : result
}
