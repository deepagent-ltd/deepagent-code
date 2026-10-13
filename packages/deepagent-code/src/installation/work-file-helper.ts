import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { WorkAuthority } from "@deepagent-code/core/session/work-authority"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { WorkFileCapability } from "@deepagent-code/core/session/work-file-capability"
import { WorkCommand } from "@deepagent-code/core/session/work-command"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkCommandMacX64Schema } from "@deepagent-code/core/session/work-command-mac-x64.schema"
import { WorkCommandV2Schema } from "@deepagent-code/core/session/work-command-v2.schema"
import { WorkCommandRuntime } from "./work-command-runtime"
import { NativeWorkProcessSupervisor } from "./work-process-supervisor"
import { WorkWriteStage } from "@deepagent-code/core/session/work-write-stage"
import { WorkWriteStageSchema } from "@deepagent-code/core/session/work-write-stage.schema"
import { Global } from "@deepagent-code/core/global"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { NativeInstallation } from "./native-installation"
import { LocalTaskAuthority } from "../im/local-task-authority"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { LinuxWorkWritePolicy } from "./linux-work-write-policy"
import { WindowsWorkWrite } from "./windows-work-write"

const failure = (code: WorkFileCapability.Error["code"] = "WORK_FILE_UNAVAILABLE") =>
  new WorkFileCapability.Error({ code, message: "Current native Work file capability is unavailable" })
// Fixed operation phases and enum-like codes preserve failure diagnosis without
// exposing project paths, tool payloads, credentials, or native error messages.
const trace = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.tapError((error) =>
  Effect.logWarning(`Native Work operation refused stage=${stage} code=${typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code : "UNCLASSIFIED"}`)))
const NumberValue = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const WireIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("posix"), device: Schema.String, inode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String, file_id: Schema.String }),
])
const Response = Schema.Struct({
  version: Schema.Literal(1), id: Schema.String, status: Schema.Literals(["ready", "observed", "refused", "closed", "prepared", "published", "unknown", "cleaned", "snapshot_ready", "work_write_stage_v2", "stage_ready", "stage_observed", "known_stage_observed", "known_stage_cleaned", "linux_write_profile_v1"]),
  code: Schema.NullOr(Schema.Literals(["FILE_SCOPE_UNAVAILABLE", "WRITE_OUTCOME_UNKNOWN"])), root: Schema.NullOr(WireIdentity),
  payload_bytes: NumberValue,
  observation: Schema.NullOr(Schema.Struct({ identity: WireIdentity, offset: NumberValue,
    file_bytes: NumberValue, scanned_bytes: NumberValue, observed_sha256: WorkAuthoritySchema.Digest,
    page_sha256: WorkAuthoritySchema.Digest, snapshot: Schema.Literal("stream_observation") })),
  snapshot: Schema.optional(Schema.Struct({ workspace: WireIdentity, manifest_sha256: WorkAuthoritySchema.Digest,
    files: NumberValue, bytes: NumberValue, output_files: NumberValue })),
  preparation: Schema.optional(Schema.Struct({ parent: WireIdentity, stage: WireIdentity })),
  write_stage: Schema.optional(WindowsWorkWrite.Stage),
  linux_write_profile: Schema.optional(LinuxWorkWritePolicy.Description),
  write: Schema.optional(Schema.Struct({ parent: WireIdentity, stage: WireIdentity, file: WireIdentity,
    sha256: WorkAuthoritySchema.Digest, bytes: NumberValue,
    previous: Schema.Union([Schema.Struct({ kind: Schema.Literal("missing") }),
      Schema.Struct({ kind: Schema.Literal("observed"), identity: WireIdentity, sha256: WorkAuthoritySchema.Digest, bytes: NumberValue })]),
    publication: Schema.Literal("optimistic_namespace_publish") })),
})
type Reply = { value: typeof Response.Type; bytes: Buffer }
type Pending = { id: string; resolve: (reply: Reply) => void; reject: (error: WorkFileCapability.Error) => void }
type HelperProcess = {
  stdin: Writable; stdout: Readable; stderr: Readable
  exitCode: number | null; signalCode: NodeJS.Signals | null
  once(event: "close" | "error", listener: () => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}
type Entry = {
  active: boolean
  scope: Scope.Scope
  process: HelperProcess
  exited: Promise<void>
  binding: typeof WorkAuthoritySchema.ProjectBinding.Type
  bindingHash: string
  controlRevision: number
  installation: NativeInstallation.VerifiedInstalledComponents
  asset: { filename: string; hash: string; identity: string }
  buffer: Buffer
  pending?: Pending
  queued: number
  tail: Promise<unknown>
  receipts: WeakMap<WorkFileCapability.Observation, WorkFileCapability.Description>
  latest?: WorkFileCapability.Observation
  written?: { handle: WorkFileCapability.WriteObservation; description: WorkFileCapability.WriteDescription;
    owner: Entry; directory: string; cleanupStarted: boolean }
}

/** The only executable location is the signed installation's adjacent fixed asset. This
 * module never accepts an executable path, environment callback, credential, or raw fd. */
export const layer = Layer.effect(WorkFileCapability.Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const { WorkExecutionProfile } = yield* Effect.promise(() => import("@deepagent-code/core/session/work-execution-profile"))
  const profile = yield* Effect.serviceOption(WorkExecutionProfile.Service)
  const global = yield* Global.Service
  const roots = new WeakMap<WorkFileCapability.Root, Entry>()
  const active = new Set<Entry>()
  const commandReceipts = new WeakMap<WorkFileCapability.CommandObservation, { root: WorkFileCapability.Root; description: WorkFileCapability.CommandDescription }>()
  const commandWorkspaces = new Map<string, { record: WorkCommandSchema.Record; directory: string;
    file: FileHandle; identity: WorkCommandSchema.Recipe["executable"]["identity"]; bindingHash: string;
    inputs: { relative: string; sha256: string; bytes: number }[]; published: Set<string>; cleanupStarted: boolean }>()
  const capacity = { opening: 0, active: true }
  const currentBinding = (entry: Pick<Entry, "binding" | "bindingHash" | "controlRevision">) => Effect.gen(function* () {
    const work = yield* WorkAuthority.get(database.db, entry.binding.workID)
    if (!work || work.binding_hash !== entry.bindingHash || work.control_revision !== entry.controlRevision) return yield* failure("WORK_FILE_CHANGED")
    if (Option.isSome(profile) && profile.value.prepareSource) yield* profile.value.prepareSource(work, { fresh: true })
    const current = yield* database.db.transaction((tx) => WorkAuthority.requireCurrentControlInTransaction(tx, {
      workID: entry.binding.workID, expectedRevision: entry.controlRevision,
    }), { behavior: "immediate" })
    if (!current || current.work_id !== entry.binding.workID || current.control_revision !== entry.controlRevision ||
      current.binding_hash !== entry.bindingHash || CanonicalJson.stringify(current.binding) !== CanonicalJson.stringify(entry.binding))
      return yield* failure("WORK_FILE_CHANGED")
  }).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
  const lookup = (root: WorkFileCapability.Root) => roots.get(root)
  const current = (entry: Entry) => Effect.gen(function* () {
    if (!capacity.active || !entry.active || !active.has(entry)) return yield* failure("WORK_FILE_CHANGED")
    yield* NativeInstallation.requireCurrent(entry.installation).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
    const asset = yield* currentAsset(entry.installation).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
    if (asset.identity !== entry.asset.identity || asset.hash !== entry.asset.hash) return yield* failure("WORK_FILE_CHANGED")
    const recipes = entry.binding.toolPolicy.commandRecipes
    if (recipes?.length) {
      if (recipes.some((recipe) => recipe.schemaVersion === "work-command-recipe.v2")) {
        const runtime = yield* NativeWorkProcessSupervisor.inspectRuntime(entry.installation).pipe(Effect.mapError(() => failure("WORK_FILE_CHANGED")))
        if (recipes.some((recipe) => recipe.schemaVersion !== "work-command-recipe.v2" ||
          CanonicalJson.stringify(recipe.executable) !== CanonicalJson.stringify(runtime.executable))) return yield* failure("WORK_FILE_CHANGED")
        return yield* currentBinding(entry)
      }
      const recipe = recipes[0]!
      if (!macRecipe(recipe)) return yield* failure("WORK_FILE_CHANGED")
      const runtime = yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedMacRecipeRuntime(entry.installation, recipe),
        catch: () => failure("WORK_FILE_CHANGED") })
      if (recipes.some((recipe) => !macRecipe(recipe) ||
        CanonicalJson.stringify(recipe.executable) !== CanonicalJson.stringify(runtime.executable))) return yield* failure("WORK_FILE_CHANGED")
    }
    yield* currentBinding(entry)
  })
  const close = async (entry: Entry) => {
    entry.active = false
    entry.pending?.reject(failure("WORK_FILE_UNKNOWN"))
    entry.pending = undefined
    entry.buffer = Buffer.alloc(0)
    entry.latest = undefined
    entry.written = undefined
    entry.receipts = new WeakMap()
    // The process owns no descendants and receives no model-supplied command. Waiting on this
    // exact handle releases native root/file descriptors; no PID lookup or tree claim is made.
    if (entry.process.exitCode === null && entry.process.signalCode === null) entry.process.kill("SIGKILL")
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000)
      timer.unref()
      void entry.exited.then(() => { clearTimeout(timer); resolve(true) })
    })
    // An unconfirmed exit never frees capacity or mints a stopped/known receipt. The exact
    // close event can release this slot later; scope close itself has a bounded wait.
    if (stopped) active.delete(entry)
  }
  const request = (entry: Entry, body: Record<string, unknown>, deadline: number, signal: AbortSignal,
    beforeDispatch: () => Promise<void>): Promise<Reply> => {
    if (!entry.active) return Promise.reject(failure("WORK_FILE_CHANGED"))
    if (entry.queued >= 16) return Promise.reject(failure("WORK_FILE_CAPACITY"))
    entry.queued++
    const result = entry.tail.then(async () => {
      entry.queued--
      if (!entry.active || signal.aborted || Date.now() >= deadline) throw failure("WORK_FILE_CHANGED")
      await beforeDispatch()
      if (!entry.active || signal.aborted || Date.now() >= deadline) throw failure("WORK_FILE_CHANGED")
      const bytes = Buffer.from(JSON.stringify(body))
      if (bytes.byteLength > 65_536) throw failure("WORK_FILE_CAPACITY")
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.byteLength)
      return await new Promise<Reply>((resolve, reject) => {
        const rejectCurrent = () => { void close(entry).then(() => reject(failure("WORK_FILE_UNKNOWN"))) }
        const timer = setTimeout(rejectCurrent, Math.max(1, deadline - Date.now()))
        signal.addEventListener("abort", rejectCurrent, { once: true })
        const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", rejectCurrent) }
        entry.pending = {
          id: String(body.id),
          resolve: (reply) => { clear(); resolve(reply) },
          reject: (error) => { clear(); reject(error) },
        }
        entry.process.stdin.write(Buffer.concat([size, bytes]), (error) => { if (error) rejectCurrent() })
      })
    })
    entry.tail = result.catch(() => undefined)
    return result
  }
  const linuxWriteCurrent = (entry: Entry) => Effect.gen(function* () {
    if (process.platform !== "linux" || entry.binding.projectScope.rootIdentity.kind !== "posix") return yield* failure()
    const context = yield* Effect.context()
    const reply = yield* Effect.tryPromise({ try: (signal) => request(entry, { op: "linux_write_capabilities", version: 1,
      id: randomUUID(), data: global.data }, Date.now() + 10_000, signal,
      () => Effect.runPromise(current(entry).pipe(Effect.provide(context)))), catch: () => failure() })
    if (reply.value.status !== "linux_write_profile_v1" || !reply.value.linux_write_profile || reply.bytes.length !== 0)
      return yield* failure()
    yield* LinuxWorkWritePolicy.check({ helper: entry.asset.filename, helperSHA256: entry.asset.hash,
      project: entry.binding.projectScope.canonicalRoot, projectIdentity: entry.binding.projectScope.rootIdentity,
      data: global.data }, reply.value.linux_write_profile).pipe(Effect.mapError(() => failure()))
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => {
    capacity.active = false
    return Promise.all([...active].map(close).concat([...commandWorkspaces.values()].map((workspace) => workspace.file.close())))
  }).pipe(Effect.asVoid))
  const openEntry = (input: Parameters<WorkFileCapability.Interface["open"]>[0], stage?: string, snapshot?: { workspace: string; inputs: readonly string[] }) => Effect.suspend(() => {
      if (!capacity.active) return Effect.fail(failure("WORK_FILE_CHANGED"))
      if (active.size + capacity.opening >= 8) return Effect.fail(failure("WORK_FILE_CAPACITY"))
      capacity.opening++
      return Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(WorkAuthoritySchema.ProjectBinding, { onExcessProperty: "error" })(input.binding)
      if (Option.isNone(decoded) || active.size >= 8) return yield* failure(active.size >= 8 ? "WORK_FILE_CAPACITY" : "WORK_FILE_UNAVAILABLE")
      const binding = decoded.value
      const bindingHash = Hash.sha256(CanonicalJson.stringify(binding))
      yield* currentBinding({ binding, bindingHash, controlRevision: input.controlRevision })
      const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure()))
      const asset = yield* currentAsset(installation).pipe(Effect.mapError(() => failure()))
      if (asset.hash !== binding.projectScope.helperHash) return yield* failure("WORK_FILE_CHANGED")
      const scope = yield* Effect.scope
      const originalWindowsChild = process.platform === "win32" ? yield* launchWindows(asset) : undefined
      const entry = yield* Effect.try({ try: () => {
        if (process.platform === "win32" && !originalWindowsChild) throw failure()
        const command = process.platform === "darwin"
          ? { executable: "/usr/bin/sandbox-exec", args: ["-p", snapshot ? WorkCommandRuntime.snapshotProfile({ helper: asset.filename, root: binding.projectScope.canonicalRoot,
              workspace: snapshot.workspace, inputs: snapshot.inputs }) : sandboxProfile({ filename: asset.filename,
              root: binding.projectScope.canonicalRoot, read: binding.toolPolicy.fileScope.read,
              write: stage ? binding.toolPolicy.fileScope.write : [], deny: binding.toolPolicy.fileScope.deny, stage }), "--", asset.filename] }
          : { executable: asset.filename, args: [] }
        const child: HelperProcess = originalWindowsChild ?? spawn(command.executable, command.args, { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] })
        const exited = new Promise<void>((resolve) => {
          child.once("close", () => resolve())
          // Windows stream/error events do not prove original Native job join.
          if (!originalWindowsChild) child.once("error", () => resolve())
        })
        const entry: Entry = { active: true, scope, process: child, exited, binding, bindingHash, controlRevision: input.controlRevision,
          installation, asset, buffer: Buffer.alloc(0), queued: 0, tail: Promise.resolve(), receipts: new WeakMap() }
        child.stdout.on("data", (bytes: Buffer) => {
          if (!entry.active || !entry.pending || entry.buffer.length + bytes.length > 65_536 + 51_200 + 4) { void close(entry); return }
          entry.buffer = Buffer.concat([entry.buffer, bytes])
          if (entry.buffer.length < 4) return
          const length = entry.buffer.readUInt32BE(0)
          if (length === 0 || length > 65_536) { void close(entry); return }
          if (entry.buffer.length < length + 4) return
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Response), { onExcessProperty: "error" })(entry.buffer.subarray(4, 4 + length).toString("utf8"))
          if (Option.isNone(decoded) || decoded.value.id !== entry.pending.id || decoded.value.payload_bytes > 51_200) { void close(entry); return }
          const total = 4 + length + decoded.value.payload_bytes
          if (entry.buffer.length < total) return
          if (entry.buffer.length !== total) { void close(entry); return }
          const pending = entry.pending
          entry.pending = undefined
          const payload = Buffer.from(entry.buffer.subarray(4 + length))
          entry.buffer = Buffer.alloc(0)
          pending.resolve({ value: decoded.value, bytes: payload })
        })
        child.stderr.resume()
        child.once("close", () => { void close(entry) })
        child.once("error", () => { void close(entry) })
        active.add(entry)
        return entry
      }, catch: () => failure() })
      yield* Effect.addFinalizer(() => Effect.promise(() => close(entry)))
      const context = yield* Effect.context()
      const beforeDispatch = () => Effect.runPromise(current(entry).pipe(Effect.provide(context)))
      const ready = yield* Effect.tryPromise({ try: (signal) => request(entry, {
        op: "open_root", version: 1, id: randomUUID(), path: binding.projectScope.canonicalRoot,
        expected: wireIdentity(binding.projectScope.rootIdentity),
      }, Date.now() + 10_000, signal, beforeDispatch), catch: () => failure() })
      if (ready.value.status !== "ready" || CanonicalJson.stringify(ready.value.root) !== CanonicalJson.stringify(wireIdentity(binding.projectScope.rootIdentity)))
        return yield* failure("WORK_FILE_CHANGED")
      yield* current(entry)
      return entry
      }).pipe(Effect.ensuring(Effect.sync(() => { capacity.opening-- })))
    })
  const cleanupCommand = (admissionID: string) => Effect.gen(function* () {
    const workspace = commandWorkspaces.get(admissionID)
    if (!capacity.active || !workspace || workspace.cleanupStarted || workspace.record.state !== "settled" ||
      workspace.record.releasedAt !== null) return yield* failure()
    const actual = yield* WorkCommand.get(database.db, admissionID).pipe(Effect.mapError(() => failure()))
    if (!actual || actual.version !== 1 || CanonicalJson.stringify(actual) !== CanonicalJson.stringify(workspace.record)) return yield* failure()
    workspace.cleanupStarted = true
    yield* Effect.tryPromise({ try: () => WorkCommandRuntime.cleanupWorkspace(workspace,
      [...workspace.inputs, ...workspace.record.outputs]), catch: () => failure("WORK_FILE_UNKNOWN") })
    workspace.record = yield* WorkCommand.released(database.db, actual).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
    yield* Effect.tryPromise({ try: () => workspace.file.close(), catch: () => failure("WORK_FILE_UNKNOWN") })
    commandWorkspaces.delete(admissionID)
  })
  const windowsCommands = process.platform === "win32" ? yield* Effect.gen(function* () {
    const { WindowsWorkCommand } = yield* Effect.promise(() => import("./windows-work-command"))
    return yield* WindowsWorkCommand.make((root) => {
      const entry = lookup(root)
      if (!entry?.active || !capacity.active || !active.has(entry)) return undefined
      return { binding: entry.binding, bindingHash: entry.bindingHash, controlRevision: entry.controlRevision,
        installation: entry.installation, helperHash: entry.asset.hash, current: current(entry), currentBinding: currentBinding(entry),
        readInput: (relative, limit, deadline, permission) => Effect.gen(function* () {
          const context = yield* Effect.context()
          const checked = () => Effect.runPromise(current(entry).pipe(Effect.andThen(permission), Effect.provide(context)))
          const reply = yield* Effect.tryPromise({ try: (signal) => request(entry, { op: "read", version: 1, id: randomUUID(),
            relative, offset: 0, length: 1, scan_limit: limit, deadline_ms: 10_000 },
            Math.min(deadline, Date.now() + 10_000), signal, checked), catch: () => failure() })
          const observed = reply.value.observation
          if (reply.value.status !== "observed" || !observed || observed.identity.kind !== "windows" ||
            observed.scanned_bytes !== observed.file_bytes || observed.file_bytes > limit) return yield* failure()
          return { relative, identity: { kind: "windows" as const, volumeSerial: observed.identity.volume_serial,
            fileID: observed.identity.file_id }, sha256: observed.observed_sha256, bytes: observed.file_bytes }
        }),
        snapshot: (workspace, files, outputs, deadline, permission) => Effect.scoped(Effect.gen(function* () {
          const copy = yield* openEntry({ binding: entry.binding, controlRevision: entry.controlRevision }, undefined,
            { workspace: workspace.directory, inputs: files.map((file) => file.relative) })
          const context = yield* Effect.context()
          const checked = () => Effect.runPromise(current(entry).pipe(Effect.andThen(permission), Effect.provide(context)))
          const reply = yield* Effect.tryPromise({ try: (signal) => request(copy, { op: "snapshot_workspace", version: 1, id: randomUUID(),
            workspace: workspace.directory, workspace_identity: wireIdentity(workspace.identity),
            inputs: files.map((file) => ({ ...file, identity: wireIdentity(file.identity) })), outputs, deadline_ms: 30_000 },
            Math.min(deadline, Date.now() + 30_000), signal, checked), catch: () => failure("WORK_FILE_UNKNOWN") })
          yield* Effect.promise(() => close(copy))
          const snapshot = reply.value.snapshot
          if (reply.value.status !== "snapshot_ready" || !snapshot || snapshot.workspace.kind !== "windows" || reply.bytes.length !== 0)
            return yield* failure("WORK_FILE_UNKNOWN")
          return { manifestHash: snapshot.manifest_sha256, files: snapshot.files, bytes: snapshot.bytes, outputFiles: snapshot.output_files,
            identity: { kind: "windows" as const, volumeSerial: snapshot.workspace.volume_serial, fileID: snapshot.workspace.file_id } }
        })),
      }
    })
  }) : undefined
  const windowsWrites = process.platform === "win32" ? yield* WindowsWorkWrite.make((root) => {
    const entry = lookup(root)
    if (!entry?.active || !capacity.active || !active.has(entry)) return undefined
    return { binding: entry.binding, bindingHash: entry.bindingHash, controlRevision: entry.controlRevision,
      helperHash: entry.asset.hash, current: current(entry), currentBinding: currentBinding(entry),
      openChannel: () => Effect.gen(function* () {
        const owned = yield* openEntry({ binding: entry.binding, controlRevision: entry.controlRevision })
          .pipe(Effect.provideService(Scope.Scope, entry.scope))
        const context = yield* Effect.context()
        return { current: current(owned), request: (input, permission) => Effect.tryPromise({
          try: (signal) => request(owned, { ...input }, Date.now() + 10_000, signal,
            () => Effect.runPromise(current(owned).pipe(Effect.andThen(permission), Effect.provide(context)))),
          catch: (error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN"),
        }) } satisfies WindowsWorkWrite.Channel
      }),
    }
  }) : undefined
  return WorkFileCapability.Service.of({
    open: (input) => Effect.gen(function* () {
      const entry = yield* openEntry(input)
      const root = Object.freeze({}) as WorkFileCapability.Root
      roots.set(root, entry)
      return root
    }),
    current: (root) => Effect.gen(function* () {
      const entry = lookup(root)
      if (!entry) return yield* failure()
      const context = yield* Effect.context()
      const checked = yield* Effect.tryPromise({ try: (signal) => request(entry, {
        op: "check_root", version: 1, id: randomUUID(),
      }, Date.now() + 10_000, signal, () => Effect.runPromise(current(entry).pipe(Effect.provide(context)))),
        catch: () => failure("WORK_FILE_CHANGED") })
      if (checked.value.status !== "ready" || checked.bytes.length !== 0 ||
        CanonicalJson.stringify(checked.value.root) !== CanonicalJson.stringify(wireIdentity(entry.binding.projectScope.rootIdentity)))
        return yield* failure("WORK_FILE_CHANGED")
    }),
    read: (root, input) => Effect.gen(function* () {
      const entry = lookup(root)
      if (!entry) return yield* failure()
      const deadlineMs = input.deadlineMs ?? 10_000
      if (![input.offset, input.bytes, input.scanLimit, deadlineMs].every(Number.isSafeInteger) ||
        input.offset < 0 || input.bytes < 1 || input.bytes > 51_200 || input.scanLimit < 1 || input.scanLimit > 16_777_216 ||
        deadlineMs < 1 || deadlineMs > 30_000 || !relative(input.relative)) return yield* failure()
      const match = (rule: { kind: "file" | "tree"; path: string }) => input.relative === rule.path ||
        (rule.kind === "tree" && input.relative.startsWith(`${rule.path}/`))
      if (entry.binding.toolPolicy.fileScope.deny.some(match) || !entry.binding.toolPolicy.fileScope.read.some(match) ||
        input.bytes > entry.binding.toolPolicy.fileScope.maxPageBytes ||
        input.scanLimit > Math.min(entry.binding.toolPolicy.fileScope.maxReadBytes, entry.binding.toolPolicy.fileScope.maxHashBytes)) return yield* failure()
      yield* current(entry)
      const context = yield* Effect.context()
      const beforeDispatch = () => Effect.runPromise(current(entry).pipe(Effect.provide(context)))
      const response = yield* Effect.tryPromise({ try: (signal) => request(entry, { op: "read", version: 1, id: randomUUID(),
        relative: input.relative, offset: input.offset, length: input.bytes, scan_limit: input.scanLimit, deadline_ms: deadlineMs,
      }, Date.now() + deadlineMs, signal, beforeDispatch), catch: (error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN") })
      yield* current(entry)
      const observation = response.value.observation
      if (response.value.status !== "observed" || !observation || observation.offset !== input.offset ||
        observation.scanned_bytes !== observation.file_bytes || observation.scanned_bytes > input.scanLimit ||
        response.bytes.byteLength > input.bytes || observation.page_sha256 !== Hash.sha256(response.bytes) ||
        CanonicalJson.stringify(response.value.root) !== CanonicalJson.stringify(wireIdentity(entry.binding.projectScope.rootIdentity)))
        return yield* failure("WORK_FILE_CHANGED")
      const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(response.bytes), catch: () => failure() })
      const handle = Object.freeze({}) as WorkFileCapability.Observation
      if (entry.latest) entry.receipts.delete(entry.latest)
      entry.latest = handle
      entry.receipts.set(handle, Object.freeze({ workID: entry.binding.workID, bindingHash: entry.bindingHash,
        controlRevision: entry.controlRevision, rootIdentity: entry.binding.projectScope.rootIdentity, helperHash: entry.asset.hash,
        fileIdentity: observation.identity.kind === "posix" ? observation.identity : {
          kind: "windows" as const, volumeSerial: observation.identity.volume_serial, fileID: observation.identity.file_id,
        },
        relative: input.relative, offset: input.offset, bytes: response.bytes.length, fileBytes: observation.file_bytes,
        scannedBytes: observation.scanned_bytes, observedHash: observation.observed_sha256, pageHash: observation.page_sha256,
        observedAt: Date.now(), snapshot: "stream_observation" }))
      return { observation: handle, text, next: input.offset + response.bytes.length < observation.file_bytes ? input.offset + response.bytes.length : null }
    }),
    describe: (root, observation) => {
      const entry = lookup(root)
      return entry?.active ? entry.receipts.get(observation) : undefined
    },
    command: (root, input) => Effect.scoped(Effect.gen(function* () {
      if (process.platform === "win32") return windowsCommands ? yield* windowsCommands.command(root, input) : yield* failure()
      const entry = lookup(root)
      if (!entry || (process.platform !== "darwin" && process.platform !== "linux") || commandWorkspaces.size >= WorkCommandSchema.MAX_CUSTODY) return yield* failure()
      const decoded = Schema.decodeUnknownOption(WorkCommandSchema.Input, { onExcessProperty: "error" })(input.input)
      const recipe = entry.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === input.input.commandID)
      if (Option.isNone(decoded) || !recipe || decoded.value.parameters.length !== recipe.parameters.length ||
        new Set(decoded.value.parameters.map((item) => item.key)).size !== decoded.value.parameters.length ||
        decoded.value.parameters.some((item) => !recipe.parameters.find((parameter) => parameter.key === item.key)?.choices.includes(item.value)))
        return yield* failure()
      yield* trace("command.current", current(entry))
      yield* trace("command.permission", input.checkPermission)
      if ((!macRecipe(recipe) && recipe.schemaVersion !== "work-command-recipe.v2") ||
        (macRecipe(recipe) && (process.platform !== "darwin" || recipe.executable.platform !== `${process.platform}-${process.arch}`)) ||
        (recipe.schemaVersion === "work-command-recipe.v2" && (process.platform !== "linux" || recipe.executable.identity.kind !== "posix" ||
          recipe.executable.platform !== `${process.platform}-${process.arch}`))) return yield* failure()
      if (recipe.schemaVersion === "work-command-recipe.v2") yield* NativeWorkProcessSupervisor.requireProvisioning
      const executable = macRecipe(recipe)
        ? yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedMacRecipeRuntime(entry.installation, recipe), catch: () => failure() })
        : { filename: path.join(yield* NativeInstallation.assetDirectory(entry.installation), "bun-command-runtime"),
            executable: (yield* NativeWorkProcessSupervisor.inspectRuntime(entry.installation)).executable }
      const installation = yield* LocalTaskAuthority.readInstallation.pipe(Effect.mapError(() => failure()))
      yield* trace("command.reserve.current", currentBinding(entry))
      const reserved = yield* trace("command.reserve", WorkCommand.reserve(database.db, { commandID: randomUUID(), admissionID: input.admissionID,
        instanceID: installation.instanceID, workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID,
        sessionID: entry.binding.sessionID, inputID: entry.binding.inputID, activityID: input.activityID,
        providerReceiptID: input.providerReceiptID, providerAttemptID: input.providerAttemptID, toolCallID: input.toolCallID,
        ownerToken: input.ownerToken, sessionClaimToken: input.sessionClaimToken, bindingHash: entry.bindingHash,
        controlRevision: entry.controlRevision, recipeID: recipe.logicalID, recipeRevision: recipe.revision,
        recipeHash: Hash.sha256(CanonicalJson.stringify(recipe)), requestHash: Hash.sha256(CanonicalJson.stringify(input.input)),
        helperHash: entry.asset.hash, runtimeHash: recipe.executable.sha256, workspaceBasename: `cmd_${randomBytes(16).toString("hex")}`,
        deadline: Math.min(entry.binding.deadline, Date.now() + recipe.timeoutMs),
      })).pipe(Effect.mapError(() => failure()))
      if (reserved.replayed) return yield* failure("WORK_FILE_UNKNOWN")
      if (reserved.record.version !== 1) return yield* failure()
      const state = { record: reserved.record }
      const context = yield* Effect.context()
      const checked = () => Effect.runPromise(Effect.gen(function* () {
        yield* current(entry); yield* input.checkPermission
        if (macRecipe(recipe))
          yield* Effect.tryPromise({ try: () => WorkCommandRuntime.verifiedMacRecipeRuntime(entry.installation, recipe), catch: () => failure() })
        if (recipe.schemaVersion === "work-command-recipe.v2") {
          const actual = yield* NativeWorkProcessSupervisor.inspectRuntime(entry.installation)
          if (CanonicalJson.stringify(actual.executable) !== CanonicalJson.stringify(recipe.executable)) return yield* failure("WORK_FILE_CHANGED")
        }
      }).pipe(Effect.provide(context)))
      const workspace = yield* trace("command.workspace", Effect.tryPromise({ try: () => WorkCommandRuntime.createWorkspace(global.data,
        state.record.workspaceBasename, entry.binding.projectScope.canonicalRoot), catch: () => failure() }))
      const retained = { ...workspace, record: state.record, bindingHash: entry.bindingHash,
        inputs: [] as { relative: string; sha256: string; bytes: number }[], published: new Set<string>(), cleanupStarted: false }
      commandWorkspaces.set(input.admissionID, retained)
      const inputs: { relative: string; identity: typeof WireIdentity.Type; sha256: string; bytes: number }[] = []
      const snapshotLimits = macRecipe(recipe) ? recipe.sandbox :
        { maxInputFileBytes: 16_777_216, maxInputBytes: 67_108_864 }
      for (const relative of recipe.inputs) {
        const matches = (rule: { kind: "file" | "tree"; path: string }) => relative === rule.path ||
          (rule.kind === "tree" && relative.startsWith(`${rule.path}/`))
        if (entry.binding.toolPolicy.fileScope.deny.some(matches) || !entry.binding.toolPolicy.fileScope.read.some(matches))
          return yield* failure()
        const reply = yield* trace("command.input", Effect.tryPromise({ try: (signal) => request(entry, { op: "read", version: 1, id: randomUUID(),
          relative, offset: 0, length: 1, scan_limit: Math.min(snapshotLimits.maxInputFileBytes,
            entry.binding.toolPolicy.fileScope.maxHashBytes, entry.binding.toolPolicy.fileScope.maxReadBytes), deadline_ms: 10000,
        }, Math.min(state.record.deadline, Date.now() + 10000), signal, checked), catch: () => failure() }))
        const observation = reply.value.observation
        if (reply.value.status !== "observed" || !observation || observation.scanned_bytes !== observation.file_bytes ||
          observation.file_bytes > snapshotLimits.maxInputFileBytes ||
          inputs.reduce((sum, item) => sum + item.bytes, observation.file_bytes) > snapshotLimits.maxInputBytes)
          return yield* failure()
        inputs.push({ relative, identity: observation.identity, sha256: observation.observed_sha256, bytes: observation.file_bytes })
      }
      retained.inputs = inputs.map((item) => ({ relative: item.relative, sha256: item.sha256, bytes: item.bytes }))
      const copy = yield* trace("command.snapshot.open", openEntry({ binding: entry.binding, controlRevision: entry.controlRevision }, undefined,
        { workspace: workspace.directory, inputs: recipe.inputs }))
      const snapshot = yield* trace("command.snapshot.request", Effect.tryPromise({ try: (signal) => request(copy, { op: "snapshot_workspace", version: 1, id: randomUUID(),
        workspace: workspace.directory, workspace_identity: workspace.identity, inputs, outputs: recipe.outputs, deadline_ms: 30000,
      }, Math.min(state.record.deadline, Date.now() + 30000), signal, checked), catch: () => failure() }))
      yield* Effect.promise(() => close(copy))
      if (snapshot.value.status !== "snapshot_ready" || !snapshot.value.snapshot || snapshot.bytes.length !== 0 ||
        CanonicalJson.stringify(snapshot.value.snapshot.workspace) !== CanonicalJson.stringify(workspace.identity) ||
        snapshot.value.snapshot.files !== inputs.length || snapshot.value.snapshot.bytes !== inputs.reduce((sum, item) => sum + item.bytes, 0) ||
        snapshot.value.snapshot.output_files !== recipe.outputs.length) return yield* trace("command.snapshot.validate", failure())
      yield* trace("command.prepared.current", currentBinding(entry))
      state.record = yield* trace("command.prepared", WorkCommand.prepared(database.db, state.record, { workspaceIdentity: workspace.identity,
        snapshotHash: snapshot.value.snapshot.manifest_sha256, observedRetainedBytes: snapshot.value.snapshot.bytes }))
        .pipe(Effect.mapError(() => failure()))
      retained.record = state.record
      const { NativeWorkStorageCleanup } = yield* Effect.promise(() => import("./work-storage-cleanup"))
      const retirement = yield* trace("command.storage.capture", NativeWorkStorageCleanup.capture({ kind: "command", admissionID: input.admissionID }))
        .pipe(Effect.provideService(Database.Service, database), Effect.provideService(Global.Service, global),
          Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      if (inputs.some((source) => !retirement.manifest.files.some((copied) => copied.relative === source.relative &&
        copied.sha256 === source.sha256 && copied.bytes === source.bytes)) ||
        recipe.outputs.some((relative) => !retirement.manifest.files.some((output) => output.relative === relative &&
          output.bytes === 0 && output.sha256 === Hash.sha256(Buffer.alloc(0))))) return yield* failure("WORK_FILE_UNKNOWN")
      yield* Effect.promise(checked)
      yield* Effect.tryPromise({ try: () => WorkCommandRuntime.currentWorkspace(workspace), catch: () => failure() })
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (recipe.schemaVersion === "work-command-recipe.v2") {
          const authority: NonNullable<Context.Service.Shape<typeof NativeWorkProcessSupervisor.Authority>> = {
            authorize: (ready, request) => Effect.gen(function* () {
              const original = NativeWorkProcessSupervisor.describeReady(ready)
              if (!original || original.workID !== state.record.workID || original.commandID !== state.record.commandID ||
                original.recipeHash !== state.record.recipeHash || original.controlRevision !== state.record.controlRevision ||
                request.workspace !== workspace.directory || CanonicalJson.stringify(request.configuration.isolation) !== CanonicalJson.stringify(recipe.sandbox))
                return yield* new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED", message: "Original command admission differs" })
              yield* current(entry)
              yield* input.checkPermission
              yield* trace("command.dispatch.current", currentBinding(entry))
              state.record = yield* database.db.transaction((tx) => WorkCommand.dispatchReadyInTransaction(tx, state.record,
                original.nonce, original.rootPID), { behavior: "immediate" })
              retained.record = state.record
            }).pipe(Effect.mapError(() => new NativeWorkProcessSupervisor.Error({ code: "SUPERVISOR_AUTH_REQUIRED", message: "Current command authority is unavailable" }))),
          }
          const supervisor = yield* NativeWorkProcessSupervisor.make(entry.installation).pipe(
            Effect.provideService(NativeWorkProcessSupervisor.Authority, authority), Effect.mapError(() => failure()))
          const actualExecutable = yield* supervisor.executable().pipe(Effect.mapError(() => failure()))
          const completion: { value?: NativeWorkProcessSupervisor.Completion } = {}
          const exit = yield* restore(supervisor.execute({ binding: { workID: state.record.workID, commandID: state.record.commandID,
              recipeHash: state.record.recipeHash, controlRevision: state.record.controlRevision },
            configuration: { target: recipe.executable.platform, isolation: recipe.sandbox }, workspace: workspace.directory,
            workspaceIdentity: workspace.identity, executable: actualExecutable,
            // Snapshot creation changes inode identity. The original Native
            // retirement capture describes the copied bytes already checked
            // against the source above; only that workspace identity is valid.
            inputs: inputs.map((item) => ({ ...item,
              identity: wireIdentity(retirement.manifest.files.find((copied) => copied.relative === item.relative)!.identity) })),
            outputs: recipe.outputs, argv: recipe.argv.map((item) => item.kind === "literal" ? item.value :
              input.input.parameters.find((parameter) => parameter.key === item.parameter)!.value),
            ...(recipe.cwd === null ? {} : { cwd: recipe.cwd }), env: Object.fromEntries(recipe.environment.map((item) => [item.name, item.value])),
            timeoutMs: Math.min(recipe.timeoutMs, state.record.deadline - Date.now()), stdoutBytes: recipe.stdoutBytes, stderrBytes: recipe.stderrBytes,
          }, (value) => { completion.value = value })).pipe(Effect.exit)
          const completed = Exit.isSuccess(exit) ? exit.value : completion.value
          if (!completed) {
            if (state.record.state === "dispatching") {
              state.record = yield* WorkCommand.unknown(database.db, state.record).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
              retained.record = state.record
            }
            return yield* failure("WORK_FILE_UNKNOWN")
          }
          const observed = supervisor.describeStop(completed.proof)
          if (!observed || observed.supervision.nonce !== state.record.processIncarnation || observed.supervision.rootPID !== state.record.processID)
            return yield* failure("WORK_FILE_UNKNOWN")
          const outputs = yield* Effect.tryPromise({ try: () => Promise.all(recipe.outputs.map((relative) =>
            WorkCommandRuntime.readOutput(workspace, relative).then((output) => output.description))), catch: () => failure("WORK_FILE_UNKNOWN") })
          const summary = (stream: typeof observed.result.stdout) => ({ sha256: stream.sha256, bytes: stream.bytes,
            capturedBytes: stream.captured_bytes, truncated: stream.bytes !== stream.captured_bytes, complete: stream.eof })
          state.record = yield* WorkCommand.settled(database.db, state.record, { outcome: observed.result.cancelled ? "cancelled" : "exited",
            exitCode: observed.result.exit_code, signal: observed.result.signal == null ? null : `signal:${observed.result.signal}`,
            stopConfirmed: true, stdout: summary(observed.result.stdout), stderr: summary(observed.result.stderr),
            outputs, observedRetainedBytes: snapshot.value.snapshot!.bytes + outputs.reduce((sum, item) => sum + item.bytes, 0) +
              observed.result.stdout.captured_bytes + observed.result.stderr.captured_bytes }).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
          retained.record = state.record
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          const handle = Object.freeze({}) as WorkFileCapability.CommandObservation
          commandReceipts.set(handle, { root, description: { record: state.record, observedAt: Date.now(), supervision: observed.supervision } })
          return { observation: handle, output: { outcome: state.record.outcome!, exitCode: state.record.exitCode, signal: state.record.signal,
            stdout: { ...summary(observed.result.stdout), text: completed.stdout.toString("utf8") },
            stderr: { ...summary(observed.result.stderr), text: completed.stderr.toString("utf8") }, stopConfirmed: true,
            manifestHash: state.record.snapshotHash!, outputs: outputs.map((item) => ({ kind: "command_output" as const,
              admissionID: state.record.admissionID, relative: item.relative, sha256: item.sha256, bytes: item.bytes })) } }
        }
        yield* trace("command.dispatch.current", currentBinding(entry))
        state.record = yield* WorkCommand.beginDispatch(database.db, state.record, randomUUID()).pipe(Effect.mapError(() => failure()))
        retained.record = state.record
        const observed: { value?: Awaited<ReturnType<typeof WorkCommandRuntime.execute>> } = {}
        const exit = yield* restore(Effect.callback<Awaited<ReturnType<typeof WorkCommandRuntime.execute>>, WorkFileCapability.Error>((resume, signal) => {
          const pending = WorkCommandRuntime.execute({ helper: entry.asset.filename, executable: executable.filename,
            workspace: workspace.directory, identity: workspace.identity, recipe, parameters: input.input.parameters,
            deadline: state.record.deadline, signal, onStarted: (pid) => Effect.runPromise(Effect.gen(function* () {
              state.record = yield* WorkCommand.started(database.db, state.record, pid)
              retained.record = state.record
              yield* current(entry)
              yield* input.checkPermission
            }).pipe(Effect.provide(context))),
          }).then((value) => { observed.value = value; resume(Effect.succeed(value)) }, () => resume(Effect.fail(failure("WORK_FILE_UNKNOWN"))))
          // Effect interruption waits for exact native termination and stream completion;
          // Promise abort alone is never treated as command stop confirmation.
          return Effect.promise(() => pending)
        })).pipe(Effect.exit)
        if (!observed.value) {
          state.record = yield* WorkCommand.unknown(database.db, state.record).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
          retained.record = state.record
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          return yield* failure("WORK_FILE_UNKNOWN")
        }
        const outputExit = yield* Effect.tryPromise({ try: () => Promise.all(recipe.outputs.map((relative) =>
          WorkCommandRuntime.readOutput(workspace, relative).then((output) => output.description))), catch: () => failure("WORK_FILE_UNKNOWN") }).pipe(Effect.exit)
        if (Exit.isFailure(outputExit)) {
          state.record = yield* WorkCommand.unknown(database.db, state.record).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
          retained.record = state.record
          return yield* Effect.failCause(outputExit.cause)
        }
        const result = observed.value
        const summary = (stream: typeof result.stdout) => ({ sha256: stream.sha256, bytes: stream.bytes,
          capturedBytes: stream.capturedBytes, truncated: stream.truncated, complete: stream.complete })
        state.record = yield* WorkCommand.settled(database.db, state.record, { outcome: result.outcome,
          exitCode: result.exitCode, signal: result.signal, stopConfirmed: result.stopConfirmed,
          stdout: summary(result.stdout), stderr: summary(result.stderr), outputs: outputExit.value,
          observedRetainedBytes: snapshot.value.snapshot!.bytes + outputExit.value.reduce((sum, item) => sum + item.bytes, 0) +
            result.stdout.capturedBytes + result.stderr.capturedBytes,
        }).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
        retained.record = state.record
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
        const handle = Object.freeze({}) as WorkFileCapability.CommandObservation
        commandReceipts.set(handle, { root, description: { record: state.record, observedAt: Date.now() } })
        return { observation: handle, output: { ...result, manifestHash: state.record.snapshotHash!,
          outputs: outputExit.value.map((item) => ({ kind: "command_output" as const, admissionID: state.record.admissionID,
            relative: item.relative, sha256: item.sha256, bytes: item.bytes })) } }
      }))
    })).pipe(Effect.mapError((error) => error instanceof WorkFileCapability.Error ? error : failure())),
    describeCommand: (root, observation) => {
      if (process.platform === "win32") return windowsCommands?.describeCommand(root, observation)
      const entry = lookup(root)
      const known = commandReceipts.get(observation)
      return entry?.active && known?.root === root ? known.description : undefined
    },
    commandOutput: (root, input) => Effect.gen(function* () {
      if (process.platform === "win32") return windowsCommands ? yield* windowsCommands.commandOutput(root, input) : yield* failure()
      const entry = lookup(root)
      const workspace = commandWorkspaces.get(input.admissionID)
      if (!entry || !workspace || workspace.bindingHash !== entry.bindingHash ||
        workspace.record.workID !== entry.binding.workID || workspace.record.state !== "settled" || workspace.record.releasedAt !== null)
        return yield* failure()
      yield* current(entry)
      const output = workspace.record.outputs.find((item) => item.relative === input.relative && item.sha256 === input.sha256)
      if (!output || output.bytes > 51200) return yield* failure("WORK_FILE_CAPACITY")
      const actual = yield* Effect.tryPromise({ try: () => WorkCommandRuntime.readOutput(workspace, input.relative, 51200), catch: () => failure("WORK_FILE_CHANGED") })
      if (CanonicalJson.stringify(actual.description) !== CanonicalJson.stringify(output)) return yield* failure("WORK_FILE_CHANGED")
      yield* current(entry)
      return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(actual.bytes), catch: () => failure() })
    }),
    cleanupCommand: (root, admissionID, published) => Effect.gen(function* () {
      if (process.platform === "win32") return windowsCommands ? yield* windowsCommands.cleanupCommand(root, admissionID, published) : yield* failure()
      const entry = lookup(root)
      const workspace = commandWorkspaces.get(admissionID)
      if (!entry || !workspace || workspace.cleanupStarted || workspace.bindingHash !== entry.bindingHash ||
        workspace.record.workID !== entry.binding.workID || workspace.record.state !== "settled" || workspace.record.releasedAt !== null)
        return yield* failure()
      yield* current(entry)
      if (published) {
        if (published.admissionID !== admissionID || !workspace.record.outputs.some((output) =>
          output.relative === published.relative && output.sha256 === published.sha256 && output.bytes === published.bytes))
          return yield* failure()
        workspace.published.add(published.relative)
      }
      if (workspace.record.outputs.some((output) => !workspace.published.has(output.relative))) return
      yield* cleanupCommand(admissionID)
    }),
    cleanupCompletedWork: (input) => Effect.gen(function* () {
      if (process.platform === "win32") return windowsCommands ? yield* windowsCommands.cleanupCompletedWork(input) : yield* failure()
      if (!capacity.active) return yield* failure()
      const work = yield* WorkAuthority.get(database.db, input.workID).pipe(Effect.mapError(() => failure()))
      if (!work || work.binding_hash !== input.bindingHash || !["succeeded", "failed"].includes(work.outcome)) return yield* failure()
      // This only destroys same-process retained objects. It does not create a Work,
      // execution, historical proof or cold filesystem capability from the SQL terminal.
      for (const [admissionID, workspace] of commandWorkspaces) {
        const record = workspace.record
        if (record.workID !== input.workID || workspace.bindingHash !== input.bindingHash || record.state !== "settled" ||
          record.releasedAt !== null || workspace.cleanupStarted) continue
        const [effect] = yield* database.db.all<{ known: number }>(sql`SELECT 1 known FROM session_v2_tool_effect
          WHERE receipt_id=${record.providerReceiptID} AND provider_attempt_id=${record.providerAttemptID}
            AND session_id=${record.sessionID} AND tool_call_id=${record.toolCallID} AND owner_token=${record.ownerToken}
            AND tool_name='managed_command' AND effect_kind='mutating' AND state='settled' AND error_code IS NULL
            AND typeof(known_command_proof)='text' AND length(CAST(known_command_proof AS BLOB)) BETWEEN 1 AND 16384
            AND known_read_proof IS NULL AND known_write_proof IS NULL`).pipe(Effect.mapError(() => failure()))
        if (!effect) continue
        yield* cleanupCommand(admissionID).pipe(Effect.catchTag("WorkFileCapability.Error", (error) =>
          Effect.logWarning("Managed command custody cleanup remains unresolved", { workID: input.workID,
            commandID: record.commandID, admissionID, code: error.code })))
      }
    }),
    write: (root, input) => Effect.scoped(Effect.gen(function* () {
      if (process.platform === "win32") return windowsWrites ? yield* windowsWrites.write(root, input) : yield* failure()
      const entry = lookup(root)
      if (!entry || !entry.active || entry.written || (process.platform !== "darwin" && process.platform !== "linux")) return yield* trace("write.entry", failure())
      const content = Buffer.from(input.content, "utf8")
      if (content.length > WorkWriteStageSchema.MAX_CONTENT_BYTES || content.toString("utf8") !== input.content ||
        !relative(input.relative) || Option.isNone(Schema.decodeUnknownOption(WorkWriteStageSchema.Expected,
          { onExcessProperty: "error" })(input.expected))) return yield* trace("write.input", failure())
      const match = (rule: { kind: "file" | "tree"; path: string }) => input.relative === rule.path ||
        (rule.kind === "tree" && input.relative.startsWith(`${rule.path}/`))
      if (entry.binding.toolPolicy.fileScope.deny.some(match) || !entry.binding.toolPolicy.fileScope.write.some(match) ||
        content.length > entry.binding.toolPolicy.fileScope.maxWriteBytes) return yield* trace("write.scope", failure())
      yield* trace("write.current", current(entry))
      yield* trace("write.permission", input.checkPermission)
      // The ordinary-UID helper must enter the exact installed current-path policy
      // before a durable custody slot or a stage can be created.
      if (process.platform === "linux") yield* trace("write.linux.policy", linuxWriteCurrent(entry))
      const installation = yield* trace("write.installation", LocalTaskAuthority.readInstallation).pipe(Effect.mapError(() => failure()))
      // Observe the bounded retained namespace before adding a new obligation. External
      // old-FD growth can exceed its reservation; record that fact and stop new admission.
      const custody = yield* trace("write.custody", WorkWriteStage.custody(database.db, installation.instanceID))
        .pipe(Effect.mapError(() => failure("WORK_FILE_CAPACITY")))
      for (const retained of custody) {
        const directory = path.join(global.data, "work-write-stage", retained.basename)
        const bytes = yield* Effect.tryPromise({ try: async () => {
          const file = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            .catch((error: unknown) => {
              if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
              throw error
            })
          if (!file) return undefined
          try {
            const actual = await file.stat({ bigint: true })
            const identity = retained.stageIdentity ?? { kind: "posix" as const, device: actual.dev.toString(), inode: actual.ino.toString() }
            return await retainedStage({ file, identity }, directory)
          } finally { await file.close() }
        }, catch: () => failure("WORK_FILE_CAPACITY") })
        if (bytes !== undefined && bytes !== retained.observedRetainedBytes)
          yield* WorkWriteStage.observed(database.db, retained, bytes).pipe(Effect.mapError(() => failure("WORK_FILE_CAPACITY")))
      }
      const expected = input.expected.kind === "missing" ? { kind: "missing" as const } : {
        kind: "observed" as const, identity: wireIdentity(input.expected.identity), sha256: input.expected.sha256, bytes: input.expected.bytes,
      }
      const stageID = `stage_${Hash.sha256(CanonicalJson.stringify([installation.instanceID, input.admissionID]))}`
      const basename = randomBytes(16).toString("hex")
      const directory = path.join(global.data, "work-write-stage", basename)
      const prepareID = randomUUID()
      const payload = { op: "prepare_write", version: 1, id: prepareID, relative: input.relative,
        stage: directory, content: input.content, expected, deadline_ms: 10_000 }
      // Worst native identity encoding is small and bounded separately. Refuse escaped
      // payloads before reserving custody instead of truncating valid UTF-8 content.
      if (Buffer.byteLength(JSON.stringify(payload)) + 256 > 65_536) return yield* trace("write.payload.capacity", failure("WORK_FILE_CAPACITY"))
      yield* trace("write.reserve.current", currentBinding(entry))
      const reserved = yield* trace("write.reserve", WorkWriteStage.reserve(database.db, { stageID, instanceID: installation.instanceID,
        workID: entry.binding.workID, rootWorkID: entry.binding.rootWorkID, sessionID: entry.binding.sessionID,
        inputID: entry.binding.inputID, activityID: input.activityID, providerReceiptID: input.providerReceiptID,
        providerAttemptID: input.providerAttemptID, admissionID: input.admissionID, toolCallID: input.toolCallID,
        ownerToken: input.ownerToken, sessionClaimToken: input.sessionClaimToken,
        bindingHash: entry.bindingHash, controlRevision: entry.controlRevision,
        requestHash: Hash.sha256(CanonicalJson.stringify({ relative: input.relative, expected: input.expected,
          nextHash: Hash.sha256(content), nextBytes: content.length, admissionID: input.admissionID,
          definitionHash: input.definitionHash })),
        definitionHash: input.definitionHash, helperHash: entry.asset.hash, relative: input.relative, basename,
        rootIdentity: entry.binding.projectScope.rootIdentity, expected: input.expected,
        nextHash: Hash.sha256(content), nextBytes: content.length,
      })).pipe(Effect.mapError((error) => failure(error.code === "WRITE_STAGE_CAPACITY" ? "WORK_FILE_CAPACITY" : "WORK_FILE_UNKNOWN")))
      if (reserved.replayed) return yield* failure("WORK_FILE_UNKNOWN")
      // The durable slot precedes every stage directory or file. Failure keeps its original
      // reservation; no startup sweep guesses whether an interrupted publication happened.
      const stage = yield* Effect.acquireRelease(Effect.tryPromise({ try: () => createStage(global.data,
        basename, entry.binding.projectScope.rootIdentity), catch: () => failure() }),
        (stage) => Effect.promise(() => stage.file.close()))
      yield* trace("write.located.current", currentBinding(entry))
      let record = yield* WorkWriteStage.located(database.db, reserved.record, stage.identity)
        .pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      // The same helper owns preparation, publication and cleanup until the enclosing
      // canonical tool scope closes; returning WriteOutput does not discard that owner.
      const owned = yield* openEntry({ binding: entry.binding, controlRevision: entry.controlRevision }, directory)
        .pipe(Effect.provideService(Scope.Scope, entry.scope))
      if (process.platform === "linux") yield* trace("write.linux.owned.policy", linuxWriteCurrent(owned))
      const context = yield* Effect.context()
      const before = () => Effect.runPromise(current(owned).pipe(Effect.andThen(input.checkPermission), Effect.provide(context)))
      const prepared = yield* Effect.tryPromise({ try: (signal) => request(owned, { ...payload,
        stage_identity: wireIdentity(stage.identity) }, Date.now() + 10_000, signal, before),
        catch: (error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN") })
      const observe = (outcome: WorkFileCapability.WriteDescription["outcome"], fileIdentity: WorkFileCapability.Identity | null) => Effect.gen(function* () {
        const retained = yield* Effect.tryPromise({ try: () => retainedStage(stage, directory), catch: () => failure("WORK_FILE_UNKNOWN") })
        record = yield* WorkWriteStage.settled(database.db, record, outcome === "published" ? "published" : "refused", retained)
          .pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
        const handle = Object.freeze({}) as WorkFileCapability.WriteObservation
        entry.written = { handle, owner: owned, directory, cleanupStarted: false,
          description: Object.freeze({ record, outcome, fileIdentity, observedAt: Date.now() }) }
        return { observation: handle, outcome }
      })
      if (prepared.value.status === "refused" && prepared.value.code === "FILE_SCOPE_UNAVAILABLE")
        return yield* observe("refused_before_publish", null)
      if (prepared.value.status !== "prepared" || !prepared.value.preparation || prepared.bytes.length ||
        CanonicalJson.stringify(prepared.value.preparation.stage) !== CanonicalJson.stringify(wireIdentity(stage.identity)))
        return yield* failure("WORK_FILE_UNKNOWN")
      yield* trace("write.prepared.current", currentBinding(entry))
      record = yield* WorkWriteStage.prepared(database.db, record, {
        parentIdentity: fromWireIdentity(prepared.value.preparation.parent), stageIdentity: stage.identity,
      }).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      const { NativeWorkStorageCleanup } = yield* Effect.promise(() => import("./work-storage-cleanup"))
      yield* trace("write.storage.capture", NativeWorkStorageCleanup.capture({ kind: "write", admissionID: input.admissionID }))
        .pipe(Effect.provideService(Database.Service, database), Effect.provideService(Global.Service, global),
          Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      yield* current(entry)
      yield* input.checkPermission
      yield* trace("write.publication.current", currentBinding(entry))
      record = yield* WorkWriteStage.beginPublication(database.db, record).pipe(Effect.mapError(() => failure("WORK_FILE_UNKNOWN")))
      const published = yield* Effect.tryPromise({ try: (signal) => request(owned, {
        op: "publish_write", version: 1, id: randomUUID(), prepared_id: prepareID,
      }, Date.now() + 10_000, signal, before),
        catch: (error) => error instanceof WorkFileCapability.Error ? error : failure("WORK_FILE_UNKNOWN") })
      yield* current(entry)
      if (published.value.status === "refused" && published.value.code === "FILE_SCOPE_UNAVAILABLE")
        return yield* observe("refused_before_publish", null)
      const result = published.value.write
      if (published.value.status !== "published" || !result || published.bytes.length || result.sha256 !== record.nextHash ||
        result.bytes !== record.nextBytes || CanonicalJson.stringify(result.previous) !== CanonicalJson.stringify(expected) ||
        CanonicalJson.stringify(result.parent) !== CanonicalJson.stringify(wireIdentity(record.parentIdentity!)) ||
        CanonicalJson.stringify(result.stage) !== CanonicalJson.stringify(wireIdentity(stage.identity))) return yield* failure("WORK_FILE_UNKNOWN")
      return yield* observe("published", fromWireIdentity(result.file))
    })),
    cleanupWrite: (root, observation) => Effect.scoped(Effect.gen(function* () {
      if (process.platform === "win32") return windowsWrites ? yield* windowsWrites.cleanupWrite(root, observation) : yield* failure()
      const entry = lookup(root)
      const written = entry?.written
      if (!entry?.active || !written || written.handle !== observation || written.cleanupStarted ||
        !written.owner.active || !written.description.record.stageIdentity) return yield* failure()
      yield* current(entry)
      const actual = yield* WorkWriteStage.get(database.db, written.description.record.admissionID)
        .pipe(Effect.mapError(() => failure()))
      if (!actual || CanonicalJson.stringify(actual) !== CanonicalJson.stringify(written.description.record) ||
        !["published", "refused"].includes(actual.state)) return yield* failure()
      const stage = yield* Effect.acquireRelease(Effect.tryPromise({ try: async () => {
        const file = await fs.open(written.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        return { file, identity: written.description.record.stageIdentity! }
      }, catch: () => failure() }), (stage) => Effect.promise(() => stage.file.close()))
      yield* Effect.tryPromise({ try: () => retainedStage(stage, written.directory), catch: () => failure() })
      written.cleanupStarted = true
      const context = yield* Effect.context()
      const cleaned = yield* Effect.tryPromise({ try: (signal) => request(written.owner,
        { op: "cleanup_write", version: 1, id: randomUUID() }, Date.now() + 10_000, signal,
        () => Effect.runPromise(current(entry).pipe(Effect.provide(context)))), catch: () => failure() })
      if (cleaned.value.status !== "cleaned" || cleaned.bytes.length !== 0) return yield* failure()
      yield* Effect.tryPromise({ try: async () => {
        if (await retainedStage(stage, written.directory) !== 0) throw failure()
        const directory = await fs.opendir(written.directory)
        for await (const _ of directory) throw failure()
        await fs.rmdir(written.directory)
        // APFS may retain the directory's link count after rmdir on an open FD.
        // The successful removal and absent name are checked alongside the original handle.
        const removed = await stage.file.stat({ bigint: true })
        if (stage.identity.kind !== "posix" || !removed.isDirectory() ||
          removed.dev.toString() !== stage.identity.device || removed.ino.toString() !== stage.identity.inode) throw failure()
        await fs.lstat(written.directory).then(() => { throw failure() }, (error: unknown) => {
          if (typeof error !== "object" || !error || !("code" in error) || error.code !== "ENOENT") throw error
        })
      }, catch: () => failure() })
      yield* WorkWriteStage.released(database.db, actual).pipe(Effect.mapError(() => failure()))
    })),
    describeWrite: (root, observation) => {
      if (process.platform === "win32") return windowsWrites?.describeWrite(root, observation)
      const entry = lookup(root)
      return entry?.active && entry.written?.handle === observation ? entry.written.description : undefined
    },
    live: () => ({ helpers: active.size, queued: [...active].reduce((count, entry) => count + entry.queued, 0),
      inFlight: [...active].filter((entry) => entry.pending !== undefined).length,
      observations: [...active].filter((entry) => entry.latest !== undefined).length }),
  })
}))

/** Fixed asset verification for cold known-result validation. It executes no helper command
 * and never accepts a path/executable from a record. Call outside the SQL transaction. */
export const requireInstalled = Effect.fn("WorkFileHelper.requireInstalled")(function* (expectedHash: string) {
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure()))
  const asset = yield* currentAsset(installation).pipe(Effect.mapError(() => failure()))
  if (asset.hash !== expectedHash) return yield* failure("WORK_FILE_CHANGED")
})

/** Fixed-purpose deterministic validation reuses the same installed helper. This is
 * construction provenance only: EventValidation's durable rule/current scope gates
 * still authorize every snapshot and command. No caller chooses an executable. */
export const validationAsset = Effect.fn("WorkFileHelper.validationAsset")(function* (expectedHash: string) {
  // These independent callers still launch a path. Their Windows purposes
  // require their own original Native port before this construction can enable.
  if (process.platform === "win32") return yield* failure()
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure()))
  const asset = yield* Effect.tryPromise({ try: () => verifiedAsset(installation), catch: () => failure() })
  if (asset.hash !== expectedHash) return yield* failure("WORK_FILE_CHANGED")
  return { installation, filename: asset.filename,
    current: Effect.gen(function* () {
      yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => failure()))
      const actual = yield* Effect.tryPromise({ try: () => verifiedAsset(installation), catch: () => failure() })
      if (actual.hash !== asset.hash || actual.identity !== asset.identity) return yield* failure("WORK_FILE_CHANGED")
    }) }
})

/** Construction provenance for the independent browser file purpose. This only observes
 * the existing installed asset and instance; browser scope and human consent own access. */
export const browserAsset = Effect.fn("WorkFileHelper.browserAsset")(function* () {
  const unavailable = () => new BrowserFileSchema.Error({ code: "BROWSER_FILE_UNAVAILABLE",
    message: "The current installed browser file helper is unavailable" })
  const changed = () => new BrowserFileSchema.Error({ code: "BROWSER_FILE_CHANGED",
    message: "The installed browser file helper or instance identity changed" })
  if (process.platform === "win32") return yield* unavailable()
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(unavailable))
  const asset = yield* Effect.tryPromise({ try: () => verifiedAsset(installation), catch: unavailable })
  const instance = yield* LocalTaskAuthority.readInstallation.pipe(Effect.mapError(unavailable))
  return { instanceID: instance.instanceID, filename: asset.filename, helperHash: asset.hash,
    current: Effect.gen(function* () {
      yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(changed))
      const actual = yield* Effect.tryPromise({ try: () => verifiedAsset(installation), catch: changed })
      const currentInstance = yield* LocalTaskAuthority.readInstallation.pipe(Effect.mapError(changed))
      if (actual.hash !== asset.hash || actual.identity !== asset.identity ||
        currentInstance.instanceID !== instance.instanceID || currentInstance.secret !== instance.secret)
        return yield* changed()
    }) }
})

function fromWireIdentity(value: typeof WireIdentity.Type): WorkFileCapability.Identity {
  return value.kind === "posix" ? value : { kind: "windows", volumeSerial: value.volume_serial, fileID: value.file_id }
}

async function createStage(data: string, basename: string, root: WorkFileCapability.Identity) {
  if ((process.platform !== "darwin" && process.platform !== "linux") || root.kind !== "posix" || !/^[a-f0-9]{32}$/.test(basename) ||
    await fs.realpath(data) !== data) throw failure()
  const owner = process.getuid?.()
  const parent = await fs.lstat(data, { bigint: true })
  if (owner === undefined || !parent.isDirectory() || parent.uid !== BigInt(owner) || (parent.mode & 0o022n) !== 0n)
    throw failure()
  const base = path.join(data, "work-write-stage")
  await fs.mkdir(base, { mode: 0o700 }).catch((error: unknown) => {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
  })
  const before = await fs.lstat(base, { bigint: true })
  if (!before.isDirectory() || before.uid !== BigInt(owner) || (before.mode & 0o077n) !== 0n ||
    before.dev.toString() !== root.device || await fs.realpath(base) !== base) throw failure()
  const directory = path.join(base, basename)
  await fs.mkdir(directory, { mode: 0o700 })
  const file = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const actual = await file.stat({ bigint: true })
    const named = await fs.lstat(directory, { bigint: true })
    const after = await fs.lstat(base, { bigint: true })
    if (!actual.isDirectory() || actual.uid !== BigInt(owner) || (actual.mode & 0o077n) !== 0n ||
      actual.dev !== before.dev || actual.dev !== named.dev || actual.ino !== named.ino ||
      before.dev !== after.dev || before.ino !== after.ino || await fs.realpath(directory) !== directory) throw failure()
    return { file, identity: { kind: "posix" as const, device: actual.dev.toString(), inode: actual.ino.toString() } }
  } catch (error) {
    await file.close()
    throw error
  }
}

async function retainedStage(stage: { file: FileHandle; identity: WorkFileCapability.Identity }, directory: string) {
  if (stage.identity.kind !== "posix") throw failure()
  const before = await stage.file.stat({ bigint: true })
  const named = await fs.lstat(directory, { bigint: true })
  if (!before.isDirectory() || before.dev.toString() !== stage.identity.device || before.ino.toString() !== stage.identity.inode ||
    before.dev !== named.dev || before.ino !== named.ino || before.uid !== BigInt(process.getuid!()) ||
    (before.mode & 0o077n) !== 0n || await fs.realpath(directory) !== directory) throw failure()
  const files = await fs.opendir(directory)
  const total = { bytes: 0, objects: 0 }
  for await (const entry of files) {
    if (++total.objects > 2 || !["payload", "previous"].includes(entry.name)) throw failure()
    const actual = await fs.lstat(path.join(directory, entry.name), { bigint: true })
    if (!actual.isFile() || actual.nlink !== 1n || actual.dev !== before.dev || actual.uid !== before.uid ||
      actual.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure()
    total.bytes += Number(actual.size)
    if (!Number.isSafeInteger(total.bytes)) throw failure()
  }
  const after = await fs.lstat(directory, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino) throw failure()
  return total.bytes
}

const inspections = { active: 0 }
/** Offline metadata only: the installed helper opens one root without following components,
 * returns its real descriptor identity, then exits. This creates no Work/read capability. */
export const inspectRoot = Effect.fn("WorkFileHelper.inspectRoot")(function* (directory: string, options?: { linuxWriteData: string }) {
  if (options && process.platform !== "linux") return yield* failure()
  if (!path.isAbsolute(directory) || Buffer.byteLength(directory) > 2048 || /[\u0000-\u001f\u007f]/.test(directory) || inspections.active >= 8)
    return yield* failure()
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(() => failure()))
  const asset = yield* currentAsset(installation).pipe(Effect.mapError(() => failure()))
  return yield* Effect.scoped(Effect.acquireUseRelease(
    Effect.gen(function* () {
      const originalWindowsChild = process.platform === "win32" ? yield* launchWindows(asset) : undefined
      return yield* Effect.try({ try: () => {
      if (process.platform === "win32" && !originalWindowsChild) throw failure()
      if (inspections.active >= 8) throw failure("WORK_FILE_CAPACITY")
      const child: HelperProcess = originalWindowsChild ?? spawn(asset.filename, [], { cwd: path.dirname(asset.filename), env: {}, stdio: ["pipe", "pipe", "pipe"] })
      inspections.active++
      const exited = new Promise<void>((resolve) => { child.once("close", () => { inspections.active--; resolve() }) })
      child.stderr.resume()
      return { child, exited }
      }, catch: () => failure() })
    }),
    (owned) => Effect.gen(function* () {
      const reply = yield* Effect.tryPromise({ try: (signal) => new Promise<Reply>((resolve, reject) => {
        const id = randomUUID()
        const state = { bytes: Buffer.alloc(0), done: false }
        const fail = () => { if (state.done) return; state.done = true; clearTimeout(timer); reject(failure()) }
        const timer = setTimeout(fail, 10_000)
        signal.addEventListener("abort", fail, { once: true })
        owned.child.once("error", fail)
        owned.child.once("close", () => {
          if (state.done) return
          state.done = true; clearTimeout(timer); signal.removeEventListener("abort", fail)
          if (state.bytes.length < 4 || state.bytes.readUInt32BE(0) !== state.bytes.length - 4) { reject(failure()); return }
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Response), { onExcessProperty: "error" })(state.bytes.subarray(4).toString("utf8"))
          if (Option.isNone(decoded) || decoded.value.id !== id || decoded.value.status !== (options ? "linux_write_profile_v1" : "ready") ||
            !decoded.value.root || decoded.value.payload_bytes !== 0 || owned.child.exitCode !== 0) { reject(failure()); return }
          resolve({ value: decoded.value, bytes: Buffer.alloc(0) })
        })
        owned.child.stdout.on("data", (data: Buffer) => {
          if (state.done) return
          if (state.bytes.length + data.length > 4096) { fail(); return }
          state.bytes = Buffer.concat([state.bytes, data])
        })
        const body = Buffer.from(JSON.stringify(options ? { version: 1, op: "inspect_linux_write_policy", id, path: directory, data: options.linuxWriteData }
          : { version: 1, op: "inspect_root", id, path: directory }))
        const length = Buffer.alloc(4); length.writeUInt32BE(body.length)
        owned.child.stdin.end(Buffer.concat([length, body]))
      }), catch: () => failure() })
      const current = yield* currentAsset(installation).pipe(Effect.mapError(() => failure()))
      if (current.hash !== asset.hash || current.identity !== asset.identity || !reply.value.root) return yield* failure()
      const identity = reply.value.root.kind === "posix" ? reply.value.root : {
        kind: "windows" as const, volumeSerial: reply.value.root.volume_serial, fileID: reply.value.root.file_id,
      }
      if (options) {
        if (identity.kind !== "posix" || !reply.value.linux_write_profile) return yield* failure()
        yield* LinuxWorkWritePolicy.check({ helper: asset.filename, helperSHA256: asset.hash,
          project: directory, projectIdentity: identity, data: options.linuxWriteData }, reply.value.linux_write_profile)
          .pipe(Effect.mapError(() => failure()))
      }
      return { helperHash: asset.hash, rootIdentity: yield* Schema.decodeUnknownEffect(
        WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity)(identity).pipe(Effect.mapError(() => failure())) }
    }),
    (owned) => Effect.promise(async () => {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL")
      await Promise.race([owned.exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))])
      // Capacity is released only by the actual close event, including a delayed exit.
    }),
  ))
})

function wireIdentity(identity: WorkFileCapability.Identity) {
  return identity.kind === "posix" ? identity : { kind: "windows" as const, volume_serial: identity.volumeSerial, file_id: identity.fileID }
}
function relative(value: string) {
  const parts = value.split("/")
  return Buffer.byteLength(value) <= 2048 && !/[\\:\u0000-\u001f\u007f]/.test(value) && parts.length <= 32 &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
}

/** Pure policy text, not an installation/Work capability or process launcher. Actual callers
 * use only the verified asset and captured Work paths; write activation additionally needs
 * the durable stage owner. No project file is ever opened writable by that publication path. */
export function sandboxProfile(input: {
  filename: string
  root: string
  read: readonly { kind: "file" | "tree"; path: string }[]
  write: readonly { kind: "file" | "tree"; path: string }[]
  deny: readonly { kind: "file" | "tree"; path: string }[]
  stage?: string
}) {
  const valid = (value: string) => path.isAbsolute(value) && Buffer.byteLength(value) <= 2048 &&
    !/[\u0000-\u001f\u007f]/.test(value) && path.normalize(value) === value
  if (!valid(input.filename) || !valid(input.root) ||
    [...input.read, ...input.write, ...input.deny].some((rule) => !relative(rule.path)) ||
    input.read.length + input.write.length + input.deny.length > 384 ||
    (input.write.length > 0 && !input.stage) ||
    (input.stage !== undefined && (!valid(input.stage) || input.stage === input.root ||
      input.stage.startsWith(`${input.root}/`) || input.root.startsWith(`${input.stage}/`)))) throw failure()
  const quote = (value: string) => JSON.stringify(value)
  const filters = (rules: typeof input.read) => rules.map((rule) =>
    `(${rule.kind === "file" ? "literal" : "subpath"} ${quote(path.join(input.root, rule.path))})`).join(" ")
  const reads = filters([...input.read, ...input.write])
  // Directory fsync needs a readable directory FD. These literal ancestors allow no
  // file contents or namespace writes beyond the explicitly approved leaves/trees.
  const directories = [...new Set(input.write.flatMap((rule) => {
    const parts = rule.path.split("/")
    return parts.map((_, index) => path.join(input.root, ...parts.slice(0, index)))
  }))].map((directory) => `(literal ${quote(directory)})`).join(" ")
  const writes = filters(input.write)
  const denies = filters(input.deny)
  const stage = input.stage === undefined ? "" : `(subpath ${quote(input.stage)})`
  return `(version 1)(deny default)
(allow process-exec (literal ${quote(input.filename)}))
(allow file-read-metadata)
(allow file-read* (literal "/") (literal ${quote(input.filename)}) (subpath "/System/Library") (subpath "/usr/lib") ${reads} ${stage})
${directories ? `(allow file-read-data ${directories})` : ""}
(allow file-map-executable (literal ${quote(input.filename)}) (subpath "/System/Library") (subpath "/usr/lib"))
(allow sysctl-read)(allow signal (target self))
${writes || stage ? `(allow file-write* ${writes} ${stage})` : ""}
(deny file-write* (subpath ${quote(path.dirname(input.filename))}))
${denies ? `(deny file-read* file-write* ${denies})` : ""}
; Codex's actual Darwin probes show these can mutate through a read-only FD.
(deny system-fcntl (fcntl-command 80 110))`
}
function currentAsset(installation: NativeInstallation.VerifiedInstalledComponents) {
  if (process.platform !== "win32") return Effect.tryPromise({ try: () => verifiedAsset(installation), catch: () => failure() })
  return Effect.gen(function* () {
    const { WindowsWorkFileHelper } = yield* Effect.promise(() => import("./windows-work-file-helper"))
    return yield* WindowsWorkFileHelper.asset(installation).pipe(Effect.mapError(() => failure()))
  })
}

function launchWindows(asset: { filename: string; hash: string; identity: string }) {
  return Effect.gen(function* () {
    const { WindowsWorkFileHelper } = yield* Effect.promise(() => import("./windows-work-file-helper"))
    return yield* WindowsWorkFileHelper.launch(asset).pipe(Effect.mapError(() => failure()))
  })
}

async function verifiedAsset(installation: NativeInstallation.VerifiedInstalledComponents) {
  const inventory = await Effect.runPromise(NativeInstallation.inventory(installation))
  const filename = path.join(await Effect.runPromise(NativeInstallation.assetDirectory(installation)),
    `deepagent-work-file-helper${process.platform === "win32" ? ".exe" : ""}`)
  const component = inventory.find((entry) => entry.path === `packages/work-file-helper/bin/${process.platform}-${process.arch}/${path.basename(filename)}`)
  if (!component || component.bytes < 1 || component.bytes > 16_777_216 || process.platform === "win32") throw failure()
  // Windows runtime asset activation additionally needs the native installation DACL contract.
  // Keeping it unavailable is explicit; the Rust Windows no-reparse implementation is not release proof.
  if (await fs.realpath(filename) !== filename) throw failure("WORK_FILE_CHANGED")
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(component.bytes) || (before.mode & 0o022n) !== 0n) throw failure()
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(65_536)
    const count = { bytes: 0 }
    while (true) {
      const read = await file.read(buffer, 0, buffer.byteLength, null)
      if (read.bytesRead === 0) break
      count.bytes += read.bytesRead
      if (count.bytes > component.bytes) throw failure()
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    const after = await file.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    const identity = (value: typeof before) => [value.dev, value.ino, value.size, value.mode, value.nlink, value.mtimeNs, value.ctimeNs].join(":")
    if (count.bytes !== component.bytes || hash.digest("hex") !== component.sha256 || identity(before) !== identity(after) ||
      identity(after) !== identity(named) || await fs.realpath(filename) !== filename) throw failure("WORK_FILE_CHANGED")
    return { filename, hash: component.sha256, identity: identity(before) }
  } finally { await file.close() }
}

function macRecipe(recipe: WorkCommandV2Schema.ApprovedRecipe): recipe is WorkCommandSchema.Recipe | WorkCommandMacX64Schema.Recipe {
  return recipe.schemaVersion === "work-command-recipe.v1" || recipe.schemaVersion === "work-command-recipe.mac-x64.v1"
}

export * as WorkFileHelper from "./work-file-helper"
