export * as WindowsWorkWriteCleanup from "./windows-work-write-cleanup"

import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsWriteSchema } from "@deepagent-code/core/session/work-storage-cleanup-windows-write.schema"
import { NativeInstallation } from "./native-installation"
import { NativeWindowsWorkFactory } from "./windows-work-factory"
import { WindowsWorkFileHelper } from "./windows-work-file-helper"
import { WindowsWorkWrite } from "./windows-work-write"

const Identity = Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const Reply = Schema.Struct({ version: Schema.Literal(1), id: Schema.String,
  status: Schema.Literals(["ready", "refused", "unknown", "closed", "work_write_stage_v2", "known_stage_observed", "known_stage_cleaned"]),
  code: Schema.NullOr(Schema.Literals(["FILE_SCOPE_UNAVAILABLE", "WRITE_OUTCOME_UNKNOWN"])),
  root: Schema.NullOr(Identity), observation: Schema.Null, payload_bytes: Schema.Literal(0),
  write_stage: Schema.optional(WindowsWorkWrite.Stage),
})
const failure = (code: WorkStorageCleanupSchema.Error["code"] = "STORAGE_UNKNOWN") => new WorkStorageCleanupSchema.Error({
  code, message: "Original Windows known write collector is unavailable or retains unknown custody",
})
const wire = (value: WorkStorageCleanupWindowsWriteSchema.Manifest["projectIdentity"]) => ({ kind: "windows" as const,
  volume_serial: value.volumeSerial, file_id: value.fileID })
const same = (left: unknown, right: unknown) => CanonicalJson.stringify(left) === CanonicalJson.stringify(right)

export const requireAvailable = Effect.fn("WindowsWorkWriteCleanup.requireAvailable")(function* (helperHash: string) {
  const factory = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (process.platform !== "win32" || Option.isNone(factory)) return yield* failure("STORAGE_UNAVAILABLE")
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure("STORAGE_UNAVAILABLE")))
  const asset = yield* WindowsWorkFileHelper.asset(installation).pipe(Effect.mapError(() => failure("STORAGE_UNAVAILABLE")))
  if (asset.hash !== helperHash || factory.value.description.helper.sha256 !== helperHash) return yield* failure("STORAGE_CONFLICT")
  return { asset, installation, factory: factory.value }
})

const openOriginal = Effect.fn("WindowsWorkWriteCleanup.openOriginal")(function* (helperHash: string) {
  const port = yield* requireAvailable(helperHash)
  const child = yield* WindowsWorkFileHelper.launch(port.asset).pipe(Effect.mapError(() => failure("STORAGE_UNAVAILABLE")))
  const state = { active: true, joined: false, closing: false, scoped: true, exit: null as number | null,
    buffer: Buffer.alloc(0), pending: undefined as {
    id: string; resolve: (value: typeof Reply.Type) => void; reject: (error: WorkStorageCleanupSchema.Error) => void
  } | undefined }
  const refuse = () => { state.active = false; state.pending?.reject(failure()); state.pending = undefined; child.kill() }
  child.stderr.resume()
  child.once("error", refuse)
  child.once("close", (code: number | null) => {
    state.active = false; state.joined = true; state.exit = code
    state.pending?.reject(failure()); state.pending = undefined
  })
  child.stdout.on("data", (data: Buffer) => {
    if (!state.active || !state.pending || state.buffer.length + data.length > 65_540) { refuse(); return }
    state.buffer = Buffer.concat([state.buffer, data])
    if (state.buffer.length < 4) return
    const bytes = state.buffer.readUInt32BE(0)
    if (bytes === 0 || bytes > 65_536) { refuse(); return }
    if (state.buffer.length < bytes + 4) return
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Reply), { onExcessProperty: "error" })(state.buffer.subarray(4).toString("utf8"))
    if (state.buffer.length !== bytes + 4 || Option.isNone(decoded) || decoded.value.id !== state.pending.id) { refuse(); return }
    const pending = state.pending
    state.pending = undefined; state.buffer = Buffer.alloc(0); pending.resolve(decoded.value)
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    state.scoped = false; state.active = false; state.pending?.reject(failure()); state.pending = undefined
  }))
  const exchange = (input: object) => Effect.gen(function* () {
    if (!state.active || state.pending || state.closing || !state.scoped) return yield* failure()
    yield* NativeInstallation.requireCurrent(port.installation).pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
    yield* port.factory.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
    const id = randomUUID()
    const body = Buffer.from(JSON.stringify({ ...input, version: 1, id }), "utf8")
    if (body.length > 65_536) return yield* failure("STORAGE_CAPACITY")
    const frame = Buffer.allocUnsafe(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4)
    return yield* Effect.tryPromise({ try: (signal) => new Promise<typeof Reply.Type>((resolve, reject) => {
      const end = () => { clearTimeout(timer); signal.removeEventListener("abort", abort) }
      const abort = () => { end(); refuse(); reject(failure()) }
      const timer = setTimeout(abort, 10_000)
      signal.addEventListener("abort", abort, { once: true })
      state.pending = { id, resolve: (value) => { end(); resolve(value) }, reject: (error) => { end(); reject(error) } }
      child.stdin.write(frame, (error) => { if (error) abort() })
      if (signal.aborted) abort()
    }), catch: () => failure() })
  })
  const close = Effect.gen(function* () {
    const result = yield* exchange({ op: "close" })
    if (result.status !== "closed" || result.code !== null || result.root !== null) return yield* failure()
    state.closing = true
    child.stdin.end()
    yield* Effect.tryPromise({ try: (signal) => new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); child.removeListener("close", joined)
      }
      const joined = () => { finish(); state.joined && state.exit === 0 ? resolve() : reject(failure()) }
      const abort = () => { finish(); child.kill(); reject(failure()) }
      const timer = setTimeout(abort, 5_000)
      signal.addEventListener("abort", abort, { once: true })
      child.once("close", joined)
      if (state.joined) joined()
      if (signal.aborted) abort()
    }), catch: () => failure() })
    yield* port.factory.current.pipe(Effect.mapError(() => failure("STORAGE_CONFLICT")))
  })
  return { port, exchange, close,
    isCurrent: () => state.scoped && port.factory.isCurrent() && (state.active || (state.closing && state.joined && state.exit === 0)) }
})

/** No Stage, Work or SQL mutation: the response and normal zero exit come from
 * the same original Native helper and joined job/EOF/writer lifecycle. */
export const capabilities = Effect.fn("WindowsWorkWriteCleanup.capabilities")(function* (
  helperHash: string, project: string, identity: WorkStorageCleanupWindowsWriteSchema.Manifest["projectIdentity"],
) {
  const original = yield* openOriginal(helperHash)
  const opened = yield* original.exchange({ op: "open_root", path: project, expected: wire(identity) })
  if (opened.status !== "ready" || opened.code !== null || !same(opened.root, wire(identity))) return yield* failure("STORAGE_CONFLICT")
  const available = yield* original.exchange({ op: "write_stage_capabilities" })
  if (available.status !== "work_write_stage_v2" || available.code !== null || available.write_stage !== undefined ||
    !same(available.root, wire(identity))) return yield* failure("STORAGE_UNAVAILABLE")
  yield* original.close
  return Object.freeze({ target: original.port.factory.description.target, helperHash,
    writeStageV2: true as const, originalHelperJoined: true as const })
})

/** Called only after the original known proof and operator/terminal SQL fences.
 * Native receives an exact private inventory, never a dispatch/write capability. */
export const prepare = Effect.fn("WindowsWorkWriteCleanup.prepare")(function* (
  manifest: WorkStorageCleanupWindowsWriteSchema.Manifest, files: ReadonlyArray<typeof WorkStorageCleanupWindowsWriteSchema.File.Type>,
) {
  const original = yield* openOriginal(manifest.helperHash)
  if (manifest.target !== original.port.factory.description.target || files.some((file) => file.relative !== "payload" || file.retainedUnlinked))
    return yield* failure("STORAGE_INVALID")
  const opened = yield* original.exchange({ op: "open_root", path: manifest.project, expected: wire(manifest.projectIdentity) })
  if (opened.status !== "ready" || opened.code !== null || !same(opened.root, wire(manifest.projectIdentity))) return yield* failure("STORAGE_CONFLICT")
  const observed = yield* original.exchange({ op: "inspect_known_write_stage", data: manifest.data, basename: manifest.basename,
    data_identity: wire(manifest.dataIdentity), base_identity: wire(manifest.baseIdentity), stage_identity: wire(manifest.containerIdentity),
    files: files.map((file) => ({ relative: file.relative, identity: wire(file.identity), sha256: file.sha256,
      bytes: file.bytes, retained_unlinked: file.retainedUnlinked })) })
  const fact = observed.write_stage
  if (observed.status !== "known_stage_observed" || observed.code !== null || !fact ||
    !same(fact.root, wire(manifest.projectIdentity)) || !same(fact.data, wire(manifest.dataIdentity)) ||
    !same(fact.base, wire(manifest.baseIdentity)) || !same(fact.stage, wire(manifest.containerIdentity)) ||
    fact.directory !== path.win32.join(manifest.data, "work-write-stage", manifest.basename) ||
    !same(fact.files, files.map((file) => ({ relative: file.relative, identity: wire(file.identity), sha256: file.sha256,
      bytes: file.bytes, retained_unlinked: file.retainedUnlinked })))) return yield* failure("STORAGE_CONFLICT")
  const state = { collected: false }
  return {
    isCurrent: original.isCurrent,
    collect: Effect.gen(function* () {
      if (state.collected) return yield* failure()
      const result = yield* original.exchange({ op: "collect_known_write_stage" })
      if (result.status !== "known_stage_cleaned" || result.code !== null || !same(result.root, wire(manifest.projectIdentity))) return yield* failure()
      state.collected = true
      yield* original.close
      // Native's exact Stage deletion closes its held inventory first. A PID,
      // absent path, terminal SQL record or timeout never sets this flag.
      return { originalStageRemoved: true as const, retainedHandlesClosed: true as const }
    }),
  }
})
