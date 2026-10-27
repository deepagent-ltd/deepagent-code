import os from "node:os"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Exit, Cause, Option, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { FSUtil } from "../src/fs-util"
import { LocationIdentity } from "../src/context-federation/identity"
import { SecurityNamespaceTable } from "../src/context-federation/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { BrowserControl } from "../src/browser/control"
import { BrowserSchema } from "../src/browser/schema"
import { BrowserActionTable, BrowserControlTable } from "../src/browser/browser.sql"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"

function fixture(filename: string) {
  const database = Database.layerFromPath(filename)
  return LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer))
}
const failure = (exit: Exit.Exit<unknown, BrowserSchema.Error>) => Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : null
const setup = (directory: string) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_browser_store"), project_id: Project.ID.global,
    slug: "browser", title: "Browser store", directory, version: "fixture", v2_authority: true }).onConflictDoNothing().run()
  const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" },
    directory: AbsolutePath.make(directory), project: { kind: "registered_root", observedProjectId: "project_browser_root" } })
  const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
  const scope: BrowserSchema.Scope = { principal: "operator", securityNamespaceID: identity.securityNamespaceId,
    namespaceBindingHash: namespace!.binding_hash, locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey,
    projectID: Project.ID.global, sessionID: "ses_browser_store", directory: identity.canonicalRoot, workspaceID: null }
  const input = { request: { requestID: "create-one", sessionID: scope.sessionID, profile: BrowserSchema.PROFILE,
    origin: "http://127.0.0.1:34567", expiresAt: Date.now() + 60_000 }, scope, hostID: "host", hostIncarnation: "incarnation",
    credentialBinding: "a".repeat(64) } satisfies Parameters<typeof BrowserControl.create>[1]
  const created = yield* BrowserControl.create(db, input)
  const control = yield* BrowserControl.observeControl(db, created.record, "active")
  return { db, input, control }
})
const admission = (suffix = "one") => ({ admissionId: `admission-${suffix}`, sessionId: "ses_browser_store", providerAttemptId: "attempt",
  receiptId: "receipt", toolCallId: `call-${suffix}`, toolName: "browser", effectKind: "mutating" as const, ownerToken: "owner", timeCreated: Date.now() })

test("public interaction pins exact page mode and same-origin targets without granting scripts or cold execution", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-public-interaction-control-")))
  const filename = path.join(directory, "control.sqlite")
  const records = await Effect.runPromise(Effect.gen(function* () {
    const value = yield* setup(directory)
    const request = { requestID: "public-interaction", sessionID: value.input.scope.sessionID,
      profile: BrowserSchema.PUBLIC_INTERACTION_PROFILE, origin: "https://example.com",
      approvedOrigins: ["https://example.com", "https://assets.example.com"], resolverPolicy: "system",
      pageMode: "dynamic", postTargets: [{ origin: "https://example.com", path: "/submit" }],
      expiresAt: Date.now() + 60_000 } satisfies BrowserSchema.Create
    const decoder = Schema.decodeUnknownOption(BrowserSchema.Create, { onExcessProperty: "error" })
    expect(Option.isSome(decoder(request))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, pageMode: undefined }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, approvedOrigins: ["https://assets.example.com"] }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, postTargets: [{ origin: "https://assets.example.com", path: "/submit" }] }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, postTargets: [...request.postTargets, ...request.postTargets] }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, scriptGrants: [] }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, programGrants: [] }))).toBeTrue()
    expect(Option.isNone(decoder({ ...request, clipboardPolicy: { read: true, write: false } }))).toBeTrue()
    const created = yield* BrowserControl.create(value.db, { ...value.input, request })
    const control = yield* BrowserControl.observeControl(value.db, created.record, "active")
    expect(control.profile).toBe(BrowserSchema.PUBLIC_INTERACTION_PROFILE)
    if (control.profile !== BrowserSchema.PUBLIC_INTERACTION_PROFILE)
      return yield* Effect.fail(new Error("Public profile was not retained"))
    expect(control.pageMode).toBe("dynamic")
    expect(control.postTargets).toEqual(request.postTargets)
    expect((yield* BrowserControl.create(value.db, { ...value.input, request })).created).toBeFalse()
    for (const changed of [
      { ...request, pageMode: "static" as const },
      { ...request, resolverPolicy: "cloudflare_doh_v1" as const },
      { ...request, postTargets: [{ origin: request.origin, path: "/other" }] },
    ]) expect(failure(yield* BrowserControl.create(value.db, { ...value.input, request: changed }).pipe(Effect.exit)))
      .toBe("BROWSER_CONFLICT")
    const readonly = yield* BrowserControl.create(value.db, { ...value.input, request: { requestID: "public-old-readonly",
      sessionID: request.sessionID, origin: request.origin, approvedOrigins: request.approvedOrigins,
      resolverPolicy: request.resolverPolicy, expiresAt: request.expiresAt, profile: BrowserSchema.PUBLIC_READONLY_PROFILE } })
    const readonlyControl = yield* BrowserControl.observeControl(value.db, readonly.record, "active")
    const fill = { type: "fill", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
      ref: "current-field", text: "approved" } satisfies BrowserSchema.Command
    const before = yield* value.db.all("SELECT total_changes() AS n")
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control: readonlyControl, command: fill,
      admission: admission("public-old-fill"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    for (const command of [
      { type: "navigate", tabID: "tab", generation: 1, url: "https://foreign.example.com/" },
      { type: "evaluate", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
        source: "return 1", argsJSON: "null", scriptHash: Hash.sha256("return 1") },
      { type: "program", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
        source: "return 1", argsJSON: "null", scriptHash: Hash.sha256("return 1"), targets: [{ name: "field", ref: "current-field" }] },
      { type: "clipboard.read", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1 },
      { type: "files.list" },
    ] satisfies BrowserSchema.Command[]) expect(Exit.isFailure(yield* BrowserControl.prepareAction(value.db,
      { control, command, admission: admission(`public-deny-${command.type}`), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBeTrue()
    expect(yield* value.db.all("SELECT total_changes() AS n")).toEqual(before)
    const action = yield* BrowserControl.prepareAction(value.db, { control, command: fill,
      admission: admission("public-fill"), timeoutMs: 1000 }, () => Effect.void)
    const pending = yield* BrowserControl.getAction(value.db, action.actionID)
    expect(pending?.outcome).toBe("pending")
    return { old: value.control, readonly: readonlyControl, control, pending }
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() AS n")
    expect(yield* BrowserControl.get(db, records.old.controlID)).toEqual(records.old)
    expect(yield* BrowserControl.get(db, records.readonly.controlID)).toEqual(records.readonly)
    expect(yield* BrowserControl.get(db, records.control.controlID)).toEqual(records.control)
    expect(yield* BrowserControl.getAction(db, records.pending!.actionID)).toEqual(records.pending)
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(before)
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
}, 30_000)

test("file-backed programs require their own immutable grant and retain one exact action through cold history", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-program-control-")))
  const filename = path.join(directory, "control.sqlite")
  const source = 'return {version:1,steps:[{type:"fill",target:"field",text:args.value}]}'
  const argsJSON = '{"value":"approved value"}'
  const command = { type: "program", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
    source, argsJSON, scriptHash: Hash.sha256(source), targets: [{ name: "field", ref: "fresh-ref" }] } satisfies BrowserSchema.Command
  const grant = { scriptHash: command.scriptHash, argsHash: Hash.sha256(argsJSON), operations: ["fill"], maxSteps: 4 } satisfies
    typeof BrowserSchema.ProgramGrants.Type[number]
  const records = await Effect.runPromise(Effect.gen(function* () {
    const value = yield* setup(directory)
    const before = yield* value.db.all("SELECT total_changes() AS n")
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control: value.control, command,
      admission: admission("old-program"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    expect(yield* value.db.all("SELECT total_changes() AS n")).toEqual(before)
    const readonly = yield* BrowserControl.create(value.db, { ...value.input, request: { ...value.input.request,
      requestID: "readonly-program-denied", profile: BrowserSchema.INTERACTION_PROFILE, postPaths: [],
      scriptGrants: [{ scriptHash: grant.scriptHash, argsHash: grant.argsHash, readOnly: true }] } })
    const readonlyControl = yield* BrowserControl.observeControl(value.db, readonly.record, "active")
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control: readonlyControl, command,
      admission: admission("readonly-program"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    const request = { ...value.input.request, requestID: "program-create", profile: BrowserSchema.INTERACTION_PROFILE,
      postPaths: [], programGrants: [grant] } satisfies BrowserSchema.Create
    const created = yield* BrowserControl.create(value.db, { ...value.input, request })
    const control = yield* BrowserControl.observeControl(value.db, created.record, "active")
    expect((yield* BrowserControl.create(value.db, { ...value.input, request })).created).toBeFalse()
    expect(failure(yield* BrowserControl.create(value.db, { ...value.input, request: { ...request,
      programGrants: [{ ...grant, maxSteps: 3 }] } }).pipe(Effect.exit))).toBe("BROWSER_CONFLICT")
    expect(BrowserSchema.allowsProgram(control, command)).toBeTrue()
    expect(BrowserSchema.allowsProgram(control, { ...command, argsJSON: '{"value":"changed"}' })).toBeFalse()
    expect(BrowserSchema.allowsScript(control, { ...command, type: "evaluate" })).toBeFalse()
    const action = yield* BrowserControl.prepareAction(value.db, { control, command, admission: admission("program"), timeoutMs: 1000 }, () => Effect.void)
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control, command, admission: admission("program"), timeoutMs: 1000 }, () => Effect.void)
      .pipe(Effect.exit))).toBe("BROWSER_UNKNOWN")
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control, command: { ...command,
      targets: [{ name: "field", ref: "another-ref" }] }, admission: admission("program"), timeoutMs: 1000 }, () => Effect.void)
      .pipe(Effect.exit))).toBe("BROWSER_CONFLICT")
    expect(failure(yield* BrowserControl.observeAction(value.db, action, { outcome: "completed", result: { tabs: [] } })
      .pipe(Effect.exit))).toBe("BROWSER_INVALID_RECORD")
    const plan = { version: 1, steps: [{ type: "fill", target: "field", text: "approved value" }] }
    const settled = yield* BrowserControl.observeAction(value.db, action, { outcome: "completed", result: { tabs: [], program: {
      version: 1, planHash: BrowserControl.hash(plan), totalSteps: 1, completedSteps: 1,
      steps: [{ ordinal: 0, operation: "fill" }],
    } } })
    expect(yield* value.db.all("SELECT action_id FROM browser_action")).toHaveLength(1)
    return { old: value.control, readonly: readonlyControl, control, settled }
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() AS n")
    for (const record of [records.old, records.readonly, records.control]) expect(yield* BrowserControl.get(db, record.controlID)).toEqual(record)
    expect(yield* BrowserControl.getAction(db, records.settled.actionID)).toEqual(records.settled)
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(before)
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
}, 30_000)

test("file-backed clipboard grants preserve old control bytes, exact admission and command-bound terminal evidence", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-clipboard-control-")))
  const filename = path.join(directory, "control.sqlite")
  const records = await Effect.runPromise(Effect.gen(function* () {
    const value = yield* setup(directory)
    const command = { type: "clipboard.read", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1 } satisfies BrowserSchema.Command
    const before = yield* value.db.all("SELECT total_changes() AS n")
    expect(BrowserSchema.allowsClipboard(value.control, command)).toBeFalse()
    expect("clipboardPolicy" in value.control).toBeFalse()
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control: value.control, command,
      admission: admission("old-clipboard"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    expect(yield* value.db.all("SELECT total_changes() AS n")).toEqual(before)
    const request = { ...value.input.request, requestID: "clipboard-grant", profile: BrowserSchema.INTERACTION_PROFILE,
      postPaths: [], clipboardPolicy: { read: true, write: false } } satisfies BrowserSchema.Create
    const created = yield* BrowserControl.create(value.db, { ...value.input, request })
    const control = yield* BrowserControl.observeControl(value.db, created.record, "active")
    expect((yield* BrowserControl.create(value.db, { ...value.input, request })).created).toBeFalse()
    expect(failure(yield* BrowserControl.create(value.db, { ...value.input, request: { ...request,
      clipboardPolicy: { read: false, write: true } } }).pipe(Effect.exit))).toBe("BROWSER_CONFLICT")
    expect(failure(yield* BrowserControl.create(value.db, { ...value.input, request: { ...request,
      requestID: "empty-clipboard", clipboardPolicy: { read: false, write: false } } }).pipe(Effect.exit))).toBe("BROWSER_INVALID_RECORD")
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control, command: { ...command, type: "clipboard.write", text: "blocked" },
      admission: admission("clipboard-write-denied"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    const action = yield* BrowserControl.prepareAction(value.db, { control, command, admission: admission("clipboard-read"), timeoutMs: 1000 }, () => Effect.void)
    expect(failure(yield* BrowserControl.prepareAction(value.db, { control, command, admission: admission("clipboard-read"), timeoutMs: 1000 }, () => Effect.void)
      .pipe(Effect.exit))).toBe("BROWSER_UNKNOWN")
    expect(failure(yield* BrowserControl.observeAction(value.db, action, { outcome: "completed", result: {
      tabs: [], clipboard: { direction: "write", bytes: 0, sha256: Hash.sha256("") },
    } }).pipe(Effect.exit))).toBe("BROWSER_INVALID_RECORD")
    expect(failure(yield* BrowserControl.observeAction(value.db, action, { outcome: "completed", result: {
      tabs: [], clipboard: { direction: "read", text: "剪贴板", bytes: 9, sha256: Hash.sha256("forged") },
    } }).pipe(Effect.exit))).toBe("BROWSER_INVALID_RECORD")
    const settled = yield* BrowserControl.observeAction(value.db, action, { outcome: "completed", result: {
      tabs: [], clipboard: { direction: "read", text: "剪贴板", bytes: 9, sha256: Hash.sha256("剪贴板") },
    } })
    expect((yield* value.db.all("SELECT action_id FROM browser_action"))).toHaveLength(1)
    return { old: value.control, control, settled }
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all("SELECT total_changes() AS n")
    expect(yield* BrowserControl.get(db, records.old.controlID)).toEqual(records.old)
    expect(yield* BrowserControl.get(db, records.control.controlID)).toEqual(records.control)
    expect(yield* BrowserControl.getAction(db, records.settled.actionID)).toEqual(records.settled)
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(before)
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
}, 30_000)

test("public readonly profile persists exact origins and resolver, rejects interaction before admission and reopens without writes", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-public-control-")))
  const filename = path.join(directory, "control.sqlite")
  const record = await Effect.runPromise(Effect.gen(function* () {
    const { db, input } = yield* setup(directory)
    const request = { requestID: "public-create", sessionID: input.scope.sessionID,
      profile: BrowserSchema.PUBLIC_READONLY_PROFILE, origin: "https://example.com",
      approvedOrigins: ["https://example.com", "https://www.example.com"], resolverPolicy: "system",
      expiresAt: Date.now() + 60_000 } satisfies BrowserSchema.Create
    const created = yield* BrowserControl.create(db, { ...input, request })
    const control = yield* BrowserControl.observeControl(db, created.record, "active")
    expect(control.profile).toBe(BrowserSchema.PUBLIC_READONLY_PROFILE)
    expect(yield* BrowserControl.get(db, control.controlID)).toEqual(control)
    const changes = yield* db.all("SELECT total_changes() AS n")
    expect((yield* BrowserControl.create(db, { ...input, request })).created).toBeFalse()
    expect(failure(yield* BrowserControl.create(db, { ...input, request: { ...request, resolverPolicy: "cloudflare_doh_v1" } }).pipe(Effect.exit))).toBe("BROWSER_CONFLICT")
    for (const change of [
      { origin: "https://127.0.0.1", approvedOrigins: ["https://127.0.0.1"] },
      { origin: "https://example.com.", approvedOrigins: ["https://example.com."] },
      { origin: "https://user@example.com", approvedOrigins: ["https://user@example.com"] },
      { approvedOrigins: ["https://www.example.com"] },
      { approvedOrigins: ["https://example.com", "https://example.com"] },
      { postPaths: ["/submit"] }, { scriptGrants: [] }, { resolverPolicy: "fallback" },
    ]) expect(failure(yield* BrowserControl.create(db, { ...input,
      request: { ...request, ...change, requestID: "invalid-public" } as BrowserSchema.Create }).pipe(Effect.exit))).toBe("BROWSER_INVALID_RECORD")
    expect(failure(yield* BrowserControl.prepareAction(db, { control,
      command: { type: "navigate", tabID: "tab", generation: 1, url: "https://unapproved.example.com" },
      admission: admission("public-denied-nav"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_NETWORK_DENIED")
    expect(failure(yield* BrowserControl.prepareAction(db, { control,
      command: { type: "fill", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1, ref: "ref", text: "blocked" },
      admission: admission("public-denied-fill"), timeoutMs: 1000 }, () => Effect.void).pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(changes)
    expect(yield* db.all("SELECT action_id FROM browser_action")).toEqual([])
    return control
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const changes = yield* db.all("SELECT total_changes() AS n")
    expect(yield* BrowserControl.get(db, record.controlID)).toEqual(record)
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(changes)
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
}, 30_000)

test("formal file DB: exact identity, current namespace, atomic rollback, one admitted action and cold read-only history", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-control-")))
  const filename = path.join(directory, "control.sqlite")
  const record = await Effect.runPromise(Effect.gen(function* () {
    const { db, input, control } = yield* setup(directory)
    expect(failure(yield* Effect.exit(BrowserControl.requireScope(db, control.scope, {
      directory: AbsolutePath.make(directory), project: { id: Project.ID.make("different_project"), directory: AbsolutePath.make(directory) },
    })))).toBe("BROWSER_SCOPE_DENIED")
    yield* BrowserControl.requireScope(db, control.scope, {
      directory: AbsolutePath.make(directory), project: { id: Project.ID.global, directory: AbsolutePath.make(directory) },
    })
    const before = yield* db.all<{ changes: number }>(sql`SELECT total_changes() AS changes`)
    const retry = yield* BrowserControl.create(db, input)
    expect(retry.created).toBe(false)
    expect(retry.record).toEqual(control)
    expect(yield* BrowserControl.get(db, control.controlID)).toEqual(control)
    expect(yield* db.all(sql`SELECT total_changes() AS changes`)).toEqual(before)
    expect(failure(yield* Effect.exit(BrowserControl.create(db, { ...input, request: { ...input.request, origin: "http://127.0.0.1:34568" } })))).toBe("BROWSER_CONFLICT")
    const count = () => db.select({ count: sql<number>`count(*)` }).from(BrowserActionTable).get()
    expect(failure(yield* Effect.exit(BrowserControl.prepareAction(db, { control,
      command: { type: "fill", tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1, ref: "opaque", text: "blocked" },
      admission: admission("preview-input"), timeoutMs: 1000 }, () => Effect.void)))).toBe("BROWSER_SCOPE_DENIED")
    expect((yield* count())!.count).toBe(0)
    const rollback = yield* Effect.exit(BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" }, admission: admission(), timeoutMs: 1000 },
      (tx) => tx.update(SessionTable).set({ title: "must rollback" }).where(eq(SessionTable.id, SessionSchema.ID.make(control.scope.sessionID))).run()
        .pipe(Effect.orDie, Effect.andThen(Effect.fail(BrowserControl.failure("BROWSER_OWNER_LOST"))))))
    expect(failure(rollback)).toBe("BROWSER_OWNER_LOST")
    expect((yield* count())!.count).toBe(0)
    expect((yield* db.select().from(SessionTable).get())!.title).toBe("Browser store")
    const action = yield* BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" }, admission: admission(), timeoutMs: 1000 },
      (tx) => BrowserControl.requireScope(tx, control.scope))
    expect(failure(yield* Effect.exit(BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" }, admission: admission(), timeoutMs: 1000 },
      () => Effect.void)))).toBe("BROWSER_UNKNOWN")
    const terminal = yield* BrowserControl.observeAction(db, action, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN", stopConfirmed: true })
    expect(terminal.stopConfirmedAt).not.toBeNull()
    expect((yield* BrowserControl.actionView(db, terminal, control)).effectID).toBeNull()
    const cancelled = yield* BrowserControl.cancel(db, control.controlID, control.scope, { requestID: "cancel-one", expectedRevision: control.revision })
    expect(cancelled.record.epoch).toBe(2)
    const stopped = yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
    expect((yield* BrowserControl.cancel(db, control.controlID, control.scope, { requestID: "cancel-one", expectedRevision: control.revision })).changed).toBe(false)
    expect(failure(yield* Effect.exit(BrowserControl.requireActive(db, control.controlID, control.scope, input)))).toBe("BROWSER_CANCELLED")
    yield* db.update(SecurityNamespaceTable).set({ retired_at: Date.now() }).where(eq(SecurityNamespaceTable.id, control.scope.securityNamespaceID)).run()
    expect(failure(yield* Effect.exit(BrowserControl.requireScope(db, control.scope)))).toBe("BROWSER_SCOPE_DENIED")
    return { stopped, terminal }
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const before = yield* db.all(sql`SELECT total_changes() AS changes`)
    expect(yield* BrowserControl.get(db, record.stopped.controlID)).toEqual(record.stopped)
    expect(yield* BrowserControl.getAction(db, record.terminal.actionID)).toEqual(record.terminal)
    expect(yield* db.all(sql`SELECT total_changes() AS changes`)).toEqual(before)
  }).pipe(Effect.provide(fixture(filename)), Effect.scoped))
  console.log("BROWSER_CONTROL_EVIDENCE", directory)
}, 30_000)

test("record mirror corruption and physical bounds fail closed; capacity never consumes cancel terminal reserve", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-control-bounds-")))
  await Effect.runPromise(Effect.gen(function* () {
    const { db, control } = yield* setup(directory)
    const invalid = yield* Effect.exit(db.run(sql`UPDATE browser_control SET revision = 1.5 WHERE control_id = ${control.controlID}`))
    expect(Exit.isFailure(invalid)).toBe(true)
    yield* db.update(BrowserControlTable).set({ origin: "http://127.0.0.1:34568" }).where(eq(BrowserControlTable.control_id, control.controlID)).run()
    expect(failure(yield* Effect.exit(BrowserControl.get(db, control.controlID)))).toBe("BROWSER_INVALID_RECORD")
    yield* db.update(BrowserControlTable).set({ origin: control.origin }).where(eq(BrowserControlTable.control_id, control.controlID)).run()
    const action = yield* BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" }, admission: admission(), timeoutMs: 1000 }, () => Effect.void)
    const oversized = yield* Effect.exit(BrowserControl.observeAction(db, action, { outcome: "completed", result: { tabs: [], text: "\u0000".repeat(65_536) } }))
    expect(failure(oversized)).toBe("BROWSER_CAPACITY")
    expect((yield* BrowserControl.getAction(db, action.actionID))!.outcome).toBe("pending")
    const unknown = yield* BrowserControl.observeAction(db, action, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
    expect(Buffer.byteLength(CanonicalJson.stringify(unknown))).toBeLessThan(BrowserSchema.MAX_ACTION_BYTES)
    const cancelled = yield* BrowserControl.cancel(db, control.controlID, control.scope, { requestID: "\u0000".repeat(512), expectedRevision: control.revision })
    const stopped = yield* BrowserControl.observeControl(db, cancelled.record, "stopped")
    expect(Buffer.byteLength(CanonicalJson.stringify(stopped))).toBeLessThan(BrowserSchema.MAX_CONTROL_BYTES)
    expect(stopped.stopConfirmedAt).not.toBeNull()
  }).pipe(Effect.provide(fixture(path.join(directory, "bounds.sqlite"))), Effect.scoped))
}, 30_000)

test("instance logical reservation budget rejects new actions but preserves existing unknown and cancel evidence", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-capacity-")))
  await Effect.runPromise(Effect.gen(function* () {
    const { db, control } = yield* setup(directory)
    const pending = yield* BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" },
      admission: admission("pending"), timeoutMs: 1000 }, () => Effect.void)
    let count = 1
    for (; count < BrowserSchema.MAX_ACTIONS; count++) {
      const result = yield* Effect.exit(BrowserControl.prepareAction(db, { control, command: { type: "tabs.list" },
        admission: admission(String(count)), timeoutMs: 1000 }, () => Effect.void))
      if (Exit.isFailure(result)) {
        expect(failure(result)).toBe("BROWSER_CAPACITY")
        break
      }
      yield* BrowserControl.observeAction(db, result.value, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
    }
    expect(count).toBeLessThan(BrowserSchema.MAX_ACTIONS)
    expect(count).toBeGreaterThan(400)
    expect((yield* db.select({ count: sql<number>`count(*)` }).from(BrowserActionTable).get())!.count).toBe(count)
    expect((count + 1) * (BrowserSchema.MAX_ACTION_BYTES + BrowserSchema.ROW_OVERHEAD_BYTES) +
      BrowserSchema.MAX_CONTROL_BYTES + BrowserSchema.ROW_OVERHEAD_BYTES).toBeGreaterThan(BrowserSchema.MAX_RESERVED_BYTES)
    expect((yield* BrowserControl.observeAction(db, pending, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })).outcome).toBe("unknown")
    const cancelled = yield* BrowserControl.cancel(db, control.controlID, control.scope, {
      requestID: "\u0000".repeat(512), expectedRevision: control.revision,
    })
    expect((yield* BrowserControl.observeControl(db, cancelled.record, "stopped")).state).toBe("stopped")
  }).pipe(Effect.provide(fixture(path.join(directory, "capacity.sqlite"))), Effect.scoped))
}, 30_000)


test("interaction policy rejects ambiguous POST paths and exposes only bounded observation-bound inputs", () => {
  const valid = Schema.is(BrowserSchema.Create)
  const request = { requestID: "interaction", sessionID: "session", origin: "http://127.0.0.1:45001",
    profile: BrowserSchema.INTERACTION_PROFILE, expiresAt: Date.now() + 60_000, postPaths: ["/submit"] }
  expect(valid(request)).toBe(true)
  for (const value of ["//submit", "/../submit", "/a/./submit", "/submit?query", "/submit#hash", "/a%2fb", "/a%5Cb", "/a%00", "/a%252fb", "/a%", "/a\\b"])
    expect(valid({ ...request, postPaths: [value] })).toBe(false)
  expect(valid({ ...request, postPaths: ["/submit", "/submit"] })).toBe(false)
  expect(valid({ ...request, postPaths: Array.from({ length: 9 }, (_, i) => `/${i}`) })).toBe(false)
  expect(valid({ ...request, postPaths: ["/" + "a".repeat(2048)] })).toBe(false)
  const target = { tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1, ref: "opaque" }
  expect(Schema.is(BrowserSchema.Command)({ type: "fill", ...target, text: "中".repeat(5461) })).toBe(true)
  expect(Schema.is(BrowserSchema.Command)({ type: "fill", ...target, text: "中".repeat(5462) })).toBe(false)
  expect(Schema.is(BrowserSchema.Command)({ type: "press", ...target, key: "Meta+s" })).toBe(false)
  expect(Schema.is(BrowserSchema.Command)({ type: "press", ...target, key: "Enter" })).toBe(true)
})
