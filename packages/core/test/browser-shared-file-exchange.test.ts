import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Cause, Option } from "effect"
import { BrowserFileAuthorityFixture } from "./fixture/browser-file-authority"
import { BrowserSchema } from "../src/browser/schema"
import { BrowserFileCapability } from "../src/browser/file-capability"
import { BrowserFileSchema } from "../src/browser/file-exchange.schema"
import { BrowserFileExchange } from "../src/browser/file-exchange"
import { BrowserFileCapacityTable } from "../src/browser/browser-file.sql"
import { SharedBrowserSchema } from "../src/browser/shared-schema"
import { SharedBrowserControl } from "../src/browser/shared-control"
import { SharedBrowserFileSchema } from "../src/browser/shared-file-schema"
import { SharedBrowserFileBinding } from "../src/browser/shared-file-binding"
import { SharedBrowserFileExchange } from "../src/browser/shared-file-exchange"

const hash = BrowserFileExchange.hash
const code = (exit: Exit.Exit<unknown, BrowserFileSchema.Error | BrowserSchema.Error>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code : undefined

test("shared fileDB: original tables and meter, exact approval, atomic once, opaque publication and unknown custody", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const scope = fixture.captureInput.control.scope
    const source = Buffer.from([0, 0xff, 0x12, 0x0a])
    yield* Effect.promise(() => fs.writeFile(path.join(scope.directory, "source.bin"), source, { mode: 0o600 }))
    const root = yield* Effect.promise(() => fs.lstat(scope.directory, { bigint: true }))
    const file = yield* Effect.promise(() => fs.lstat(path.join(scope.directory, "source.bin"), { bigint: true }))
    const created = yield* SharedBrowserControl.create(fixture.db, { scope, mainIncarnation: "actual-main-distinct",
      sidecarIncarnation: fixture.captureInput.host.hostIncarnation,
      request: { version: 2, profile: SharedBrowserSchema.PROFILE, inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        requestID: "shared-files-create", sessionID: scope.sessionID, expiresAt: Date.now() + 120_000,
        policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"], manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } } } })
    const resource = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource,
      { resourceID: created.resource.resourceID, mainIncarnation: "actual-main-distinct", manualEpoch: 0, barrierOrder: 0,
        resourceAlive: true, agentAccessFenced: false, leaseRevoked: false, inputIsolated: true, heldReleased: true,
        transportStopped: true, manualEnabled: false, unknownEffects: false, leaseID: created.lease.leaseID, leaseEpoch: 1 })
    const lease = yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID)
    if (!lease) throw new Error("Missing actual lease")
    const previews = new WeakMap<BrowserFileCapability.Preview, SharedBrowserFileSchema.Preview>()
    const approvals = new WeakMap<BrowserFileCapability.Approval, BrowserFileSchema.Confirmation>()
    const publications = new WeakMap<BrowserFileCapability.Observation, BrowserFileSchema.Publication>()
    const releases = new WeakMap<BrowserFileCapability.Released, readonly string[]>()
    const facts = { confirmations: 0, accepts: 0, execution: 0 }
    const unavailable = () => Effect.die("Store oracle must not execute file/native/network operations")
    // Controlled opaque producer: real fileDB admission evidence, not actual Main/Native qualification.
    const shared: BrowserFileCapability.Shared = {
      preview: (input) => Effect.sync(() => {
        if (input.request.direction !== "upload") throw new Error("Only real upload observation in this fixture")
        const handle = Object.freeze({}) as BrowserFileCapability.Preview
        const binding = SharedBrowserFileBinding.from(input.resource, input.lease)
        previews.set(handle, { version: 2, binding, bindingHash: hash(binding), instanceID: "shared-original-factory-instance",
          scopeHash: hash(scope), helperHash: "a".repeat(64), rootIdentity: { kind: "posix", device: String(root.dev), inode: String(root.ino) },
          relative: input.request.relative, name: "source.bin", observedAt: Date.now(), direction: "upload", targetURL: input.request.targetURL,
          fileIdentity: { kind: "posix", device: String(file.dev), inode: String(file.ino) }, bytes: source.length,
          sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex") })
        return handle
      }),
      describePreview: (handle) => previews.get(handle), currentPreview: () => Effect.void,
      confirm: (handle, command) => Effect.sync(() => {
        facts.confirmations++
        const approved = Object.freeze({}) as BrowserFileCapability.Approval
        approvals.set(approved, { previewHash: hash(previews.get(handle)), commandHash: hash(command), confirmationHash: "b".repeat(64), confirmedAt: Date.now() })
        return approved
      }),
      approved: (handle, preview, command) => approvals.get(handle)?.commandHash === hash(command) && approvals.get(handle)?.previewHash === hash(previews.get(preview)),
      describeApproval: (handle) => approvals.get(handle), acceptGrant: () => { facts.accepts++; return true },
      prepare: () => { facts.execution++; return unavailable() }, executionFiles: unavailable, finishAction: unavailable,
    }
    const producer: BrowserFileCapability.Interface = { shared, preview: unavailable, describePreview: () => undefined, currentPreview: unavailable,
      confirm: unavailable, approved: () => false, describeApproval: () => undefined, acceptGrant: () => false,
      prepare: unavailable, current: unavailable, readUpload: unavailable, writeDownload: unavailable, sealUpload: unavailable,
      observeUpload: unavailable, publishDownload: unavailable, describe: (handle) => publications.get(handle), cleanup: unavailable,
      describeReleased: (handle) => releases.get(handle) }
    const input = { resourceID: resource.resourceID, scope, request: { direction: "upload" as const, relative: "source.bin", targetURL: "https://example.com/upload" } }
    expect(code(yield* SharedBrowserFileExchange.preview(fixture.db, input).pipe(Effect.exit))).toBe("BROWSER_FILE_UNAVAILABLE")
    expect((yield* fixture.db.select().from(BrowserFileCapacityTable)).length).toBe(0)
    expect(code(yield* SharedBrowserFileExchange.preview(fixture.db, { ...input, request: { ...input.request, targetURL: "https://denied.example/upload" } })
      .pipe(Effect.provideService(BrowserFileCapability.Service, producer), Effect.exit))).toBe("BROWSER_FILE_SCOPE_DENIED")
    const grant = (requestID: string) => Effect.gen(function* () {
      const capture = yield* SharedBrowserFileExchange.preview(fixture.db, input)
      const command: SharedBrowserFileSchema.Approve = { previewID: `preview-${requestID}`, requestID, expectedResourceRevision: resource.revision,
        expectedLeaseID: lease.leaseID, expectedLeaseEpoch: lease.leaseEpoch, expectedManualEpoch: resource.manualEpoch, expiresAt: Date.now() + 90_000 }
      expect(code(yield* SharedBrowserFileExchange.approve(fixture.db, { ...input, command }, capture).pipe(Effect.exit))).toBe("BROWSER_FILE_SCOPE_DENIED")
      yield* SharedBrowserFileExchange.confirm(fixture.db, capture, command)
      const result = yield* SharedBrowserFileExchange.approve(fixture.db, { ...input, command }, capture)
      expect(result.replayed).toBe(false)
      expect((yield* SharedBrowserFileExchange.approve(fixture.db, { ...input, command })).replayed).toBe(true)
      expect(code(yield* SharedBrowserFileExchange.approve(fixture.db, { ...input, command: { ...command, expiresAt: command.expiresAt + 1 } }).pipe(Effect.exit)))
        .toBe("BROWSER_FILE_CONFLICT")
      expect((yield* SharedBrowserFileExchange.getGrant(fixture.db, result.grant.grantID))?.bindingHash).toBe(hash(SharedBrowserFileBinding.from(resource, lease)))
      return result.grant
    }).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    const first = yield* grant("first")
    const second = yield* grant("second")
    expect(facts.confirmations).toBe(2)
    expect(facts.accepts).toBe(2)
    const command = (grantID: string) => ({ type: "file.upload" as const, tabID: "tab", generation: 1, frameID: "frame", observationRevision: 1,
      ref: "ref", grantIDs: [grantID] })
    const prepare = (grantID: string, id: string) => SharedBrowserControl.prepareAction(fixture.db, { resource, lease, command: command(grantID), timeoutMs: 30_000,
      admission: { ...fixture.admission, admissionId: id, toolCallId: id } }, () => Effect.void)
    const action = yield* prepare(first.grantID, "first-file-admission")
    const pair = (yield* SharedBrowserFileExchange.actionFiles(fixture.db, action))[0]!
    expect(pair.artifact.grantID).toBe(first.grantID)
    expect(pair.artifact.binding).toEqual(first.binding)
    expect(pair.artifact.reservedBytes).toBe(2 * source.length)
    const meter = yield* fixture.db.select().from(BrowserFileCapacityTable).get()
    expect(meter?.grant_count).toBe(2)
    expect(meter?.artifact_count).toBe(1)
    const before = yield* fixture.db.all("SELECT action_id FROM browser_shared_action")
    expect(Exit.isFailure(yield* prepare(first.grantID, "second-admission-must-rollback").pipe(Effect.exit))).toBe(true)
    expect(yield* fixture.db.all("SELECT action_id FROM browser_shared_action")).toEqual(before)
    expect(yield* fixture.db.select().from(BrowserFileCapacityTable).get()).toEqual(meter)
    const publication = Object.freeze({}) as BrowserFileCapability.Observation
    publications.set(publication, { version: 1, artifactID: pair.artifact.artifactID, grantID: first.grantID, direction: "upload", rootIdentity: first.preview.rootIdentity,
      stageIdentity: first.preview.rootIdentity, fileIdentity: first.preview.direction === "upload" ? first.preview.fileIdentity : first.preview.rootIdentity,
      bytes: source.length, sha256: first.preview.direction === "upload" ? first.preview.sha256 : "a".repeat(64), helperHash: first.preview.helperHash, observedAt: Date.now(), outcome: "selected" })
    expect(code(yield* SharedBrowserFileExchange.observed(fixture.db, pair.artifact, Object.freeze({}) as BrowserFileCapability.Observation).pipe(Effect.provideService(BrowserFileCapability.Service, producer), Effect.exit)))
      .toBe("BROWSER_FILE_INVALID")
    const selected = yield* SharedBrowserFileExchange.observed(fixture.db, pair.artifact, publication).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    const cleanup = Object.freeze({}) as BrowserFileCapability.Released
    releases.set(cleanup, [selected.artifactID])
    expect(code(yield* SharedBrowserFileExchange.released(fixture.db, [selected], cleanup).pipe(Effect.provideService(BrowserFileCapability.Service, producer), Effect.exit)))
      .toBe("BROWSER_FILE_UNKNOWN")
    yield* SharedBrowserControl.observeAction(fixture.db, action, { outcome: "cancelled", errorCode: "BROWSER_CANCELLED" })
    expect(code(yield* SharedBrowserFileExchange.actionFiles(fixture.db, action).pipe(Effect.exit))).toBe("BROWSER_FILE_CHANGED")
    const released = yield* SharedBrowserFileExchange.released(fixture.db, [selected], cleanup).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
    expect(released[0]!.reservedBytes).toBe(0)
    const after = yield* fixture.db.select().from(BrowserFileCapacityTable).get()
    expect(after!.metadata_bytes).toBe(meter!.metadata_bytes)
    expect(after!.reserved_bytes).toBe(meter!.reserved_bytes - selected.reservedBytes)
    const unknownAction = yield* prepare(second.grantID, "unknown-file-admission")
    const next = (yield* SharedBrowserFileExchange.actionFiles(fixture.db, unknownAction))[0]!
    const unknown = yield* SharedBrowserFileExchange.unknown(fixture.db, next.artifact)
    const unknownCleanup = Object.freeze({}) as BrowserFileCapability.Released
    releases.set(unknownCleanup, [unknown.artifactID])
    yield* SharedBrowserControl.observeAction(fixture.db, unknownAction, { outcome: "unknown", errorCode: "BROWSER_UNKNOWN" })
    const retained = yield* fixture.db.select().from(BrowserFileCapacityTable).get()
    expect(code(yield* SharedBrowserFileExchange.released(fixture.db, [unknown], unknownCleanup).pipe(Effect.provideService(BrowserFileCapability.Service, producer), Effect.exit)))
      .toBe("BROWSER_FILE_UNKNOWN")
    expect(yield* fixture.db.select().from(BrowserFileCapacityTable).get()).toEqual(retained)
    const page = yield* SharedBrowserFileExchange.list(fixture.db, { resourceID: resource.resourceID, scope, limit: 1 })
    expect(page.records).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    expect(yield* fixture.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'browser_file_%' ORDER BY name"))
      .toEqual([{ name: "browser_file_artifact" }, { name: "browser_file_capacity" }, { name: "browser_file_grant" }])
    expect(facts.execution).toBe(0)
  })), 30_000)

test("shared file cancellation: exact negative receipt, lost reply lookup and no grant or meter admission", () =>
  BrowserFileAuthorityFixture.isolated((fixture) => Effect.gen(function* () {
    const scope = fixture.captureInput.control.scope
    const created = yield* SharedBrowserControl.create(fixture.db, { scope, mainIncarnation: "cancel-main-distinct",
      sidecarIncarnation: fixture.captureInput.host.hostIncarnation,
      request: { version: 2, profile: SharedBrowserSchema.PROFILE, inputAssurance: SharedBrowserSchema.INPUT_ASSURANCE,
        requestID: "cancel-resource", sessionID: scope.sessionID, expiresAt: Date.now() + 120_000,
        policy: { origin: "https://example.com", approvedOrigins: ["https://example.com"], manualApprovedOrigins: ["https://example.com"],
          resolverPolicy: "system", postGrants: [], filePolicy: { upload: true, download: true } } } })
    const resource = yield* SharedBrowserControl.observeCreated(fixture.db, created.resource,
      { resourceID: created.resource.resourceID, mainIncarnation: "cancel-main-distinct", manualEpoch: 0, barrierOrder: 0,
        resourceAlive: true, agentAccessFenced: false, leaseRevoked: false, inputIsolated: true, heldReleased: true,
        transportStopped: true, manualEnabled: false, unknownEffects: false, leaseID: created.lease.leaseID, leaseEpoch: 1 })
    const lease = yield* SharedBrowserControl.lease(fixture.db, created.lease.leaseID)
    if (!lease) throw new Error("Missing actual cancellation lease")
    const previews = new WeakMap<BrowserFileCapability.Preview, SharedBrowserFileSchema.Preview>()
    const decisions = new Map<string, SharedBrowserFileSchema.Cancellation>()
    const facts = { confirms: 0, current: 0, accepts: 0 }
    const unavailable = () => Effect.die("Cancellation oracle must not execute files or Native")
    const producer: BrowserFileCapability.Interface = { preview: unavailable, describePreview: () => undefined,
      currentPreview: unavailable, confirm: unavailable, approved: () => false, describeApproval: () => undefined,
      acceptGrant: () => false, prepare: unavailable, current: unavailable, readUpload: unavailable, writeDownload: unavailable,
      sealUpload: unavailable, observeUpload: unavailable, publishDownload: unavailable, describe: () => undefined,
      cleanup: unavailable, describeReleased: () => undefined,
      // This controlled opaque producer proves real Core/fileDB semantics, not physical Native Cancel.
      shared: {
        preview: (input) => Effect.sync(() => {
          const handle = Object.freeze({}) as BrowserFileCapability.Preview
          const binding = SharedBrowserFileBinding.from(input.resource, input.lease)
          previews.set(handle, { version: 2, binding, bindingHash: hash(binding), instanceID: "cancel-instance", scopeHash: hash(scope),
            helperHash: "a".repeat(64), rootIdentity: { kind: "posix", device: "1", inode: "2" }, relative: "cancel.txt", name: "cancel.txt",
            observedAt: Date.now(), direction: "upload", targetURL: input.request.targetURL,
            fileIdentity: { kind: "posix", device: "1", inode: "3" }, bytes: 1, sha256: "b".repeat(64) })
          return handle
        }),
        describePreview: (handle) => previews.get(handle), currentPreview: () => Effect.sync(() => { facts.current++ }),
        confirm: (handle, command) => Effect.gen(function* () {
          facts.confirms++
          if (command.requestID === "no-negative") return yield* BrowserFileExchange.failure("BROWSER_FILE_UNKNOWN")
          const preview = previews.get(handle)!
          const decision: SharedBrowserFileSchema.Cancellation = { kind: "cancelled", resourceID: resource.resourceID,
            requestID: command.requestID, bindingHash: preview.bindingHash, previewHash: hash(preview), commandHash: hash(command), cancelledAt: Date.now() }
          if (command.requestID === "invalid-negative") return { ...decision, commandHash: "c".repeat(64) }
          decisions.set(command.requestID, decision)
          if (command.requestID === "lost-reply") return yield* BrowserFileExchange.failure("BROWSER_FILE_UNKNOWN")
          return decision
        }),
        cancellation: (_handle, command) => Effect.succeed(decisions.get(command.requestID)), approved: () => false,
        describeApproval: () => undefined, acceptGrant: () => { facts.accepts++; return false },
        prepare: unavailable, executionFiles: unavailable, finishAction: unavailable,
      } }
    yield* Effect.gen(function* () {
      const capture = yield* SharedBrowserFileExchange.preview(fixture.db, { resourceID: resource.resourceID, scope,
        request: { direction: "upload", relative: "cancel.txt", targetURL: "https://example.com/upload" } })
      const command: SharedBrowserFileSchema.Approve = { requestID: "actual-negative", previewID: "cancel-preview",
        expectedResourceRevision: resource.revision, expectedLeaseID: lease.leaseID, expectedLeaseEpoch: lease.leaseEpoch,
        expectedManualEpoch: resource.manualEpoch, expiresAt: Date.now() + 90_000 }
      const decision = yield* SharedBrowserFileExchange.confirm(fixture.db, capture, command)
      expect(decision?.kind).toBe("cancelled")
      expect(yield* SharedBrowserFileExchange.confirm(fixture.db, capture, command)).toEqual(decision)
      expect(facts.confirms).toBe(1)
      expect(code(yield* SharedBrowserFileExchange.confirm(fixture.db, capture, { ...command, expiresAt: command.expiresAt + 1 }).pipe(Effect.exit)))
        .toBe("BROWSER_FILE_CONFLICT")
      expect(code(yield* SharedBrowserFileExchange.approve(fixture.db, { resourceID: resource.resourceID, scope, command }, capture).pipe(Effect.exit)))
        .toBe("BROWSER_FILE_SCOPE_DENIED")
      for (const requestID of ["invalid-negative", "no-negative", "lost-reply"]) {
        const next = yield* SharedBrowserFileExchange.preview(fixture.db, { resourceID: resource.resourceID, scope,
          request: { direction: "upload", relative: "cancel.txt", targetURL: "https://example.com/upload" } })
        const changed = { ...command, requestID }
        expect(code(yield* SharedBrowserFileExchange.confirm(fixture.db, next, changed).pipe(Effect.exit)))
          .toBe(requestID === "invalid-negative" ? "BROWSER_FILE_CHANGED" : "BROWSER_FILE_UNKNOWN")
        const before = facts.current
        expect((yield* SharedBrowserFileExchange.cancellation(fixture.db, next, changed))?.kind)
          .toBe(requestID === "lost-reply" ? "cancelled" : undefined)
        expect(facts.current).toBe(before)
      }
      yield* SharedBrowserControl.prepareClose(fixture.db, resource, {
        resourceID: resource.resourceID, requestID: "retire-after-negative", expectedRevision: resource.revision,
      })
      const before = facts.current
      expect(yield* SharedBrowserFileExchange.cancellation(fixture.db, capture, command)).toEqual(decision)
      expect(facts.current).toBe(before)
      expect(yield* fixture.db.all("SELECT grant_id FROM browser_file_grant")).toEqual([])
      expect(yield* fixture.db.all("SELECT artifact_id FROM browser_file_artifact")).toEqual([])
      expect(yield* fixture.db.select().from(BrowserFileCapacityTable)).toEqual([])
      expect(facts.accepts).toBe(0)
    }).pipe(Effect.provideService(BrowserFileCapability.Service, producer))
  })), 30_000)
