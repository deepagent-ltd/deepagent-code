import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"

const root = process.env.DAC_BROWSER_PUBLIC_ROOT!
const utility = Reflect.get(process, "type") === "utility"
const pageMode = process.env.DAC_BROWSER_PAGE_MODE === "dynamic" ? "dynamic" : "static"

async function runUtility() {
  const { Effect, Layer, Option, Fiber, Exit, Cause } = await import("effect")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { SecurityNamespaceTable } = await import("@deepagent-code/core/context-federation/sql")
  const { Project } = await import("@deepagent-code/core/project")
  const { ProjectTable } = await import("@deepagent-code/core/project/sql")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { SessionSchema } = await import("@deepagent-code/core/session/schema")
  const { SessionTable } = await import("@deepagent-code/core/session/sql")
  const { BrowserControl } = await import("@deepagent-code/core/browser/control")
  const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
  const { BrowserActionTable } = await import("@deepagent-code/core/browser/browser.sql")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const parent = Reflect.get(process, "parentPort") as {
    postMessage(value: unknown): void
    on(event: "message", listener: (event: { data: { type?: string } }) => void): void
  }
  const slow = Promise.withResolvers<void>()
  const idle = Promise.withResolvers<unknown>()
  const probes = Promise.withResolvers<void>()
  parent.on("message", (event) => {
    if (event.data.type === "slow-ready") slow.resolve()
    if (event.data.type === "idle-result") idle.resolve(event.data)
    if (event.data.type === "probes-ready") probes.resolve()
  })
  await BrowserNativeHost.prepare()
  BrowserNativeHost.captureServerConfiguration({ username: "deepagent-code", password: Option.some("private-browser-fixture") })
  const host = BrowserNativeHost.current()
  assert.ok(host)
  const directory = await fs.realpath(path.join(root, "project"))
  const database = Database.layerFromPath(path.join(root, "browser.sqlite"))
  const services = LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer))
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_public_browser_fixture"), project_id: Project.ID.global,
      slug: "public-browser", title: "Public readonly module", directory, version: "fixture", v2_authority: true }).run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
      directory: AbsolutePath.make(directory), project: { kind: "registered_root", observedProjectId: "project_public_browser_fixture" } })
    const namespaces = yield* db.select().from(SecurityNamespaceTable).all()
    const namespace = namespaces.find((row) => row.id === identity.securityNamespaceId)
    assert.ok(namespace)
    const scope = { principal: host.principal, securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
      projectID: Project.ID.global, sessionID: "ses_public_browser_fixture", directory: identity.canonicalRoot, workspaceID: null }
    const input = { request: { requestID: "public-browser-create", sessionID: scope.sessionID,
      profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE, pageMode, postTargets: [{ origin: "https://positive.example.com", path: "/submit" }], origin: "https://positive.example.com",
      approvedOrigins: ["https://positive.example.com"], resolverPolicy: "cloudflare_doh_v1" as const, expiresAt: Date.now() + 90_000 },
      scope, hostID: host.hostID, hostIncarnation: host.hostIncarnation, credentialBinding: host.credentialBinding } satisfies Parameters<typeof BrowserControl.create>[1]
    const created = yield* BrowserControl.create(db, input)
    yield* host.create(created.record)
    const control = yield* BrowserControl.observeControl(db, created.record, "active")
    assert.equal(control.profile, BrowserSchema.PUBLIC_INTERACTION_PROFILE)
    assert.equal(host.verify(control).matched, true)
    assert.equal(host.verify({ ...control, resolverPolicy: "system" }).matched, false)
    const current = () => BrowserControl.requireActive(db, control.controlID, scope, host).pipe(Effect.asVoid)
    const prepare = (command: typeof BrowserSchema.Command.Type, suffix: string) => BrowserControl.prepareAction(db, {
      control, command, timeoutMs: 10_000,
      // Controlled store admission witness: no model, provider or canonical tool effect is minted.
      admission: { admissionId: `module-${suffix}`, sessionId: scope.sessionID, providerAttemptId: "controlled-attempt",
        receiptId: "controlled-receipt", toolCallId: suffix, toolName: "browser", effectKind: "mutating", ownerToken: "controlled-owner", timeCreated: Date.now() },
    }, (tx) => BrowserControl.requireActive(tx, control.controlID, scope, host).pipe(Effect.asVoid))
    const execute = Effect.fnUntraced(function* (command: typeof BrowserSchema.Command.Type, suffix: string) {
      const action = yield* prepare(command, suffix)
      const response = yield* host.execute(control, action, current())
      yield* BrowserControl.observeAction(db, action, { outcome: "completed", result: response.result })
      parent.postMessage({ type: "checkpoint", suffix })
      return response
    })
    const rejected = Effect.fnUntraced(function* (command: typeof BrowserSchema.Command.Type, suffix: string) {
      const action = yield* prepare(command, suffix)
      const response = yield* Effect.exit(host.execute(control, action, current()))
      assert.ok(Exit.isFailure(response))
      const code = Option.getOrUndefined(Cause.findErrorOption(response.cause))?.code
      assert.ok(code)
      yield* BrowserControl.observeAction(db, action, { outcome: code === "BROWSER_UNKNOWN" ? "unknown" : "failed", errorCode: code })
      const retry = yield* Effect.exit(prepare(command, suffix))
      assert.ok(Exit.isFailure(retry))
      const retryCode = Option.getOrUndefined(Cause.findErrorOption(retry.cause))?.code
      assert.equal(retryCode, code === "BROWSER_UNKNOWN" ? "BROWSER_UNKNOWN" : "BROWSER_CONFLICT")
      return code
    })
    const form = Effect.fnUntraced(function* (tab: typeof BrowserSchema.Tab.Type, kind: string) {
      const moved = yield* execute({ type: "navigate", tabID: tab.tabID, generation: tab.generation,
        url: `https://positive.example.com/${kind}` }, `${kind}-navigate`)
      const next = moved.result.tabs.find((value) => value.tabID === tab.tabID)!
      const observed = yield* execute({ type: "snapshot", tabID: next.tabID, generation: next.generation }, `${kind}-observation`)
      const submit = observed.result.refs?.find((value) => value.name === "Submit")
      assert.ok(submit)
      return { tab: next, observed: observed.result, command: { type: "click" as const, tabID: next.tabID,
        generation: next.generation, frameID: observed.result.frameID!, observationRevision: observed.result.observationRevision!,
        ref: submit.ref, waitForNavigation: true } }
    })
    const initial = yield* execute({ type: "tabs.list" }, "initial")
    assert.equal(initial.result.tabs.length, 1)
    const first = initial.result.tabs[0]!
    const navigated = yield* execute({ type: "navigate", tabID: first.tabID, generation: first.generation, url: "https://positive.example.com/" }, "navigate")
    const tab = navigated.result.tabs[0]!
    assert.equal(tab.url, "https://positive.example.com/")
    const snapshot = yield* execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation }, "snapshot")
    assert.ok(snapshot.result.text?.includes(pageMode === "dynamic" ? "Dynamic rendered" : "Public interaction Manager"))
    const ref = snapshot.result.refs?.find((value) => value.name === "Name")
    assert.ok(ref)
    const inputTarget = { tabID: tab.tabID, generation: tab.generation, frameID: snapshot.result.frameID!,
      observationRevision: snapshot.result.observationRevision!, ref: ref.ref }
    yield* execute({ type: "fill", ...inputTarget, text: "原生交互 Unicode" }, "fill")
    const observed = yield* execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation }, "submit-observation")
    const submit = observed.result.refs?.find((value) => value.name === "Submit")
    assert.ok(submit)
    const submitted = yield* execute({ type: "click", tabID: tab.tabID, generation: tab.generation,
      frameID: observed.result.frameID!, observationRevision: observed.result.observationRevision!, ref: submit.ref,
      waitForNavigation: true }, "submit")
    const settledTab = submitted.result.tabs[0]!
    const settled = yield* execute({ type: "snapshot", tabID: settledTab.tabID, generation: settledTab.generation }, "submitted-observation")
    assert.ok(settled.result.text?.includes("Form accepted"))
    parent.postMessage({ type: "idle-check" })
    const idleResult = yield* Effect.promise(() => idle.promise)
    const image = yield* execute({ type: "screenshot", tabID: settledTab.tabID, generation: settledTab.generation }, "screenshot")
    assert.ok(image.png && image.result.image)
    yield* Effect.promise(() => fs.writeFile(path.join(root, "managed-public.png"), Buffer.from(image.png!, "base64"), { mode: 0o600 }))
    const next = yield* execute({ type: "tabs.list" }, "next-action")
    assert.equal(next.result.tabs[0]?.url, settledTab.url)
    assert.equal(host.verify(control).stopped, false)
    const isolated = []
    for (const command of [
      { type: "files.list" as const },
      { type: "clipboard.read" as const, tabID: settledTab.tabID, generation: settledTab.generation,
        frameID: settled.result.frameID!, observationRevision: settled.result.observationRevision! },
      { type: "evaluate" as const, tabID: settledTab.tabID, generation: settledTab.generation,
        frameID: settled.result.frameID!, observationRevision: settled.result.observationRevision!, source: "return 1",
        argsJSON: "{}", scriptHash: "0".repeat(64) },
      { type: "program" as const, tabID: settledTab.tabID, generation: settledTab.generation,
        frameID: settled.result.frameID!, observationRevision: settled.result.observationRevision!, source: "return {version:1,steps:[]}",
        argsJSON: "{}", scriptHash: "0".repeat(64), targets: [{ name: "obsolete", ref: submit.ref }] },
    ]) {
      const result = yield* Effect.exit(prepare(command, `isolation-${command.type}`))
      assert.ok(Exit.isFailure(result))
      isolated.push(Option.getOrUndefined(Cause.findErrorOption(result.cause))?.code)
    }
    assert.deepEqual(isolated, Array(4).fill("BROWSER_SCOPE_DENIED"))
    const redirected = yield* form(settledTab, "redirect303")
    const redirectedResult = yield* execute(redirected.command, "redirect303-submit")
    const redirectedTab = redirectedResult.result.tabs[0]!
    assert.equal(redirectedTab.url, "https://positive.example.com/accepted")
    const redirectView = yield* execute({ type: "snapshot", tabID: redirectedTab.tabID, generation: redirectedTab.generation }, "redirect303-result")
    assert.ok(redirectView.result.text?.includes("Redirect accepted"))
    const blockedRedirect = yield* form(redirectedTab, "redirect307")
    const redirectCode = yield* rejected(blockedRedirect.command, "redirect307-submit")
    assert.equal(redirectCode, "BROWSER_UNKNOWN")
    const afterRedirect = (yield* execute({ type: "tabs.list" }, "after-redirect-denial")).result.tabs[0]!
    const oversized = yield* form(afterRedirect, "oversize")
    const oversizedCode = yield* rejected(oversized.command, "oversize-submit")
    assert.equal(oversizedCode, "BROWSER_UNKNOWN")
    const afterOversized = (yield* execute({ type: "tabs.list" }, "after-oversized-denial")).result.tabs[0]!
    const createdTab = (yield* execute({ type: "tabs.create", url: "https://positive.example.com/accepted" }, "new-tab")).result.tabs
      .find((value) => value.tabID !== afterOversized.tabID)!
    const closedTab = yield* execute({ type: "tabs.close", tabID: createdTab.tabID, generation: createdTab.generation }, "close-tab")
    assert.equal(closedTab.result.tabs.length, 1)
    const aba = pageMode === "dynamic" ? yield* form(afterOversized, "aba") : undefined
    const stale = aba ? aba.observed.refs?.find((value) => value.name === "Name") : undefined
    const abaCode = aba && stale ? yield* Effect.gen(function* () {
      const triggered = yield* rejected({ type: "fill", tabID: aba.tab.tabID, generation: aba.tab.generation,
        frameID: aba.observed.frameID!, observationRevision: aba.observed.observationRevision!, ref: stale.ref, text: "aba-value" }, "aba-fill")
      assert.equal(triggered, "BROWSER_UNKNOWN")
      const seen = yield* execute({ type: "tabs.list" }, "aba-current")
      assert.equal(seen.result.tabs[0]?.url, "https://positive.example.com/aba")
      return yield* rejected({ type: "fill", tabID: aba.tab.tabID, generation: aba.tab.generation,
        frameID: aba.observed.frameID!, observationRevision: aba.observed.observationRevision!, ref: stale.ref, text: "must-not-write" }, "aba-stale")
    }) : undefined
    if (abaCode) assert.equal(abaCode, "BROWSER_STALE_TARGET")
    const currentTab = (yield* execute({ type: "tabs.list" }, "before-active-cancel")).result.tabs[0]!
    const denied = yield* Effect.exit(prepare({ type: "navigate", tabID: settledTab.tabID, generation: settledTab.generation,
      url: "https://unapproved.example.com/" }, "denied"))
    assert.ok(Exit.isFailure(denied))
    const deniedCode = Exit.isFailure(denied) ? Option.getOrUndefined(Cause.findErrorOption(denied.cause))?.code : undefined
    assert.equal(deniedCode, "BROWSER_NETWORK_DENIED")
    const held = pageMode === "dynamic" ? yield* form(currentTab, "held") : undefined
    if (held) {
      const name = held.observed.refs?.find((value) => value.name === "Name")!
      yield* execute({ type: "fill", tabID: held.tab.tabID, generation: held.tab.generation, frameID: held.observed.frameID!,
        observationRevision: held.observed.observationRevision!, ref: name.ref, text: "held" }, "held-fill")
    }
    const heldView = held ? (yield* execute({ type: "snapshot", tabID: held.tab.tabID, generation: held.tab.generation }, "held-submit-observation")).result : undefined
    const heldSubmit = heldView?.refs?.find((value) => value.name === "Submit")
    const pending = yield* prepare(held && heldView && heldSubmit ? { type: "click", tabID: held.tab.tabID, generation: held.tab.generation,
      frameID: heldView.frameID!, observationRevision: heldView.observationRevision!, ref: heldSubmit.ref, waitForNavigation: true } :
      { type: "navigate", tabID: currentTab.tabID, generation: currentTab.generation, url: "https://positive.example.com/slow" }, "cancel-active")
    const running = yield* Effect.forkScoped(host.execute(control, pending, current()))
    yield* Effect.promise(() => slow.promise)
    if (pageMode === "dynamic") yield* Effect.promise(() => probes.promise)
    const cancelled = yield* BrowserControl.cancel(db, control.controlID, scope, { requestID: "cancel-public", expectedRevision: control.revision })
    assert.equal(yield* host.cancel(cancelled.record), true)
    const cancelledExit = yield* Fiber.await(running)
    assert.ok(Exit.isFailure(cancelledExit))
    const cancelledCode = Exit.isFailure(cancelledExit) ? Option.getOrUndefined(Cause.findErrorOption(cancelledExit.cause))?.code : undefined
    yield* BrowserControl.observeAction(db, pending, { outcome: "unknown", errorCode: cancelledCode ?? "BROWSER_UNKNOWN", stopConfirmed: true })
    const stopped = yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
    assert.equal(host.verify(stopped).stopped, true)
    const before = yield* db.all("SELECT total_changes() AS changes")
    const retry = yield* BrowserControl.cancel(db, control.controlID, scope, { requestID: "cancel-public", expectedRevision: control.revision })
    assert.equal(retry.changed, false)
    assert.equal(yield* host.cancel(retry.record), true)
    yield* BrowserControl.get(db, control.controlID)
    yield* BrowserControl.getAction(db, pending.actionID)
    assert.deepEqual(yield* db.all("SELECT total_changes() AS changes"), before)
    const rows = yield* db.select().from(BrowserActionTable).all()
    return { boundary: "controlled-fileDB-admission/actual-utility-nativeHost/actual-Main-manager",
      profile: control.profile, pageMode, resolverPolicy: "cloudflare_doh_v1", actions: rows.map((row) => ({ outcome: row.outcome })),
      snapshotText: snapshot.result.text, settledText: settled.result.text, image: image.result.image, deniedCode, cancelledCode,
      idle: idleResult,
      isolated, redirectCode, oversizedCode, abaCode,
      controlState: stopped.state, stopConfirmed: stopped.stopConfirmedAt !== null, closed: host.verify(stopped).stopped,
      readAndExactCancelWrites: 0, providerCalls: 0, node: process.versions.node, electron: process.versions.electron }
  }).pipe(Effect.provide(services), Effect.scoped))
  parent.postMessage({ type: "result", result })
  setTimeout(() => process.exit(0), 25)
}

async function runMain() {
  const { app, utilityProcess, BrowserWindow } = await import("electron")
  const { createServer } = await import("node:https")
  const http = await import("node:http")
  const net = await import("node:net")
  const tls = await import("node:tls")
  const { installManagedBrowser } = await import("../managed-browser")
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const facts = { connects: [] as string[], sni: [] as string[], doh: [] as number[], page: [] as string[],
    authLeak: false, bodies: [] as string[], debuggerListeners: [] as number[], proxyAuthenticated: [] as boolean[],
    browserEvents: [] as unknown[], dom: [] as unknown[], lateProbes: 0 }
  const observed = new WeakSet<Electron.WebContents>()
  const sockets = new Set<import("node:stream").Duplex>()
  const peer = createServer({ key: await fs.readFile(path.join(root, "server-key.pem")), cert: await fs.readFile(path.join(root, "server.pem")) }, (request, response) => {
    if (request.headers.host === "cloudflare-dns.com") {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const query = Buffer.concat(chunks)
        const type = query.readUInt16BE(query.length - 4)
        facts.doh.push(type)
        assert.equal(request.method, "POST")
        assert.equal(request.url, "/dns-query")
        assert.equal(request.headers["content-type"], "application/dns-message")
        const header = Buffer.from(query)
        header.writeUInt16BE(0x8180, 2)
        header.writeUInt16BE(type === 1 ? 1 : 0, 6)
        const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34])
        response.setHeader("content-type", "application/dns-message")
        response.end(type === 1 ? Buffer.concat([header, record]) : header)
      })().catch(() => response.destroy())
      return
    }
    facts.page.push(`${request.method} ${request.url ?? ""}`)
    facts.authLeak ||= Boolean(request.headers.authorization || request.headers.cookie || request.headers["proxy-authorization"])
    assert.equal(request.headers.host, "positive.example.com")
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (request.url === "/slow") { response.write("<html><body>partial"); child.postMessage({ type: "slow-ready" }); return }
    if (request.url === "/api") { response.setHeader("content-type", "application/json"); response.end('{"title":"Dynamic rendered"}'); return }
    if (request.url === "/submit") {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString("utf8")
        facts.bodies.push(body)
        const value = new URLSearchParams(body).get("name")
        if (value === "redirect303" || value === "redirect307") {
          response.writeHead(value === "redirect303" ? 303 : 307, { location: "/accepted" }); response.end(); return
        }
        if (value === "held") { child.postMessage({ type: "slow-ready" }); return }
        response.end('<html><body><h1>Form accepted</h1><script>window.fixtureTicks=0;setInterval(()=>window.fixtureTicks++,50)</script></body></html>')
      })().catch(() => response.destroy())
      return
    }
    response.setHeader("set-cookie", "untrusted=not-forwarded; Path=/; Secure")
    if (request.url === "/accepted") { response.end("<html><body><h1>Redirect accepted</h1></body></html>"); return }
    if (["/redirect303", "/redirect307", "/oversize", "/aba", "/held"].includes(request.url ?? "")) {
      const value = request.url!.slice(1)
      const hidden = value === "oversize" ? `<input type="hidden" name="large" value="${"x".repeat(65_536)}">` : ""
      const script = value === "aba" ? `document.querySelector('input').oninput=()=>{history.pushState({},'', '/aba#middle');history.replaceState({},'', '/aba')}` :
        value === "held" ? `let clicked=false,scheduled=false;document.querySelector('input').oninput=()=>{if(scheduled)return;scheduled=true;const poll=()=>{if(!clicked){setTimeout(poll,10);return;}setTimeout(async()=>{await Promise.allSettled([fetch('/submit',{method:'POST',body:'late-api'}),fetch('https://unapproved.example.com/late')]);navigator.sendBeacon('/submit','late-beacon');try{new WebSocket('wss://unapproved.example.com/socket')}catch{}try{new Worker('/worker.js')}catch{}try{await navigator.serviceWorker.register('/worker.js')}catch{}console.log('FIXTURE_PROBES_READY')},200)};poll()};document.querySelector('form').onsubmit=event=>{event.preventDefault();clicked=true;setTimeout(()=>document.querySelector('form').submit(),50)}` : ""
      response.end(`<html><body><h1>${value}</h1><form action="/submit" method="POST"><label>Name<input name="name" value="${value}"></label>${hidden}<button>Submit</button></form><script>${script}</script></body></html>`)
      return
    }
    response.end('<html><body style="background:#183640;color:white"><h1 id="heading">Public interaction Manager</h1><form action="/submit" method="POST"><label>Name<input name="name"></label><button>Submit</button></form><script>window.fixtureTicks=0;setInterval(()=>window.fixtureTicks++,50);for(const name of ["mousedown","mouseup","click","pointerdown","pointerup","freeze","resume"])document.addEventListener(name,()=>console.log("FIXTURE_EVENT_"+name));fetch("/api").then(r=>r.json()).then(r=>document.getElementById("heading").textContent=r.title)</script></body></html>')
  })
  peer.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  peer.on("secureConnection", (socket) => facts.sni.push(socket.servername || ""))
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
  const address = peer.address()
  assert.ok(address && typeof address !== "string")
  const proxy = http.createServer((_request, response) => { response.writeHead(403); response.end() })
  proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  proxy.on("connect", (request, client, head) => {
    facts.connects.push(request.url ?? "")
    facts.proxyAuthenticated.push(request.headers["proxy-authorization"] === `Basic ${Buffer.from("private:fixture").toString("base64")}`)
    assert.ok(["1.1.1.1:443", "93.184.216.34:443"].includes(request.url ?? ""))
    const upstream = net.connect(address.port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream))
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy())
    upstream.once("close", () => client.destroy()); client.once("close", () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const proxyAddress = proxy.address()
  assert.ok(proxyAddress && typeof proxyAddress !== "string")
  Object.assign(process.env, { https_proxy: `http://private:fixture@127.0.0.1:${proxyAddress.port}`, no_proxy: "", NO_PROXY: "" })
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), await fs.readFile(path.join(root, "ca.pem"), "utf8")])
  const child = utilityProcess.fork(process.argv[1]!, [], { env: { ...process.env }, stdio: "pipe" })
  child.stdout?.on("data", (data) => process.stdout.write(data))
  child.stderr?.on("data", (data) => process.stderr.write(data))
  const timer = setTimeout(() => { child.kill(); app.exit(2) }, 60_000)
  const state = { result: undefined as unknown, close: undefined as undefined | (() => void), failed: false }
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") { state.close = installManagedBrowser(child, "private-browser-fixture"); return }
    if (message.type === "checkpoint") {
      for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents
        if (!observed.has(contents)) {
          observed.add(contents)
          contents.debugger.on("message", (_event, method, params) => {
            if (facts.browserEvents.length >= 128) return
            if (method === "Page.frameRequestedNavigation" || method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Fetch.requestPaused")
              facts.browserEvents.push({ method, params })
          })
          contents.on("did-fail-load", (_event, code, reason, url) => facts.browserEvents.push({ method: "did-fail-load", code, reason, url }))
          contents.on("console-message", (event) => {
            if (facts.browserEvents.length < 128) facts.browserEvents.push({ method: "console", message: event.message })
            if (event.message === "FIXTURE_PROBES_READY") { facts.lateProbes++; child.postMessage({ type: "probes-ready" }) }
          })
        }
        facts.debuggerListeners.push(contents.debugger.listenerCount("message") - 1)
        if (message.suffix === "submit-observation") void contents.debugger.sendCommand("Runtime.evaluate", {
          expression: `JSON.stringify({ready:document.readyState,ticks:window.fixtureTicks,button:document.querySelector('button')?.outerHTML,
            form:document.querySelector('form')?.outerHTML,value:document.querySelector('input')?.value,
            valid:document.querySelector('input')?.validity.valid,active:document.activeElement?.tagName,focused:document.hasFocus()})`, returnByValue: true,
        }).then((value) => facts.dom.push({value:value.result?.value,windowFocused:window.isFocused(),contentsFocused:contents.isFocused()}), () => {})
      }
      return
    }
    if (message.type === "idle-check") {
      void (async () => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents
        const before = await contents.debugger.sendCommand("Runtime.evaluate", { expression: "window.fixtureTicks", returnByValue: true })
        const pages = facts.page.length
        await new Promise<void>((resolve) => setTimeout(resolve, 450))
        const after = await contents.debugger.sendCommand("Runtime.evaluate", { expression: "window.fixtureTicks", returnByValue: true })
        child.postMessage({ type: "idle-result", before: before.result.value ?? null, after: after.result.value ?? null,
          extraHTTP: facts.page.length - pages })
      })().catch(() => child.postMessage({ type: "idle-result", failed: true }))
      return
    }
    if (message.type === "result") { state.result = message.result; return }
    if (message.type === "fixture-error") { state.failed = true; state.result = message.error }
  })
  child.once("exit", (code) => {
    clearTimeout(timer)
    state.close?.()
    void (async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise<void>((resolve) => { peer.closeAllConnections(); peer.close(() => resolve()) }),
        new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()) })])
      await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ result: state.result, facts,
        childExit: code, windows: BrowserWindow.getAllWindows().length, remainingPeerSockets: sockets.size,
        diagnosticTrust: "private-startup-CA/fixed-IP-CONNECT-to-own-TLS-peer; no external public network" }, null, 2), { mode: 0o600 })
      app.exit(code === 0 && !state.failed ? 0 : 1)
    })()
  })
}

void (utility ? runUtility() : runMain()).catch(async (error: unknown) => {
  const safe = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Fixture failed",
    stack: error instanceof Error ? error.stack : undefined,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined }
  await fs.writeFile(path.join(root, utility ? "utility-failure.json" : "failure.json"), JSON.stringify(safe), { mode: 0o600 })
  if (utility) {
    const parent = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
    parent.postMessage({ type: "fixture-error", error: safe }); process.exit(1)
    return
  }
  const { app } = await import("electron")
  app.exit(1)
})
