// Fixed physical diagnostic entry. The private publisher signs these actual bytes together
// with the production source inventory and the original installed native file helper.
import { NativeBootstrap } from "../../../../deepagent-code/src/runtime/native-bootstrap"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"

NativeBootstrap.install()
const root = process.env.DAC_BROWSER_FILES_ROOT!

async function utility() {
  const { Effect, Layer, Option, Exit, Cause } = await import("effect")
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
  const { BrowserFileCapability } = await import("@deepagent-code/core/browser/file-capability")
  const { BrowserFileExchange } = await import("@deepagent-code/core/browser/file-exchange")
  const { BrowserFileCapacityTable } = await import("@deepagent-code/core/browser/browser-file.sql")
  const { BrowserHost } = await import("@deepagent-code/core/browser/host")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const { BrowserFiles } = await import("../../../../deepagent-code/src/browser/file-exchange")
  const { LocalAuthority } = await import("../../../../deepagent-code/src/installation/local-authority")
  const parent = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
  await BrowserNativeHost.prepare()
  BrowserNativeHost.captureServerConfiguration({ username: "deepagent-code", password: Option.some("private-files-module") })
  const host = BrowserNativeHost.current()
  assert.ok(host)
  const directory = await fs.realpath(path.join(root, "project"))
  const database = Database.layerFromPath(path.join(root, "files.sqlite"))
  const graph = Layer.mergeAll(LocationIdentity.layer, BrowserFiles.layer).pipe(Layer.provideMerge(database),
    Layer.provide(FSUtil.defaultLayer), Layer.provide(Layer.succeed(BrowserHost.Current, host)))
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const api = yield* BrowserFiles.Service
    const cap = yield* BrowserFileCapability.Service
    yield* LocalAuthority.initializeInstallation()
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_browser_files_fixture"), project_id: Project.ID.global,
      slug: "files", title: "Installed file exchange module", directory, version: "fixture", v2_authority: true }).run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" }, directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: "project_browser_files_fixture" } })
    const namespace = (yield* db.select().from(SecurityNamespaceTable).all()).find((row) => row.id === identity.securityNamespaceId)
    assert.ok(namespace)
    const scope: typeof BrowserSchema.Scope.Type = { principal: host.principal, securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
      projectID: Project.ID.global, sessionID: "ses_browser_files_fixture", directory, workspaceID: null }
    const origin = process.env.DAC_BROWSER_FILES_ORIGIN!
    const create = Effect.fnUntraced(function* (id: string) {
      const made = yield* BrowserControl.create(db, { request: { requestID: id, sessionID: scope.sessionID,
        profile: BrowserSchema.FILE_EXCHANGE_PROFILE, origin, postPaths: ["/upload"], filePolicy: { upload: true, download: true },
        expiresAt: Date.now() + 240_000 }, scope, hostID: host.hostID, hostIncarnation: host.hostIncarnation, credentialBinding: host.credentialBinding })
      yield* host.create(made.record)
      return yield* BrowserControl.observeControl(db, made.record, "active")
    })
    const execute = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, command: typeof BrowserSchema.Command.Type, id: string) {
      const current = () => BrowserControl.requireActive(db, control.controlID, scope, host).pipe(Effect.asVoid)
      const action = yield* BrowserControl.prepareAction(db, { control, command, timeoutMs: 30_000,
        // Store admission witness only. No model/provider/Work or canonical ToolEffect is minted.
        admission: { admissionId: id, sessionId: scope.sessionID, providerAttemptId: "controlled-files", receiptId: "controlled-files",
          toolCallId: id, toolName: "browser", effectKind: "mutating", ownerToken: "controlled-files", timeCreated: Date.now() } },
        (tx) => BrowserControl.requireActive(tx, control.controlID, scope, host).pipe(Effect.asVoid))
      const response = yield* host.execute(control, action, current())
      yield* BrowserControl.observeAction(db, action, { outcome: "completed", result: response.result })
      if (command.type === "file.upload" || command.type === "file.download") {
        assert.ok(cap.finishAction)
        yield* cap.finishAction(action.actionID)
      }
      return response.result
    })
    const open = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, id: string) {
      const initial = yield* execute(control, { type: "tabs.list" }, `${id}-tabs`)
      const first = initial.tabs[0]!
      const page = yield* execute(control, { type: "navigate", tabID: first.tabID, generation: first.generation, url: `${origin}/` }, `${id}-navigate`)
      const tab = page.tabs[0]!
      const snapshot = yield* execute(control, { type: "snapshot", tabID: tab.tabID, generation: tab.generation }, `${id}-snapshot`)
      return { tab, snapshot }
    })
    const uploadControl = yield* create("upload-control")
    const page = yield* open(uploadControl, "upload")
    const upload = yield* api.preview({ controlID: uploadControl.controlID, scope, request: { direction: "upload", relative: "source.bin", targetPath: "/upload" } })
    parent.postMessage({ type: "files-native-confirm", name: "upload" })
    const command = { previewID: upload.previewID, requestID: "upload-grant", expectedControlRevision: uploadControl.revision, expiresAt: Date.now() + 120_000 }
    const approved = yield* Effect.all([api.approve({ controlID: uploadControl.controlID, scope, command }),
      api.approve({ controlID: uploadControl.controlID, scope, command })], { concurrency: 2 })
    assert.equal(approved[0].grant.grantID, approved[1].grant.grantID)
    assert.equal(approved[0].grant.state, "approved")
    const prior = yield* db.all("SELECT total_changes() AS n")
    assert.equal((yield* api.approve({ controlID: uploadControl.controlID, scope, command })).replayed, true)
    assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), prior)
    const reference = page.snapshot.refs?.find((ref) => ref.role === "button" && /file/i.test(ref.name))
    assert.ok(reference)
    const selected = yield* execute(uploadControl, { type: "file.upload", tabID: page.tab.tabID, generation: page.tab.generation,
      frameID: reference.frameID, observationRevision: page.snapshot.observationRevision!, ref: reference.ref,
      grantIDs: [approved[0].grant.grantID] }, "upload-once")
    assert.equal(selected.files?.[0]?.state, "selected")
    const downloadControl = yield* create("download-control")
    const downloadPage = yield* open(downloadControl, "download")
    const destination = yield* api.preview({ controlID: downloadControl.controlID, scope,
      request: { direction: "download", relative: "download.bin", targetURL: `${origin}/download`, maxBytes: 65536 } })
    parent.postMessage({ type: "files-native-confirm", name: "download" })
    const granted = yield* api.approve({ controlID: downloadControl.controlID, scope, command: { previewID: destination.previewID,
      requestID: "download-grant", expectedControlRevision: downloadControl.revision, expiresAt: Date.now() + 120_000 } })
    const link = downloadPage.snapshot.refs?.find((ref) => ref.role === "link" && ref.name === "Download file")
    assert.ok(link)
    const downloaded = yield* execute(downloadControl, { type: "file.download", tabID: downloadPage.tab.tabID, generation: downloadPage.tab.generation,
      frameID: link.frameID, observationRevision: downloadPage.snapshot.observationRevision!, ref: link.ref, grantID: granted.grant.grantID }, "download-once")
    assert.equal(downloaded.files?.[0]?.state, "published")
    assert.deepEqual(yield* Effect.promise(() => fs.readFile(path.join(directory, "download.bin"))),
      yield* Effect.promise(() => fs.readFile(path.join(directory, "source.bin"))))
    const meter = yield* db.select().from(BrowserFileCapacityTable).get()
    assert.ok(meter)
    assert.equal(meter.reserved_bytes, meter.metadata_bytes)
    const census = yield* db.all("SELECT total_changes() AS n")
    const list = yield* api.list({ controlID: downloadControl.controlID, scope })
    assert.equal(list.grants[0]?.state, "used")
    assert.equal(list.files[0]?.state, "published")
    yield* api.status({ controlID: downloadControl.controlID, scope, requestID: "download-grant" })
    assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), census)
    const cancelled = yield* BrowserControl.cancel(db, downloadControl.controlID, scope, { requestID: "close-download", expectedRevision: downloadControl.revision })
    assert.equal(yield* host.cancel(cancelled.record), true)
    yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
    assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_input"))[0]?.n, 0)
    assert.equal((yield* db.all<{ n: number }>("SELECT count(*) AS n FROM work_count_acquisition"))[0]?.n, 0)
    return { node: process.versions.node, electron: process.versions.electron, selected: selected.files, downloaded: downloaded.files,
      instanceID: upload.preview.instanceID, confirms: 2, grantCount: (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM browser_file_grant"))[0]?.n,
      artifactCount: meter.artifact_count, reservedBytes: meter.reserved_bytes, metadataBytes: meter.metadata_bytes, list,
      inputs: 0, providers: 0, actualInstalled: true, controlledAdmission: true }
  }).pipe(Effect.provide(graph), Effect.scoped))
  parent.postMessage({ type: "files-result", result })
}

void utility().then(() => process.exit(0), async (error) => {
  await fs.writeFile(path.join(root, "utility-failure.json"), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : "" }), { mode: 0o600 }); process.exit(1)
})
