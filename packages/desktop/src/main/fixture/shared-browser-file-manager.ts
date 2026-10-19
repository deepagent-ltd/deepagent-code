import { app, BrowserWindow, dialog } from "electron"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { createSharedBrowserManager } from "../shared-browser"
import { fileStages } from "./shared-browser-file-observer"

const root = process.env.DAC_SHARED_FILE_MANAGER_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.commandLine.appendSwitch("disable-quic")
app.on("window-all-closed", () => {})
const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const file = Buffer.from("DAC native owned file fixture\n")
const sha = createHash("sha256").update(file).digest("hex")
const trace: Array<{ kind: string; at: number; method?: string; code?: string }> = []
const facts = { post: 0, bytes: 0, read: 0, seal: 0, observe: 0, checks: 0, error: "", outcome: "" }

async function main() {
  await app.whenReady()
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      facts.post++
      request.on("data", (data: Buffer) => {
        facts.bytes += data.length
      })
      request.on("end", () => {
        response.setHeader("content-type", "text/html")
        response.end("<h1>Upload completed</h1>")
      })
      return
    }
    response.setHeader("content-type", "text/html")
    response.end(
      '<form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="file" aria-label="Owned file"></form>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const manager = createSharedBrowserManager({})
  const now = Date.now()
  const policy: SharedBrowserSchema.Policy = {
    origin,
    approvedOrigins: [origin],
    manualApprovedOrigins: [origin],
    resolverPolicy: "system",
    postGrants: [],
    filePolicy: { upload: true, download: false },
  }
  const resource: SharedBrowserSchema.Resource = {
    version: 2,
    profile: SharedBrowserSchema.PROFILE,
    inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
    resourceID: "manager-file-resource",
    requestID: "manager-file-create",
    requestDigest: hash(origin),
    rootSessionID: "manager-file-session",
    mainIncarnation: manager.mainIncarnation,
    scope: {
      principal: "fixture",
      securityNamespaceID: "fixture",
      locationKey: "fixture",
      projectScopeKey: "fixture",
      namespaceBindingHash: hash(root),
      sessionID: "manager-file-session",
      projectID: "fixture",
      directory: root,
      workspaceID: null,
    },
    policy,
    policyHash: hash(policy),
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
  }
  const lease: SharedBrowserSchema.Lease = {
    version: 2,
    leaseID: "manager-file-lease",
    controlID: "manager-file-lease",
    resourceID: resource.resourceID,
    mainIncarnation: manager.mainIncarnation,
    sidecarIncarnation: "manager-file-sidecar",
    scope: resource.scope,
    policyHash: resource.policyHash,
    leaseEpoch: 1,
    manualEpoch: 0,
    state: "active",
    originInputID: null,
    requestID: "manager-file-lease-create",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 90_000,
  }
  const allowed = new Map<string, string>()
  manager.attachHost(lease.sidecarIncarnation, async (action) => {
    facts.checks++
    trace.push({ kind: "check.enter", at: Date.now() })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const result = allowed.get(action.actionID) === hash(action)
    trace.push({ kind: "check.return", at: Date.now() })
    return result
  })
  const action = (command: BrowserSchema.Command): SharedBrowserSchema.Action => ({
    actionID: randomUUID(),
    resourceID: resource.resourceID,
    leaseID: lease.leaseID,
    leaseEpoch: lease.leaseEpoch,
    manualEpoch: 0,
    admissionID: randomUUID(),
    providerReceiptID: "fixture",
    providerAttemptID: "fixture",
    toolCallID: randomUUID(),
    rootSessionID: resource.rootSessionID,
    command,
    commandHash: hash(command),
    deadline: Date.now() + 10_000,
  })
  const execute = async (command: BrowserSchema.Command) => {
    const value = action(command)
    allowed.set(value.actionID, hash(value))
    return (await manager.execute(resource, lease, value)).result
  }
  const originalDialog = dialog.showMessageBox
  try {
    await manager.create(resource, lease)
    const page = BrowserWindow.getAllWindows()[0]!
    const send = page.webContents.debugger.sendCommand.bind(page.webContents.debugger)
    page.webContents.debugger.sendCommand = async (...args) => {
      trace.push({ kind: "cdp.enter", at: Date.now(), method: args[0] })
      try {
        const value = await send(...args)
        trace.push({ kind: "cdp.return", at: Date.now(), method: args[0] })
        return value
      } catch (error) {
        trace.push({ kind: "cdp.throw", at: Date.now(), method: args[0], code: String(error) })
        throw error
      }
    }
    page.webContents.on("did-fail-load", (_event, code) =>
      trace.push({ kind: "did-fail-load", at: Date.now(), code: String(code) }),
    )
    const initial = (await execute({ type: "tabs.list" })).tabs[0]!
    const tab = (await execute({ type: "navigate", tabID: initial.tabID, generation: initial.generation, url: origin }))
      .tabs[0]!
    const snapshot = await execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation })
    const ref = snapshot.refs?.find((value) => value.name === "Owned file")
    assert.ok(ref && snapshot.observationRevision)
    const active = manager.getView(resource.resourceID).resource
    const binding = SharedBrowserFileBinding.from(active, lease)
    const preview: SharedBrowserFileSchema.Preview = {
      version: 2,
      binding,
      bindingHash: hash(binding),
      instanceID: "fixture",
      scopeHash: hash(resource.scope),
      helperHash: hash("controlled-not-helper-custody"),
      rootIdentity: { kind: "posix", device: "1", inode: "1" },
      relative: "owned.txt",
      name: "owned.txt",
      observedAt: Date.now(),
      direction: "upload",
      targetURL: origin + "/upload",
      fileIdentity: { kind: "posix", device: "1", inode: "2" },
      bytes: file.length,
      sha256: sha,
    }
    const intent: SharedBrowserFileSchema.Approve = {
      requestID: "manager-file-approval",
      previewID: "manager-file-preview",
      expectedResourceRevision: active.revision,
      expectedLeaseID: lease.leaseID,
      expectedLeaseEpoch: 1,
      expectedManualEpoch: 0,
      expiresAt: now + 60_000,
    }
    const owner = new BrowserWindow({ show: true })
    await owner.loadURL("about:blank")
    manager.registerFileConfirmationOwner(() => ({ window: owner, current: () => !owner.isDestroyed() }))
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    const confirmation = await manager.confirmFile(active, lease, preview, intent, async () => {})
    assert.ok(!("kind" in confirmation))
    const command: Extract<BrowserSchema.Command, { type: "file.upload" }> = {
      type: "file.upload",
      tabID: tab.tabID,
      generation: tab.generation,
      frameID: ref.frameID,
      observationRevision: snapshot.observationRevision,
      ref: ref.ref,
      grantIDs: ["manager-file-grant"],
    }
    const upload = action(command)
    allowed.set(upload.actionID, hash(upload))
    const grant: SharedBrowserFileSchema.Grant = {
      version: 2,
      binding,
      bindingHash: hash(binding),
      grantID: "manager-file-grant",
      instanceID: "fixture",
      scopeHash: preview.scopeHash,
      command: intent,
      commandHash: hash(intent),
      preview,
      confirmation,
      expiresAt: intent.expiresAt,
      createdAt: Date.now(),
    }
    const artifact: SharedBrowserFileSchema.Artifact = {
      version: 2,
      binding,
      bindingHash: hash(binding),
      artifactID: "manager-file-artifact",
      instanceID: "fixture",
      grantID: grant.grantID,
      grantHash: hash(grant),
      actionID: upload.actionID,
      admissionID: upload.admissionID,
      providerReceiptID: upload.providerReceiptID,
      providerAttemptID: upload.providerAttemptID,
      toolCallID: upload.toolCallID,
      sessionID: resource.rootSessionID,
      scopeHash: preview.scopeHash,
      ordinal: 0,
      manifest: preview,
      state: "reserved",
      revision: 1,
      reservedBytes: file.length * 2,
      publication: null,
      stopConfirmedAt: null,
      releasedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const publication: BrowserFileSchema.Publication = {
      version: 1,
      artifactID: artifact.artifactID,
      grantID: grant.grantID,
      direction: "upload",
      rootIdentity: preview.rootIdentity,
      stageIdentity: preview.fileIdentity,
      fileIdentity: preview.fileIdentity,
      bytes: file.length,
      sha256: sha,
      helperHash: preview.helperHash,
      observedAt: Date.now(),
      outcome: "selected",
    }
    facts.outcome = await manager
      .execute(resource, lease, upload, {
        pairs: [{ grant, artifact }],
        ask: async (leaf) => {
          if (leaf.operation === "upload.read") {
            facts.read++
            return { type: "shared.file.leaf.response", id: "fixture", payload: file.toString("base64") }
          }
          if (leaf.operation === "upload.seal") {
            facts.seal++
            return { type: "shared.file.leaf.response", id: "fixture" }
          }
          facts.observe++
          return { type: "shared.file.leaf.response", id: "fixture", publication }
        },
      })
      .then(
        () => "completed",
        (error: unknown) => {
          facts.error = String(error)
          return "failed"
        },
      )
    const view = manager.getView(resource.resourceID).resource
    const closed = await manager.close(view, {
      resourceID: resource.resourceID,
      requestID: "manager-file-close",
      expectedRevision: view.revision,
    })
    await fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(
        {
          facts,
          fileStages,
          trace,
          closed,
          productionMainManager: true,
          actualDriverNetworkAndFileLeaf: true,
          transparentFileStageObservation: true,
          controlledAuthorityAndNativeResponse: true,
          physicalNativeAcceptance: false,
          providerCalls: 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  } finally {
    dialog.showMessageBox = originalDialog
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
void main().then(
  () => app.exit(0),
  async (error) => {
    await fs.writeFile(
      path.join(root, "failure.json"),
      JSON.stringify({ error: String(error), stack: error.stack, facts, fileStages, trace }),
      { mode: 0o600 },
    )
    app.exit(1)
  },
)
