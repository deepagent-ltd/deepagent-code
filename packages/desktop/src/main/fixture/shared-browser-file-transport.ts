import { app, BrowserWindow, session } from "electron"
import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"
import type { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import type { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import type { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { createSharedBrowserNetwork } from "../shared-browser-network"
import type { SharedBrowserNetwork } from "../shared-browser-network"
import { createSharedBrowserDriver, createSharedBrowserWitnessBudget } from "../shared-browser-driver"
import { createManagedBrowserFiles } from "../managed-browser-files"

const root = process.env.DAC_SHARED_BROWSER_FILE_TRANSPORT_ROOT!
const diagnosticOnly = process.env.DAC_SHARED_BROWSER_FILE_TRANSPORT_MODE === "download-diagnostic"
const downloadOnly = diagnosticOnly || process.env.DAC_SHARED_BROWSER_FILE_TRANSPORT_MODE === "download-only"
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-quic")
app.on("window-all-closed", () => {})

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const digest = (value: unknown) => hash(CanonicalJson.stringify(value))
const fail = (code: BrowserSchema.Error["code"]): never => { throw new Error(code) }
const state: { phase: string; epoch: number; mode: SharedBrowserSchema.Resource["state"]; action?: SharedBrowserSchema.Action;
  file?: { action: SharedBrowserSchema.Action; transfer: ReturnType<typeof createManagedBrowserFiles> }; network?: SharedBrowserNetwork } =
  { phase: "startup", epoch: 0, mode: "agent_owned" }
const facts = { submitCalls: 0, clearCalls: 0, clearAcks: 0, cleanupClearCalls: 0, cleanupClearAcks: 0,
  gateClearAcks: 0, checkedMultipartHash: "", checkedMultipartBytes: 0,
  receivedMultipartHash: "", receivedMultipartBytes: 0, fileBodyHash: "", fileBodyBytes: 0,
  uploadReadCalls: 0, uploadSeals: 0, uploadObservations: 0, downloadWrites: 0, downloadPublishes: 0,
  authorizeError: "", uploadDataError: "", contentTypeName: "", contentType: "",
  heldWrites: 0, heldPublishes: 0, heldRejected: false, heldSucceeded: false, heldError: "",
  heldTransportStopped: false, heldServerClosed: false, heldServerEnded: false, heldOriginalPreserved: false }
const uploadParts: Array<{ bytes: number; file: string | null; blob: boolean }> = []
const commandErrors: Array<{ method: string; phase: string; error: string }> = []
const requests: Array<{ method: string; path: string; cookie: string; privateHeader: boolean; clearAcks: number }> = []
const trace: Array<{ method: string; phase: string }> = []
const gates: Array<{ gate: string; phase: string; method: string; resourceType: string;
  pathClass: string; webContentsPresent: boolean; sameOwnedContents: boolean; privateNoncePresent: boolean | null;
  privateNonceType: string; cancel: boolean; privateNonceForwarded?: boolean }> = []
const upload = Buffer.from("owned standard multipart\n中文 source bytes\n")
const downloaded = Buffer.from("owned same-partition download\n中文 result bytes\n")
const context = new AsyncLocalStorage<SharedBrowserSchema.Action>()
const bindings = { resourceID: randomUUID(), rootSessionID: randomUUID(), mainIncarnation: randomUUID(),
  sidecarIncarnation: randomUUID(), leaseID: randomUUID() }

async function phase(value: string) {
  state.phase = value
  await fs.writeFile(path.join(root, "stage.json"), JSON.stringify({ phase: value }), { mode: 0o600 })
}

function makeAction(command: BrowserSchema.Command): SharedBrowserSchema.Action {
  return { ...bindings, actionID: randomUUID(), leaseEpoch: 1, manualEpoch: 0, admissionID: "controlled-admission",
    providerReceiptID: "controlled-receipt", providerAttemptID: "controlled-attempt", toolCallID: randomUUID(),
    command, commandHash: digest(command), deadline: Date.now() + 15_000 }
}

async function main() {
  await app.whenReady()
  await fs.writeFile(path.join(root, "owned-source.txt"), upload, { mode: 0o600 })
  const source = await fs.readFile(path.join(root, "owned-source.txt"))
  const sourceStat = await fs.stat(path.join(root, "owned-source.txt"), { bigint: true })
  const rootStat = await fs.stat(root, { bigint: true })
  const identity = (stat: { dev: bigint; ino: bigint }): BrowserFileSchema.Identity =>
    ({ kind: "posix", device: String(stat.dev), inode: String(stat.ino) })
  const cookie = "shared_file=fixture-owned"
  const heldServerClosed = Promise.withResolvers<void>()
  const server = createServer((request, response) => {
    const record = { method: request.method ?? "", path: request.url ?? "", cookie: request.headers.cookie ?? "",
      privateHeader: request.headers["x-dac-private-file-admission"] !== undefined, clearAcks: facts.clearAcks }
    requests.push(record)
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie + "; HttpOnly; SameSite=Lax; Path=/" })
      response.end(downloadOnly
        ? '<!doctype html><title>Owned download transport</title><a aria-label="Owned download" href="/download?owned=bytes">Owned download</a><a aria-label="Owned held download" href="/download?owned=held">Owned held download</a>'
        : '<!doctype html><title>Owned file transport</title><form method="POST" action="/upload?owned=exact" enctype="multipart/form-data"><input name="owned" value="field" type="hidden"><input type="file" name="asset" aria-label="Owned upload"></form>')
      return
    }
    if (request.method === "POST" && request.url === "/upload?owned=exact") {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.once("end", () => {
        const body = Buffer.concat(chunks)
        facts.receivedMultipartHash = hash(body); facts.receivedMultipartBytes = body.length
        const type = request.headers["content-type"] ?? ""
        const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(type)
        const filename = body.indexOf(Buffer.from('filename="owned-source.txt"'))
        const start = filename < 0 ? -1 : body.indexOf(Buffer.from("\r\n\r\n"), filename)
        const end = boundary && start >= 0 ? body.indexOf(Buffer.from("\r\n--" + (boundary[1] ?? boundary[2])), start + 4) : -1
        const file = start >= 0 && end >= start ? body.subarray(start + 4, end) : Buffer.alloc(0)
        facts.fileBodyHash = hash(file); facts.fileBodyBytes = file.length
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        response.end('<!doctype html><title>Owned upload accepted</title><p>Owned upload accepted</p><a aria-label="Owned download" href="/download?owned=bytes">Owned download</a>')
      })
      return
    }
    if (request.method === "GET" && request.url === "/download?owned=bytes") {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(downloaded.length),
        "Content-Disposition": 'attachment; filename="owned-result.txt"' })
      response.end(downloaded)
      return
    }
    if (request.method === "GET" && request.url === "/download?owned=held") {
      response.once("close", () => {
        facts.heldServerClosed = true; facts.heldServerEnded = response.writableFinished
        heldServerClosed.resolve()
      })
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1024" })
      response.write(downloaded.subarray(0, 8))
      return
    }
    response.writeHead(404); response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const policy: SharedBrowserSchema.Policy = { origin, approvedOrigins: [origin], manualApprovedOrigins: [origin],
    resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } }
  const partition = session.fromPartition("dac-shared-file-component-" + randomUUID(), { cache: false })
  partition.setPermissionCheckHandler(() => false)
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({ show: false, focusable: false, webPreferences: { session: partition,
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } })
  const contents = window.webContents
  if (diagnosticOnly) {
    // Transparent, synchronous diagnostics around the registered production
    // gates. Never record nonce/Cookie values or replace an allow/cancel result.
    const beforeRequest = partition.webRequest.onBeforeRequest.bind(partition.webRequest)
    const beforeHeaders = partition.webRequest.onBeforeSendHeaders.bind(partition.webRequest)
    type RequestListener = Exclude<Parameters<typeof beforeRequest>[0], null>
    type HeadersListener = Exclude<Parameters<typeof beforeHeaders>[0], null>
    const requestListener = (listener: RequestListener | null): RequestListener | null => listener && ((details, callback) => {
      listener(details, (response) => {
        if (gates.length < 16) gates.push({ gate: "before-request", phase: state.phase, method: details.method,
          resourceType: details.resourceType, pathClass: details.url.endsWith("/download?owned=bytes") ? "download" : "bootstrap-or-other",
          webContentsPresent: details.webContents !== undefined && details.webContents !== null,
          sameOwnedContents: details.webContents === contents, privateNoncePresent: null, privateNonceType: "not-exposed",
          cancel: response.cancel === true })
        callback(response)
      })
    })
    const headersListener = (listener: HeadersListener | null): HeadersListener | null => listener && ((details, callback) => {
      listener(details, (response) => {
        const nonce = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === "x-dac-private-file-admission")
        if (gates.length < 16) gates.push({ gate: "before-headers", phase: state.phase, method: details.method,
          resourceType: details.resourceType, pathClass: details.url.endsWith("/download?owned=bytes") ? "download" : "bootstrap-or-other",
          webContentsPresent: details.webContents !== undefined && details.webContents !== null,
          sameOwnedContents: details.webContents === contents, privateNoncePresent: nonce !== undefined,
          privateNonceType: nonce ? typeof nonce[1] : "absent", cancel: response.cancel === true,
          privateNonceForwarded: Object.keys(response.requestHeaders ?? details.requestHeaders)
            .some((name) => name.toLowerCase() === "x-dac-private-file-admission") })
        callback(response)
      })
    })
    partition.webRequest.onBeforeRequest = (...args: [Electron.WebRequestFilter, RequestListener | null] | [RequestListener | null]) => {
      if (args.length === 2) return beforeRequest(args[0], requestListener(args[1]))
      return beforeRequest(requestListener(args[0]))
    }
    partition.webRequest.onBeforeSendHeaders = (...args: [Electron.WebRequestFilter, HeadersListener | null] | [HeadersListener | null]) => {
      if (args.length === 2) return beforeHeaders(args[0], headersListener(args[1]))
      return beforeHeaders(headersListener(args[0]))
    }
  }
  const send = contents.debugger.sendCommand.bind(contents.debugger)
  contents.debugger.sendCommand = (method, params, sessionID) => send(method, params, sessionID).catch((error: unknown) => {
    if (commandErrors.length < 16) commandErrors.push({ method, phase: state.phase, error: String(error) })
    throw error
  })
  const initialIDs = { window: window.id, contents: contents.id }
  const currentNow = () => {
    const active = context.getStore()
    if (state.epoch !== 0 || state.mode !== "agent_owned" || contents.isDestroyed() || !active ||
      state.action !== active || active.deadline <= Date.now()) fail("BROWSER_CANCELLED")
  }
  const current = async () => { currentNow() }
  const currentAction = (active: SharedBrowserSchema.Action) => async () => {
    if (state.epoch !== 0 || state.mode !== "agent_owned" || state.action !== active || active.deadline <= Date.now() || contents.isDestroyed())
      fail("BROWSER_CANCELLED")
  }
  const network = await createSharedBrowserNetwork({ partition, policy,
    current: () => ({ epoch: state.epoch, state: state.mode, action: state.action }), owns: (value) => value === contents,
    onAllocated: (value) => { state.network = value }, file: () => state.file })
  const detach = network.attach(contents)
  const driver = createSharedBrowserDriver({ contents, generation: () => 1, current, currentNow,
    witnessBudget: createSharedBrowserWitnessBudget(),
    setupCurrentNow: () => { if (state.epoch !== 0 || state.mode !== "agent_owned" || contents.isDestroyed()) fail("BROWSER_CANCELLED") },
    approvedOrigins: [origin], dispatched: currentNow, fail })
  contents.debugger.on("message", (_event, method) => {
    if (trace.length < 96 && ["DOM.documentUpdated", "Page.frameNavigated", "Page.navigatedWithinDocument"].includes(method)) trace.push({ method, phase: state.phase })
  })
  const actions = { fileTarget: driver.fileTarget, selectFiles: driver.selectFiles,
    submitFiles: async (...args: Parameters<typeof driver.submitFiles>) => {
      facts.submitCalls++
      const cleared = await driver.submitFiles(...args)
      // Count only the real static leaf's selection-clear receipt. No extra
      // DOM cleanup command is dispatched while navigation headers are held.
      if (cleared === true) { facts.clearCalls++; facts.clearAcks++ }
      return cleared
    },
    clearFiles: async (command: Extract<BrowserSchema.Command, { type: "file.upload" }>) => {
      facts.cleanupClearCalls++
      const value = await driver.clearFiles(command)
      if (value) facts.cleanupClearAcks++
      return value
    } }
  const pair = (direction: "upload" | "download", active: SharedBrowserSchema.Action, held = false) => {
    const suffix = held ? "download-held" : direction
    const now = Date.now()
    const binding: SharedBrowserFileSchema.Binding = { kind: "shared-v2", ...bindings, leaseEpoch: 1, manualEpoch: 0,
      policyHash: digest(policy), scopeHash: digest({ root }) }
    const common = { version: 2 as const, binding, bindingHash: digest(binding), instanceID: "controlled-instance",
      scopeHash: binding.scopeHash, helperHash: hash("CONTROLLED-NOT-NATIVE-HELPER"), rootIdentity: identity(rootStat), observedAt: now }
    const preview: SharedBrowserFileSchema.Preview = direction === "upload"
      ? { ...common, direction, relative: "owned-source.txt", name: "owned-source.txt", fileIdentity: identity(sourceStat),
        targetURL: origin + "/upload?owned=exact", bytes: source.length, sha256: hash(source) }
      : { ...common, direction, relative: held ? "owned-held.txt" : "owned-result.txt", name: held ? "owned-held.txt" : "owned-result.txt", parentIdentity: identity(rootStat),
        targetURL: origin + (held ? "/download?owned=held" : "/download?owned=bytes"), maxBytes: 1024, expected: "missing" }
    const command = { requestID: "controlled-" + suffix, previewID: "controlled-preview-" + suffix,
      expectedResourceRevision: 1, expectedLeaseID: binding.leaseID, expectedLeaseEpoch: 1, expectedManualEpoch: 0, expiresAt: active.deadline }
    const grant: SharedBrowserFileSchema.Grant = { version: 2, binding, bindingHash: digest(binding), grantID: "controlled-grant-" + suffix,
      instanceID: common.instanceID, scopeHash: common.scopeHash, command, commandHash: digest(command), preview,
      confirmation: { previewHash: digest(preview), commandHash: digest(command), confirmationHash: hash("CONTROLLED-NOT-OS-APPROVAL"), confirmedAt: now },
      expiresAt: command.expiresAt, createdAt: now }
    const artifact: SharedBrowserFileSchema.Artifact = { version: 2, binding, bindingHash: digest(binding), artifactID: "controlled-artifact-" + suffix,
      instanceID: common.instanceID, grantID: grant.grantID, grantHash: digest(grant), actionID: active.actionID,
      admissionID: active.admissionID, providerReceiptID: active.providerReceiptID, providerAttemptID: active.providerAttemptID,
      toolCallID: active.toolCallID, sessionID: bindings.rootSessionID, scopeHash: binding.scopeHash, ordinal: 0, manifest: preview,
      state: "reserved", revision: 1, reservedBytes: 1024, publication: null, stopConfirmedAt: null, releasedAt: null, createdAt: now, updatedAt: now }
    return { grant, artifact }
  }
  const publication = (entry: ReturnType<typeof pair>, bytes: Buffer, outcome: "selected" | "published"): BrowserFileSchema.Publication =>
    ({ version: 1, artifactID: entry.artifact.artifactID, grantID: entry.grant.grantID, direction: entry.grant.preview.direction,
      rootIdentity: identity(rootStat), stageIdentity: identity(sourceStat), fileIdentity: identity(sourceStat), bytes: bytes.length,
      sha256: hash(bytes), helperHash: entry.grant.preview.helperHash, observedAt: Date.now(), outcome })
  try {
    await phase("bootstrap-cookie-and-driver")
    state.action = makeAction({ type: "tabs.list" })
    await contents.loadURL(origin)
    await context.run(state.action, () => driver.attach())
    const jar = await partition.cookies.get({ url: origin })
    assert.equal(jar.find((value) => value.name === "shared_file")?.httpOnly, true)
    const snapshotCommand: Extract<BrowserSchema.Command, { type: "snapshot" }> = { type: "snapshot", tabID: "owned-tab", generation: 1 }
    const uploadStopped = { closed: false }
    if (!downloadOnly) {
      state.action = makeAction(snapshotCommand)
      const initial = await context.run(state.action, () => driver.snapshot(snapshotCommand))
      await fs.writeFile(path.join(root, "upload-snapshot.json"), JSON.stringify(initial, null, 2), { mode: 0o600 })
      const uploadRef = initial.refs.find((value) => value.name === "Owned upload")
      assert.ok(uploadRef)
      const uploadCommand: Extract<BrowserSchema.Command, { type: "file.upload" }> = { type: "file.upload", tabID: "owned-tab", generation: 1,
        frameID: uploadRef.frameID, observationRevision: initial.observationRevision, ref: uploadRef.ref, grantIDs: ["controlled-grant-upload"] }
      const uploadAction = makeAction(uploadCommand)
      state.action = uploadAction
      const uploadPair = pair("upload", uploadAction)
      const uploadTransfer = createManagedBrowserFiles({ action: uploadAction, shared: { origin,
        download: (url, signal) => network.download(uploadAction, url, signal, currentAction(uploadAction)) },
        files: [uploadPair], actions, current: currentAction(uploadAction), fail, ask: async (leaf) => {
          if (leaf.operation === "upload.read") {
            facts.uploadReadCalls++
            assert.equal(leaf.offset, 0)
            return { payload: source.subarray(leaf.offset, leaf.offset + leaf.length).toString("base64") }
          }
          assert.equal("bytes" in leaf && leaf.bytes, source.length)
          assert.equal("sha256" in leaf && leaf.sha256, hash(source))
          if (leaf.operation === "upload.seal") { facts.uploadSeals++; return {} }
          assert.equal(leaf.operation, "upload.observe"); facts.uploadObservations++
          return { publication: publication(uploadPair, source, "selected") }
        } })
      const authorize = uploadTransfer.authorizePost
      const uploadData = uploadTransfer.uploadData
      uploadTransfer.uploadData = async (parts) => {
        uploadParts.push(...parts.slice(0, 32).map((part) => ({ bytes: part.bytes?.length ?? 0,
          file: part.file ? path.basename(part.file) : null, blob: part.blobUUID !== undefined })))
        try { return await uploadData(parts) }
        catch (error) { facts.uploadDataError = String(error); throw error }
      }
      uploadTransfer.authorizePost = async (url, headers, body) => {
        facts.checkedMultipartHash = hash(body); facts.checkedMultipartBytes = body.length
        const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")
        facts.contentTypeName = contentType?.[0] ?? ""
        facts.contentType = typeof contentType?.[1] === "string" ? contentType[1] : ""
        try { await authorize(url, headers, body) }
        catch (error) { facts.authorizeError = String(error); throw error }
        facts.gateClearAcks = facts.clearAcks
      }
      state.file = { action: uploadAction, transfer: uploadTransfer }
      await phase("actual-multipart-upload")
      const uploadLoaded = new Promise<void>((resolve) => contents.once("did-finish-load", () => resolve()))
      const uploads = await context.run(uploadAction, () => uploadTransfer.run())
      await uploadLoaded
      assert.equal(uploads[0]?.outcome, "selected")
      assert.equal(facts.receivedMultipartHash, facts.checkedMultipartHash)
      assert.equal(facts.receivedMultipartBytes, facts.checkedMultipartBytes)
      assert.equal(facts.fileBodyHash, hash(source)); assert.equal(facts.fileBodyBytes, source.length)
      assert.equal(facts.submitCalls, 1); assert.equal(facts.clearAcks, 1); assert.equal(facts.gateClearAcks, 1)
      assert.equal(facts.cleanupClearCalls, 0)
      assert.equal(requests.filter((value) => value.method === "POST").length, 1)
      assert.equal(requests.find((value) => value.method === "POST")?.cookie, cookie)
      assert.equal(requests.find((value) => value.method === "POST")?.clearAcks, 1)
      Object.assign(uploadStopped, await network.quiesce(0))
      assert.equal(uploadStopped.closed, true)
      assert.equal(await uploadTransfer.close(), true)
      state.file = undefined
      assert.equal(network.resume(0), true)
      assert.equal(window.isDestroyed(), false)
      assert.equal(window.id, initialIDs.window); assert.equal(contents.id, initialIDs.contents)
    }

    await phase("fresh-download-snapshot")
    state.action = makeAction(snapshotCommand)
    const fresh = await context.run(state.action, () => driver.snapshot(snapshotCommand))
    await fs.writeFile(path.join(root, "download-snapshot.json"), JSON.stringify(fresh, null, 2), { mode: 0o600 })
    const downloadRef = fresh.refs.find((value) => value.name === "Owned download")
    assert.ok(downloadRef)
    const downloadCommand: Extract<BrowserSchema.Command, { type: "file.download" }> = { type: "file.download", tabID: "owned-tab", generation: 1,
      frameID: downloadRef.frameID, observationRevision: fresh.observationRevision, ref: downloadRef.ref, grantID: "controlled-grant-download" }
    const downloadAction = makeAction(downloadCommand)
    state.action = downloadAction
    const downloadPair = pair("download", downloadAction)
    const output = await fs.open(path.join(root, "owned-result.txt"), "wx", 0o600)
    const written: Buffer[] = []
    const downloadTransfer = createManagedBrowserFiles({ action: downloadAction, shared: { origin,
      download: (url, signal) => network.download(downloadAction, url, signal, currentAction(downloadAction)) },
      files: [downloadPair], actions, current: currentAction(downloadAction), fail, ask: async (leaf) => {
        if (leaf.operation === "download.write") {
          const chunk = Buffer.from(leaf.payload, "base64")
          assert.equal(leaf.offset, written.reduce((total, bytes) => total + bytes.length, 0))
          assert.equal((await output.write(chunk, 0, chunk.length, leaf.offset)).bytesWritten, chunk.length)
          written.push(chunk); facts.downloadWrites++
          return {}
        }
        assert.equal(leaf.operation, "download.publish")
        assert.equal("bytes" in leaf && leaf.bytes, downloaded.length)
        assert.equal("sha256" in leaf && leaf.sha256, hash(downloaded))
        await output.sync(); facts.downloadPublishes++
        return { publication: publication(downloadPair, Buffer.concat(written), "published") }
      } })
    state.file = { action: downloadAction, transfer: downloadTransfer }
    await phase("actual-same-partition-download")
    const downloads = await context.run(downloadAction, () => downloadTransfer.run())
    await output.close()
    assert.equal(downloads[0]?.outcome, "published")
    assert.deepEqual(await fs.readFile(path.join(root, "owned-result.txt")), downloaded)
    assert.equal(requests.filter((value) => value.path === "/download?owned=bytes").length, 1)
    assert.equal(requests.find((value) => value.path === "/download?owned=bytes")?.cookie, cookie)
    assert.equal(requests.some((value) => value.privateHeader), false)
    if (downloadOnly) {
      assert.equal(facts.uploadReadCalls, 0); assert.equal(facts.submitCalls, 0)
      assert.equal(requests.some((value) => value.method === "POST"), false)
    }
    if (downloadOnly && !diagnosticOnly) {
      await downloadTransfer.close()
      state.file = undefined
      const heldRef = fresh.refs.find((value) => value.name === "Owned held download")
      assert.ok(heldRef)
      const heldCommand: Extract<BrowserSchema.Command, { type: "file.download" }> = { ...downloadCommand,
        frameID: heldRef.frameID, ref: heldRef.ref, grantID: "controlled-grant-download-held" }
      const heldAction = makeAction(heldCommand)
      state.action = heldAction
      const heldPair = pair("download", heldAction, true)
      const heldOutput = await fs.open(path.join(root, "owned-held.txt"), "wx", 0o600)
      const firstWrite = Promise.withResolvers<void>()
      const heldTransfer = createManagedBrowserFiles({ action: heldAction, shared: { origin,
        download: (url, signal) => network.download(heldAction, url, signal, currentAction(heldAction)) },
        files: [heldPair], actions, current: currentAction(heldAction), fail, ask: async (leaf) => {
          if (leaf.operation === "download.write") {
            const chunk = Buffer.from(leaf.payload, "base64")
            assert.equal((await heldOutput.write(chunk, 0, chunk.length, leaf.offset)).bytesWritten, chunk.length)
            facts.heldWrites++; firstWrite.resolve()
            return {}
          }
          facts.heldPublishes++
          assert.fail("An unfinished held response cannot publish")
        } })
      state.file = { action: heldAction, transfer: heldTransfer }
      await phase("actual-held-download-start")
      const pending = context.run(heldAction, () => heldTransfer.run()).then(() => {
        facts.heldSucceeded = true
      }, (error: unknown) => { facts.heldRejected = true; facts.heldError = String(error) })
      await firstWrite.promise
      await phase("actual-held-download-quiesce")
      state.epoch++; state.mode = "fenced_blocked"
      const stopped = await network.quiesce(state.epoch)
      facts.heldTransportStopped = stopped.closed
      assert.equal(stopped.closed, true)
      await pending
      await heldServerClosed.promise
      await heldOutput.close()
      assert.equal(facts.heldRejected, true); assert.equal(facts.heldSucceeded, false)
      assert.equal(facts.heldPublishes, 0); assert.equal(facts.heldServerEnded, false)
      assert.equal(await heldTransfer.close(), true)
      facts.heldOriginalPreserved = !window.isDestroyed() && window.id === initialIDs.window && contents.id === initialIDs.contents && contents.session === partition
      assert.equal(facts.heldOriginalPreserved, true)
      assert.equal(requests.filter((value) => value.path === "/download?owned=held").length, 1)
      assert.equal(requests.find((value) => value.path === "/download?owned=held")?.cookie, cookie)
      assert.equal(requests.some((value) => value.privateHeader), false)
      state.file = undefined
    }
    await phase("actual-stop-before-stage-cleanup")
    state.epoch++; state.mode = "closing"
    assert.equal(await network.close(), true)
    assert.equal(await downloadTransfer.close(), true)
    state.file = undefined
    const originalPreserved = !window.isDestroyed() && window.id === initialIDs.window && contents.id === initialIDs.contents && contents.session === partition
    assert.equal(originalPreserved, true)
    assert.deepEqual(await driver.cleanup(), { heldReleased: true, transportStopped: true })
    detach(); window.destroy()
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "shared-file-transport-component",
      electron: process.versions.electron, node: process.versions.node, facts, requests, sourceHash: hash(source), sourceBytes: source.length,
      downloadHash: hash(downloaded), downloadBytes: downloaded.length, originalPreserved, windows: BrowserWindow.getAllWindows().length,
      cookieHttpOnly: true, uploadStopped: downloadOnly ? null : uploadStopped.closed, finalTransportStopped: true, providerCalls: 0,
      productionPermissionAcceptance: false, nativeFileProofAcceptance: false, nativeOsConfirmationAcceptance: false,
      mainManagerImported: false, controlledV2Records: true, diagnosticOnly, downloadOnly, trace, gates }, null, 2), { mode: 0o600 })
  } finally {
    await state.network?.close()
    await state.file?.transfer.close()
    if (!window.isDestroyed()) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void main().then(() => app.exit(0), async (error: unknown) => {
  await fs.writeFile(path.join(root, "failure.json"), JSON.stringify({ phase: state.phase, error: String(error),
    stack: error instanceof Error ? error.stack : undefined, facts, requests, trace, uploadParts, commandErrors,
    diagnosticOnly, downloadOnly, gates }, null, 2), { mode: 0o600 })
  app.exit(1)
})
