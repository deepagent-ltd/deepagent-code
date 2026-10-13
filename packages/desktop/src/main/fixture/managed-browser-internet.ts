// Live public transport qualification, independent from the private TLS/DoH peers.
// All browser actions still use the original NativeHost/Main and file-backed control.
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Schema } from "effect"

const root = process.env.DAC_BROWSER_INTERNET_ROOT!
const resolverPolicy = Schema.decodeUnknownSync(Schema.Literals(["system", "cloudflare_doh_v1", "alidns_doh_v1"]))(
  process.env.DAC_BROWSER_INTERNET_RESOLVER ?? "cloudflare_doh_v1")

async function utility() {
  const { Effect, Layer, Option } = await import("effect")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { SecurityNamespaceTable } = await import("@deepagent-code/core/context-federation/sql")
  const { Project } = await import("@deepagent-code/core/project")
  const { ProjectTable } = await import("@deepagent-code/core/project/sql")
  const { AbsolutePath } = await import("@deepagent-code/core/schema")
  const { SessionSchema } = await import("@deepagent-code/core/session/schema")
  const { SessionTable } = await import("@deepagent-code/core/session/sql")
  const { BrowserSchema } = await import("@deepagent-code/core/browser/schema")
  const { BrowserControl } = await import("@deepagent-code/core/browser/control")
  const { BrowserNativeHost } = await import("../../../../deepagent-code/src/browser/native-host")
  const parent = Reflect.get(process, "parentPort") as { postMessage(value: unknown): void }
  await BrowserNativeHost.prepare()
  BrowserNativeHost.captureServerConfiguration({ username: "deepagent-code", password: Option.some("private-internet-fixture") })
  const host = BrowserNativeHost.current()
  assert.ok(host)
  const directory = await fs.realpath(path.join(root, "project"))
  const graph = LocationIdentity.layer.pipe(Layer.provideMerge(Database.layerFromPath(path.join(root, "browser.sqlite"))),
    Layer.provide(FSUtil.defaultLayer))
  const state = { stage: "create", phase: "starting", admitted: 0 }
  await fs.writeFile(path.join(root, "stage.json"), JSON.stringify(state), { mode: 0o600 })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_browser_internet_fixture"), project_id: Project.ID.global,
      slug: "internet", title: "Actual public transport", directory, version: "fixture", v2_authority: true }).run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
      directory: AbsolutePath.make(directory), project: { kind: "registered_root", observedProjectId: "project_internet_fixture" } })
    const namespace = (yield* db.select().from(SecurityNamespaceTable).all()).find((row) => row.id === identity.securityNamespaceId)
    assert.ok(namespace)
    const scope: typeof BrowserSchema.Scope.Type = { principal: host.principal, securityNamespaceID: identity.securityNamespaceId,
      namespaceBindingHash: namespace.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
      projectID: Project.ID.global, sessionID: "ses_browser_internet_fixture", directory: identity.canonicalRoot, workspaceID: null }
    const made = yield* BrowserControl.create(db, { request: { requestID: "internet-create", sessionID: scope.sessionID,
      profile: BrowserSchema.PUBLIC_READONLY_PROFILE, origin: "https://example.com", approvedOrigins: ["https://example.com"],
      resolverPolicy, expiresAt: Date.now() + 90_000 }, scope,
      hostID: host.hostID, hostIncarnation: host.hostIncarnation, credentialBinding: host.credentialBinding })
    yield* host.create(made.record)
    const control = yield* BrowserControl.observeControl(db, made.record, "active")
    if (control.profile !== BrowserSchema.PUBLIC_READONLY_PROFILE) throw new Error("Unexpected public transport profile")
    const execute = Effect.fnUntraced(function* (command: typeof BrowserSchema.Command.Type, stage: string) {
      state.stage = stage
      state.phase = "prepare"
      yield* Effect.promise(() => fs.writeFile(path.join(root, "stage.json"), JSON.stringify(state), { mode: 0o600 }))
      const action = yield* BrowserControl.prepareAction(db, { control, command, timeoutMs: 30_000,
        // This witness qualifies live transport; it never claims a canonical provider tool call.
        admission: { admissionId: `internet-${stage}`, sessionId: scope.sessionID, providerAttemptId: "controlled-transport",
          receiptId: "controlled-transport", toolCallId: stage, toolName: "browser", effectKind: "mutating",
          ownerToken: "controlled-transport", timeCreated: Date.now() } },
        (tx) => BrowserControl.requireActive(tx, control.controlID, scope, host).pipe(Effect.asVoid))
      state.admitted++
      state.phase = "admitted"
      yield* Effect.promise(() => fs.writeFile(path.join(root, "stage.json"), JSON.stringify(state), { mode: 0o600 }))
      const response = yield* host.execute(control, action,
        BrowserControl.requireActive(db, control.controlID, scope, host).pipe(Effect.asVoid))
      state.phase = "native-settled"
      yield* Effect.promise(() => fs.writeFile(path.join(root, "stage.json"), JSON.stringify(state), { mode: 0o600 }))
      yield* BrowserControl.observeAction(db, action, { outcome: "completed", result: response.result })
      return response
    })
    const initial = yield* execute({ type: "tabs.list" }, "tabs")
    const first = initial.result.tabs[0]
    assert.ok(first)
    const navigated = yield* execute({ type: "navigate", tabID: first.tabID, generation: first.generation,
      url: "https://example.com/" }, "navigate")
    const tab = navigated.result.tabs[0]
    assert.ok(tab)
    assert.equal(tab.url, "https://example.com/")
    const snapshot = yield* execute({ type: "snapshot", tabID: tab.tabID, generation: tab.generation }, "snapshot")
    assert.ok(snapshot.result.text?.includes("Example Domain"))
    const image = yield* execute({ type: "screenshot", tabID: tab.tabID, generation: tab.generation }, "screenshot")
    assert.ok(image.png && image.result.image)
    yield* Effect.promise(() => fs.writeFile(path.join(root, "internet.png"), Buffer.from(image.png!, "base64"), { mode: 0o600 }))
    const stopped = yield* BrowserControl.cancel(db, control.controlID, scope,
      { requestID: "internet-stop", expectedRevision: control.revision })
    assert.equal(yield* host.cancel(stopped.record), true)
    yield* BrowserControl.observeControl(db, stopped.record, "stopped")
    const census = yield* db.all<{ inputs: number; providers: number; work: number }>(
      "SELECT (SELECT count(*) FROM session_input) AS inputs, (SELECT count(*) FROM session_provider_attempt) AS providers, (SELECT count(*) FROM work_execution) AS work")
    assert.equal(census[0]?.inputs, 0)
    assert.equal(census[0]?.providers, 0)
    assert.equal(census[0]?.work, 0)
    return { origin: "https://example.com", profile: control.profile, resolverPolicy: control.resolverPolicy,
      exampleDomainObserved: true, image: image.result.image, actions: state.admitted, census: census[0],
      stopConfirmed: true, boundary: "actual-public-HTTPS/default-TLS/production-DoH-and-IP-broker/controlled-store-admission",
      node: process.versions.node, electron: process.versions.electron }
  }).pipe(Effect.tapError((error) => Effect.promise(() => fs.writeFile(path.join(root, "typed-failure.json"),
    JSON.stringify({ ...state, code: error instanceof BrowserSchema.Error ? error.code : "UNCLASSIFIED" }), { mode: 0o600 }))),
    Effect.provide(graph), Effect.scoped))
  parent.postMessage({ type: "internet-result", result })
  process.exit(0)
}

async function main() {
  const { app, utilityProcess, BrowserWindow } = await import("electron")
  const { installManagedBrowser } = await import("../managed-browser")
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.commandLine.appendSwitch("disable-background-networking")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const state = { result: undefined as unknown, close: undefined as undefined | (() => void) }
  const child = utilityProcess.fork(process.argv[1]!, [], { env: { ...process.env }, stdio: "pipe" })
  child.stdout?.on("data", (bytes: Buffer) => process.stdout.write(bytes))
  child.stderr?.on("data", (bytes: Buffer) => process.stderr.write(bytes))
  const timer = setTimeout(() => { state.close?.(); child.kill(); app.exit(2) }, 75_000)
  child.on("message", (message: { type?: string; result?: unknown }) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") state.close = installManagedBrowser(child, "private-internet-fixture")
    if (message.type === "internet-result") state.result = message.result
  })
  child.once("exit", (code) => {
    clearTimeout(timer)
    state.close?.()
    void fs.writeFile(path.join(root, "result.json"), JSON.stringify({ childExit: code, result: state.result,
      windows: BrowserWindow.getAllWindows().length, noPrivateTLSOrProxyOverride: true }), { mode: 0o600 }).then(() => app.exit(code ?? 1))
  })
}

void (Reflect.get(process, "type") === "utility" ? utility() : main()).catch(async (error: unknown) => {
  await fs.writeFile(path.join(root, Reflect.get(process, "type") === "utility" ? "utility-failure.json" : "main-failure.json"),
    JSON.stringify({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Fixture failed" }), { mode: 0o600 })
  if (Reflect.get(process, "type") === "utility") { process.exit(1); return }
  const { app } = await import("electron")
  app.exit(1)
})
