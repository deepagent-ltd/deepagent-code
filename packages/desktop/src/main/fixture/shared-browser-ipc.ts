import { app, BrowserWindow, session, dialog } from "electron"
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import path from "node:path"
import { Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserTuiSchema } from "@deepagent-code/core/browser/shared-tui-schema"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { registerSharedBrowserIpc } from "../shared-browser-ipc"
import { sharedBrowserManager } from "../shared-browser"
import { sharedBrowserTuiRegistry } from "../shared-browser-tui"

const root = process.env.DAC_SHARED_BROWSER_IPC_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-quic")
app.on("window-all-closed", () => {})
const digest = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const stage = { value: "startup" }

async function main() {
  await app.whenReady()
  const manager = sharedBrowserManager()
  const requests = { authenticatedLists: 0, rejectedAuthentication: 0 }
  const projection: { resources?: SharedBrowserSchema.Resource[] } = {}
  const pending = { next: false, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/api/")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end("<!doctype html><html><body>Owned shared browser IPC fixture</body></html>")
      return
    }
    if (request.headers.authorization !== "Basic " + Buffer.from("fixture-owned:fixture-only").toString("base64")) {
      requests.rejectedAuthentication++; response.writeHead(401); response.end(); return
    }
    if (request.method !== "GET" || !request.url.startsWith("/api/v1/browser/shared/resources?")) {
      response.writeHead(404); response.end(); return
    }
    requests.authenticatedLists++
    if (pending.next) { pending.next = false; pending.entered.resolve(); await pending.release.promise }
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ resources: projection.resources ?? manager.list("ipc-fixture-session") }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  process.env.ELECTRON_RENDERER_URL = origin
  manager.attachHost("ipc-fixture-sidecar", async () => false)
  const policy = Schema.decodeUnknownSync(SharedBrowserSchema.Policy)({ origin, approvedOrigins: [origin],
    manualApprovedOrigins: [origin], resolverPolicy: "system", postGrants: [],
    ...(process.env.DAC_SHARED_BROWSER_FILE_OWNER_ONLY === "1" ? { filePolicy: { upload: true, download: true } } : {}) })
  const now = Date.now()
  const resource = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({ version: 2,
    profile: SharedBrowserSchema.PROFILE, inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
    resourceID: "ipc-fixture-resource", requestID: "ipc-fixture-create", requestDigest: digest({ origin }),
    rootSessionID: "ipc-fixture-session", mainIncarnation: manager.mainIncarnation,
    scope: { principal: "fixture-owner", securityNamespaceID: "fixture-namespace", locationKey: "fixture-location",
      projectScopeKey: "fixture-project-scope", namespaceBindingHash: digest(root), sessionID: "ipc-fixture-session",
      projectID: "fixture-project", directory: root, workspaceID: null },
    policy, policyHash: digest(policy), state: "creating", revision: 1, manualEpoch: 0, barrierOrder: 0,
    coreCutoff: -1, liveLeaseID: null, agentAccessFenced: true, resourceAlive: false, manualEnabled: false,
    createdAt: now, updatedAt: now, expiresAt: now + 60_000 })
  const lease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({ version: 2, leaseID: "ipc-fixture-lease",
    controlID: "ipc-fixture-lease", resourceID: resource.resourceID, mainIncarnation: manager.mainIncarnation,
    sidecarIncarnation: "ipc-fixture-sidecar", scope: resource.scope, policyHash: resource.policyHash, leaseEpoch: 1,
    manualEpoch: 0, state: "active", originInputID: null, requestID: "ipc-fixture-lease-create", createdAt: now,
    updatedAt: now, expiresAt: now + 60_000 })
  if (process.env.DAC_SHARED_BROWSER_PUBLIC_TLS_ONLY === "1") {
    const publicOrigin = "https://example.com"
    const resolverPolicy = process.env.DAC_SHARED_BROWSER_PUBLIC_RESOLVER === "alidns_doh_v1" ? "alidns_doh_v1" : "system"
    const publicPolicy = Schema.decodeUnknownSync(SharedBrowserSchema.Policy)({ ...policy, origin: publicOrigin,
      approvedOrigins: [publicOrigin], manualApprovedOrigins: [publicOrigin], resolverPolicy })
    const current = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({ ...resource, policy: publicPolicy,
      policyHash: digest(publicPolicy), requestDigest: digest({ publicOrigin }) })
    const currentLease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({ ...lease, policyHash: current.policyHash })
    const allowed = new Map<string, string>()
    manager.attachHost("ipc-fixture-sidecar", async (action) => allowed.get(action.actionID) === digest(action))
    const execute = async (command: BrowserSchema.Command) => {
      const action = Schema.decodeUnknownSync(SharedBrowserSchema.Action)({ actionID: randomUUID(), resourceID: current.resourceID,
        leaseID: currentLease.leaseID, leaseEpoch: currentLease.leaseEpoch, manualEpoch: currentLease.manualEpoch,
        admissionID: randomUUID(), providerReceiptID: "public-tls-fixture-receipt", providerAttemptID: "public-tls-fixture-attempt",
        toolCallID: randomUUID(), rootSessionID: current.rootSessionID, command, commandHash: digest(command), deadline: Date.now() + 8_000 })
      allowed.set(action.actionID, digest(action))
      return Schema.decodeUnknownSync(BrowserSchema.Result)((await manager.execute(current, currentLease, action)).result)
    }
    try {
      stage.value = "public-tls-create-real-main-resource"
      assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0")
      assert.equal(app.commandLine.hasSwitch("ignore-certificate-errors"), false)
      await manager.create(current, currentLease)
      const initial = (await execute({ type: "tabs.list" })).tabs[0]!
      stage.value = "public-tls-single-example-com-get"
      const navigated = await execute({ type: "navigate", tabID: initial.tabID, generation: initial.generation, url: publicOrigin + "/" })
      const tab = navigated.tabs[0]!
      stage.value = "public-tls-fresh-snapshot"
      const snapshot = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
      assert.equal(tab.url, publicOrigin + "/")
      assert.ok(snapshot.text?.includes("Example Domain"))
      const closing = manager.getView(current.resourceID).resource
      const closed = await manager.close(closing, { resourceID: current.resourceID,
        requestID: "public-tls-fixture-close", expectedRevision: closing.revision })
      assert.equal(closed.resourceAlive, false)
      assert.equal(closed.transportStopped, true)
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "public-tls-only", electron: process.versions.electron,
        url: tab.url, title: tab.title, text: snapshot.text, resolverPolicy, nativeTlsVerification: true,
        authentication: "none", modelCalls: 0, navigationActions: 1, closed, physicalInputAcceptance: false,
        dohAdapterAcceptance: resolverPolicy === "system" ? "not-exercised" : "alidns_doh_v1-only",
        productionProviderSelectionAcceptance: false }, null, 2), { mode: 0o600 })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    return
  }
  if (process.env.DAC_SHARED_BROWSER_INITIALIZATION_ONLY === "1") {
    const fromPartition = session.fromPartition.bind(session)
    const rows: Array<{ stage: string; cleanupRetainedReservation: boolean; closed: boolean; proxyListenerClosed: boolean;
      cleanupCalls: number; windows: number }> = []
    try {
      for (const failure of ["set-proxy", "close-connections"] as const) {
        stage.value = "initialization-failure-" + failure
        const calls = { proxy: "", failed: 0, cleanup: 0 }
        session.fromPartition = (...args) => {
          const partition = fromPartition(...args)
          const setProxy = partition.setProxy.bind(partition)
          const closeConnections = partition.closeAllConnections.bind(partition)
          partition.setProxy = async (config) => {
            calls.proxy = config.proxyRules ?? ""
            if (failure === "set-proxy" && calls.failed++ === 0) throw new Error("fixture-owned-set-proxy-failure")
            return setProxy(config)
          }
          partition.closeAllConnections = async () => {
            calls.cleanup++
            if (failure === "close-connections" && calls.failed++ < 2) throw new Error("fixture-owned-close-connections-failure")
            return closeConnections()
          }
          return partition
        }
        const current = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({ ...resource,
          resourceID: "initialization-" + failure, requestID: "initialization-create-" + failure,
          requestDigest: digest({ failure }) })
        const currentLease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({ ...lease,
          resourceID: current.resourceID, leaseID: "initialization-lease-" + failure, controlID: "initialization-lease-" + failure })
        await assert.rejects(manager.create(current, currentLease), (error: unknown) =>
          error instanceof Error && error.message === "fixture-owned-" + failure + "-failure")
        const failed = manager.getView(current.resourceID)
        const retained = manager.physicalCount() === 1
        assert.equal(BrowserWindow.getAllWindows().length, 0)
        assert.ok(failed.pendingClose)
        if (failure === "close-connections") {
          assert.equal(failed.resource.state, "recovery_required")
          assert.equal(retained, true)
          assert.equal(manager.status(current.resourceID).transportStopped, false)
          await manager.close(failed.resource, failed.pendingClose)
        }
        assert.equal(manager.getView(current.resourceID).resource.state, "closed")
        assert.equal(manager.status(current.resourceID).transportStopped, true)
        assert.equal(manager.physicalCount(), 0)
        const target = new URL(calls.proxy)
        const refused = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: target.hostname, port: Number(target.port) })
          const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 1_000)
          socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false) })
          socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code === "ECONNREFUSED") })
        })
        assert.equal(refused, true)
        rows.push({ stage: failure, cleanupRetainedReservation: retained, closed: true,
          proxyListenerClosed: refused, cleanupCalls: calls.cleanup, windows: BrowserWindow.getAllWindows().length })
        session.fromPartition = fromPartition
      }
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "initialization-only", rows,
        electron: process.versions.electron, providerCalls: 0, networkInitializationFaultInjection: true,
        originalDatabaseRead: false, physicalInputAcceptance: false }, null, 2), { mode: 0o600 })
    } finally {
      session.fromPartition = fromPartition
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    return
  }
  const owners = new WeakSet<BrowserWindow>()
  const dispose = registerSharedBrowserIpc(async () => ({ url: origin, username: "fixture-owned", password: "fixture-only" }),
    (window) => owners.has(window))
  const owned = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, "preload.cjs"),
    nodeIntegration: false, contextIsolation: true, sandbox: true } })
  owners.add(owned)
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, "preload.cjs"),
    nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const run = <Value>(window: BrowserWindow, source: string) => window.webContents.executeJavaScript<Value>(source)
  const input = (id: string) => ({ sessionID: resource.rootSessionID, inputID: "ipc-input-" + id,
    originalSubmissionID: "ipc-submission-" + id, rawInput: "fixture user " + id })
  try {
    if (process.env.DAC_SHARED_BROWSER_PROJECTION_ONLY === "1") {
      stage.value = "durable-closed-and-stale-main-projection"
      projection.resources = [
        { ...resource, resourceID: "closed-old-main", mainIncarnation: "previous-main", state: "closed" },
        { ...resource, resourceID: "closed-current-main", state: "closed" },
        { ...resource, resourceID: "blocked-old-main", mainIncarnation: "previous-main", state: "fenced_blocked" },
        { ...resource, resourceID: "lost-old-main", mainIncarnation: "previous-main", state: "resource_lost" },
      ]
      await owned.loadURL(origin)
      const bridge = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
      const listed = await run<{ value: Array<{ resource: SharedBrowserSchema.Resource }> }>(owned,
        `window.api.sharedBrowser.list(${JSON.stringify(bridge.generation)},${JSON.stringify(resource.rootSessionID)})`)
      assert.deepEqual(listed.value.slice(0, 2).map((value) => value.resource), projection.resources.slice(0, 2))
      assert.deepEqual(listed.value.map((value) => value.resource.state), ["closed", "closed", "resource_lost", "resource_lost"])
      assert.equal(listed.value[2]!.resource.agentAccessFenced, true)
      assert.equal(listed.value[2]!.resource.resourceAlive, false)
      assert.equal(listed.value[2]!.resource.liveLeaseID, null)
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "durable-projection",
        productionPreload: true, productionIpc: true, closedPreserved: true,
        states: listed.value.map((value) => value.resource.state), oldBlockedFenced: true,
        authenticatedLists: requests.authenticatedLists, managedPagesCreated: manager.list(resource.rootSessionID).length,
        providerCalls: 0, coreHttpSeam: "owned authenticated durable-resource list fixture; not production SQL" }, null, 2), { mode: 0o600 })
      return
    }
    stage.value = "actual-main-resource-and-production-preload"
    await manager.create(resource, lease)
    const page = BrowserWindow.getAllWindows().find((window) => window !== owned && window !== foreign)!
    const identity = { windowID: page.id, contentsID: page.webContents.id }
    await Promise.all([owned.loadURL(origin), foreign.loadURL(origin)])
    stage.value = "registered-window-positive-and-same-url-foreign-negative"
    const first = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
    assert.ok(first.generation)
    if (process.env.DAC_SHARED_BROWSER_FILE_OWNER_ONLY === "1") {
      stage.value = "file-confirmation-trusted-renderer-owner"
      const current = manager.getView(resource.resourceID).resource
      const binding = SharedBrowserFileBinding.from(current, lease)
      const preview = Schema.decodeUnknownSync(SharedBrowserFileSchema.Preview)({ version: 2, direction: "upload",
        binding, bindingHash: digest(binding), instanceID: "fixture-instance", scopeHash: binding.scopeHash,
        helperHash: digest("confirmation-only-not-custody"), rootIdentity: { kind: "posix", device: "1", inode: "1" },
        relative: "owned.txt", name: "owned.txt", observedAt: now, targetURL: origin + "/upload",
        fileIdentity: { kind: "posix", device: "1", inode: "2" }, bytes: 5, sha256: digest("owned") })
      const command: SharedBrowserFileSchema.Approve = { requestID: "ipc-file-confirm", previewID: "ipc-file-preview",
        expectedResourceRevision: current.revision, expectedLeaseID: lease.leaseID,
        expectedLeaseEpoch: lease.leaseEpoch, expectedManualEpoch: lease.manualEpoch, expiresAt: now + 30_000 }
      const denied = () => assert.throws(() => manager.confirmFile(current, lease, preview, command, async () => {}),
        (error: unknown) => error instanceof Error && error.message === "BROWSER_AUTHORITY_REQUIRED")
      foreign.show()
      denied()
      owned.show()
      denied()
      await run(owned, `window.api.sharedBrowser.list(${JSON.stringify(first.generation)},"different-session")`)
      denied()
      await run(owned, `window.api.sharedBrowser.list(${JSON.stringify(first.generation)},${JSON.stringify(resource.rootSessionID)})`)
      const replacement = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
      denied()
      await run(owned, `window.api.sharedBrowser.list(${JSON.stringify(replacement.generation)},${JSON.stringify(resource.rootSessionID)})`)
      const originalDialog = dialog.showMessageBox.bind(dialog)
      const native = { calls: 0, parent: 0, rootSheets: 0, agentShows: 0 }
      page.on("show", () => native.agentShows++)
      const cancel = () => manager.beginTakeover(current, { resourceID: resource.resourceID,
        requestID: "ipc-file-confirm-cancel", expectedRevision: current.revision })
      owned.once("sheet-begin", () => { native.rootSheets++; setImmediate(cancel) })
      dialog.showMessageBox = ((window: BrowserWindow, options: Electron.MessageBoxOptions) => {
        native.calls++; native.parent = window.id
        const result = originalDialog(window, options)
        if (process.platform !== "darwin") setTimeout(cancel, 100)
        return result
      }) as typeof dialog.showMessageBox
      const cancelled = await manager.confirmFile(current, lease, preview, command, async () => {})
        .then(() => false, () => true)
      dialog.showMessageBox = originalDialog
      assert.equal(cancelled, true)
      assert.equal(native.parent, owned.id)
      assert.equal(page.isVisible(), false)
      const closed = await manager.close(manager.getView(resource.resourceID).resource,
        { resourceID: resource.resourceID, requestID: "ipc-file-owner-close", expectedRevision: current.revision })
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "file-confirm-owner",
        productionPreload: true, productionIpc: true, unsubscribedDenied: true, foreignVisibleWindowDenied: true,
        wrongSessionDenied: true, retiredOwnerDenied: true, nativeDialogCalls: native.calls, nativeDialogParent: native.parent,
        registeredRootWindow: owned.id, agentPageWindow: page.id, rootSheetEvents: native.rootSheets,
        agentShowEvents: native.agentShows, agentPageWasHidden: true, confirmationCancelled: cancelled,
        grantsIssued: 0, transfers: 0, providerCalls: 0, closed, physicalAllowOnceAcceptance: false,
        actualHelperCustodyAcceptance: false }, null, 2), { mode: 0o600 })
      return
    }
    if (process.env.DAC_SHARED_BROWSER_TUI_ONLY === "1") {
      stage.value = "actual-main-tui-pairing-and-trusted-window-approval"
      const tui = sharedBrowserTuiRegistry()
      const metadata: SharedBrowserTuiSchema.State[] = []
      const transport = { hostIncarnation: "ipc-fixture-sidecar", credentialBinding: digest("owned-tui-credential"), serverURL: origin }
      tui.registerHost(transport.hostIncarnation, { credentialBinding: transport.credentialBinding,
        verifyReady: (value) => value.url === origin && value.username === "fixture-owned" && value.password === "fixture-only",
        onState: (value) => { metadata.push(value) },
      })
      const secret = randomBytes(32)
      const paired = tui.pair(transport.hostIncarnation, transport, { requestID: "ipc-tui-pair", rootSessionID: resource.rootSessionID,
        directory: root, challengeHash: createHash("sha256").update(secret).digest("hex") })
      const connect = { attachID: paired.attachID, generation: paired.generation, secret: secret.toString("hex") }
      const approval = { attachID: paired.attachID, requestID: paired.requestID, challengeHash: paired.challengeHash,
        rootSessionID: paired.rootSessionID, directory: paired.directory, expectedGeneration: paired.generation }
      const approve = (value = approval, window = owned) => run<{ value: SharedBrowserTuiSchema.View }>(window,
        `window.api.sharedBrowser.tuiApprove(${JSON.stringify(first.generation)},${JSON.stringify(value)})`)
      const reserve = (id: string, expectedBarrierOrder = 0) => ({ ...connect, expectedBarrierOrder,
        inputID: "ipc-tui-input-" + id, originalSubmissionID: "ipc-tui-submit-" + id, rawInput: "真实 TUI 输入 " + id })
      assert.equal(paired.streamLive, false)
      assert.throws(() => tui.reserve(transport.hostIncarnation, reserve("before-approval")))
      await assert.rejects(approve())
      const stream = { attachID: paired.attachID, generation: paired.generation, streamID: randomUUID() }
      tui.open(transport.hostIncarnation, transport, connect, stream)
      await assert.rejects(approve(approval, foreign))
      for (const bad of [{ ...approval, challengeHash: digest("wrong challenge") },
        { ...approval, rootSessionID: "other-session" }, { ...approval, directory: path.dirname(root) },
        { ...approval, expectedGeneration: randomUUID() }]) await assert.rejects(approve(bad))
      const pendingTui = await run<{ value: SharedBrowserTuiSchema.View[] }>(owned,
        `window.api.sharedBrowser.tuiPending(${JSON.stringify(first.generation)},${JSON.stringify(resource.rootSessionID)})`)
      assert.equal(pendingTui.value.length, 1)
      assert.equal(pendingTui.value[0]!.streamLive, true)
      assert.equal((await approve()).value.state, "active")
      assert.throws(() => tui.reserve(transport.hostIncarnation, { ...reserve("wrong-secret"), secret: randomBytes(32).toString("hex") }))
      const original = tui.reserve(transport.hostIncarnation, reserve("sealed"))!
      const unsealed = tui.reserve(transport.hostIncarnation, reserve("unsealed"))!
      assert.equal(original.sourceKind, "tui_owner")
      assert.equal(manager.validateInput(original), false)
      const prompt = { id: original.inputID, parts: [{ type: "text", text: reserve("sealed").rawInput }] }
      const sealed = tui.seal(transport.hostIncarnation, { ...connect, stamp: original, prompt })
      assert.equal(manager.validateInput(sealed), true)
      assert.equal(tui.reserve(transport.hostIncarnation, reserve("sealed"))!.submissionOrder, original.submissionOrder)
      assert.throws(() => tui.seal(transport.hostIncarnation, { ...connect, stamp: original, prompt: { ...prompt, id: "different-input" } }))
      assert.throws(() => tui.open(transport.hostIncarnation, transport, connect, { ...stream, streamID: randomUUID() }))
      tui.disconnect(transport.hostIncarnation, { ...stream, streamID: randomUUID() })
      assert.equal(tui.pending(resource.rootSessionID)[0]!.state, "active")
      const takeover = manager.beginTakeover(manager.getView(resource.resourceID).resource,
        { resourceID: resource.resourceID, requestID: "ipc-tui-takeover", expectedRevision: 1 })
      assert.ok(takeover.ticket.barrierOrder > original.submissionOrder)
      assert.throws(() => tui.reserve(transport.hostIncarnation, reserve("late", 0)))
      assert.equal(metadata.at(-1)!.view.barrierOrder, takeover.ticket.barrierOrder)
      const freshRoot = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
      assert.notEqual(freshRoot.generation, first.generation)
      await run(owned, `window.api.sharedBrowser.detach(${JSON.stringify(first.generation)})`)
      const retiredPending = await run<{ value: SharedBrowserTuiSchema.View[] }>(owned,
        `window.api.sharedBrowser.tuiPending(${JSON.stringify(freshRoot.generation)},${JSON.stringify(resource.rootSessionID)})`)
      assert.equal(retiredPending.value.length, 0)
      assert.equal(tui.pending(resource.rootSessionID).length, 0)
      assert.throws(() => tui.reserve(transport.hostIncarnation, reserve("retired", takeover.ticket.barrierOrder)))
      assert.throws(() => tui.seal(transport.hostIncarnation, { ...connect, stamp: unsealed, prompt: "late unsealed" }))
      assert.deepEqual(tui.seal(transport.hostIncarnation, { ...connect, stamp: original, prompt }), sealed)
      assert.equal(manager.validateInput(sealed), true)
      assert.throws(() => tui.open(transport.hostIncarnation, transport, connect, stream))
      for (let index = 0; index < SharedBrowserTuiSchema.MAX_PENDING; index++) tui.pair(transport.hostIncarnation, transport,
        { requestID: "ipc-tui-capacity-" + index, rootSessionID: paired.rootSessionID, directory: paired.directory, challengeHash: paired.challengeHash })
      assert.throws(() => tui.pair(transport.hostIncarnation, transport, { requestID: "ipc-tui-over-capacity", rootSessionID: paired.rootSessionID, directory: paired.directory, challengeHash: paired.challengeHash }))
      tui.hostLost(transport.hostIncarnation)
      const closed = await manager.close(manager.getView(resource.resourceID).resource,
        { resourceID: resource.resourceID, requestID: "ipc-tui-close", expectedRevision: 1 })
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "tui-pairing", electron: process.versions.electron,
        productionPreload: true, productionIpc: true, approvedByRegisteredWindow: true,
        unapprovedRejected: true, foreignWindowRejected: true, wrongApprovalFieldsRejected: 4,
        wrongSecretRejected: true, changedStreamRejected: true, staleDisconnectIgnored: true,
        sourceKind: sealed.sourceKind, sealedValidated: manager.validateInput(sealed), originalOrder: original.submissionOrder,
        barrierOrder: takeover.ticket.barrierOrder, oldBarrierRejected: true, rootGenerationRetired: true,
        lateUnsealedRejected: true, sealedExactRetryPreserved: true, pendingCapacity: SharedBrowserTuiSchema.MAX_PENDING,
        closed, providerCalls: 0, coreHttpSeam: "owned authenticated listener fixture; private-port dispatch not exercised",
        actualTtyAcceptance: false, productionSqlAdmissionAcceptance: false, physicalUserClickAcceptance: false }, null, 2), { mode: 0o600 })
      return
    }
    await assert.rejects(run(foreign, "window.api.sharedBrowser.register()"))
    await assert.rejects(run(foreign, `window.api.sharedBrowser.list(${JSON.stringify(first.generation)},${JSON.stringify(resource.rootSessionID)})`))
    assert.equal(requests.authenticatedLists, 0)
    const before = await run<{ generation: string; value: Array<{ elapsedMs: number }> }>(owned,
      `window.api.sharedBrowser.list(${JSON.stringify(first.generation)},${JSON.stringify(resource.rootSessionID)})`)
    assert.equal(before.generation, first.generation)
    assert.equal(before.value.length, 1)
    assert.ok(before.value[0]!.elapsedMs >= 0)
    const reserved = await run<{ generation: string; value: SharedBrowserSchema.InputStamp }>(owned,
      `window.api.sharedBrowser.stampInput(${JSON.stringify(first.generation)},${JSON.stringify(input("pending"))})`)
    const sealedReservation = await run<{ generation: string; value: SharedBrowserSchema.InputStamp }>(owned,
      `window.api.sharedBrowser.stampInput(${JSON.stringify(first.generation)},${JSON.stringify(input("sealed"))})`)
    const sealed = await run<{ generation: string; value: SharedBrowserSchema.InputStamp }>(owned,
      `window.api.sharedBrowser.sealInput(${JSON.stringify(first.generation)},${JSON.stringify({ stamp: sealedReservation.value, prompt: { parts: [{ type: "text", text: input("sealed").rawInput }] } })})`)
    assert.equal(manager.validateInput(reserved.value), false)
    assert.equal(manager.validateInput(sealed.value), true)

    stage.value = "in-flight-old-result-and-late-disposer-fenced"
    pending.next = true
    await run(owned, `window.pendingList=window.api.sharedBrowser.list(${JSON.stringify(first.generation)},${JSON.stringify(resource.rootSessionID)}).then(()=>({ok:true}),error=>({ok:false,message:error.message}));true`)
    await pending.entered.promise
    const second = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
    assert.notEqual(second.generation, first.generation)
    pending.release.resolve()
    const late = await run<{ ok: boolean; message: string }>(owned, "window.pendingList")
    assert.equal(late.ok, false)
    assert.match(late.message, /retired/)
    await run(owned, `window.api.sharedBrowser.detach(${JSON.stringify(first.generation)})`)
    const secondView = await run<{ generation: string; value: unknown[] }>(owned,
      `window.api.sharedBrowser.list(${JSON.stringify(second.generation)},${JSON.stringify(resource.rootSessionID)})`)
    assert.equal(secondView.generation, second.generation)
    assert.equal(secondView.value.length, 1)
    assert.throws(() => manager.seal(reserved.value, digest("retired prompt")))
    assert.equal(manager.validateInput(sealed.value), true)
    await assert.rejects(run(owned,
      `window.api.sharedBrowser.sealInput(${JSON.stringify(second.generation)},${JSON.stringify({ stamp: reserved.value, prompt: "old input" })})`))
    const reloadReservation = await run<{ generation: string; value: SharedBrowserSchema.InputStamp }>(owned,
      `window.api.sharedBrowser.stampInput(${JSON.stringify(second.generation)},${JSON.stringify(input("reload"))})`)

    stage.value = "actual-renderer-navigation-preserves-main-page-and-elapsed"
    await owned.loadURL(origin + "/?reload=1")
    await assert.rejects(run(owned,
      `window.api.sharedBrowser.list(${JSON.stringify(second.generation)},${JSON.stringify(resource.rootSessionID)})`))
    assert.throws(() => manager.seal(reloadReservation.value, digest("retired reload prompt")))
    const third = await run<{ generation: string }>(owned, "window.api.sharedBrowser.register()")
    await run(owned, `window.api.sharedBrowser.detach(${JSON.stringify(second.generation)})`)
    const after = await run<{ generation: string; value: Array<{ elapsedMs: number }> }>(owned,
      `window.api.sharedBrowser.list(${JSON.stringify(third.generation)},${JSON.stringify(resource.rootSessionID)})`)
    assert.equal(after.generation, third.generation)
    assert.ok(after.value[0]!.elapsedMs >= before.value[0]!.elapsedMs)
    assert.equal(page.id, identity.windowID)
    assert.equal(page.webContents.id, identity.contentsID)
    assert.equal(manager.status(resource.resourceID).resourceAlive, true)
    assert.equal(manager.status(resource.resourceID).leaseID, lease.leaseID)
    assert.equal(manager.validateInput(sealed.value), true)
    const closed = await manager.close(manager.getView(resource.resourceID).resource,
      { resourceID: resource.resourceID, requestID: "ipc-fixture-close", expectedRevision: 1 })
    assert.equal(closed.transportStopped, true)
    assert.equal(closed.resourceAlive, false)
    await writeFile(path.join(root, "result.json"), JSON.stringify({ electron: process.versions.electron,
      productionPreload: true, productionIpc: true, sameOriginUnregisteredWindowRejected: true,
      lateResponseRejected: late.ok === false, oldDetachPreservedNewGeneration: true, oldUnsealedRetired: true,
      sealedRetained: manager.validateInput(sealed.value), navigationRetiredOldGeneration: true,
      resourceAndLeasePreserved: true, elapsedBefore: before.value[0]!.elapsedMs, elapsedAfter: after.value[0]!.elapsedMs,
      requests, closed, providerCalls: 0, coreHttpSeam: "owned localhost authenticated list fixture; not production Core",
      nativeUserInteractionAcceptance: false, productionProviderSelectionAcceptance: false }, null, 2), { mode: 0o600 })
  } finally {
    pending.release.resolve()
    dispose()
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void main().then(() => app.exit(0), async (error: unknown) => {
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ stage: stage.value, error: String(error),
    stack: error instanceof Error ? error.stack : undefined }, null, 2), { mode: 0o600 })
  app.exit(1)
})
