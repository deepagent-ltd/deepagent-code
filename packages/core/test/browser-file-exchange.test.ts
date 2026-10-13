import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { eq } from "drizzle-orm"
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
import { BrowserFileSchema } from "../src/browser/file-exchange.schema"
import { BrowserFileCapability } from "../src/browser/file-capability"
import { BrowserFileExchange } from "../src/browser/file-exchange"
import { BrowserFileCapacityTable } from "../src/browser/browser-file.sql"

const code = (exit: Exit.Exit<unknown, BrowserFileSchema.Error | BrowserSchema.Error>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : undefined

test("real fileDB: explicit grant ledger, atomic capacity, original-action once and cold unknown zero retransfer", async () => {
  const directory = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-files-store-"))
  await fs.chmod(directory, 0o700)
  const bytes = Buffer.alloc(BrowserFileSchema.MAX_FILE_BYTES, 0xfe)
  await fs.writeFile(path.join(directory, "source.bin"), bytes, { mode: 0o600 })
  const fileStat = await fs.lstat(path.join(directory, "source.bin"), { bigint: true })
  const rootStat = await fs.lstat(directory, { bigint: true })
  const fileHash = createHash("sha256").update(bytes).digest("hex")
  const filename = path.join(directory, "files.sqlite")
  const database = Database.layerFromPath(filename)
  const layers = LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer))
  // Controlled opaque producer only: storage/admission oracles below are not an installed Native approval.
  const previews = new WeakMap<BrowserFileCapability.Preview, BrowserFileSchema.Preview>()
  const approvals = new WeakMap<BrowserFileCapability.Approval, BrowserFileSchema.Confirmation>()
  const facts = { confirms: 0, transfers: 0 }
  const trap = () => Effect.die("No file execution in the store oracle")
  const producer: BrowserFileCapability.Interface = {
    preview: ({ control, request }) => Effect.sync(() => {
      if (request.direction !== "upload") throw new Error("Only actual source-file upload previews in this store oracle")
      const handle = Object.freeze({}) as BrowserFileCapability.Preview
      previews.set(handle, { version: 1, instanceID: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", controlID: control.controlID,
        controlHash: BrowserFileExchange.hash(control), scopeHash: BrowserFileExchange.hash(control.scope), helperHash: "a".repeat(64),
        rootIdentity: { kind: "posix", device: String(rootStat.dev), inode: String(rootStat.ino) }, relative: request.relative,
        name: "source.bin", observedAt: Date.now(), direction: "upload", targetPath: request.targetPath,
        fileIdentity: { kind: "posix", device: String(fileStat.dev), inode: String(fileStat.ino) }, bytes: bytes.length, sha256: fileHash })
      return handle
    }),
    describePreview: (handle) => previews.get(handle), currentPreview: () => Effect.void,
    confirm: (handle, command) => Effect.sync(() => {
      facts.confirms++
      const approved = Object.freeze({}) as BrowserFileCapability.Approval
      approvals.set(approved, { previewHash: BrowserFileExchange.hash(previews.get(handle)), commandHash: BrowserFileExchange.hash(command),
        confirmationHash: "b".repeat(64), confirmedAt: Date.now() })
      return approved
    }),
    approved: (handle, preview, command) => approvals.get(handle)?.commandHash === BrowserFileExchange.hash(command) &&
      approvals.get(handle)?.previewHash === BrowserFileExchange.hash(previews.get(preview)),
    describeApproval: (handle) => approvals.get(handle), acceptGrant: () => true,
    prepare: () => { facts.transfers++; return trap() }, current: trap, readUpload: trap, writeDownload: trap,
    sealUpload: trap, observeUpload: trap, publishDownload: trap, describe: () => undefined, cleanup: trap, describeReleased: () => undefined,
  }
  const saved = await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: SessionSchema.ID.make("ses_browser_files"), project_id: Project.ID.global,
      slug: "files", title: "Browser file store", directory, version: "fixture", v2_authority: true }).run()
    const identity = yield* (yield* LocationIdentity.Service).resolve({ boundary: { kind: "implicit_local" }, directory: AbsolutePath.make(directory),
      project: { kind: "registered_root", observedProjectId: "project_browser_files" } })
    const namespace = yield* db.select().from(SecurityNamespaceTable).where(eq(SecurityNamespaceTable.id, identity.securityNamespaceId)).get()
    const scope: BrowserSchema.Scope = { principal: "operator", securityNamespaceID: identity.securityNamespaceId, namespaceBindingHash: namespace!.binding_hash,
      locationKey: identity.locationKey, projectScopeKey: identity.projectScopeKey, projectID: Project.ID.global, sessionID: "ses_browser_files",
      directory, workspaceID: null }
    const created = yield* BrowserControl.create(db, { request: { requestID: "files-create", sessionID: scope.sessionID,
      profile: BrowserSchema.FILE_EXCHANGE_PROFILE, origin: "http://127.0.0.1:34567", postPaths: ["/upload"],
      filePolicy: { upload: true, download: true }, expiresAt: Date.now() + 120_000 }, scope, hostID: "host", hostIncarnation: "incarnation", credentialBinding: "a".repeat(64) })
    const control = yield* BrowserControl.observeControl(db, created.record, "active")
    const before = yield* db.all("SELECT total_changes() AS n")
    expect(code(yield* BrowserFileExchange.preview(db, { controlID: control.controlID, scope,
      request: { direction: "upload", relative: "source.bin", targetPath: "/upload" } }).pipe(Effect.exit))).toBe("BROWSER_FILE_UNAVAILABLE")
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(before)
    const grantIDs: string[] = []
    for (let index = 0; index < 12; index++) {
      const input = { controlID: control.controlID, scope, request: { direction: "upload" as const, relative: "source.bin", targetPath: "/upload" } }
      const capture = yield* BrowserFileExchange.preview(db, input).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
      const command: BrowserFileSchema.Approve = { previewID: `preview-${index}`, requestID: `grant-${index}`,
        expectedControlRevision: control.revision, expiresAt: Date.now() + 100_000 }
      if (index === 0) expect(code(yield* BrowserFileExchange.approve(db, { ...input, command }, capture)
        .pipe(Effect.provideService(BrowserFileCapability.Service, producer), Effect.exit))).toBe("BROWSER_FILE_SCOPE_DENIED")
      yield* BrowserFileExchange.confirm(db, capture, command).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
      const grant = yield* BrowserFileExchange.approve(db, { ...input, command }, capture).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
      grantIDs.push(grant.grant.grantID)
      if (index === 0) {
        const changes = yield* db.all("SELECT total_changes() AS n")
        expect((yield* BrowserFileExchange.approve(db, { ...input, command })).replayed).toBe(true)
        expect(code(yield* BrowserFileExchange.approve(db, { ...input, command: { ...command, expiresAt: command.expiresAt + 1 } }).pipe(Effect.exit))).toBe("BROWSER_FILE_CONFLICT")
        expect(yield* db.all("SELECT total_changes() AS n")).toEqual(changes)
      }
    }
    expect(facts.confirms).toBe(12)
    const command = (ids: string[]): BrowserSchema.Command => ({ type: "file.upload", tabID: "tab", generation: 1,
      frameID: "frame", observationRevision: 1, ref: "ref", grantIDs: ids })
    const prepare = (ids: string[], id: string) => BrowserControl.prepareAction(db, { control, command: command(ids), timeoutMs: 30_000,
      admission: { admissionId: id, sessionId: scope.sessionID, providerAttemptId: "attempt", receiptId: "receipt", toolCallId: id,
        toolName: "browser", effectKind: "mutating", ownerToken: "owner", timeCreated: Date.now() } }, () => Effect.void)
    const first = yield* prepare(grantIDs.slice(0, 4), "first")
    const second = yield* prepare(grantIDs.slice(4, 8), "second")
    const meter = yield* db.select().from(BrowserFileCapacityTable).get()
    expect(meter!.reserved_bytes).toBeGreaterThan(800 * 1024 * 1024)
    expect(meter!.artifact_count).toBe(8)
    const priorActions = yield* db.all("SELECT action_id FROM browser_action")
    const priorMeter = meter
    expect(code(yield* prepare(grantIDs.slice(8, 12), "capacity").pipe(Effect.exit))).toBe("BROWSER_CAPACITY")
    expect(yield* db.all("SELECT action_id FROM browser_action")).toEqual(priorActions)
    expect(yield* db.select().from(BrowserFileCapacityTable).get()).toEqual(priorMeter)
    const files = yield* BrowserFileExchange.actionFiles(db, first)
    for (const file of files) yield* BrowserFileExchange.unknown(db, file.artifact)
    yield* BrowserControl.observeAction(db, first, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
    yield* BrowserControl.observeAction(db, second, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
    const beforeRetry = yield* db.all("SELECT total_changes() AS n")
    expect(code(yield* prepare(grantIDs.slice(0, 4), "first").pipe(Effect.exit))).toBe("BROWSER_UNKNOWN")
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(beforeRetry)
    const durable = yield* db.all("SELECT action_id,record FROM browser_action ORDER BY action_id")
    const custody = yield* db.select().from(BrowserFileCapacityTable).get()
    expect(code(yield* prepare(grantIDs.slice(0, 4), "again").pipe(Effect.exit))).toBe("BROWSER_SCOPE_DENIED")
    // SQLite total_changes includes INSERTs rolled back with the rejected transaction.
    // Compare durable rows for a different admission; exact original retry above performs no write.
    expect(yield* db.all("SELECT action_id,record FROM browser_action ORDER BY action_id")).toEqual(durable)
    expect(yield* db.select().from(BrowserFileCapacityTable).get()).toEqual(custody)
    expect(facts.transfers).toBe(0)
    return { scope, controlID: control.controlID, meter: yield* db.select().from(BrowserFileCapacityTable).get() }
  }).pipe(Effect.provide(layers), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const changes = yield* db.all("SELECT total_changes() AS n")
    const page = yield* BrowserFileExchange.list(db, { scope: saved.scope, controlID: saved.controlID, limit: 4 })
    expect(page.records.length).toBe(4)
    expect(page.nextCursor).not.toBeNull()
    const next = yield* BrowserFileExchange.list(db, { scope: saved.scope, controlID: saved.controlID, limit: 4, cursor: page.nextCursor! })
    expect(next.records.every((row) => !page.records.some((prior) => row.grant.grantID === prior.grant.grantID))).toBe(true)
    expect(yield* db.select().from(BrowserFileCapacityTable).get()).toEqual(saved.meter)
    expect(yield* db.all("SELECT total_changes() AS n")).toEqual(changes)
    expect(facts.transfers).toBe(0)
  }).pipe(Effect.provide(layers), Effect.scoped))
  await fs.rm(directory, { recursive: true, force: true })
}, 30_000)
