import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { BrowserFileCapability } from "@deepagent-code/core/browser/file-capability"
import { BrowserFileExchange } from "@deepagent-code/core/browser/file-exchange"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { SharedBrowserControl } from "@deepagent-code/core/browser/shared-control"
import { SharedBrowserFileSchema } from "@deepagent-code/core/browser/shared-file-schema"
import { SharedBrowserFileBinding } from "@deepagent-code/core/browser/shared-file-binding"
import { SharedBrowserFileExchange } from "@deepagent-code/core/browser/shared-file-exchange"
import { AppRuntime } from "@/effect/app-runtime"
import { BrowserNativeHost } from "@/browser/native-host"
import { Server } from "@/server/server"

const root = process.argv[2]!
const directory = path.join(root, "project")
const hash = BrowserFileExchange.hash
const authorization = `Basic ${Buffer.from("deepagent-code:shared-files-http-fixture").toString("base64")}`
// Use the existing process-root adoption path; a separate listener-first root would
// compete with AppRuntime for this fixture's own fileDB lifetime lock.
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const cleanup = { listenerClosed: false, runtimeDisposed: false }
try {
  const session = await AppRuntime.runPromise(SessionV2.Service.use((sessions) => sessions.create({ location: { directory: AbsolutePath.make(directory) } })))
  await fs.writeFile(path.join(directory, "source.bin"), Uint8Array.of(0, 0xff, 10), { mode: 0o600 })
  const rootStat = await fs.lstat(directory, { bigint: true })
  const fileStat = await fs.lstat(path.join(directory, "source.bin"), { bigint: true })
  const facts = { confirms: 0, accepts: 0 }
  const saved = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const identity = yield* LocationIdentity.Service.use((service) => service.resolve({ boundary: { kind: "implicit_local" }, directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: session.projectID } })).pipe(
        Effect.provide(LocationIdentity.layer.pipe(Layer.provide(FSUtil.defaultLayer))))
    const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
    assert(namespace)
    const scope: BrowserSchema.Scope = { principal: "deepagent-code", securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
      projectID: session.projectID, sessionID: session.id, directory, workspaceID: null }
    const create = (principal: string, requestID: string) => Effect.gen(function* () {
      const created = yield* SharedBrowserControl.create(db, { scope: { ...scope, principal }, mainIncarnation: "store-only-main-distinct",
        sidecarIncarnation: "store-only-sidecar", request: { version: 2, profile: SharedBrowserSchema.PROFILE,
          inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE, requestID, sessionID: session.id, expiresAt: Date.now() + 120_000,
          policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"], manualApprovedOrigins: ["https://example.com"],
            resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } } } })
      const resource = yield* SharedBrowserControl.observeCreated(db, created.resource, { resourceID: created.resource.resourceID,
        mainIncarnation: created.resource.mainIncarnation, manualEpoch: 0, barrierOrder: 0, resourceAlive: true, agentAccessFenced: false,
        leaseRevoked: false, inputIsolated: true, heldReleased: true, transportStopped: true, manualEnabled: false, unknownEffects: false,
        leaseID: created.lease.leaseID, leaseEpoch: 1 })
      const lease = yield* SharedBrowserControl.lease(db, created.lease.leaseID)
      assert(lease)
      return { resource, lease }
    })
    const active = yield* create(scope.principal, "owned-history")
    const foreign = yield* create("different-operator", "foreign-history")
    const previews = new WeakMap<BrowserFileCapability.Preview, SharedBrowserFileSchema.Preview>()
    const confirmations = new WeakMap<BrowserFileCapability.Approval, BrowserFileSchema.Confirmation>()
    const unavailable = () => Effect.die("No Native execution in the storage-history producer")
    // This opaque producer constructs only historical storage via real Core APIs. The actual
    // AppRuntime factory remains source/uninstalled and cannot accept or execute this grant.
    const producer: BrowserFileCapability.Interface = {
      preview: unavailable, describePreview: () => undefined, currentPreview: unavailable, confirm: unavailable, approved: () => false,
      describeApproval: () => undefined, acceptGrant: () => false, prepare: unavailable, current: unavailable, readUpload: unavailable,
      writeDownload: unavailable, sealUpload: unavailable, observeUpload: unavailable, publishDownload: unavailable, describe: () => undefined,
      cleanup: unavailable, describeReleased: () => undefined,
      shared: {
        preview: (input) => Effect.sync(() => {
          assert.equal(input.request.direction, "upload")
          const handle = Object.freeze({}) as BrowserFileCapability.Preview
          const binding = SharedBrowserFileBinding.from(input.resource, input.lease)
          previews.set(handle, { version: 2, binding, bindingHash: hash(binding), instanceID: "store-only-private-instance", scopeHash: hash(scope),
            helperHash: "a".repeat(64), rootIdentity: { kind: "posix", device: String(rootStat.dev), inode: String(rootStat.ino) },
            relative: "source.bin", name: "source.bin", observedAt: Date.now(), direction: "upload", targetURL: input.request.targetURL,
            fileIdentity: { kind: "posix", device: String(fileStat.dev), inode: String(fileStat.ino) }, bytes: 3,
            sha256: new Bun.CryptoHasher("sha256").update(Uint8Array.of(0, 0xff, 10)).digest("hex") })
          return handle
        }),
        describePreview: (handle) => previews.get(handle), currentPreview: () => Effect.void,
        confirm: (handle, command) => Effect.sync(() => {
          facts.confirms++
          const value = Object.freeze({}) as BrowserFileCapability.Approval
          confirmations.set(value, { previewHash: hash(previews.get(handle)), commandHash: hash(command), confirmationHash: "b".repeat(64), confirmedAt: Date.now() })
          return value
        }),
        approved: (handle, preview, command) => confirmations.get(handle)?.previewHash === hash(previews.get(preview)) && confirmations.get(handle)?.commandHash === hash(command),
        describeApproval: (handle) => confirmations.get(handle), acceptGrant: () => { facts.accepts++; return true },
        prepare: unavailable, executionFiles: unavailable, finishAction: unavailable,
      },
    }
    const capture = yield* SharedBrowserFileExchange.preview(db, { resourceID: active.resource.resourceID, scope,
      request: { direction: "upload", relative: "source.bin", targetURL: "https://example.com/upload" } }).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    const command: SharedBrowserFileSchema.Approve = { requestID: "original-approved-request", previewID: "original-private-preview",
      expectedResourceRevision: active.resource.revision, expectedLeaseID: active.lease.leaseID, expectedLeaseEpoch: active.lease.leaseEpoch,
      expectedManualEpoch: active.resource.manualEpoch, expiresAt: Date.now() + 90_000 }
    yield* SharedBrowserFileExchange.confirm(db, capture, command).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    const approved = yield* SharedBrowserFileExchange.approve(db, { resourceID: active.resource.resourceID, scope, command }, capture)
      .pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    return { ...active, foreign: foreign.resource.resourceID, command, grantID: approved.grant.grantID }
  }))
  const route = `/api/v1/browser/shared/resources/${encodeURIComponent(saved.resource.resourceID)}/files`
  const request = async (suffix: string, options: { body?: unknown; authorization?: string; path?: string } = {}) => {
    const response = await fetch(new URL(options.path ?? `${route}${suffix}`, listener.url), { method: options.body === undefined ? "GET" : "POST",
      headers: { authorization: options.authorization ?? authorization, "content-type": "application/json", connection: "close" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(10_000) })
    return { status: response.status, body: await response.json() }
  }
  const before = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.all("SELECT record,record_hash FROM browser_file_grant ORDER BY grant_id")
  }))
  const status = await request(`/requests/${saved.command.requestID}`)
  assert.equal(status.status, 200)
  assert.equal(status.body.state, "unavailable")
  assert.equal(status.body.grant.grantID, saved.grantID)
  const listed = await request("?limit=1")
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.files, [])
  assert.equal(listed.body.grants[0].state, "unavailable")
  const replay = await request("/approve", { body: saved.command })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.replayed, true)
  assert.equal(replay.body.grant.state, "unavailable")
  const conflict = await request("/approve", { body: { ...saved.command, expiresAt: saved.command.expiresAt + 1 } })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, "BROWSER_FILE_CONFLICT")
  const fresh = await request("/approve", { body: { ...saved.command, requestID: "new-unapproved-request" } })
  assert.equal(fresh.status, 503)
  const preview = await request("/preview", { body: { direction: "upload", relative: "source.bin", targetURL: "https://example.com/upload" } })
  assert.equal(preview.status, 503)
  const excess = await request("/approve", { body: { ...saved.command, approved: true, binding: saved.resource.scope } })
  assert.equal(excess.status, 409)
  assert.equal(excess.body.code, "BROWSER_FILE_INVALID")
  const wrongAuth = await request("", { authorization: "Basic invalid" })
  assert.equal(wrongAuth.status, 401)
  const foreign = await request("", { path: `/api/v1/browser/shared/resources/${saved.foreign}/files` })
  assert.equal(foreign.status, 403)
  const missing = await request("", { path: "/api/v1/browser/shared/resources/missing/files" })
  assert.equal(missing.status, 404)
  const absent = await fetch(new URL(`${route}/execute`, listener.url), { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}" })
  assert.equal(absent.status, 404)
  const after = await AppRuntime.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return { grantBytes: yield* db.all("SELECT record,record_hash FROM browser_file_grant ORDER BY grant_id"),
      artifacts: (yield* db.all("SELECT artifact_id FROM browser_file_artifact")).length,
      oldControls: (yield* db.all("SELECT control_id FROM browser_control")).length,
      providers: (yield* db.all("SELECT attempt_id FROM session_provider_attempt")).length,
      receipts: (yield* db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt")).length }
  }))
  assert.deepEqual(after.grantBytes, before)
  assert.deepEqual(facts, { confirms: 1, accepts: 1 })
  assert.equal(BrowserNativeHost.current(), undefined)
  assert.deepEqual({ artifacts: after.artifacts, oldControls: after.oldControls, providers: after.providers, receipts: after.receipts },
    { artifacts: 0, oldControls: 0, providers: 0, receipts: 0 })
  await listener.stop(); cleanup.listenerClosed = true
  await Server.disposeDefault(); await AppRuntime.dispose(); cleanup.runtimeDisposed = true
  await Bun.write(path.join(root, "result.json"), JSON.stringify({ status, listed, replay, conflict, fresh, preview, excess, wrongAuth, foreign, missing,
    publicDispatchStatus: absent.status, facts, unchangedGrantBytes: true, artifacts: after.artifacts, oldControls: after.oldControls,
    providers: after.providers, receipts: after.receipts, nativeHostAvailable: false, cleanup }))
} finally {
  if (!cleanup.listenerClosed) await listener.stop()
  if (!cleanup.runtimeDisposed) { await Server.disposeDefault(); await AppRuntime.dispose() }
}
