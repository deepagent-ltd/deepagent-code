// Physical QA utility: original private parent bootstrap and production fileDB admission; no provider/Work.
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Cause, Exit, Option } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"

const root = process.env.DAC_BROWSER_CLIPBOARD_ROOT!
const readText = "界".repeat(5_461) + "x"
const writeText = "文".repeat(2_730) + "xy"

async function utility() {
  const { Effect, Layer, Fiber, Schema } = await import("effect")
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
  const { BrowserActionTable } = await import("@deepagent-code/core/browser/browser.sql")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const parent = Reflect.get(process, "parentPort") as {
    postMessage(value: unknown): void
    on(event: "message", listener: (event: { data: { type?: string; name?: string } }) => void): void
  }
  const pending = new Map<string, () => void>()
  parent.on("message", (event) => {
    if (event.data.type === "clipboard-stage-ready" && event.data.name) pending.get(event.data.name)?.()
  })
  const stage = (name: string) => Effect.promise(() => new Promise<void>((resolve) => {
    pending.set(name, () => { pending.delete(name); resolve() })
    parent.postMessage({ type: "clipboard-stage", name })
  }))
  const credential = process.env.DAC_BROWSER_CLIPBOARD_QA_CREDENTIAL
  assert.ok(credential && /^[a-f0-9]{64}$/.test(credential), "QA_CREDENTIAL_CONTRACT_MISSING")
  await BrowserNativeHost.prepare()
  BrowserNativeHost.captureServerConfiguration({ username: "deepagent-code", password: Option.some(credential) })
  const host = BrowserNativeHost.current()
  assert.ok(host)
  assert.equal(host.matchesCredentials("deepagent-code", credential), true, "QA_NATIVE_HMAC_CONTRACT_MISMATCH")
  const directory = await fs.realpath(path.join(root, "project"))
  const database = Database.layerFromPath(path.join(root, "clipboard.sqlite"))
  const services = LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer))
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_clipboard_module"), project_id: Project.ID.global,
      slug: "clipboard", title: "Clipboard actual Main module", directory, version: "fixture", v2_authority: true }).run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" }, directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: "project_clipboard_module" } })
    const namespace = (yield* db.select().from(SecurityNamespaceTable).all()).find((row) => row.id === identity.securityNamespaceId)
    assert.ok(namespace)
    const scope: typeof BrowserSchema.Scope.Type = { principal: host.principal, securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
      projectID: Project.ID.global, sessionID: "ses_clipboard_module", directory, workspaceID: null }
    const origin = process.env.DAC_BROWSER_CLIPBOARD_ORIGIN!
    const create = Effect.fnUntraced(function* (id: string, clipboardPolicy?: { read: boolean; write: boolean }) {
      const created = yield* BrowserControl.create(db, { request: { requestID: id, sessionID: scope.sessionID,
        profile: BrowserSchema.INTERACTION_PROFILE, origin, postPaths: [], expiresAt: Date.now() + 180_000,
        ...(clipboardPolicy ? { clipboardPolicy } : {}) }, scope,
        hostID: host.hostID, hostIncarnation: host.hostIncarnation, credentialBinding: host.credentialBinding })
      yield* host.create(created.record)
      return yield* BrowserControl.observeControl(db, created.record, "active")
    })
    const current = (control: typeof BrowserSchema.Control.Type) => BrowserControl.requireActive(db, control.controlID, scope, host).pipe(Effect.asVoid)
    const prepare = (control: typeof BrowserSchema.Control.Type, command: typeof BrowserSchema.Command.Type, id: string) =>
      BrowserControl.prepareAction(db, { control, command, timeoutMs: 30_000,
        // Controlled admission only. No provider, Work or canonical ToolEffect is created.
        admission: { admissionId: id, sessionId: scope.sessionID, providerAttemptId: "controlled-clipboard", receiptId: "controlled-clipboard",
          toolCallId: id, toolName: "browser", effectKind: "mutating", ownerToken: "controlled-clipboard", timeCreated: Date.now() } },
        (tx) => BrowserControl.requireActive(tx, control.controlID, scope, host).pipe(Effect.asVoid))
    const execute = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, command: typeof BrowserSchema.Command.Type, id: string) {
      const action = yield* prepare(control, command, id)
      const response = yield* host.execute(control, action, current(control))
      // An unexpected owner must never turn a QA read into a persisted user body.
      if (command.type === "clipboard.read") assert.equal(response.result.clipboard?.direction === "read" &&
        response.result.clipboard.text === readText, true, "QA read differs from owned synthetic text")
      yield* BrowserControl.observeAction(db, action, { outcome: "completed", result: response.result })
      return { action, result: response.result }
    })
    const open = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, id: string) {
      const first = (yield* execute(control, { type: "tabs.list" }, `${id}-tabs`)).result.tabs[0]!
      const navigated = yield* execute(control, { type: "navigate", tabID: first.tabID, generation: first.generation, url: `${origin}/` }, `${id}-navigate`)
      const tab = navigated.result.tabs[0]!
      const snapshot = (yield* execute(control, { type: "snapshot", tabID: tab.tabID, generation: tab.generation }, `${id}-snapshot`)).result
      assert.ok(snapshot.frameID && snapshot.observationRevision)
      return { tabID: tab.tabID, generation: tab.generation, frameID: snapshot.frameID, observationRevision: snapshot.observationRevision }
    })
    const code = (exit: Exit.Exit<unknown, BrowserSchema.Error>) => Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : undefined
    const refused = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, action: typeof BrowserSchema.Action.Type) {
      const exit = yield* Effect.exit(host.execute(control, action, current(control)))
      assert.ok(Exit.isFailure(exit))
      const errorCode = code(exit)
      assert.ok(errorCode)
      yield* BrowserControl.observeAction(db, action, { outcome: "unknown", errorCode })
      return errorCode
    })
    const close = Effect.fnUntraced(function* (control: typeof BrowserSchema.Control.Type, id: string) {
      const cancelled = yield* BrowserControl.cancel(db, control.controlID, scope, { requestID: id, expectedRevision: control.revision })
      assert.equal(yield* host.cancel(cancelled.record), true)
      return yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
    })
    const old = yield* create("old-policy")
    const oldTarget = yield* open(old, "old")
    if (BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE) yield* stage("page-bypass")
    const oldDenied = code(yield* Effect.exit(prepare(old, { type: "clipboard.read", ...oldTarget }, "old-denied")))
    assert.equal(oldDenied, "BROWSER_SCOPE_DENIED")
    yield* close(old, "old-close")
    const first = yield* create("clipboard-first", { read: true, write: true })
    assert.ok(first.profile === BrowserSchema.INTERACTION_PROFILE)
    assert.equal(host.verify({ ...first, clipboardPolicy: { read: true, write: false } }).matched, false)
    const target = yield* open(first, "first")
    if (!BrowserSchema.CLIPBOARD_NATIVE_AVAILABLE) {
      const refusedRead = yield* refused(first, yield* prepare(first, { type: "clipboard.read", ...target }, "blocked-read"))
      const refusedWrite = yield* refused(first, yield* prepare(first, { type: "clipboard.write", ...target, text: writeText }, "blocked-write"))
      assert.equal(refusedRead, "BROWSER_DRIVER_UNAVAILABLE")
      assert.equal(refusedWrite, "BROWSER_DRIVER_UNAVAILABLE")
      yield* close(first, "blocked-close")
      const inputs = (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_input"))[0]!.n
      const providers = (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM work_count_acquisition"))[0]!.n
      assert.equal(inputs, 0)
      assert.equal(providers, 0)
      return { blocked: true, node: process.versions.node, electron: process.versions.electron,
        oldDenied, copiedDescriptorDenied: true, refusedRead, refusedWrite, inputs, providers,
        boundary: "source-module/original-private-utility-Main/fileDB/controlled-admission" }
    }
    const stale = yield* prepare(first, { type: "clipboard.read", ...target, observationRevision: target.observationRevision + 1 }, "stale")
    assert.equal(yield* refused(first, stale), "BROWSER_STALE_TARGET")
    // Cancel/close/lease native negatives reuse the separately frozen confirmation-only actual.
    assert.equal(process.env.DAC_BROWSER_CLIPBOARD_SAFE, "1", "CLIPBOARD_QA_RESTORE_UNAVAILABLE")
    const positives: { direction: string; bytes: number; sha256: string }[] = []
    if (process.env.DAC_BROWSER_CLIPBOARD_SAFE === "1") {
      yield* stage("read")
      const read = yield* execute(first, { type: "clipboard.read", ...target }, "read-once")
      assert.ok(read.result.clipboard?.direction === "read")
      assert.equal(read.result.clipboard.text === readText, true, "Only the owned synthetic text may be returned")
      assert.equal(read.result.clipboard.bytes, 16384)
      assert.equal(read.result.clipboard.sha256, createHash("sha256").update(readText).digest("hex"))
      positives.push({ direction: "read", bytes: read.result.clipboard.bytes, sha256: read.result.clipboard.sha256 })
      const before = yield* db.all("SELECT total_changes() AS n")
      assert.equal(code(yield* Effect.exit(host.execute(first, read.action, current(first)))), "BROWSER_UNKNOWN")
      assert.equal(code(yield* Effect.exit(prepare(first, read.action.command, "read-once"))), "BROWSER_CONFLICT")
      assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), before)
      yield* stage("write")
      const written = (yield* execute(first, { type: "clipboard.write", ...target, text: writeText }, "write-once")).result.clipboard
      assert.ok(written?.direction === "write")
      assert.equal(written.bytes, 8192)
      assert.equal("text" in written, false)
      assert.equal(written.sha256, createHash("sha256").update(writeText).digest("hex"))
      positives.push(written)
    }
    yield* close(first, "first-close")
    const rows = yield* db.select().from(BrowserActionTable).all()
    const inputs = (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM session_input"))[0]!.n
    const providers = (yield* db.all<{ n: number }>("SELECT count(*) AS n FROM work_count_acquisition"))[0]!.n
    assert.equal(inputs, 0)
    assert.equal(providers, 0)
    return { blocked: false, node: process.versions.node, electron: process.versions.electron, positives, oldDenied,
      reusedConfirmationOnlyNegatives: true, copiedDescriptorDenied: true, staleDenied: true,
      exactRetryNoWrites: positives.length > 0, inputs, providers,
      actions: rows.map((row) => ({ id: row.admission_id, outcome: row.outcome })),
      boundary: "source-module/original-private-utility-Main/fileDB/controlled-admission" }
  }).pipe(Effect.provide(services), Effect.scoped))
  const cold = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() AS n")
    const rows = yield* db.select().from(BrowserActionTable).all()
    for (const row of rows) yield* BrowserControl.getAction(db, row.action_id)
    assert.deepEqual(yield* db.all("SELECT total_changes() AS n"), before)
    return { readOnly: true, actions: rows.length }
  }).pipe(Effect.provide(database), Effect.scoped))
  parent.postMessage({ type: "clipboard-result", result: { ...result, cold } })
  process.exit(0)
}

void utility().catch(async (error) => {
  await fs.writeFile(path.join(root, "utility-failure.json"), JSON.stringify({ code: error instanceof BrowserSchema.Error ? error.code : "CLIPBOARD_QA_UTILITY_FAILED" }), { mode: 0o600 })
  process.exit(1)
})
