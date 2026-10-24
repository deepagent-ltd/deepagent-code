import { app, BrowserWindow, dialog } from "electron"
import type { DownloadItem } from "electron"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { createSharedBrowserManager } from "../shared-browser"
import { sharedBrowserComputationState } from "../shared-browser-compute"

const root = process.env.DAC_SHARED_BROWSER_ROOT!
const policyOnly = process.env.DAC_SHARED_BROWSER_POLICY_ONLY === "1"
const postOnly = process.env.DAC_SHARED_BROWSER_POST_ONLY === "1"
const capacityOnly = process.env.DAC_SHARED_BROWSER_CAPACITY_ONLY === "1"
const framesOnly = process.env.DAC_SHARED_BROWSER_FRAMES_ONLY === "1"
const downloadsOnly = process.env.DAC_SHARED_BROWSER_DOWNLOADS_ONLY === "1"
const scriptOnly = process.env.DAC_SHARED_BROWSER_SCRIPT_ONLY === "1"
const fileConfirmOnly = process.env.DAC_SHARED_BROWSER_FILE_CONFIRM_ONLY === "1"
const fileCancelOnly = process.env.DAC_SHARED_BROWSER_FILE_CANCEL_ONLY === "1"
const programOnly = process.env.DAC_SHARED_BROWSER_PROGRAM_ONLY === "1"
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-quic")
if (framesOnly) app.commandLine.appendSwitch("site-per-process")
app.on("window-all-closed", () => {})

const digest = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const stage = { value: "startup" }
const trace: Array<{ event: string; phase: string; at: number }> = []
const frameEvidence = {
  targets: [] as Array<{
    sessionID: string
    targetID: string
    type: string
    targetInfo: unknown
    parentSessionID: string | null
  }>,
  commands: [] as Array<{ method: string; sessionID: string | null; frameID: string | null }>,
  processes: [] as Array<{
    url: string
    processID: number
    osProcessID: number
    parentProcessID: number | null
    frameToken: string
    parentFrameToken: string | null
  }>,
  frames: [] as Array<{ frameID: string; parentFrameID: string | null; url: string }>,
  trees: [] as Array<{ sessionID: string | null; frameTree: unknown }>,
  diagnosticErrors: [] as string[],
}
async function phase(value: string) {
  stage.value = value
  if (trace.length < 128) trace.push({ event: "fixture.phase", phase: value, at: Date.now() })
  await writeFile(path.join(root, "stage.json"), JSON.stringify({ stage: value }), { mode: 0o600 })
}

async function main() {
  await app.whenReady()
  const nonce = randomUUID()
  const childRequests: Array<{ path: string; method: string }> = []
  const requests: Array<{ path: string; cookie: string; method: string; contentType?: string; body?: string }> = []
  const server = createServer((request, response) => {
    const record = {
      path: request.url ?? "",
      cookie: request.headers.cookie ?? "",
      method: request.method ?? "",
      contentType: request.headers["content-type"],
      body: undefined as string | undefined,
    }
    requests.push(record)
    if (programOnly) {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (request.method === "POST") {
        const chunks: Buffer[] = []
        request.on("data", (data: Buffer) => chunks.push(data))
        request.on("end", () => {
          record.body = Buffer.concat(chunks).toString("utf8")
          response.end("<h1>Program submitted</h1>")
        })
        return
      }
      response.setHeader("Set-Cookie", "shared=program-owned; HttpOnly; SameSite=Strict; Path=/")
      response.end(
        `<html><body><h1>Shared program</h1><form method="post" action="/program-submit"><label>Name<input aria-label="Name" name="name" value="initial" ${request.url === "/program-drift" ? "oninput=\"document.querySelector('#tail').value='unexpected'\"" : ""}></label><label>Choice<select aria-label="Choice" name="choice"><option value="a">A</option><option value="b">B</option></select></label><button type="submit">Submit</button></form><label>Tail<input aria-label="Tail" id="tail" value="untouched"></label></body></html>`,
      )
      return
    }
    if (downloadsOnly && request.url?.startsWith("/manual-download")) {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=owned.bin",
        "Content-Length": "8192",
      })
      response.write(Buffer.alloc(4096, 97))
      return
    }
    if (framesOnly && request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        `<!doctype html><html><body><h1>Shared Main fixture</h1><button type="button" onclick="document.querySelector('#root-status').textContent='root-click-ok'">Root Click</button><output id="root-status"></output><div style="height:120px"></div><iframe title="Owned cross-site child" src="${childOrigin}/frame" style="margin-left:180px;width:640px;height:350px;border:8px solid black"></iframe></body></html>`,
      )
      return
    }
    if (postOnly && request.method === "POST") {
      const chunks: Buffer[] = []
      request.on("data", (data: Buffer) => chunks.push(data))
      request.on("end", () => {
        record.body = Buffer.concat(chunks).toString("utf8")
        if (request.url === "/redirect307") {
          response.writeHead(307, { location: "/redirect-target" })
          response.end()
          return
        }
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end("<!doctype html><html><body><h1>POST accepted</h1></body></html>")
      })
      return
    }
    if (postOnly && ["/", "/redirect-form"].includes(request.url ?? "")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.setHeader("Set-Cookie", "shared=fixture-owned; HttpOnly; SameSite=Strict; Path=/")
      response.end(
        `<!doctype html><html><body><h1>Shared Main fixture</h1><form method="POST" action="${request.url === "/" ? "/submit" : "/redirect307"}"><input type="hidden" name="owned" value="post"><button type="submit">Submit</button></form></body></html>`,
      )
      return
    }
    if (request.url?.startsWith("/manual?")) {
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify({
          cookie: request.headers.cookie ?? "",
          nonce: new URL(request.url, "http://fixture").searchParams.get("nonce"),
        }),
      )
      return
    }
    if (request.url !== "/") {
      response.writeHead(404)
      response.end()
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.setHeader(
      "Set-Cookie",
      scriptOnly
        ? [
            "shared=fixture-owned; HttpOnly; SameSite=Strict; Path=/",
            "script-visible=original-cookie-secret; SameSite=Strict; Path=/",
          ]
        : "shared=fixture-owned; HttpOnly; SameSite=Strict; Path=/",
    )
    response.end(
      `<!doctype html><html><body><h1>Shared Main fixture</h1><form><label>Code note<input id="note" value="initial"></label>${scriptOnly ? '<label>Password<input type="password" value="original-password-secret"></label>' : ""}</form><output id="echo"></output><script>window.sharedNonce=${JSON.stringify(nonce)};${scriptOnly ? 'localStorage.setItem("original-private","original-storage-secret");' : ""}document.querySelector('#note').addEventListener('input',event=>document.querySelector('#echo').textContent=event.target.value)</script></body></html>`,
    )
  })
  const childServer = framesOnly || policyOnly
    ? createServer((request, response) => {
        childRequests.push({ path: request.url ?? "", method: request.method ?? "" })
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(
          `<!doctype html><html><body><h2>Owned child frame</h2><label>子框输入<input id="child-input" value="initial"></label><p><button type="button" onclick="document.querySelector('#child-status').textContent='child-click-ok'">Child Click</button></p><output id="child-status"></output></body></html>`,
        )
      })
    : undefined
  if (childServer)
    await new Promise<void>((resolve, reject) => {
      childServer.once("error", reject)
      childServer.listen(0, "::1", () => {
        childServer.off("error", reject)
        resolve()
      })
    })
  const childAddress = childServer?.address()
  const childOrigin = childAddress && typeof childAddress !== "string" ? `http://[::1]:${childAddress.port}` : undefined
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const sources = {
    valid:
      'let cookie,storage;try{cookie=document.cookie}catch{cookie="denied"}try{storage=localStorage.getItem("original-private")}catch{storage="denied"}return {node:typeof process+"/"+typeof require,cookie,storage,originalDom:typeof document!=="undefined"&&!!document.querySelector("#note"),opener:typeof window==="undefined"?null:window.opener,echo:args.value,public:page.text.includes("Shared Main fixture")};',
    accessor:
      'Object.prototype.value="forged";return Object.defineProperty({},"invalid",{enumerable:true,get(){return "must-not-run"}});',
    toJSON: "return {toJSON(){return {forged:true}}};",
    promise: "return Promise.resolve({forged:true});",
    cycle: "const value={};value.self=value;return value;",
    network:
      "return [typeof fetch,typeof WebSocket,typeof XMLHttpRequest,typeof RTCPeerConnection,typeof navigator,typeof importScripts];",
    memory: "const heap=[];while(true)heap.push(new Uint8Array(1024*1024));",
    loop: "while(true){}",
  }
  const manager = createSharedBrowserManager({})
  const programSource = "return {version:1,steps:args.steps};"
  const programArgs = [
    JSON.stringify({
      steps: [
        { type: "fill", target: "name", text: "program value" },
        { type: "select", target: "choice", values: ["b"] },
        { type: "fill", target: "name", text: "program value" },
        { type: "click", target: "submit", waitForNavigation: true },
      ],
    }),
    JSON.stringify({
      steps: [
        { type: "fill", target: "name", text: "must not execute" },
        { type: "select", target: "choice", values: ["missing"] },
      ],
    }),
    JSON.stringify({
      steps: [
        { type: "fill", target: "name", text: "program value" },
        { type: "fill", target: "tail", text: "must not execute" },
      ],
    }),
    JSON.stringify({
      steps: [
        { type: "fill", target: "name", text: "stop-after-first" },
        { type: "fill", target: "tail", text: "must not execute" },
      ],
    }),
  ]
  const approved = new Map<string, string>()
  let programObserver: (() => Promise<void>) | undefined
  const held = { actionID: "", entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  manager.attachHost("fixture-sidecar", async (action) => {
    if (approved.get(action.actionID) !== digest(action)) return false
    await programObserver?.()
    if (action.actionID === held.actionID) {
      held.entered.resolve()
      await held.release.promise
    }
    return approved.get(action.actionID) === digest(action)
  })
  const now = Date.now()
  const policy = Schema.decodeUnknownSync(SharedBrowserSchema.Policy)({
    origin,
    approvedOrigins: [origin],
    ...(framesOnly
      ? { approvedOrigins: [origin, childOrigin], manualApprovedOrigins: [origin, childOrigin] }
      : { manualApprovedOrigins: [origin] }),
    resolverPolicy: "system",
    postGrants: postOnly
      ? ["/submit", "/redirect307", "/redirect-target"].map((target) => ({
          method: "POST",
          url: origin + target,
          contentType: "application/x-www-form-urlencoded",
          bytes: Buffer.byteLength("owned=post"),
          bodySha256: createHash("sha256").update("owned=post").digest("hex"),
        }))
      : programOnly
        ? [
            {
              method: "POST",
              url: origin + "/program-submit",
              contentType: "application/x-www-form-urlencoded",
              bytes: Buffer.byteLength("name=program+value&choice=b"),
              bodySha256: createHash("sha256").update("name=program+value&choice=b").digest("hex"),
            },
          ]
        : [],
    ...(programOnly
      ? {
          scriptContext: "snapshot-json-v1",
          programGrants: programArgs.map((argsJSON) => ({
            scriptHash: createHash("sha256").update(programSource).digest("hex"),
            argsHash: createHash("sha256").update(argsJSON).digest("hex"),
            operations: ["fill", "select", "click"],
            maxSteps: 4,
          })),
        }
      : {}),
    ...(fileConfirmOnly || fileCancelOnly ? { filePolicy: { upload: true, download: true } } : {}),
    ...(scriptOnly
      ? {
          scriptContext: "snapshot-json-v1",
          scriptGrants: Object.values(sources).map((source) => ({
            scriptHash: createHash("sha256").update(source).digest("hex"),
            argsHash: createHash("sha256").update('{"value":"fixture"}').digest("hex"),
            readOnly: true,
          })),
        }
      : {}),
  })
  const resource = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
    version: 2,
    profile: SharedBrowserSchema.PROFILE,
    inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
    resourceID: "shared-fixture-resource",
    requestID: "shared-fixture-create",
    requestDigest: digest({ origin }),
    rootSessionID: "shared-fixture-session",
    mainIncarnation: manager.mainIncarnation,
    scope: {
      principal: "fixture-owner",
      securityNamespaceID: "fixture-namespace",
      locationKey: "fixture-location",
      projectScopeKey: "fixture-project-scope",
      namespaceBindingHash: digest(root),
      sessionID: "shared-fixture-session",
      projectID: "fixture-project",
      directory: root,
      workspaceID: null,
    },
    policy,
    policyHash: digest(policy),
    state: "creating",
    revision: 1,
    manualEpoch: 0,
    barrierOrder: 0,
    coreCutoff: -1,
    liveLeaseID: null,
    agentAccessFenced: true,
    resourceAlive: false,
    manualEnabled: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 120_000,
  })
  const lease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({
    version: 2,
    leaseID: "fixture-lease-1",
    controlID: "fixture-lease-1",
    resourceID: resource.resourceID,
    mainIncarnation: manager.mainIncarnation,
    sidecarIncarnation: "fixture-sidecar",
    scope: resource.scope,
    policyHash: resource.policyHash,
    leaseEpoch: 1,
    manualEpoch: 0,
    state: "active",
    originInputID: null,
    requestID: "fixture-lease-create",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
  })
  const makeAction = (command: BrowserSchema.Command, current = lease) =>
    Schema.decodeUnknownSync(SharedBrowserSchema.Action)({
      actionID: randomUUID(),
      resourceID: resource.resourceID,
      leaseID: current.leaseID,
      leaseEpoch: current.leaseEpoch,
      manualEpoch: current.manualEpoch,
      admissionID: randomUUID(),
      providerReceiptID: "fixture-only-provider-receipt",
      providerAttemptID: "fixture-only-provider-attempt",
      toolCallID: randomUUID(),
      rootSessionID: resource.rootSessionID,
      command,
      commandHash: digest(command),
      deadline: Date.now() + 8_000,
    })
  const execute = async (command: BrowserSchema.Command, current = lease) => {
    const action = makeAction(command, current)
    approved.set(action.actionID, digest(action))
    const output = await manager.execute(resource, current, action)
    return {
      result: Schema.decodeUnknownSync(BrowserSchema.Result)(output.result),
      png: "png" in output ? output.png : undefined,
    }
  }
  const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : undefined)
  try {
    await phase("create-real-partition-driver-and-proxy")
    const created = await manager.create(resource, lease)
    assert.equal(created.resourceAlive, true)
    assert.equal(created.agentAccessFenced, false)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    const window = BrowserWindow.getAllWindows()[0]!
    const contents = window.webContents
    contents.debugger.on("message", (_event, method) => {
      if (trace.length < 128 && (method === "DOM.documentUpdated" || method.startsWith("Page.frame")))
        trace.push({ event: method, phase: stage.value, at: Date.now() })
    })
    const partition = contents.session
    const identity = { windowID: window.id, contentsID: contents.id, partitionPath: partition.storagePath }
    assert.equal(contents.debugger.isAttached(), true)
    if (policyOnly) {
      assert.ok(childOrigin)
      await phase("policy-trusted-prepare-exact-commit-and-fresh-acquire")
      const ticket = manager.beginTakeover(manager.getView(resource.resourceID).resource,
        { resourceID: resource.resourceID, requestID: "policy-takeover", expectedRevision: resource.revision })
      await manager.confirmBarrier({ ...manager.getView(resource.resourceID).resource, coreCutoff: 4,
        revision: manager.getView(resource.resourceID).resource.revision + 1 }, ticket.ticket)
      const human = manager.getView(resource.resourceID).resource
      const command: SharedBrowserSchema.ApproveOrigin = { resourceID: human.resourceID, requestID: "manual-origin",
        expectedRevision: human.revision, expectedManualEpoch: human.manualEpoch,
        expectedPolicyHash: human.policyHash, origin: childOrigin }
      assert.throws(() => manager.claimPolicy(human, command))
      assert.throws(() => manager.prepareOrigin(human, command, "fixture-owner", () => false))
      await assert.rejects(contents.loadURL(childOrigin + "/before"))
      assert.equal(childRequests.length, 0)
      manager.prepareOrigin(human, command, "fixture-owner", () => true)
      assert.equal(manager.cancelOrigin(human.resourceID, command, "fixture-owner"), true)
      assert.throws(() => manager.claimPolicy(human, command))
      manager.prepareOrigin(human, command, "fixture-owner", () => true)
      manager.prepareOrigin(human, command, "fixture-owner", () => true)
      assert.throws(() => manager.prepareOrigin(human, { ...command, requestID: "conflict" }, "fixture-owner", () => true))
      const aborted = manager.claimPolicy(human, command)
      assert.equal(manager.cancelOrigin(human.resourceID, command, "fixture-owner"), false)
      assert.throws(() => manager.claimPolicy(human, command))
      assert.throws(() => manager.abortPolicy(human, command, "wrong-claim"))
      manager.abortPolicy(human, command, aborted)
      assert.equal(manager.cancelOrigin(human.resourceID, command, "fixture-owner"), true)
      manager.prepareOrigin(human, command, "fixture-owner", () => true)
      const claim = manager.claimPolicy(human, command)
      manager.checkPolicy(human, command, claim)
      await assert.rejects(contents.loadURL(childOrigin + "/prepared"))
      const beforeCommitRequests = childRequests.length
      assert.equal(beforeCommitRequests, 0)
      const nextPolicy = { ...human.policy, manualApprovedOrigins: [...human.policy.manualApprovedOrigins, childOrigin] }
      const committed: SharedBrowserSchema.Resource = { ...human, policy: nextPolicy, policyHash: digest(nextPolicy),
        policyRevision: (human.policyRevision ?? 1) + 1, revision: human.revision + 1,
        policyApprovals: [{ requestID: command.requestID, requestHash: digest(command), manualEpoch: human.manualEpoch,
          baseRevision: human.revision, revision: human.revision + 1, policyRevision: (human.policyRevision ?? 1) + 1,
          policyHash: digest(nextPolicy) }] }
      assert.throws(() => manager.syncProjection(committed))
      assert.throws(() => manager.commitPolicy({ ...committed, revision: committed.revision + 1 }, command))
      manager.commitPolicy(committed, command)
      manager.prepareOrigin(committed, command, "fixture-owner", () => true)
      manager.commitPolicy(committed, command)
      assert.equal(manager.getView(resource.resourceID).pendingOrigin, undefined)
      await contents.loadURL(childOrigin + "/approved")
      assert.equal(childRequests.length, 1)
      const manualOnlyBeforeAcquire = !manager.getView(resource.resourceID).resource.policy.approvedOrigins.includes(childOrigin)
      assert.equal(manualOnlyBeforeAcquire, true)
      const reserved = manager.stamp({ originalSubmissionID: "policy-new-input", inputID: "policy-new-input",
        rootSessionID: resource.rootSessionID, rawInputHash: digest("continue on approved site"), sourceKind: "gui_composer",
        sourceBindingHash: digest("fixture-owner") })
      const stamp = manager.seal(reserved, digest({ text: "continue on approved site" }))
      const witness: SharedBrowserSchema.UserWitness = { inputID: stamp.inputID, rootSessionID: stamp.rootSessionID,
        mainIncarnation: stamp.mainIncarnation, submissionOrder: stamp.submissionOrder, admittedSeq: 5, promotedSeq: 6,
        originHash: digest(stamp), providerReceiptID: "controlled-policy-receipt", selectionID: "controlled-policy-selection",
        projectionHash: digest("controlled-policy-projection") }
      const agentPolicy = { ...nextPolicy, approvedOrigins: nextPolicy.manualApprovedOrigins }
      const resumed: SharedBrowserSchema.Resource = { ...committed, policy: agentPolicy, policyHash: digest(agentPolicy),
        policyRevision: committed.policyRevision! + 1, revision: committed.revision + 1, state: "acquire_pending", manualEnabled: false }
      const nextLease: SharedBrowserSchema.Lease = { ...lease, leaseID: "policy-lease-2", controlID: "policy-lease-2",
        leaseEpoch: 2, manualEpoch: human.manualEpoch, policyHash: resumed.policyHash, originInputID: stamp.inputID }
      await assert.rejects(manager.acquire(resumed, nextLease, { ...witness, submissionOrder: ticket.ticket.barrierOrder }))
      assert.equal(manager.getView(resource.resourceID).resource.state, "human_owned")
      await manager.acquire(resumed, nextLease, witness)
      assert.equal(window.webContents, contents)
      assert.equal(contents.getURL(), childOrigin + "/approved")
      const commandAction = makeAction({ type: "tabs.list" }, nextLease)
      approved.set(commandAction.actionID, digest(commandAction))
      assert.equal((await manager.execute(resumed, nextLease, commandAction)).result.tabs.length, 1)
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, { resourceID: closing.resourceID, requestID: "policy-close", expectedRevision: closing.revision })
      assert.equal(closed.resourceAlive, false)
      assert.throws(() => manager.prepareOrigin(closing, command, "fixture-owner", () => true))
      const lostResource = { ...resource, resourceID: "policy-lost-ack", requestID: "policy-lost-create" }
      const lostLease = { ...lease, resourceID: lostResource.resourceID, leaseID: "policy-lost-lease", controlID: "policy-lost-lease" }
      await manager.create(lostResource, lostLease)
      const lostTicket = manager.beginTakeover(manager.getView(lostResource.resourceID).resource,
        { resourceID: lostResource.resourceID, requestID: "lost-takeover", expectedRevision: lostResource.revision })
      await manager.confirmBarrier({ ...manager.getView(lostResource.resourceID).resource, coreCutoff: 4,
        revision: manager.getView(lostResource.resourceID).resource.revision + 1 }, lostTicket.ticket)
      const lostHuman = manager.getView(lostResource.resourceID).resource
      const lostCommand: SharedBrowserSchema.ApproveOrigin = { resourceID: lostResource.resourceID,
        requestID: "lost-policy", expectedRevision: lostHuman.revision, expectedManualEpoch: lostHuman.manualEpoch,
        expectedPolicyHash: lostHuman.policyHash, origin: childOrigin }
      const owner = { current: true }
      manager.prepareOrigin(lostHuman, lostCommand, "lost-owner", () => owner.current)
      manager.claimPolicy(lostHuman, lostCommand)
      const lostCAS: SharedBrowserSchema.Resource = { ...lostHuman, policy: nextPolicy, policyHash: digest(nextPolicy),
        policyRevision: 2, revision: lostHuman.revision + 1, policyApprovals: [{ requestID: lostCommand.requestID,
          requestHash: digest(lostCommand), manualEpoch: lostHuman.manualEpoch, baseRevision: lostHuman.revision,
          revision: lostHuman.revision + 1, policyRevision: 2, policyHash: digest(nextPolicy) }] }
      owner.current = false
      assert.throws(() => manager.commitPolicy(lostCAS, lostCommand))
      assert.equal(manager.getView(lostResource.resourceID).resource.policyHash, lostHuman.policyHash)
      const lostClosed = await manager.close(lostCAS, { resourceID: lostResource.resourceID,
        requestID: "lost-policy-close", expectedRevision: lostCAS.revision })
      assert.equal(lostClosed.resourceAlive, false)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "policy-origins", beforeCommitRequests,
        afterCommitRequests: childRequests.length, samePage: true, manualOnlyBeforeAcquire, originalPolicyProjectionDenied: true,
        exactCancelNoCommit: true, claimedUnknownRetained: true, lostPolicyAckCloseOnly: !lostClosed.resourceAlive,
        staleInputDenied: true, closed, windows: BrowserWindow.getAllWindows().length, providerCalls: 0,
        productionWitnessAcceptance: false, nativeInputAcceptance: false }), { mode: 0o600 })
      return
    }
    if (programOnly) {
      const prepare = async (page: string, argsJSON: string) => {
        const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
        const navigated = (
          await execute({ type: "navigate", tabID: initial.tabID, generation: initial.generation, url: origin + page })
        ).result.tabs[0]!
        const observed = (await execute({ type: "snapshot", tabID: navigated.tabID, generation: navigated.generation }))
          .result
        assert.ok(observed.frameID && observed.observationRevision && observed.refs)
        return {
          type: "program" as const,
          tabID: navigated.tabID,
          generation: navigated.generation,
          frameID: observed.frameID,
          observationRevision: observed.observationRevision,
          source: programSource,
          scriptHash: createHash("sha256").update(programSource).digest("hex"),
          argsJSON,
          targets: ["Name", "Choice", "Submit", "Tail"].map((name) => ({
            name: name.toLowerCase(),
            ref: observed.refs!.find((value) => value.name === name)!.ref,
          })),
        }
      }
      await phase("shared-program-full-preflight-before-any-leaf")
      const preflight = await prepare("/program-preflight", programArgs[1]!)
      const preflightCode = await execute(preflight).then(() => "unexpected-success", code)
      const preflightValue = await contents.executeJavaScript("document.querySelector('input').value")
      assert.equal(preflightCode, "BROWSER_STALE_TARGET")
      assert.equal(preflightValue, "initial")
      await phase("shared-program-unrelated-state-cannot-advance-private-cursor")
      const drift = await prepare("/program-drift", programArgs[2]!)
      const driftCode = await execute(drift).then(() => "unexpected-success", code)
      const driftValues = await contents.executeJavaScript(
        "[document.querySelector('input').value,document.querySelector('#tail').value]",
      )
      assert.equal(driftCode, "BROWSER_UNKNOWN")
      assert.deepEqual(driftValues, ["program value", "unexpected"])
      await phase("shared-program-snapshot-json-exact-post-and-terminal-navigation")
      const command = await prepare("/program-success", programArgs[0]!)
      const output = (await execute(command)).result
      assert.ok(output.program && output.scriptContextEvidence)
      const samePartition = partition === contents.session
      await phase("shared-program-takeover-between-fixed-native-leaves")
      const interrupted = await prepare("/program-takeover", programArgs[3]!)
      let takeover: ReturnType<typeof manager.beginTakeover> | undefined
      programObserver = async () => {
        if ((await contents.executeJavaScript("document.querySelector('input')?.value")) !== "stop-after-first") return
        programObserver = undefined
        const original = manager.getView(resource.resourceID).resource
        takeover = manager.beginTakeover(original, {
          resourceID: resource.resourceID,
          requestID: "program-mid-step-takeover",
          expectedRevision: original.revision,
        })
      }
      const interruptedCode = await execute(interrupted).then(() => "unexpected-success", code)
      programObserver = undefined
      assert.equal(interruptedCode, "BROWSER_UNKNOWN")
      assert.ok(takeover)
      const manual = await manager.confirmBarrier(
        { ...manager.getView(resource.resourceID).resource, coreCutoff: 1, revision: resource.revision + 1 },
        takeover.ticket,
      )
      assert.equal(manual.manualEnabled, true)
      const interruptedValues = await contents.executeJavaScript(
        "[document.querySelector('input').value,document.querySelector('#tail').value]",
      )
      assert.deepEqual(interruptedValues, ["stop-after-first", "untouched"])
      const closeStates: string[] = []
      const stop = manager.subscribe((value) => closeStates.push(value.state))
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "program-close",
        expectedRevision: closing.revision,
      })
      stop()
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "shared-program",
            program: output.program,
            context: output.scriptContextEvidence.context,
            samePartition,
            preflightCode,
            preflightValue,
            driftCode,
            driftValues,
            interruptedCode,
            interruptedValues,
            closeStates,
            closed,
            submissions: requests.filter((value) => value.method === "POST"),
            providerCalls: 0,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    if (fileCancelOnly) {
      await phase("exact-negative-native-response-oracle-not-physical-button-acceptance")
      const owner = new BrowserWindow({
        show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      })
      await owner.loadURL("about:blank")
      const stopOwner = manager.registerFileConfirmationOwner(() => ({
        window: owner,
        current: () => !owner.isDestroyed(),
      }))
      const resourceNow = manager.getView(resource.resourceID).resource
      const binding = SharedBrowserFileBinding.from(resourceNow, lease)
      const preview = Schema.decodeUnknownSync(SharedBrowserFileSchema.Preview)({
        version: 2,
        direction: "upload",
        binding,
        bindingHash: digest(binding),
        instanceID: "fixture-instance",
        scopeHash: binding.scopeHash,
        helperHash: digest("response-oracle-not-custody"),
        rootIdentity: { kind: "posix", device: "1", inode: "1" },
        relative: "owned.txt",
        name: "owned.txt",
        observedAt: now,
        targetURL: origin + "/upload",
        fileIdentity: { kind: "posix", device: "1", inode: "2" },
        bytes: 5,
        sha256: digest("owned"),
      })
      const command = (requestID: string): SharedBrowserFileSchema.Approve => ({
        requestID,
        previewID: "fixture-preview",
        expectedResourceRevision: resourceNow.revision,
        expectedLeaseID: lease.leaseID,
        expectedLeaseEpoch: lease.leaseEpoch,
        expectedManualEpoch: lease.manualEpoch,
        expiresAt: now + 30_000,
      })
      const original = dialog.showMessageBox
      const response = { calls: 0, value: 0, hideOwner: false, reject: false }
      dialog.showMessageBox = (async () => {
        response.calls++
        if (response.hideOwner) owner.hide()
        if (response.reject) throw new Error("fixture transport response lost")
        return { response: response.value, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      try {
        const intent = command("cancel-exact")
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const check = async () => {
          entered.resolve()
          await release.promise
        }
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, intent), undefined)
        const pending = manager.confirmFile(resourceNow, lease, preview, intent, check)
        assert.equal(pending, manager.confirmFile(resourceNow, lease, preview, intent, check))
        await entered.promise
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, intent), undefined)
        release.resolve()
        const cancelled = Schema.decodeUnknownSync(SharedBrowserFileSchema.Cancellation)(await pending)
        assert.equal(cancelled.requestID, intent.requestID)
        assert.equal(cancelled.resourceID, resource.resourceID)
        assert.equal(cancelled.bindingHash, digest(binding))
        assert.equal(cancelled.previewHash, digest(preview))
        assert.equal(cancelled.commandHash, digest(intent))
        assert.ok(cancelled.cancelledAt >= now && cancelled.cancelledAt < intent.expiresAt)
        assert.deepEqual(manager.fileCancellation(resourceNow, lease, preview, intent), cancelled)
        assert.deepEqual(await manager.confirmFile(resourceNow, lease, preview, intent, async () => {}), cancelled)
        assert.equal(response.calls, 1)
        assert.throws(
          () => manager.fileCancellation(resourceNow, lease, { ...preview, bytes: 6 }, intent),
          (error: unknown) => code(error) === "BROWSER_CONFLICT",
        )
        assert.throws(
          () => manager.fileCancellation(resourceNow, { ...lease, expiresAt: lease.expiresAt - 1 }, preview, intent),
          (error: unknown) => code(error) === "BROWSER_CONFLICT",
        )
        assert.throws(
          () => manager.fileCancellation({ ...resourceNow, rootSessionID: "different" }, lease, preview, intent),
          (error: unknown) => code(error) === "BROWSER_AUTHORITY_REQUIRED",
        )
        response.value = 1
        const positive = command("positive-unchanged")
        assert.equal(
          "confirmationHash" in (await manager.confirmFile(resourceNow, lease, preview, positive, async () => {})),
          true,
        )
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, positive), undefined)
        response.value = 0
        response.hideOwner = true
        const hidden = command("owner-lost-is-not-cancel")
        assert.equal(
          await manager.confirmFile(resourceNow, lease, preview, hidden, async () => {}).then(() => "unexpected", code),
          "BROWSER_AUTHORITY_REQUIRED",
        )
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, hidden), undefined)
        owner.show()
        response.hideOwner = false
        response.reject = true
        const lost = command("lost-response-is-not-cancel")
        assert.equal(
          await manager
            .confirmFile(resourceNow, lease, preview, lost, async () => {})
            .then(
              () => "unexpected",
              () => "unknown",
            ),
          "unknown",
        )
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, lost), undefined)
        response.reject = false
        const aborted = command("takeover-is-not-cancel")
        const held = Promise.withResolvers<void>()
        const waiting = Promise.withResolvers<void>()
        const task = manager
          .confirmFile(resourceNow, lease, preview, aborted, async () => {
            waiting.resolve()
            await held.promise
          })
          .then(() => "unexpected", code)
        await waiting.promise
        window.on("show", () => window.hide())
        const takeover = manager.beginTakeover(resourceNow, {
          resourceID: resource.resourceID,
          requestID: "cancel-fixture-takeover",
          expectedRevision: resourceNow.revision,
        })
        held.resolve()
        assert.equal(await task, "BROWSER_CANCELLED")
        assert.equal(manager.fileCancellation(resourceNow, lease, preview, aborted), undefined)
        await manager.confirmBarrier(
          { ...manager.getView(resource.resourceID).resource, coreCutoff: 0, revision: 2 },
          takeover.ticket,
        )
        assert.deepEqual(manager.fileCancellation(resourceNow, lease, preview, intent), cancelled)
        assert.equal(response.calls, 4)
        const closing = manager.getView(resource.resourceID).resource
        const closed = await manager.close(closing, {
          resourceID: resource.resourceID,
          requestID: "cancel-fixture-close",
          expectedRevision: closing.revision,
        })
        assert.deepEqual(manager.fileCancellation(resourceNow, lease, preview, intent), cancelled)
        await writeFile(
          path.join(root, "result.json"),
          JSON.stringify(
            {
              mode: "file-cancel-decision",
              cancelled,
              exactSingleDialog: true,
              pendingUnknown: true,
              missingUnknown: true,
              positiveUnchanged: true,
              ownerLossUnknown: true,
              responseLossUnknown: true,
              abortUnknown: true,
              retiredLeaseNegativeReadable: true,
              nativeResponseOracle: true,
              physicalCancelAcceptance: false,
              helperCustodyAcceptance: false,
              grantsIssued: 0,
              transfers: 0,
              providerCalls: 0,
              closed,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        )
      } finally {
        dialog.showMessageBox = original
        stopOwner()
        owner.destroy()
      }
      return
    }
    if (fileConfirmOnly) {
      const owner = new BrowserWindow({
        show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      })
      await owner.loadURL("about:blank")
      const stopOwner = manager.registerFileConfirmationOwner(() => ({
        window: owner,
        current: () => !owner.isDestroyed(),
      }))
      const resourceNow = manager.getView(resource.resourceID).resource
      assert.equal(manager.fileReady(resourceNow, lease), true)
      assert.throws(
        () => manager.fileReady({ ...resourceNow, revision: resourceNow.revision + 1 }, lease),
        (error: unknown) => code(error) === "BROWSER_CANCELLED",
      )
      assert.throws(
        () => manager.fileCurrent({ ...resourceNow, revision: resourceNow.revision + 1 }, lease),
        (error: unknown) => code(error) === "BROWSER_CANCELLED",
      )
      const binding = SharedBrowserFileBinding.from(resourceNow, lease)
      const preview = Schema.decodeUnknownSync(SharedBrowserFileSchema.Preview)({
        version: 2,
        direction: "upload",
        binding,
        bindingHash: digest(binding),
        instanceID: "fixture-instance",
        scopeHash: binding.scopeHash,
        helperHash: digest("not-a-native-custody-proof"),
        rootIdentity: { kind: "posix", device: "1", inode: "1" },
        relative: "owned.txt",
        name: "owned.txt",
        observedAt: now,
        targetURL: origin + "/upload",
        fileIdentity: { kind: "posix", device: "1", inode: "2" },
        bytes: 5,
        sha256: digest("owned"),
      })
      const command: SharedBrowserFileSchema.Approve = {
        requestID: "fixture-confirm",
        previewID: "fixture-preview",
        expectedResourceRevision: resourceNow.revision,
        expectedLeaseID: lease.leaseID,
        expectedLeaseEpoch: lease.leaseEpoch,
        expectedManualEpoch: lease.manualEpoch,
        expiresAt: now + 30_000,
      }
      assert.throws(
        () =>
          manager.confirmFile(resourceNow, lease, { ...preview, bindingHash: digest("wrong") }, command, async () => {
            throw new Error("Must not ask Core on identity mismatch")
          }),
        (error: unknown) => code(error) === "BROWSER_SCOPE_DENIED",
      )
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const check = async () => {
        entered.resolve()
        await release.promise
      }
      const pending = manager.confirmFile(resourceNow, lease, preview, command, check)
      const exactRetrySamePromise = pending === manager.confirmFile(resourceNow, lease, preview, command, check)
      assert.equal(exactRetrySamePromise, true)
      const outcome = pending.then(() => "unexpected-success", code)
      await entered.promise
      assert.throws(
        () => manager.confirmFile(resourceNow, lease, { ...preview, bytes: 6 }, command, check),
        (error: unknown) => code(error) === "BROWSER_CONFLICT",
      )
      assert.equal(await execute({ type: "tabs.list" }).then(() => "unexpected-success", code), "BROWSER_CONFLICT")
      window.on("show", () => window.hide())
      const takeover = manager.beginTakeover(resourceNow, {
        resourceID: resource.resourceID,
        requestID: "confirm-takeover",
        expectedRevision: resourceNow.revision,
      })
      const confirming = manager.confirmBarrier(
        { ...manager.getView(resource.resourceID).resource, coreCutoff: 0, revision: 2 },
        takeover.ticket,
      )
      assert.equal(manager.status(resource.resourceID).manualEnabled, false)
      release.resolve()
      assert.equal(await outcome, "BROWSER_CANCELLED")
      assert.equal((await confirming).manualEnabled, true)
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "confirm-close",
        expectedRevision: closing.revision,
      })
      stopOwner()
      owner.destroy()
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "file-confirm-current",
            exactRetrySamePromise,
            identityDriftDenied: true,
            concurrentActionDenied: true,
            latePermitRejected: true,
            manualOnlyAfterConfirmationSettled: true,
            nativePositiveApprovalAcceptance: false,
            fixtureIdentitiesAreNotNativeProof: true,
            closed,
            providerCalls: 0,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    if (scriptOnly) {
      await phase("shared-snapshot-json-exact-grants-and-independent-worker")
      assert.equal(manager.fileCurrent(manager.getView(resource.resourceID).resource, lease), true)
      const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
      const navigated = (
        await execute({ type: "navigate", tabID: initial.tabID, generation: initial.generation, url: origin + "/" })
      ).result.tabs[0]!
      const fresh = async (current = lease) => {
        const snapshot = (
          await execute({ type: "snapshot", tabID: navigated.tabID, generation: navigated.generation }, current)
        ).result
        assert.ok(snapshot.frameID && snapshot.observationRevision && snapshot.refs && snapshot.text)
        return {
          snapshot,
          target: {
            tabID: navigated.tabID,
            generation: navigated.generation,
            frameID: snapshot.frameID,
            observationRevision: snapshot.observationRevision,
          },
        }
      }
      const observed = await fresh()
      const argsJSON = '{"value":"fixture"}'
      const command: Extract<BrowserSchema.Command, { type: "evaluate" }> = {
        ...observed.target,
        type: "evaluate",
        source: sources.valid,
        scriptHash: createHash("sha256").update(sources.valid).digest("hex"),
        argsJSON,
      }
      await assert.rejects(
        execute({ ...command, source: "return document.cookie" }),
        (error: unknown) => code(error) === "BROWSER_SCOPE_DENIED",
      )
      await assert.rejects(
        execute({ ...command, argsJSON: "{}" }),
        (error: unknown) => code(error) === "BROWSER_SCOPE_DENIED",
      )
      assert.equal(BrowserWindow.getAllWindows().length, 1)
      const output = (await execute(command)).result
      assert.ok(output.scriptResultJSON && output.scriptContextEvidence)
      const result = JSON.parse(output.scriptResultJSON) as {
        node: string
        cookie: string
        storage: string | null
        originalDom: boolean
        opener: null
        echo: string
        public: boolean
      }
      assert.equal(result.node, "undefined/undefined")
      assert.ok(result.cookie === "" || result.cookie === "denied")
      assert.ok(result.storage === null || result.storage === "denied")
      assert.equal(result.originalDom, false)
      assert.equal(result.opener, null)
      assert.equal(result.echo, "fixture")
      assert.equal(result.public, true)
      const page = {
        text: observed.snapshot.text,
        truncated: observed.snapshot.truncated,
        refs: observed.snapshot.refs,
        frameID: observed.snapshot.frameID,
        observationRevision: observed.snapshot.observationRevision,
        generation: navigated.generation,
      }
      assert.equal(output.scriptContextEvidence.sha256, digest({ argsJSON, page }))
      assert.equal(output.scriptContextEvidence.bytes, Buffer.byteLength(CanonicalJson.stringify({ argsJSON, page })))
      assert.equal(observed.snapshot.text?.includes("original-password-secret"), false)
      const rejectedNonJson = []
      for (const source of [sources.accessor, sources.toJSON, sources.promise, sources.cycle]) {
        const target = await fresh()
        const rejected = await execute({
          ...target.target,
          type: "evaluate",
          source,
          scriptHash: createHash("sha256").update(source).digest("hex"),
          argsJSON,
        }).then(() => "unexpected-success", code)
        assert.equal(rejected, "BROWSER_INVALID_RECORD")
        rejectedNonJson.push(rejected)
      }
      const network = await fresh()
      const networkResult = (
        await execute({
          ...network.target,
          type: "evaluate",
          source: sources.network,
          scriptHash: createHash("sha256").update(sources.network).digest("hex"),
          argsJSON,
        })
      ).result
      const networkGlobals = JSON.parse(networkResult.scriptResultJSON!)
      assert.deepEqual(networkGlobals, Array(6).fill("undefined"))
      const memory = await fresh()
      const memoryCode = await execute({
        ...memory.target,
        type: "evaluate",
        source: sources.memory,
        scriptHash: createHash("sha256").update(sources.memory).digest("hex"),
        argsJSON,
      }).then(() => "unexpected-success", code)
      assert.equal(memoryCode, "BROWSER_INVALID_RECORD")
      const deadlineTarget = await fresh()
      const deadlineCode = await execute({
        ...deadlineTarget.target,
        type: "evaluate",
        source: sources.loop,
        scriptHash: createHash("sha256").update(sources.loop).digest("hex"),
        argsJSON,
      }).then(() => "unexpected-success", code)
      assert.equal(deadlineCode, "BROWSER_CANCELLED")
      assert.equal(requests.filter((value) => value.path.startsWith("/sandbox-")).length, 0)
      await phase("takeover-cancels-actual-sandbox-evaluation-not-the-original-page")
      const loop = await fresh()
      const pending = execute({
        ...loop.target,
        type: "evaluate",
        source: sources.loop,
        scriptHash: createHash("sha256").update(sources.loop).digest("hex"),
        argsJSON,
      }).then(() => "unexpected-success", code)
      const waitingUntil = Date.now() + 1500
      while (
        !sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID)?.started &&
        Date.now() < waitingUntil
      )
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID)?.started, true)
      window.on("show", () => window.hide())
      const takeover = manager.beginTakeover(manager.getView(resource.resourceID).resource, {
        resourceID: resource.resourceID,
        requestID: "script-takeover",
        expectedRevision: 1,
      })
      const barrier = { ...manager.getView(resource.resourceID).resource, coreCutoff: 0, revision: 2 }
      assert.equal((await manager.confirmBarrier(barrier, takeover.ticket)).manualEnabled, true)
      assert.equal(sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID), undefined)
      const cancelledCode = await pending
      assert.equal(cancelledCode, "BROWSER_CANCELLED")
      assert.throws(
        () => manager.fileCurrent(manager.getView(resource.resourceID).resource, lease),
        (error: unknown) => code(error) === "BROWSER_CANCELLED",
      )
      assert.equal(contents.debugger.isAttached(), false)
      assert.equal(window.id, identity.windowID)
      assert.equal(contents.id, identity.contentsID)
      const original = await contents.executeJavaScript(`({nonce:window.sharedNonce,cookie:document.cookie,
        storage:localStorage.getItem("original-private"),password:document.querySelector('input[type=password]').value})`)
      assert.equal(original.nonce, nonce)
      assert.ok(original.cookie.includes("original-cookie-secret"))
      assert.equal(original.storage, "original-storage-secret")
      assert.equal(original.password, "original-password-secret")
      const sandboxWindowsAfter = BrowserWindow.getAllWindows().filter((candidate) => candidate !== window).length
      assert.equal(sandboxWindowsAfter, 0)
      const stamp = manager.seal(
        manager.stamp({
          originalSubmissionID: "script-resume-submission",
          inputID: "script-resume-input",
          rootSessionID: resource.rootSessionID,
          rawInputHash: digest("resume pure computation"),
          sourceKind: "gui_composer",
          sourceBindingHash: digest("script-fixture-source"),
        }),
        digest("script-fixture-prompt"),
      )
      const witness = Schema.decodeUnknownSync(SharedBrowserSchema.UserWitness)({
        inputID: stamp.inputID,
        rootSessionID: stamp.rootSessionID,
        mainIncarnation: stamp.mainIncarnation,
        submissionOrder: stamp.submissionOrder,
        admittedSeq: 5,
        promotedSeq: 6,
        originHash: digest(stamp),
        providerReceiptID: "script-fixture-receipt",
        selectionID: "script-fixture-selection",
        projectionHash: digest("script-fixture-projection"),
      })
      const nextLease = {
        ...lease,
        leaseID: "script-lease-2",
        controlID: "script-lease-2",
        leaseEpoch: 2,
        manualEpoch: takeover.ticket.manualEpoch,
        originInputID: witness.inputID,
      }
      const resumed = {
        ...manager.getView(resource.resourceID).resource,
        state: "agent_owned" as const,
        agentAccessFenced: false,
        manualEnabled: false,
        liveLeaseID: nextLease.leaseID,
        revision: 3,
      }
      assert.equal((await manager.acquire(resumed, nextLease, witness)).leaseID, nextLease.leaseID)
      const closeTarget = await fresh(nextLease)
      const closePending = execute(
        {
          ...closeTarget.target,
          type: "evaluate",
          source: sources.loop,
          scriptHash: createHash("sha256").update(sources.loop).digest("hex"),
          argsJSON,
        },
        nextLease,
      ).then(() => "unexpected-success", code)
      const closeWaitingUntil = Date.now() + 1500
      while (
        !sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID)?.started &&
        Date.now() < closeWaitingUntil
      )
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID)?.started, true)
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "script-close",
        expectedRevision: closing.revision,
      })
      assert.equal(sharedBrowserComputationState(manager.mainIncarnation + "/" + resource.resourceID), undefined)
      assert.equal(await closePending, "BROWSER_CANCELLED")
      assert.equal(manager.physicalCount(), 0)
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "snapshot-json",
            electron: process.versions.electron,
            exactSourceDenied: true,
            exactArgsDenied: true,
            snapshotProtected: true,
            result,
            rejectedNonJson,
            blockedNetworkRequests: requests.filter((value) => value.path.startsWith("/sandbox-")).length,
            evidence: output.scriptContextEvidence,
            commandGeneration: navigated.generation,
            cancelledCode,
            samePageAfterTakeover: true,
            originalSecretsPreserved: true,
            sandboxWindowsAfter,
            closed,
            networkGlobals,
            memoryRejected: memoryCode === "BROWSER_INVALID_RECORD",
            deadlineCode,
            workerExitedBeforeTakeoverCompleted: true,
            workerExitedBeforeCloseCompleted: true,
            providerCalls: 0,
            productionPermissionAdmissionAcceptance: false,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    if (downloadsOnly) {
      await phase("manual-original-download-item-and-acquire-boundary")
      const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
      await execute({ type: "navigate", tabID: initial.tabID, generation: initial.generation, url: origin + "/" })
      // Keep this noninteractive fixture from interrupting another owned DAC UI.
      // It deliberately does not qualify physical takeover or the native dialog.
      window.on("show", () => window.hide())
      const takeover = manager.beginTakeover(manager.getView(resource.resourceID).resource, {
        resourceID: resource.resourceID,
        requestID: "download-takeover",
        expectedRevision: 1,
      })
      const barrier = { ...manager.getView(resource.resourceID).resource, coreCutoff: 4, revision: 2 }
      assert.equal((await manager.confirmBarrier(barrier, takeover.ticket)).manualEnabled, true)
      const records: Array<{ item: DownloadItem; done: Promise<string>; presetPath: boolean; paused: boolean }> = []
      const download = async (id: string) => {
        const started = Promise.withResolvers<{ accepted: boolean; item: DownloadItem; done: Promise<string> }>()
        partition.once("will-download", (event, item) => {
          if (event.defaultPrevented) {
            started.resolve({ accepted: false, item, done: Promise.resolve("denied") })
            return
          }
          const presetPath = item.getSavePath() !== ""
          const paused = item.isPaused()
          const done = Promise.withResolvers<string>()
          item.once("done", (_event, state) => done.resolve(state))
          // Fixture-only destination suppresses the OS dialog. Production has
          // already handled this exact item without choosing or reading a path.
          item.setSavePath(path.join(root, "owned-download-" + id + ".bin"))
          records.push({ item, done: done.promise, presetPath, paused })
          started.resolve({ accepted: true, item, done: done.promise })
        })
        contents.downloadURL(origin + "/manual-download?" + id)
        return started.promise
      }
      const first = await download("first")
      assert.equal(first.accepted, true)
      const stamp = manager.seal(
        manager.stamp({
          originalSubmissionID: "download-resume-submission",
          inputID: "download-resume-input",
          rootSessionID: resource.rootSessionID,
          rawInputHash: digest("resume after download"),
          sourceKind: "gui_composer",
          sourceBindingHash: digest("download-fixture-source"),
        }),
        digest("download-fixture-prompt"),
      )
      const witness = Schema.decodeUnknownSync(SharedBrowserSchema.UserWitness)({
        inputID: stamp.inputID,
        rootSessionID: stamp.rootSessionID,
        mainIncarnation: stamp.mainIncarnation,
        submissionOrder: stamp.submissionOrder,
        admittedSeq: 5,
        promotedSeq: 6,
        originHash: digest(stamp),
        providerReceiptID: "download-fixture-receipt",
        selectionID: "download-fixture-selection",
        projectionHash: digest("download-fixture-projection"),
      })
      const nextLease = {
        ...lease,
        leaseID: "download-lease-2",
        controlID: "download-lease-2",
        leaseEpoch: 2,
        manualEpoch: takeover.ticket.manualEpoch,
        originInputID: witness.inputID,
      }
      const resumed = {
        ...manager.getView(resource.resourceID).resource,
        state: "agent_owned" as const,
        agentAccessFenced: false,
        manualEnabled: false,
        liveLeaseID: nextLease.leaseID,
        revision: 3,
      }
      const busyCode = await manager.acquire(resumed, nextLease, witness).then(() => "unexpected-success", code)
      assert.equal(busyCode, "BROWSER_CONFLICT")
      assert.equal(manager.getView(resource.resourceID).resource.state, "human_owned")
      assert.equal(manager.status(resource.resourceID).leaseRevoked, true)
      first.item.cancel()
      const userCancelledState = await first.done
      assert.equal(userCancelledState, "cancelled")
      assert.equal((await manager.acquire(resumed, nextLease, witness)).leaseID, nextLease.leaseID)
      const denied = await download("agent-denied")
      assert.equal(denied.accepted, false)
      const secondTakeover = manager.beginTakeover(manager.getView(resource.resourceID).resource, {
        resourceID: resource.resourceID,
        requestID: "download-second-takeover",
        expectedRevision: 3,
      })
      const secondBarrier = { ...manager.getView(resource.resourceID).resource, coreCutoff: 5, revision: 4 }
      assert.equal((await manager.confirmBarrier(secondBarrier, secondTakeover.ticket)).manualEnabled, true)
      const last = await download("resource-close")
      assert.equal(last.accepted, true)
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "download-close",
        expectedRevision: closing.revision,
      })
      const closeCancelledOriginalState = await last.done
      assert.equal(closeCancelledOriginalState, "cancelled")
      assert.equal(
        records.every((value) => !value.presetPath && !value.paused),
        true,
      )
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "manual-downloads",
            electron: process.versions.electron,
            acceptedOriginalItems: records.length,
            productionPresetPaths: records.filter((value) => value.presetPath).length,
            productionPausedItems: records.filter((value) => value.paused).length,
            busyCode,
            busyPreservedManual: true,
            userCancelledState,
            resumedAfterOriginalDone: true,
            agentDownloadDenied: !denied.accepted,
            closeCancelledOriginalState,
            downloadRequests: requests.filter((value) => value.path.startsWith("/manual-download")).length,
            closed,
            nativeSaveDialogAcceptance: false,
            productionUserWitnessAcceptance: false,
            destinationMethod:
              "fixture-only synchronous setSavePath on the original item; production leaves stock Save unchanged",
            providerCalls: 0,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    if (framesOnly) {
      await phase("frames-record-actual-child-sessions-and-renderer-processes")
      const send = contents.debugger.sendCommand.bind(contents.debugger)
      contents.debugger.sendCommand = async (...args: Parameters<typeof send>) => {
        if (frameEvidence.commands.length === 256) frameEvidence.commands.shift()
        frameEvidence.commands.push({
          method: args[0],
          sessionID: args[2] ?? null,
          frameID: typeof args[1]?.frameId === "string" ? args[1].frameId : null,
        })
        const result = await send(...args)
        if (args[0] === "Page.getFrameTree" && frameEvidence.trees.length < 8)
          frameEvidence.trees.push({ sessionID: args[2] ?? null, frameTree: result.frameTree })
        return result
      }
      contents.debugger.on("message", (_event, method, params, parentSessionID) => {
        if (
          method === "Target.attachedToTarget" &&
          params.targetInfo?.type === "iframe" &&
          frameEvidence.targets.length < 16
        )
          frameEvidence.targets.push({
            sessionID: params.sessionId,
            targetID: params.targetInfo.targetId,
            type: params.targetInfo.type,
            targetInfo: params.targetInfo,
            parentSessionID: parentSessionID ?? null,
          })
      })
      const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
      const navigated = await execute({
        type: "navigate",
        tabID: initial.tabID,
        generation: initial.generation,
        url: origin + "/",
      })
      const tab = navigated.result.tabs[0]!
      frameEvidence.processes = contents.mainFrame.framesInSubtree.map((value) => ({
        url: value.url,
        processID: value.processId,
        osProcessID: value.osProcessId,
        parentProcessID: value.parent?.processId ?? null,
        frameToken: value.frameToken,
        parentFrameToken: value.parent?.frameToken ?? null,
      }))
      const listed = await execute({ type: "frames.list", tabID: tab.tabID, generation: tab.generation })
      frameEvidence.frames = [...(listed.result.frames ?? [])]
      await writeFile(path.join(root, "frames-evidence.json"), JSON.stringify(frameEvidence, null, 2), { mode: 0o600 })
      const child = frameEvidence.frames.find((value) => value.url === childOrigin + "/frame")
      const childProcess = frameEvidence.processes.find((value) => value.url === childOrigin + "/frame")
      if (
        !child ||
        !childProcess ||
        childProcess.parentProcessID === null ||
        childProcess.processID === childProcess.parentProcessID
      ) {
        const sessionID = frameEvidence.targets[0]?.sessionID
        if (sessionID)
          await contents.debugger
            .sendCommand("Page.getFrameTree", {}, sessionID)
            .catch((error: unknown) => frameEvidence.diagnosticErrors.push(String(error)))
        await writeFile(path.join(root, "frames-evidence.json"), JSON.stringify(frameEvidence, null, 2), {
          mode: 0o600,
        })
      }
      assert.ok(child && childProcess && childProcess.parentProcessID !== null)
      assert.notEqual(childProcess.processID, childProcess.parentProcessID)
      assert.ok(frameEvidence.targets.some((value) => value.targetID === child.frameID && value.sessionID.length > 0))
      await phase("frames-actual-child-snapshot-and-unicode-fill")
      const snapshot = await execute({
        type: "snapshot",
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: child.frameID,
      })
      const input = snapshot.result.refs?.find((value) => value.name === "子框输入")
      assert.ok(input && snapshot.result.observationRevision)
      const target = {
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: child.frameID,
        observationRevision: snapshot.result.observationRevision,
        ref: input.ref,
      }
      const unicode = "中文输入🙂 — DAC"
      await execute({ type: "fill", ...target, text: unicode })
      const filled = await execute({
        type: "snapshot",
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: child.frameID,
      })
      assert.ok(filled.result.text?.includes(unicode))
      await phase("frames-actual-offset-child-and-root-coordinate-click")
      const button = filled.result.refs?.find((value) => value.name === "Child Click")
      assert.ok(button && filled.result.observationRevision)
      await execute({
        type: "click",
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: child.frameID,
        observationRevision: filled.result.observationRevision,
        ref: button.ref,
      })
      const clicked = await execute({
        type: "snapshot",
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: child.frameID,
      })
      assert.ok(clicked.result.text?.includes("child-click-ok"))
      const rootSnapshot = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
      const rootButton = rootSnapshot.result.refs?.find((value) => value.name === "Root Click")
      assert.ok(rootButton && rootSnapshot.result.frameID && rootSnapshot.result.observationRevision)
      await execute({
        type: "click",
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: rootSnapshot.result.frameID,
        observationRevision: rootSnapshot.result.observationRevision,
        ref: rootButton.ref,
      })
      const rootClicked = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
      assert.ok(rootClicked.result.text?.includes("root-click-ok"))
      await phase("frames-takeover-rejects-old-child-reference")
      const before = manager.getView(resource.resourceID).resource
      const takeover = manager.beginTakeover(before, {
        resourceID: resource.resourceID,
        requestID: "fixture-frames-takeover",
        expectedRevision: before.revision,
      })
      const barrier = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
        ...manager.getView(resource.resourceID).resource,
        manualEpoch: takeover.ticket.manualEpoch,
        barrierOrder: takeover.ticket.barrierOrder,
        coreCutoff: 0,
        revision: before.revision + 1,
      })
      const manual = await manager.confirmBarrier(barrier, takeover.ticket)
      assert.equal(manual.manualEnabled, true)
      await assert.rejects(
        execute({ type: "fill", ...target, text: "forbidden-old-ref" }),
        (error: unknown) => code(error) === "BROWSER_CANCELLED",
      )
      assert.equal(contents.debugger.isAttached(), false)
      contents.debugger.sendCommand = send
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "fixture-frames-close",
        expectedRevision: closing.revision,
      })
      assert.equal(closed.resourceAlive, false)
      assert.equal(closed.transportStopped, true)
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "frames-unicode",
            electron: process.versions.electron,
            node: process.versions.node,
            unicode,
            filledText: filled.result.text,
            childClickedText: clicked.result.text,
            rootClickedText: rootClicked.result.text,
            frameEvidence,
            manual,
            closed,
            requests,
            childRequests,
            trace,
            oopif: childProcess.processID !== childProcess.parentProcessID,
            oldChildRefRejected: true,
            sitePerProcessFixture: true,
            physicalIMEAcceptance: false,
            threeOSAcceptance: false,
            productionWitnessAcceptance: false,
            providerCalls: 0,
            windows: BrowserWindow.getAllWindows().length,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    if (capacityOnly) {
      await phase("mixed-physical-window-registry-capacity")
      const counts = [{ phase: "initial-shared", count: manager.physicalCount() }]
      const elapsedStart = manager.getView(resource.resourceID).elapsedMs
      const legacy = Array.from(
        { length: 3 },
        () =>
          new BrowserWindow({
            show: false,
            focusable: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
          }),
      )
      const unconfirmed = new Set(legacy.map((value) => value.id))
      const destroyed = legacy.map((value) => {
        const id = value.id
        return new Promise<void>((resolve) =>
          value.once("closed", () => {
            unconfirmed.delete(id)
            resolve()
          }),
        )
      })
      const host = { alive: true }
      manager.registerLegacyHost("fixture-legacy-host", { count: () => unconfirmed.size, alive: () => host.alive })
      counts.push({ phase: "three-legacy-plus-shared", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), BrowserSchema.MAX_ACTIVE_CONTROLS)
      const second = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
        ...resource,
        resourceID: "fixture-second-shared",
        requestID: "fixture-second-shared-create",
        requestDigest: digest({ second: true, origin }),
      })
      const secondLease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({
        ...lease,
        leaseID: "fixture-second-lease",
        controlID: "fixture-second-lease",
        resourceID: second.resourceID,
        requestID: "fixture-second-lease-create",
      })
      await assert.rejects(manager.create(second, secondLease), (error: unknown) => code(error) === "BROWSER_CAPACITY")
      host.alive = false
      manager.hostLost("fixture-legacy-host")
      counts.push({ phase: "legacy-host-lost-unconfirmed", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), BrowserSchema.MAX_ACTIVE_CONTROLS)
      await assert.rejects(manager.create(second, secondLease), (error: unknown) => code(error) === "BROWSER_CAPACITY")

      await phase("actual-cdp-held-key-release-fault-retains-debugger")
      const heldContents = contents
      const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
      const navigated = await execute({
        type: "navigate",
        tabID: initial.tabID,
        generation: initial.generation,
        url: origin + "/",
      })
      const heldTab = navigated.result.tabs[0]!
      const observed = (await execute({ type: "snapshot", tabID: heldTab.tabID, generation: heldTab.generation }))
        .result
      const input = observed.refs?.find((value) => value.name === "Code note")
      assert.ok(input && observed.observationRevision)
      const send = heldContents.debugger.sendCommand.bind(heldContents.debugger)
      const keyEvents = { failedKeyUps: 0, keyDownAcks: 0, keyUpAcks: 0, remainingFaults: 2 }
      heldContents.debugger.sendCommand = async (...args: Parameters<typeof send>) => {
        const key = args[0] === "Input.dispatchKeyEvent" ? args[1]?.type : undefined
        if (key === "keyUp" && keyEvents.remainingFaults > 0) {
          keyEvents.remainingFaults--
          keyEvents.failedKeyUps++
          throw new Error("fixture-owned-key-up-ack-fault")
        }
        const result = await send(...args)
        if (key === "keyDown") keyEvents.keyDownAcks++
        if (key === "keyUp") keyEvents.keyUpAcks++
        return result
      }
      await assert.rejects(
        execute({
          type: "press",
          tabID: heldTab.tabID,
          generation: heldTab.generation,
          frameID: input.frameID,
          observationRevision: observed.observationRevision,
          ref: input.ref,
          key: "Space",
        }),
        (error: unknown) => code(error) === "BROWSER_UNKNOWN",
      )
      assert.equal(keyEvents.keyDownAcks, 1)
      const takeoverView = manager.getView(resource.resourceID).resource
      const takeoverRequest = {
        resourceID: resource.resourceID,
        requestID: "fixture-held-takeover",
        expectedRevision: takeoverView.revision,
      }
      const takeover = manager.beginTakeover(takeoverView, takeoverRequest)
      const barrier = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
        ...manager.getView(resource.resourceID).resource,
        manualEpoch: takeover.ticket.manualEpoch,
        barrierOrder: takeover.ticket.barrierOrder,
        coreCutoff: 0,
        revision: takeoverView.revision + 1,
      })
      const failedCleanup = await manager.confirmBarrier(barrier, takeover.ticket)
      assert.equal(failedCleanup.heldReleased, false)
      assert.equal(failedCleanup.transportStopped, false)
      assert.equal(failedCleanup.manualEnabled, false)
      assert.equal(manager.getView(resource.resourceID).resource.state, "fenced_blocked")
      assert.equal(heldContents.debugger.isAttached(), true)
      assert.equal(unconfirmed.size, 3)
      counts.push({ phase: "failed-held-release-still-owned", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), BrowserSchema.MAX_ACTIVE_CONTROLS)
      const retry = manager.beginTakeover(manager.getView(resource.resourceID).resource, takeoverRequest)
      assert.deepEqual(retry.ticket, takeover.ticket)
      const retriedCleanup = await manager.confirmBarrier(barrier, retry.ticket)
      assert.equal(retriedCleanup.heldReleased, true)
      assert.equal(retriedCleanup.transportStopped, true)
      assert.equal(retriedCleanup.manualEnabled, true)
      assert.equal(keyEvents.failedKeyUps, 2)
      assert.equal(keyEvents.keyUpAcks, 1)
      assert.equal(heldContents.debugger.isAttached(), false)
      heldContents.debugger.sendCommand = send
      const elapsedFrozen = manager.getView(resource.resourceID).elapsedMs

      await phase("retired-unsealed-source-does-not-destroy-resource")
      const sourceBindingHash = digest("fixture-retired-source")
      const reserve = (suffix: string, binding = sourceBindingHash) =>
        manager.stamp({
          originalSubmissionID: "fixture-source-" + suffix,
          inputID: "fixture-input-" + suffix,
          rootSessionID: resource.rootSessionID,
          rawInputHash: digest("fixture source " + suffix),
          sourceKind: "gui_composer",
          sourceBindingHash: binding,
        })
      const retired = reserve("unsealed")
      const preserved = manager.seal(reserve("sealed"), digest("fixture sealed prompt"))
      const beforeRetire = manager.status(resource.resourceID)
      manager.retireSource(sourceBindingHash)
      assert.throws(
        () => manager.seal(retired, digest("fixture retired prompt")),
        (error: unknown) => code(error) === "BROWSER_AUTHORITY_REQUIRED",
      )
      assert.equal(manager.validateInput(retired), false)
      assert.equal(manager.validateInput(preserved), true)
      const freshInput = manager.seal(reserve("fresh", digest("fixture-new-source")), digest("fixture fresh prompt"))
      assert.equal(manager.validateInput(freshInput), true)
      assert.equal(manager.status(resource.resourceID).resourceAlive, true)
      assert.deepEqual(manager.status(resource.resourceID), beforeRetire)
      assert.equal(manager.getView(resource.resourceID).elapsedMs, elapsedFrozen)

      await phase("actual-legacy-closed-acks-release-physical-slots")
      legacy.forEach((value) => value.destroy())
      await Promise.all(destroyed)
      assert.equal(unconfirmed.size, 0)
      counts.push({ phase: "legacy-actual-closed", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), 1)
      await manager.create(second, secondLease)
      counts.push({ phase: "second-shared-after-release", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), 2)
      const elapsedEnd = manager.getView(resource.resourceID).elapsedMs
      assert.ok(Number.isFinite(elapsedStart) && elapsedStart >= 0 && elapsedEnd >= elapsedStart)
      assert.equal(elapsedEnd, elapsedFrozen)
      const secondView = manager.getView(second.resourceID).resource
      const secondClosed = await manager.close(secondView, {
        resourceID: second.resourceID,
        requestID: "fixture-close-second",
        expectedRevision: secondView.revision,
      })
      assert.equal(secondClosed.resourceAlive, false)
      assert.equal(secondClosed.transportStopped, true)
      counts.push({ phase: "second-shared-closed", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), 1)
      const firstView = manager.getView(resource.resourceID).resource
      const firstClosed = await manager.close(firstView, {
        resourceID: resource.resourceID,
        requestID: "fixture-close-first",
        expectedRevision: firstView.revision,
      })
      counts.push({ phase: "all-actual-closed", count: manager.physicalCount() })
      assert.equal(manager.physicalCount(), 0)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "mixed-capacity-held-release",
            counts,
            electron: process.versions.electron,
            node: process.versions.node,
            keyEvents,
            failedCleanup,
            retriedCleanup,
            legacyActualCloseAcks: 3,
            retiredUnsealedRejected: true,
            priorSealedPreserved: true,
            freshSourceAccepted: true,
            resourceSurvivedSourceRetirement: true,
            elapsedStart,
            elapsedEnd,
            elapsedFrozen,
            firstClosed,
            secondClosed,
            takeoverSameTicket: digest(takeover.ticket) === digest(retry.ticket),
            takeoverTicket: takeover.ticket,
            providerCalls: 0,
            nativeInputAcceptance: false,
            productionWitnessAcceptance: false,
            legacyUtilityAcceptance: false,
            requests,
            trace,
            windows: BrowserWindow.getAllWindows().length,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    const initial = (await execute({ type: "tabs.list" })).result.tabs[0]!
    await phase("navigate-owned-http-cookie-and-dom")
    const navigated = await execute({
      type: "navigate",
      tabID: initial.tabID,
      generation: initial.generation,
      url: origin + "/",
    })
    const tab = navigated.result.tabs[0]!
    const snapshot = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
    await writeFile(
      path.join(root, "snapshot.json"),
      JSON.stringify({ text: snapshot.result.text, refs: snapshot.result.refs, tabs: snapshot.result.tabs }, null, 2),
      { mode: 0o600 },
    )
    if (!snapshot.result.text?.includes("Shared Main fixture")) {
      const page = await contents.executeJavaScript(
        `({URL:location.href,readyState:document.readyState,title:document.title,text:document.body?.textContent,nonce:window.sharedNonce})`,
      )
      await writeFile(path.join(root, "failure-diagnostic.json"), JSON.stringify({ page, requests, trace }, null, 2), {
        mode: 0o600,
      })
    }
    assert.ok(snapshot.result.text?.includes("Shared Main fixture"))
    if (postOnly) {
      await phase("post-readonly-action-cannot-borrow-exact-grant")
      const pending = makeAction({ type: "tabs.list" })
      approved.set(pending.actionID, digest(pending))
      held.actionID = pending.actionID
      const waiting = manager.execute(resource, lease, pending)
      await held.entered.promise
      const borrowed = await contents.executeJavaScript(
        `fetch('/submit',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'owned=post'}).then(response=>({accepted:true,status:response.status}),()=>({accepted:false}))`,
      )
      assert.equal(borrowed.accepted, false)
      assert.equal(requests.filter((value) => value.method === "POST").length, 0)
      held.release.resolve()
      await waiting
      await phase("post-unregistered-click-rejected-before-dispatch")
      const submit = snapshot.result.refs?.find((value) => value.name === "Submit")
      assert.ok(submit && snapshot.result.observationRevision)
      const click = {
        type: "click" as const,
        tabID: tab.tabID,
        generation: tab.generation,
        frameID: submit.frameID,
        observationRevision: snapshot.result.observationRevision,
        ref: submit.ref,
        waitForNavigation: true,
      }
      await assert.rejects(
        manager.execute(resource, lease, makeAction(click)),
        (error: unknown) => code(error) === "BROWSER_SCOPE_DENIED",
      )
      assert.equal(requests.filter((value) => value.method === "POST").length, 0)
      await phase("post-exact-authorized-cdp-form-submit")
      const submitted = await execute(click)
      const acceptedTab = submitted.result.tabs[0]!
      const accepted = await execute({ type: "snapshot", tabID: acceptedTab.tabID, generation: acceptedTab.generation })
      assert.ok(accepted.result.text?.includes("POST accepted"))
      assert.deepEqual(
        requests.filter((value) => value.method === "POST"),
        [
          {
            path: "/submit",
            cookie: "shared=fixture-owned",
            method: "POST",
            contentType: "application/x-www-form-urlencoded",
            body: "owned=post",
          },
        ],
      )
      await phase("post-307-cannot-reuse-same-action-grant")
      const redirectPage = await execute({
        type: "navigate",
        tabID: acceptedTab.tabID,
        generation: acceptedTab.generation,
        url: origin + "/redirect-form",
      })
      const redirectTab = redirectPage.result.tabs[0]!
      const redirectSnapshot = await execute({
        type: "snapshot",
        tabID: redirectTab.tabID,
        generation: redirectTab.generation,
      })
      const redirectSubmit = redirectSnapshot.result.refs?.find((value) => value.name === "Submit")
      assert.ok(redirectSubmit && redirectSnapshot.result.observationRevision)
      const redirectCode = await execute({
        type: "click",
        tabID: redirectTab.tabID,
        generation: redirectTab.generation,
        frameID: redirectSubmit.frameID,
        observationRevision: redirectSnapshot.result.observationRevision,
        ref: redirectSubmit.ref,
        waitForNavigation: true,
      }).then(
        () => "unexpected-success",
        (error: unknown) => code(error),
      )
      assert.equal(redirectCode, "BROWSER_UNKNOWN")
      assert.equal(requests.filter((value) => value.path === "/redirect307").length, 1)
      assert.equal(requests.filter((value) => value.path === "/redirect-target").length, 0)
      assert.equal(requests.filter((value) => value.method === "POST").length, 2)
      await phase("post-close-only-owned-resource")
      const closing = manager.getView(resource.resourceID).resource
      const closed = await manager.close(closing, {
        resourceID: resource.resourceID,
        requestID: "fixture-post-close",
        expectedRevision: closing.revision,
      })
      assert.equal(closed.resourceAlive, false)
      assert.equal(closed.transportStopped, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0)
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify(
          {
            mode: "post-only",
            electron: process.versions.electron,
            node: process.versions.node,
            borrowed,
            readOnlyBorrowServerPosts: 0,
            unregisteredClickServerPosts: 0,
            acceptedSnapshot: accepted.result.text,
            requests,
            redirectCode,
            closed,
            trace,
            providerCalls: 0,
            nativeInputAcceptance: false,
            productionWitnessAcceptance: false,
            sameActionDoubleSubmit: "pending-not-exercised",
            manualPost: "pending-not-exercised",
            windows: BrowserWindow.getAllWindows().length,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      return
    }
    const ref = snapshot.result.refs?.find((value) => value.name === "Code note")
    assert.ok(ref && snapshot.result.frameID && snapshot.result.observationRevision)
    const target = {
      tabID: tab.tabID,
      generation: tab.generation,
      frameID: ref.frameID,
      observationRevision: snapshot.result.observationRevision,
      ref: ref.ref,
    }
    await phase("actual-hidden-cdp-fill-and-preview")
    await execute({ type: "fill", ...target, text: "agent-filled" })
    const filled = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
    assert.ok(filled.result.text?.includes("agent-filled"))
    const screenshot = await execute({ type: "screenshot", tabID: tab.tabID, generation: tab.generation })
    assert.ok(screenshot.png && screenshot.result.image && screenshot.result.image.bytes > 0)
    assert.ok(manager.preview(resource.resourceID, resource.rootSessionID, 0))
    await assert.rejects(
      manager.execute(resource, lease, makeAction({ type: "tabs.list" })),
      (error: unknown) => code(error) === "BROWSER_SCOPE_DENIED",
    )

    await phase("takeover-fences-awaiting-authorization-synchronously")
    const pending = makeAction({ type: "tabs.list" })
    approved.set(pending.actionID, digest(pending))
    held.actionID = pending.actionID
    const waiting = manager.execute(resource, lease, pending).then(
      () => "unexpected-success",
      (error: unknown) => code(error),
    )
    await held.entered.promise
    const view = manager.getView(resource.resourceID).resource
    const takeover = manager.beginTakeover(view, {
      resourceID: resource.resourceID,
      requestID: "fixture-takeover",
      expectedRevision: view.revision,
    })
    assert.equal(manager.status(resource.resourceID).agentAccessFenced, true)
    assert.equal(manager.status(resource.resourceID).leaseRevoked, true)
    assert.equal(manager.preview(resource.resourceID, resource.rootSessionID, 0), undefined)
    await assert.rejects(
      manager.execute(resource, lease, makeAction({ type: "tabs.list" })),
      (error: unknown) => code(error) === "BROWSER_CANCELLED",
    )
    const barrier = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
      ...manager.getView(resource.resourceID).resource,
      manualEpoch: takeover.ticket.manualEpoch,
      barrierOrder: takeover.ticket.barrierOrder,
      coreCutoff: 4,
      revision: manager.getView(resource.resourceID).resource.revision + 1,
    })
    const manual = await manager.confirmBarrier(barrier, takeover.ticket)
    held.release.resolve()
    assert.equal(await waiting, "BROWSER_CANCELLED")
    assert.equal(manual.manualEnabled, true)
    assert.equal(manual.inputIsolated, true)
    assert.equal(manual.heldReleased, true)
    assert.equal(manual.transportStopped, true)
    assert.equal(contents.debugger.isAttached(), false)
    assert.equal(BrowserWindow.getAllWindows()[0], window)
    assert.equal(window.webContents, contents)
    assert.equal(contents.session, partition)
    await assert.rejects(
      manager.execute(resource, lease, makeAction({ type: "fill", ...target, text: "forbidden" })),
      (error: unknown) => code(error) === "BROWSER_CANCELLED",
    )

    await phase("manual-page-script-simulation-and-real-cookie-xhr")
    // This is fixture-only page/user simulation, not native human input acceptance.
    const manualPage = await contents.executeJavaScript(
      `(async()=>{const input=document.querySelector('#note');const before=input.value;input.value='manual-kept';input.dispatchEvent(new Event('input',{bubbles:true}));const reply=await fetch('/manual?nonce='+window.sharedNonce).then(value=>value.json());return {before,value:input.value,nonce:window.sharedNonce,reply}})()`,
    )
    assert.equal(manualPage.before, "agent-filled")
    assert.equal(manualPage.value, "manual-kept")
    assert.equal(manualPage.nonce, nonce)
    assert.deepEqual(manualPage.reply, { cookie: "shared=fixture-owned", nonce })
    assert.equal(manager.preview(resource.resourceID, resource.rootSessionID, takeover.ticket.manualEpoch), undefined)

    await phase("main-stamp-fixture-witness-and-reacquire-same-resource")
    const reservation = manager.stamp({
      originalSubmissionID: "fixture-new-original-submission",
      inputID: "fixture-new-input",
      rootSessionID: resource.rootSessionID,
      rawInputHash: digest("continue shared fixture"),
      sourceKind: "gui_composer",
      sourceBindingHash: digest({ owner: "fixture-owner", windowID: window.id }),
    })
    assert.equal(manager.validateInput(reservation), false)
    const stamp = manager.seal(reservation, digest({ parts: [{ type: "text", text: "continue shared fixture" }] }))
    assert.equal(manager.validateInput(stamp), true)
    assert.ok(stamp.submissionOrder > takeover.ticket.barrierOrder)
    // The selection IDs below are fixture data. This is not the production
    // provider-selection/user-message authorization chain owned by Core.
    const witness = Schema.decodeUnknownSync(SharedBrowserSchema.UserWitness)({
      inputID: stamp.inputID,
      rootSessionID: stamp.rootSessionID,
      mainIncarnation: stamp.mainIncarnation,
      submissionOrder: stamp.submissionOrder,
      admittedSeq: 5,
      promotedSeq: 6,
      originHash: digest(stamp),
      providerReceiptID: "fixture-only-new-provider-receipt",
      selectionID: "fixture-only-selection",
      projectionHash: digest({ inputID: stamp.inputID, promotedSeq: 6 }),
    })
    const witnesses = new Map([[witness.inputID, digest(witness)]])
    assert.equal(manager.validateInput({ ...stamp, submissionOrder: stamp.submissionOrder + 1 }), false)
    const reacquired = Schema.decodeUnknownSync(SharedBrowserSchema.Resource)({
      ...manager.getView(resource.resourceID).resource,
      state: "agent_owned",
      revision: barrier.revision + 1,
      agentAccessFenced: false,
      manualEnabled: false,
      liveLeaseID: "fixture-lease-2",
      updatedAt: Date.now(),
    })
    const nextLease = Schema.decodeUnknownSync(SharedBrowserSchema.Lease)({
      ...lease,
      leaseID: "fixture-lease-2",
      controlID: "fixture-lease-2",
      leaseEpoch: 2,
      manualEpoch: takeover.ticket.manualEpoch,
      originInputID: stamp.inputID,
      requestID: "fixture-reacquire",
      updatedAt: Date.now(),
    })
    const acquire = async (value: SharedBrowserSchema.UserWitness) => {
      assert.equal(
        witnesses.get(value.inputID),
        digest(value),
        "fixture witness registry rejected unregistered identity",
      )
      return manager.acquire(reacquired, nextLease, value)
    }
    await assert.rejects(acquire({ ...witness, selectionID: "unregistered-fixture-selection" }))
    await acquire(witness)
    assert.equal(window.webContents, contents)
    assert.equal(contents.session, partition)
    assert.equal(contents.debugger.isAttached(), true)
    const fresh = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation }, nextLease)
    assert.ok(fresh.result.text?.includes("manual-kept"))
    await phase("close-only-owned-resource")
    const closing = manager.getView(resource.resourceID).resource
    const closed = await manager.close(closing, {
      resourceID: resource.resourceID,
      requestID: "fixture-close",
      expectedRevision: closing.revision,
    })
    assert.equal(closed.resourceAlive, false)
    assert.equal(closed.transportStopped, true)
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          electron: process.versions.electron,
          node: process.versions.node,
          identity,
          preservedWindow: true,
          preservedWebContents: true,
          preservedPartition: true,
          agentFilled: "agent-filled",
          manualPage,
          freshSnapshotText: fresh.result.text,
          screenshot: screenshot.result.image,
          waitingActionCode: await waiting,
          manual,
          closed,
          requests,
          privateActionRegistryRejectedUnregistered: true,
          stampOrder: stamp.submissionOrder,
          barrierOrder: takeover.ticket.barrierOrder,
          providerCalls: 0,
          nativeInputAcceptance: false,
          productionWitnessAcceptance: false,
          unsealedInputRejected: true,
          sealedInputValidated: true,
          windows: BrowserWindow.getAllWindows().length,
          trace,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  } finally {
    held.release.resolve()
    if (childServer) {
      childServer.closeAllConnections()
      await new Promise<void>((resolve) => childServer.close(() => resolve()))
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
  }
}

void main().then(
  () => app.exit(0),
  async (error: unknown) => {
    await writeFile(
      path.join(root, "failure.json"),
      JSON.stringify(
        {
          stage: stage.value,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
          trace,
          ...(framesOnly ? { frameEvidence } : {}),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    app.exit(1)
  },
)
