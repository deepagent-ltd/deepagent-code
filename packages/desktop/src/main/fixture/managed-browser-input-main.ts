import assert from "node:assert/strict"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { appendFileSync, writeFileSync } from "node:fs"
import type { BrowserWindow } from "electron"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { managedBrowserInputFixtureAsset } from "./managed-browser-input-fixture-asset"

const root = process.argv[2]!
const utility = Reflect.get(process, "type") === "utility"
const checkpoint = { phase: "startup", ordinal: 0 }
const stage = (phase: string) => {
  checkpoint.phase = phase
  appendFileSync(path.join(root, utility ? "utility-stages.jsonl" : "main-stages.jsonl"),
    JSON.stringify({ phase, ordinal: checkpoint.ordinal, at: Date.now(), elapsedMs: performance.now() }) + "\n", { mode: 0o600 })
}
stage("entry")

async function runUtility() {
  const { Effect, Exit, Cause, Option } = await import("effect")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
  const { BrowserControl } = await import("@deepagent-code/core/browser/control")
  const parent = Reflect.get(process, "parentPort") as {
    postMessage(message: unknown): void
    on(event: "message", listener: (message: { data: { type?: string; dispatches?: number } }) => void): void
    removeListener(event: "message", listener: (message: { data: { type?: string } }) => void): void
  }
  stage("prepare-host")
  await BrowserNativeHost.prepare()
  stage("host-prepared")
  const host = BrowserNativeHost.current()!
  const now = Date.now()
  const control: BrowserSchema.Control = { version: 1, controlID: "source-main", requestID: "create-source",
    requestDigest: "a".repeat(64), scope: { principal: "deepagent-code", securityNamespaceID: "qa-namespace",
      locationKey: "qa-location", projectScopeKey: "qa-project-scope", namespaceBindingHash: "a".repeat(64),
      sessionID: "qa-session", projectID: "qa-project", directory: root, workspaceID: null },
    hostID: host.hostID, hostIncarnation: host.hostIncarnation, resourceID: "source-resource",
    credentialBinding: host.credentialBinding, profile: BrowserSchema.INTERACTION_PROFILE, postPaths: [],
    origin: process.env.DAC_SOURCE_ORIGIN!, revision: 1, epoch: 1, policyRevision: 1, state: "creating",
    expiresAt: now + 30_000, createdAt: now, updatedAt: now, cancel: null, stopConfirmedAt: null }
  const sequence = { value: 0 }
  const request = (command: BrowserSchema.Command) => {
    const id = ++sequence.value
    checkpoint.phase = command.type
    checkpoint.ordinal = id
    stage(`request:${command.type}`)
    const action: BrowserSchema.Action = { version: 1, actionID: `source-${id}`, controlID: control.controlID,
      requestID: `request-${id}`, commandDigest: BrowserControl.hash(command), command, admissionID: `admission-${id}`,
      providerReceiptID: "qa-receipt", providerAttemptID: "qa-attempt", toolCallID: `qa-call-${id}`,
      sessionID: control.scope.sessionID, hostIncarnation: control.hostIncarnation, resourceID: control.resourceID,
      controlEpoch: 1, policyRevision: 1, revision: 1, deadline: Date.now() + 8_000, outcome: "pending",
      result: null, errorCode: null, createdAt: Date.now(), updatedAt: Date.now(), terminalAt: null, stopConfirmedAt: null }
    return host.execute({ ...control, state: "active", revision: 2 }, action, Effect.void)
  }
  const execute = (command: BrowserSchema.Command) => Effect.runPromise(request(command))
  const native = (kind: "other" | "own" | "counts") => new Promise<number>((resolve) => {
    stage(`native:${kind}:request`)
    const listener = (message: { data: { type?: string; dispatches?: number } }) => {
      if (message.data.type !== "source-event-processed") return
      parent.removeListener("message", listener)
      stage(`native:${kind}:processed`)
      resolve(message.data.dispatches!)
    }
    parent.on("message", listener)
    parent.postMessage({ type: "source-event", kind })
  })
  stage("create-host")
  await Effect.runPromise(host.create(control))
  stage("created")
  const original = (await execute({ type: "tabs.list" })).result.tabs[0]!
  const tab = (await execute({ type: "navigate", tabID: original.tabID, generation: original.generation,
    url: control.origin + "/" })).result.tabs[0]!
  const first = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
  const ref = first.result.refs?.find((value) => value.name === "Name")
  assert.ok(ref)
  const initialTarget = { tabID: tab.tabID, generation: tab.generation, ref: ref.ref,
    frameID: first.result.frameID!, observationRevision: first.result.observationRevision! }
  await native("other")
  const otherWindowTab = (await execute({ type: "tabs.list" })).result.tabs[0]!
  await writeFile(path.join(root, "source-boundary.json"), JSON.stringify({
    before: tab.generation, afterOtherWindow: otherWindowTab.generation,
  }))
  assert.equal(otherWindowTab.tabID, tab.tabID)
  const reobserved = otherWindowTab.generation !== tab.generation
  if (reobserved) {
    const before = await native("counts")
    const stale = await Effect.runPromise(Effect.exit(request({ type: "fill", ...initialTarget, text: "MUST_NOT_DISPATCH" })))
    assert.ok(Exit.isFailure(stale))
    const error = Exit.isFailure(stale) ? Option.getOrUndefined(Cause.findErrorOption(stale.cause)) : undefined
    assert.equal(error && typeof error === "object" && "code" in error ? error.code : null, "BROWSER_STALE_TARGET")
    assert.equal(await native("counts"), before)
  }
  // A real Cocoa callback can retire the prior observation. Only an explicit
  // original snapshot admits new references; no native/source gate is bypassed.
  const current = await execute({ type: "snapshot", tabID: otherWindowTab.tabID, generation: otherWindowTab.generation })
  const currentRef = current.result.refs?.find((value) => value.name === "Name")
  assert.ok(currentRef)
  const target = { tabID: otherWindowTab.tabID, generation: otherWindowTab.generation, ref: currentRef.ref,
    frameID: current.result.frameID!, observationRevision: current.result.observationRevision! }
  await execute({ type: "fill", ...target, text: "owned中文" })
  const unchanged = (await execute({ type: "tabs.list" })).result.tabs[0]!
  assert.equal(unchanged.generation, otherWindowTab.generation)
  const before = await native("own")
  const stale = await Effect.runPromise(Effect.exit(request({ type: "fill", ...target, text: "MUST_NOT_DISPATCH" })))
  assert.ok(Exit.isFailure(stale))
  const error = Exit.isFailure(stale) ? Option.getOrUndefined(Cause.findErrorOption(stale.cause)) : undefined
  assert.equal(error && typeof error === "object" && "code" in error ? error.code : null, "BROWSER_STALE_TARGET")
  const after = await native("counts")
  assert.equal(after, before)
  const freshTab = (await execute({ type: "tabs.list" })).result.tabs[0]!
  // One user input may pass both an AppKit event and a text-client callback;
  // generations invalidate authority, they do not count gestures exactly once.
  assert.ok(freshTab.generation > otherWindowTab.generation)
  const fresh = await execute({ type: "snapshot", tabID: freshTab.tabID, generation: freshTab.generation })
  const freshRef = fresh.result.refs?.find((value) => value.name === "Name")
  assert.ok(freshRef)
  await execute({ type: "fill", tabID: freshTab.tabID, generation: freshTab.generation, ref: freshRef.ref,
    frameID: fresh.result.frameID!, observationRevision: fresh.result.observationRevision!, text: "fresh中文" })
  const final = (await execute({ type: "tabs.list" })).result.tabs[0]!
  assert.equal(final.generation, freshTab.generation)
  const stopped = await Effect.runPromise(host.cancel({ ...control, state: "cancel_requested", epoch: 2, revision: 3,
    cancel: { requestID: "stop-source", expectedRevision: 2, requestedAt: Date.now() } }))
  assert.equal(stopped, true)
  parent.postMessage({ type: "source-result", result: { otherWindowResourcePreserved: true, reobserved,
    initialGeneration: tab.generation, afterOtherGeneration: otherWindowTab.generation, ownSourceRetired: true,
    staleDispatches: after - before, freshOwnCDPPreserved: true, stopped, actions: sequence.value } })
  stage("source-result-posted")
  process.exit(0)
}

async function runMain() {
  stage("main-imports")
  const { app, BrowserWindow, utilityProcess } = await import("electron")
  const { createServer } = await import("node:http")
  const { createRequire } = await import("node:module")
  const { installManagedBrowser } = await import("../managed-browser")
  app.setPath("userData", path.join(root, "profile"))
  const runtimePaths = { userData: app.getPath("userData"), sessionData: app.getPath("sessionData") }
  writeFileSync(path.join(root, "runtime-paths.json"), JSON.stringify(runtimePaths), { mode: 0o600 })
  assert.ok(Object.values(runtimePaths).every((value) => value === path.join(root, "profile")))
  app.commandLine.appendSwitch("disable-background-networking")
  // Keep a shown native input surface away from ambient pointer events. The
  // constructor can show after browser-window-created; hiding there is not isolation.
  app.on("browser-window-created", (_event, window) => {
    window.on("show", () => { window.setPosition(-10_000, -10_000); stage("window-shown-offpointer") })
    window.setPosition(-10_000, -10_000)
    stage("window-created-offpointer")
  })
  app.on("window-all-closed", () => {})
  stage("app-ready:wait")
  await app.whenReady()
  stage("app-ready")
  const qa = createRequire(import.meta.url)(path.join(root, "qa.node")) as {
    postKey(handle: Buffer): void; counts(): { installed: number; removed: number }
    tracking(value: boolean): void; cleanup(filename: string): void }
  qa.cleanup(path.join(root, "cleanup.json"))
  stage("qa-loaded")
  const peer = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end('<label>Name<input autofocus></label><div style="height:1000px">Source target</div>')
  })
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
  stage("peer-listening")
  const address = peer.address()
  assert.ok(address && typeof address !== "string")
  // Create the independent window before observing a target. Creating it later
  // can retire the first window's IME source. Do not construct a Window between
  // forking and installing the original bootstrap listener: Cocoa may reenter.
  const state = { close: undefined as undefined | (() => void), result: undefined as unknown,
    other: new BrowserWindow({ show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }),
    dispatches: 0, observed: false }
  stage("other-window-created")
  const child = utilityProcess.fork(process.argv[1]!, [root], { env: { ...process.env,
    DAC_SOURCE_ORIGIN: `http://127.0.0.1:${address.port}` }, stdio: "pipe" })
  stage("utility-forked")
  const timer = setTimeout(() => { stage("main-watchdog"); child.kill(); app.exit(2) }, 20_000)
  qa.tracking(true)
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") {
      stage("bootstrap-ready")
      // The default ESM qualification exercises the product's fixed build-selected asset path.
      state.close = process.argv[1]!.endsWith(".cjs")
        ? installManagedBrowser(child, "source-fixture", managedBrowserInputFixtureAsset(root))
        : installManagedBrowser(child, "source-fixture")
      stage("browser-installed")
      return
    }
    if (message.type === "source-result") { stage("source-result"); state.result = message.result; return }
    if (message.type !== "source-event") return
    stage(`source-event:${message.kind}`)
    const window = BrowserWindow.getAllWindows().find((window) => window !== state.other)!
    if (!state.observed) {
      state.observed = true
      const debuggerOwner = window.webContents.debugger
      const send = debuggerOwner.sendCommand.bind(debuggerOwner)
      debuggerOwner.sendCommand = (method, parameters, sessionID) => {
        if (method.startsWith("Input.") || method === "Runtime.callFunctionOn") state.dispatches++
        return send(method, parameters, sessionID)
      }
    }
    if (message.kind === "counts") {
      child.postMessage({ type: "source-event-processed", dispatches: state.dispatches })
      return
    }
    qa.postKey((message.kind === "other" ? state.other! : window).getNativeWindowHandle())
    // The later generation assertion proves that the actual AppKit event was consumed.
    setTimeout(() => child.postMessage({ type: "source-event-processed", dispatches: state.dispatches }), 75)
  })
  stage("message-listener-installed")
  child.stdout?.on("data", (bytes) => process.stdout.write(bytes))
  child.stderr?.on("data", (bytes) => process.stderr.write(bytes))
  await new Promise<void>((resolve, reject) => child.once("exit", (code) => {
    stage(`utility-exit:${code}`)
    clearTimeout(timer)
    state.close?.()
    if (state.other && !state.other.isDestroyed()) state.other.destroy()
    peer.closeAllConnections()
    peer.close(() => {
      stage("peer-closed")
      void writeFile(path.join(root, "result.json"), JSON.stringify({ childExit: code, result: state.result, runtimePaths,
        runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch },
        defaultProductAsset: !process.argv[1]!.endsWith(".cjs"),
        monitors: qa.counts(), windows: BrowserWindow.getAllWindows().length,
        boundary: { physicalHuman: false, canonicalRunner: false, provider: 0, clipboard: 0, externalNetwork: 0 } }),
      { mode: 0o600 }).then(() => code === 0 ? resolve() : reject(new Error("QA_CHILD_FAILED")))
    })
  }))
  stage("complete")
  app.exit(0)
}

void (utility ? runUtility() : runMain()).catch(async (error: unknown) => {
  await writeFile(path.join(root, utility ? "utility-error.json" : "main-error.json"), JSON.stringify({
    name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "QA_FAILED",
    checkpoint, code: error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      /^BROWSER_[A-Z_]+$/.test(error.code) ? error.code : null }),
  { mode: 0o600 })
  if (utility) { process.exit(1); return }
  const { app } = await import("electron")
  app.exit(1)
})
