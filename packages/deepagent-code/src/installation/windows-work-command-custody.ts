export * as WindowsWorkCommandCustody from "./windows-work-command-custody"

import { createHmac, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkCommand } from "@deepagent-code/core/session/work-command"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { WorkStorageCleanup } from "@deepagent-code/core/session/work-storage-cleanup"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows.schema"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { LocalTaskAuthority } from "../im/local-task-authority"
import { NativeWindowsWorkFactory } from "./windows-work-factory"
import { NativeWorkProcessSupervisor } from "./work-process-supervisor"
import { WindowsWorkCommand } from "./windows-work-command"
import { WindowsWorkCommandRuntime } from "./windows-work-command-runtime"
import { WindowsWorkCommandDescription } from "./windows-work-command-description"

const failure = (code: WorkFileCapability.Error["code"] = "WORK_FILE_UNAVAILABLE") =>
  new WorkFileCapability.Error({ code, message: "Original Windows command custody is unavailable" })
const same = (first: unknown, second: unknown) => CanonicalJson.stringify(first) === CanonicalJson.stringify(second)
/** This Root factory consumes only original Workspace/command ports. Its
 * read-only Native descriptions do not form an alternative launch factory. */
export const make = Effect.fn("WindowsWorkCommandCustody.make")(function* () {
  const database = yield* Database.Service
  const factory = yield* NativeWindowsWorkFactory.Service
  const runtime = yield* WindowsWorkCommandRuntime.Service
  const context = yield* Effect.context<Scope.Scope>()
  if (process.platform !== "win32" || !factory.commandAvailable) return yield* failure()
  const lifetime = { active: true }
  const preparations = new WeakMap<WindowsWorkCommand.Preparation, {
    held: Effect.Success<typeof LocalTaskAuthority.holdWindowsInstallation>; active: boolean; consumed: boolean
  }>()
  const retained = new WeakMap<WindowsWorkCommandRuntime.Workspace, { manifest: WorkStorageCleanupWindowsSchema.Manifest;
    retirement?: WindowsWorkCommandDescription.Observation; cleaned: boolean }>()
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  const current = Effect.suspend(() => lifetime.active ? factory.current.pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
    : Effect.fail(failure()))
  return WindowsWorkCommand.Custody.of({
    current,
    prepare: Effect.gen(function* () {
      const scope = yield* Scope.Scope
      return yield* Effect.gen(function* () {
        yield* current
        const held = yield* LocalTaskAuthority.holdWindowsInstallation.pipe(Effect.mapError(() => failure()))
        const prepared = Object.freeze(Object.create(null)) as WindowsWorkCommand.Preparation
        const original = { held, active: true, consumed: false }
        preparations.set(prepared, original)
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          original.active = false
          preparations.delete(prepared)
        }))
        return prepared
      }).pipe(Effect.provide(Context.add(context, Scope.Scope, scope)))
    }),
    instanceID: (preparation) => {
      const original = preparations.get(preparation)
      return lifetime.active && original?.active && !original.consumed ? original.held.installation.instanceID : undefined
    },
    capture: (record, workspace, currentBinding, preparation) => Effect.scoped(Effect.gen(function* () {
      yield* current
      const original = preparations.get(preparation)
      if (!original?.active || original.consumed) return yield* failure("WORK_FILE_UNKNOWN")
      original.consumed = true
      yield* original.held.current.pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
      if (retained.has(workspace) || record.version !== 2 || record.state !== "prepared" || record.snapshotHash === null ||
        record.workspaceIdentity === null || !same(record.workspaceIdentity, workspace.identity)) return yield* failure("WORK_FILE_UNKNOWN")
      const work = yield* WorkAuthority.get(database.db, record.workID)
      const observed = yield* runtime.commandDescription(workspace).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      if (!work || work.binding.schemaVersion !== "work-execution.v2" || work.binding.projectScope.rootIdentity.kind !== "windows" ||
        observed.phase !== "ready" || observed.binding.work_id !== record.workID || observed.binding.command_id !== record.commandID ||
        observed.binding.recipe_hash !== record.recipeHash || observed.binding.control_revision !== record.controlRevision ||
        !same(WindowsWorkCommandDescription.identity(observed.inventory.root_identity), workspace.identity) ||
        !same(WindowsWorkCommandDescription.identity(observed.inventory.project_identity), work.binding.projectScope.rootIdentity))
        return yield* failure("WORK_FILE_UNKNOWN")
      const witness = yield* WorkToolPolicy.storageProducer("command", record.admissionID)
      if (!witness) return yield* failure("WORK_FILE_UNKNOWN")
      const installation = original.held.installation
      if (installation.instanceID !== record.instanceID || work.binding_hash !== record.bindingHash) return yield* failure("WORK_FILE_UNKNOWN")
      const decoded = Schema.decodeUnknownOption(WorkStorageCleanupWindowsSchema.Manifest, { onExcessProperty: "error" })({
        version: 2, target: record.target, kind: "command", captureKind: "native_live", admissionID: record.admissionID,
        instanceID: record.instanceID, workID: record.workID, rootWorkID: record.rootWorkID, sessionID: record.sessionID,
        inputID: record.inputID, activityID: record.activityID, providerReceiptID: record.providerReceiptID,
        providerAttemptID: record.providerAttemptID, toolCallID: record.toolCallID, ownerToken: record.ownerToken,
        sessionClaimToken: record.sessionClaimToken, bindingHash: record.bindingHash, controlRevision: record.controlRevision,
        custodyID: record.commandID, sourceRequestHash: record.requestHash, helperHash: record.helperHash,
        snapshotHash: record.snapshotHash, project: work.binding.projectScope.canonicalRoot,
        projectIdentity: work.binding.projectScope.rootIdentity, data: runtime.data,
        dataIdentity: WindowsWorkCommandDescription.identity(observed.inventory.data_identity),
        baseIdentity: WindowsWorkCommandDescription.identity(observed.inventory.stage_identity),
        containerIdentity: workspace.identity, basename: record.workspaceBasename,
        files: observed.inventory.files.map((file) => ({ relative: file.relative, bytes: file.bytes, sha256: file.sha256,
          identity: WindowsWorkCommandDescription.identity(file.identity) })),
        directories: observed.inventory.directories.map((directory) => ({ relative: directory.relative,
          identity: WindowsWorkCommandDescription.identity(directory.identity) })),
        security: observed.security, createdAt: Date.now(),
      })
      if (Option.isNone(decoded)) return yield* failure("WORK_FILE_UNKNOWN")
      const manifest = decoded.value
      const secret = Buffer.from(installation.secret, "hex")
      const mac = (value: unknown) => createHmac("sha256", secret).update("dac-work-windows-command-manifest.v2\0")
        .update(CanonicalJson.stringify([installation.instanceID, value])).digest("hex")
      const prepared = Object.freeze(Object.create(null)) as WorkStorageCleanup.Prepared
      const authority = WorkStorageCleanup.Authority.of({
        prepareManifest: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
        manifest: (tx, actual) => Effect.gen(function* () {
          if (actual !== prepared || !lifetime.active || !factory.isCurrent()) return yield* WorkStorageCleanup.failure("STORAGE_UNAVAILABLE")
          const source = yield* WorkToolPolicy.requireStorageProducer(tx, witness, "command", record.admissionID)
          const stored = yield* WorkCommand.get(tx, record.admissionID)
          if (!stored || !same(stored, record) || source.work.binding_hash !== manifest.bindingHash)
            return yield* WorkStorageCleanup.failure("STORAGE_CONFLICT")
          return { value: manifest, mac: mac(manifest) }
        }).pipe(Effect.mapError((error) => error instanceof WorkStorageCleanupSchema.Error ? error : WorkStorageCleanup.failure("STORAGE_UNAVAILABLE"))),
        verifyManifest: (value, stored) => Effect.gen(function* () {
          if (!lifetime.active || !Schema.is(WorkStorageCleanupWindowsSchema.Manifest)(value) ||
            !Schema.is(WorkStorageCleanupSchema.Digest)(stored) ||
            !timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(mac(value), "hex"))) return yield* WorkStorageCleanup.failure("STORAGE_INVALID")
        }),
        prepare: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
        current: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
        execute: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
        verifyJournal: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
        verifyProof: () => Effect.fail(WorkStorageCleanup.failure("STORAGE_UNSUPPORTED")),
      })
      // All Native observation finishes before this last original source fence.
      // The SQL transaction consumes only the captured facts and same witness.
      yield* original.held.current.pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")), Effect.andThen(currentBinding),
        Effect.andThen(WorkStorageCleanup.capture(database.db, prepared).pipe(
        Effect.provideService(WorkStorageCleanup.Authority, authority))),
        Effect.ensuring(Effect.sync(() => secret.fill(0))), Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      retained.set(workspace, { manifest, cleaned: false })
      return { manifest }
    }).pipe(Effect.provide(context), Effect.mapError((error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN")))),
    stopped: (workspace, proof) => Effect.gen(function* () {
      yield* current
      const original = retained.get(workspace)
      const retirement = NativeWorkProcessSupervisor.describeWindowsStop(proof, workspace)
      if (!original || original.cleaned || original.retirement || !retirement || retirement.phase !== "retired" ||
        !retirement.jobRetired || !retirement.appContainerRetired || !retirement.aclRestored || !retirement.aclRestoreHash ||
        !same(retirement.security, original.manifest.security)) return yield* failure("WORK_FILE_UNKNOWN")
      yield* runtime.currentWorkspace(workspace).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      original.retirement = retirement
      return { security: retirement.security, aclRestoreHash: retirement.aclRestoreHash,
        jobRetired: true as const, appContainerRetired: true as const, aclRestored: true as const }
    }),
    cleanup: (record, workspace, files) => Effect.gen(function* () {
      yield* current
      const original = retained.get(workspace)
      if (!original || original.cleaned || !original.retirement || record.state !== "settled" || !record.stopConfirmed ||
        record.releasedAt !== null || record.commandID !== original.manifest.custodyID || record.admissionID !== original.manifest.admissionID ||
        record.bindingHash !== original.manifest.bindingHash || !same(record.workspaceIdentity, workspace.identity) ||
        !same(original.retirement.security, original.manifest.security)) return yield* failure("WORK_FILE_UNKNOWN")
      const stored = yield* WorkCommand.get(database.db, record.admissionID)
      const journal = yield* WorkStorageCleanup.read(database.db, record.admissionID)
      if (!stored || !same(stored, record) || !journal || !same(journal.manifest, original.manifest)) return yield* failure("WORK_FILE_UNKNOWN")
      yield* runtime.cleanupWorkspace(workspace, files, original.manifest.directories.filter((directory) => directory.relative !== "")
        .map((directory) => directory.relative)).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      original.cleaned = true
    }).pipe(Effect.mapError((error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN"))),
  })
})
export const layer = Layer.effect(WindowsWorkCommand.Custody, make())
