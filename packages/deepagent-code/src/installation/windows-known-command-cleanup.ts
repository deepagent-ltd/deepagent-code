export * as WindowsKnownCommandCleanup from "./windows-known-command-cleanup"

import { Effect, Option, Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows.schema"
import { NativeInstallation } from "./native-installation"
import { NativeWindowsWorkFactory } from "./windows-work-factory"

const Identity = Schema.Struct({
  kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
})
const Security = Schema.Struct({
  lease_set_hash: WorkStorageCleanupSchema.Digest,
  app_container_sid: Schema.String,
  restriction_sid: Schema.String,
})
const Observation = Schema.Struct({
  version: Schema.Literal(1),
  cleanup_id: Schema.String,
  manifest_hash: WorkStorageCleanupSchema.Digest,
  plan_hash: WorkStorageCleanupSchema.Digest,
  container_identity: Identity,
  security: Security,
  acl_restore_hash: WorkStorageCleanupSchema.Digest,
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(4898)),
  complete: Schema.Boolean,
})
const wire = (value: typeof WorkStorageCleanupWindowsSchema.Identity.Type) => ({
  kind: "windows" as const,
  volume_serial: value.volumeSerial,
  file_id: value.fileID,
})
const same = (left: unknown, right: unknown) => CanonicalJson.stringify(left) === CanonicalJson.stringify(right)
const failure = (code: WorkStorageCleanupSchema.Error["code"] = "STORAGE_UNKNOWN") =>
  new WorkStorageCleanupSchema.Error({
    code,
    message: "Original known Windows command storage cannot be authenticated or remains unknown",
  })

export const requireAvailable = Effect.fn("WindowsKnownCommandCleanup.requireAvailable")(function* (
  helperHash: string,
) {
  const original = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  const unavailable =
    process.platform !== "win32"
      ? "PLATFORM_UNAVAILABLE"
      : Option.isNone(original)
        ? "FACTORY_ABSENT"
        : !original.value.knownCommandCleanup
          ? "COLLECTOR_ABSENT"
          : original.value.description.helper.sha256 !== helperHash
            ? "HELPER_MISMATCH"
            : undefined
  if (unavailable) {
    console.warn(JSON.stringify({ service: "known-work-storage", stage: "factory", code: unavailable }))
    return yield* failure("STORAGE_UNAVAILABLE")
  }
  if (Option.isNone(original)) return yield* failure("STORAGE_UNAVAILABLE")
  const installation = yield* NativeInstallation.current().pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        console.warn(
          JSON.stringify({ service: "known-work-storage", stage: "installation", code: "INSTALLATION_UNAVAILABLE" }),
        )
      }),
    ),
    Effect.mapError(() => failure("STORAGE_UNAVAILABLE")),
  )
  yield* original.value.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
  return { original: original.value, installation }
})

/** The caller has authenticated the original manifest, known command MAC and
 * inactive terminal SQL facts. This port never creates execution or StopProof. */
export const prepare = Effect.fn("WindowsKnownCommandCleanup.prepare")(function* (
  manifest: WorkStorageCleanupWindowsSchema.Manifest,
  journal: WorkStorageCleanupWindowsSchema.Journal,
  command: { nonce: string; inputs: readonly string[]; outputs: readonly string[] },
  jobKey: string,
) {
  const port = yield* requireAvailable(manifest.helperHash)
  const native = port.original.knownCommandCleanup!
  const planHash = Hash.sha256(CanonicalJson.stringify(journal))
  if (
    manifest.target !== port.original.description.target ||
    journal.manifestHash !== Hash.sha256(CanonicalJson.stringify(manifest)) ||
    journal.target !== manifest.target ||
    !same(journal.security, manifest.security)
  )
    return yield* failure("STORAGE_INVALID")
  const state = { scoped: true, open: true, unknown: false, complete: false }
  const opened = yield* Effect.try({
    try: () =>
      native.open({
        version: 1,
        root: manifest.data,
        project: manifest.project,
        basename: manifest.basename,
        data_identity: wire(manifest.dataIdentity),
        base_identity: wire(manifest.baseIdentity),
        project_identity: wire(manifest.projectIdentity),
        container_identity: wire(manifest.containerIdentity),
        cleanup_id: journal.cleanupID,
        manifest_hash: journal.manifestHash,
        plan_hash: planHash,
        quarantine: journal.quarantine,
        nonce: command.nonce,
        inputs: [...command.inputs],
        outputs: [...command.outputs],
        security: {
          lease_set_hash: manifest.security.leaseSetHash,
          app_container_sid: manifest.security.appContainerSID,
          restriction_sid: manifest.security.restrictionSID,
        },
        files: journal.files.map((file) => ({
          relative: file.relative,
          identity: wire(file.identity),
          bytes: file.bytes,
          sha256: file.sha256,
        })),
        directories: journal.directories.map((directory) => ({
          relative: directory.relative,
          identity: wire(directory.identity),
        })),
        job_key: jobKey,
      }),
    catch: () => failure("STORAGE_CONFLICT"),
  })
  const observe = (text: string) => {
    if (Buffer.byteLength(text) > 16384) throw failure("STORAGE_INVALID")
    const decoded = Option.flatMap(
      Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
      Schema.decodeUnknownOption(Observation, { onExcessProperty: "error" }),
    )
    if (
      Option.isNone(decoded) ||
      decoded.value.cleanup_id !== journal.cleanupID ||
      decoded.value.manifest_hash !== journal.manifestHash ||
      decoded.value.plan_hash !== planHash ||
      !same(decoded.value.container_identity, wire(manifest.containerIdentity)) ||
      !same(decoded.value.security, {
        lease_set_hash: manifest.security.leaseSetHash,
        app_container_sid: manifest.security.appContainerSID,
        restriction_sid: manifest.security.restrictionSID,
      }) ||
      decoded.value.step > journal.files.length + journal.directories.length ||
      (decoded.value.complete && decoded.value.step !== journal.files.length + journal.directories.length)
    )
      throw failure("STORAGE_CONFLICT")
    return decoded.value
  }
  const initial = yield* Effect.try({ try: () => observe(opened.metadata), catch: () => failure("STORAGE_CONFLICT") })
  state.complete = initial.complete
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state.scoped = false
      if (!state.open) return
      try {
        native.close(opened.lease)
        state.open = false
      } catch {
        state.unknown = true
      }
    }),
  )
  const current = Effect.gen(function* () {
    if (!state.scoped || !state.open || state.unknown) return yield* failure()
    yield* NativeInstallation.requireCurrent(port.installation).pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
    yield* port.original.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
    const value = yield* Effect.try({
      try: () => observe(native.current(opened.lease)),
      catch: () => failure("STORAGE_CONFLICT"),
    })
    if (value.acl_restore_hash !== initial.acl_restore_hash) return yield* failure("STORAGE_CONFLICT")
    yield* port.original.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
    return value
  })
  yield* current
  return {
    isCurrent: () => state.scoped && !state.unknown && port.original.isCurrent() && (state.open || state.complete),
    collect: Effect.gen(function* () {
      yield* current
      state.unknown = true
      const value = yield* Effect.try({ try: () => observe(native.collect(opened.lease)), catch: () => failure() })
      if (!value.complete || value.acl_restore_hash !== initial.acl_restore_hash) return yield* failure()
      // Native only reports exact storage/ACL facts. The historical Job and
      // AppContainer retirement remain authenticated by the original known MAC.
      yield* port.original.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
      yield* Effect.try({ try: () => native.close(opened.lease), catch: () => failure() })
      state.open = false
      state.complete = true
      state.unknown = false
      return { security: manifest.security, aclRestoreHash: value.acl_restore_hash }
    }),
  }
})
