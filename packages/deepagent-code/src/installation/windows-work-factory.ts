export * as NativeWindowsWorkFactory from "./windows-work-factory"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallation } from "./native-installation"
import { NativeWindowsBootstrap } from "./windows-native-bootstrap"
import { NativeWindowsImageFactory } from "./windows-image-factory"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identity = Schema.Struct({ kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const Image = Schema.Struct({ asset_path: Schema.NullOr(Schema.String), path: WorkWindowsPathSchema.Absolute,
  identity: Identity, bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)),
  sha256: Digest, system: Schema.Boolean })
const Observation = Schema.Struct({ library_evidence: Schema.Literal("original-system32-import-leases.v1"), target: Schema.Literals(["win32-x64", "win32-arm64"]), bootstrap_hash: Digest,
  closure_hash: Digest, helper: Image, supervisor: Image, payload: Image,
  libraries: Schema.Array(Image).check(Schema.isMaxLength(128)) })
const ChildEvent = Schema.Struct({ version: Schema.Literal(1),
  kind: Schema.Literals(["idle", "stdout", "stderr", "exit"]), exit_code: Schema.NullOr(Schema.Int),
  payload_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_540)) })
export class Error extends Schema.TaggedErrorClass<Error>()("WindowsWorkFactoryError", {
  code: Schema.Literals(["WINDOWS_WORK_FACTORY_UNAVAILABLE", "WINDOWS_WORK_FACTORY_CHANGED", "WINDOWS_WORK_FACTORY_UNKNOWN"]),
}) {}
const unavailable = () => new Error({ code: "WINDOWS_WORK_FACTORY_UNAVAILABLE" })
const retained = new Set<() => void>()
export type CommandRequest = {
  version: 2; nonce: string; work_id: string; command_id: string; recipe_hash: string; control_revision: number
  argv: string[]; cwd: string | null; env: Record<string, string>; inputs: string[]; outputs: string[]
  cpu: { hard_cap_percent: number; job_user_time_limit_100ns: number; total_watchdog_micros: number; poll_ms: number }
  job_commit_max_bytes: number; timeout_ms: number; stdout_bytes: number; stderr_bytes: number
}
export type WorkspaceOpen = { root: string; basename: string; project: string }
export type WorkspaceCleanup = { expected: readonly { relative: string; bytes: number; sha256: string }[]; directories: readonly string[] }

/** Every closure holds the same original preloaded capture and native External.
 * Neither a path/hash record nor a copied JavaScript object can create a lease. */
export const make = Effect.fn("NativeWindowsWorkFactory.make")(function* () {
  const bootstrap = yield* NativeWindowsBootstrap.Service
  // Global prepares the fixed machine-local home before Native captures its
  // original directory. No JavaScript path argument is sent to the factory.
  yield* Effect.promise(() => import("@deepagent-code/core/global"))
  const native = bootstrap.workFactory
  if (process.platform !== "win32" || !native || !NativeWindowsBootstrap.describe(bootstrap.capture)) return yield* unavailable()
  const installation = yield* NativeInstallation.current().pipe(Effect.mapError(unavailable))
  const inventory = yield* NativeInstallation.inventory(installation).pipe(Effect.mapError(unavailable))
  const lifetime = { active: true, scoped: true }
  const original = yield* Effect.try({ try: () => native.open(), catch: unavailable })
  const close = () => {
    if (!lifetime.active) return
    native.close(original)
    lifetime.active = false
    retained.delete(close)
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.scoped = false
    try { close() } catch { retained.add(close) }
  }))
  const text = yield* Effect.try({ try: () => native.describe(original), catch: unavailable })
  if (typeof text !== "string" || Buffer.byteLength(text) > 131_072) return yield* unavailable()
  const decoded = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
    Schema.decodeUnknownOption(Observation, { onExcessProperty: "error" }))
  if (Option.isNone(decoded) || decoded.value.target !== `${process.platform}-${process.arch}` ||
    decoded.value.bootstrap_hash !== bootstrap.description.bootstrap.sha256) return yield* unavailable()
  const source = decoded.value
  const prefix = `packages/work-file-helper/bin/${source.target}/`
  const fixed = [source.helper, source.supervisor, source.payload]
  const names = ["deepagent-work-file-helper.exe", "deepagent-work-process-supervisor.exe", "bun-command-runtime.exe"]
  if (fixed.some((image, index) => image.system || image.asset_path !== `${prefix}${names[index]}` ||
    !inventory.some((entry) => entry.path === image.asset_path && entry.bytes === image.bytes && entry.sha256 === image.sha256)) ||
    // These are the original Native factory's held machine System32 imports,
    // including publisher-attested PE delay imports resolved in that same lease.
    // Their native External cannot be reconstructed from this JSON description.
    source.libraries.some((image) => !image.system || image.asset_path !== null) ||
    fixed.concat(source.libraries).reduce((bytes, image) => bytes + image.bytes, 0) > 536_870_912 ||
    new Set(fixed.concat(source.libraries).map((image) => `${image.identity.volume_serial}:${image.identity.file_id}`)).size !== fixed.length + source.libraries.length)
    return yield* unavailable()
  const description = Object.freeze({ target: source.target, bootstrapHash: source.bootstrap_hash, closureHash: source.closure_hash,
    libraryEvidence: source.library_evidence, helper: image(source.helper), supervisor: image(source.supervisor), payload: image(source.payload),
    libraries: Object.freeze(source.libraries.map(image)) })
  const current = bootstrap.requireCurrent.pipe(Effect.mapError(() => new Error({ code: "WINDOWS_WORK_FACTORY_CHANGED" })),
    Effect.flatMap(() => Effect.try({ try: () => {
      if (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture) || native.describe(original) !== text)
        throw new Error({ code: "WINDOWS_WORK_FACTORY_CHANGED" })
    }, catch: () => new Error({ code: "WINDOWS_WORK_FACTORY_CHANGED" }) })))
  yield* current
  const launchHelper = Effect.gen(function* () {
    yield* current
    const port = native.launchHelper
    if (!port) return yield* unavailable()
    const child = yield* Effect.try({ try: () => port.launch(original), catch: unavailable })
    if (!child || typeof child !== "object" || typeof child.lease !== "object" || !Number.isSafeInteger(child.pid) || child.pid <= 0)
      return yield* unavailable()
    const state = { active: true, ended: false }
    const requireLive = () => {
      if (!lifetime.scoped || !lifetime.active || !state.active || !NativeWindowsBootstrap.describe(bootstrap.capture))
        throw new Error({ code: "WINDOWS_WORK_FACTORY_CHANGED" })
    }
    return Object.freeze({ pid: child.pid,
      write(bytes: Buffer) { requireLive(); if (state.ended || !Buffer.isBuffer(bytes) || bytes.length > 1_048_580) throw unavailable(); port.write(original,child.lease,bytes) },
      end() { requireLive(); if (state.ended) return; port.end(original,child.lease); state.ended = true },
      read() {
        // Retirement may observe/drain the exact original child; it cannot
        // launch, renew a factory, or send another input after Scope closes.
        if (!state.active) throw new Error({ code: "WINDOWS_WORK_FACTORY_CHANGED" })
        const value = port.read(original,child.lease)
        const event = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value.metadata),
          Schema.decodeUnknownOption(ChildEvent, { onExcessProperty: "error" }))
        if (Option.isNone(event) || !Buffer.isBuffer(value.bytes) || value.bytes.length !== event.value.payload_bytes ||
          ((event.value.kind === "idle" || event.value.kind === "exit") && value.bytes.length !== 0) ||
          (event.value.kind !== "exit" && event.value.exit_code !== null)) throw unavailable()
        return { kind: event.value.kind, bytes: value.bytes, exitCode: event.value.exit_code }
      },
      stop() { if (state.active) port.stop(original,child.lease) },
      close() {
        if (!state.active) return true
        if (!port.close(original,child.lease)) return false
        state.active = false
        return true
      },
    })
  })
  const eventRuntimes = new WeakSet<object>()
  const eventRepositories = new WeakSet<object>()
  const eventDirectories = new WeakSet<object>()
  const requireEvent = (set: WeakSet<object>, lease: object, live = true) => {
    if (!set.has(lease) || !lifetime.active || live && (!lifetime.scoped || !NativeWindowsBootstrap.describe(bootstrap.capture))) throw unavailable()
  }
  const eventGit = native.eventGit ? Object.freeze({
    open() { if (!lifetime.scoped || !lifetime.active) throw unavailable(); const value = native.eventGit!.open(original); eventRuntimes.add(value.lease); return value },
    current(lease: object) { requireEvent(eventRuntimes, lease); return native.eventGit!.current(original, lease) },
    close(lease: object) { requireEvent(eventRuntimes, lease, false); native.eventGit!.close(original, lease); eventRuntimes.delete(lease) },
    openRepository(runtime: object, text: string) { requireEvent(eventRuntimes, runtime); const value = native.eventGit!.openRepository(original, runtime, text); eventRepositories.add(value.lease); return value },
    currentRepository(lease: object) { requireEvent(eventRepositories, lease); return native.eventGit!.currentRepository(original, lease) },
    closeRepository(lease: object) { requireEvent(eventRepositories, lease, false); native.eventGit!.closeRepository(original, lease); eventRepositories.delete(lease) },
    run(lease: object, text: string, bytes: Buffer) { requireEvent(eventRepositories, lease); if (!Buffer.isBuffer(bytes) || bytes.byteLength > 16_777_216) throw unavailable(); return native.eventGit!.run(original, lease, text, bytes) },
    openIndex(lease: object) { requireEvent(eventRepositories, lease); return native.eventGit!.openIndex(original, lease) },
    prepareParent(lease: object) { requireEvent(eventRepositories, lease); return native.eventGit!.prepareParent(original, lease) },
    indexAllocation(lease: object) { requireEvent(eventRepositories, lease); return native.eventGit!.indexAllocation(original, lease) },
    closeIndex(lease: object) { requireEvent(eventRepositories, lease, false); native.eventGit!.closeIndex(original, lease) },
    openDirectory(text: string) { if (!lifetime.scoped || !lifetime.active) throw unavailable(); const value = native.eventGit!.openDirectory(original, text); eventDirectories.add(value.lease); return value },
    currentDirectory(lease: object) { requireEvent(eventDirectories, lease); return native.eventGit!.currentDirectory(original, lease) },
    closeDirectory(lease: object) { requireEvent(eventDirectories, lease, false); native.eventGit!.closeDirectory(original, lease); eventDirectories.delete(lease) },
  }) : undefined
  const collectors = new WeakSet<object>()
  const requireCollector = (lease: object, live = true) => {
    if (!collectors.has(lease) || (live && (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)))) throw unavailable()
  }
  const knownCommandCleanup = native.knownCommandCleanup ? Object.freeze({
    open(value: unknown) {
      if (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)) throw unavailable()
      const text = CanonicalJson.stringify(value)
      if (Buffer.byteLength(text) > 1_048_576) throw unavailable()
      const opened = native.knownCommandCleanup!.open(original, text)
      if (!opened || typeof opened.lease !== "object" || opened.lease === null || typeof opened.metadata !== "string") throw unavailable()
      collectors.add(opened.lease)
      return opened
    },
    current(lease: object) { requireCollector(lease); return native.knownCommandCleanup!.current(original, lease) },
    collect(lease: object) { requireCollector(lease); return native.knownCommandCleanup!.collect(original, lease) },
    close(lease: object) {
      requireCollector(lease, false)
      native.knownCommandCleanup!.close(original, lease)
      collectors.delete(lease)
    },
  }) : undefined
  const workspaces = new WeakSet<object>()
  const requireWorkspace = (lease: object, live = true) => {
    if (!workspaces.has(lease) || (live && (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)))) throw unavailable()
  }
  const request = (value: unknown) => {
    const text = CanonicalJson.stringify(value)
    if (Buffer.byteLength(text) > 1_048_576) throw unavailable()
    return text
  }
  const workspace = native.workspace ? Object.freeze({
    open(value: WorkspaceOpen) {
      if (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)) throw unavailable()
      const opened = native.workspace!.open(original, request(value))
      if (!opened || typeof opened.lease !== "object" || opened.lease === null || typeof opened.metadata !== "string") throw unavailable()
      workspaces.add(opened.lease)
      return opened
    },
    current(lease: object) { requireWorkspace(lease); return native.workspace!.current(original, lease) },
    readOutput(lease: object, value: { relative: string; limit: number }) {
      requireWorkspace(lease)
      return native.workspace!.readOutput(original, lease, request(value))
    },
    cleanup(lease: object, value: WorkspaceCleanup) {
      requireWorkspace(lease)
      return native.workspace!.cleanup(original, lease, request(value))
    },
    close(lease: object) {
      requireWorkspace(lease, false)
      native.workspace!.close(original, lease)
      workspaces.delete(lease)
    },
  }) : undefined
  const launchCommand = Effect.fn("NativeWindowsWorkFactory.launchCommand")(function* (lease: object, value: CommandRequest) {
    yield* current
    requireWorkspace(lease)
    const port = native.command
    if (!port) return yield* unavailable()
    const child = yield* Effect.try({ try: () => port.launch(original, lease, request(value)), catch: unavailable })
    if (!child || typeof child.lease !== "object" || child.lease === null || !Number.isSafeInteger(child.pid) || child.pid <= 0)
      return yield* unavailable()
    const state = { active: true }
    return Object.freeze({ pid: child.pid,
      control(action: "continue" | "cancel") {
        if (!state.active || (action === "continue" && (!lifetime.scoped || !lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)))) throw unavailable()
        port.control(original, child.lease, action)
      },
      read() {
        if (!state.active) throw unavailable()
        const value = port.read(original, child.lease)
        const event = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value.metadata),
          Schema.decodeUnknownOption(ChildEvent, { onExcessProperty: "error" }))
        if (Option.isNone(event) || !Buffer.isBuffer(value.bytes) || value.bytes.length !== event.value.payload_bytes ||
          ((event.value.kind === "idle" || event.value.kind === "exit") && value.bytes.length !== 0) ||
          (event.value.kind !== "exit" && event.value.exit_code !== null)) throw unavailable()
        return { kind: event.value.kind, bytes: value.bytes, exitCode: event.value.exit_code }
      },
      describe() { if (!state.active) throw unavailable(); return port.describe(original, child.lease) },
      cancel() { if (state.active) port.cancel(original, child.lease) },
      close() {
        if (!state.active) return true
        if (!port.close(original, child.lease)) return false
        state.active = false
        return true
      },
    })
  })
  return { current, description, launchHelper, launchCommand, workspace, knownCommandCleanup, eventGit, commandAvailable: Boolean(native.command), isCurrent: () => lifetime.scoped && lifetime.active && Boolean(NativeWindowsBootstrap.describe(bootstrap.capture)) }
})

export type Interface = Effect.Success<ReturnType<typeof make>>
export type Child = Effect.Success<Interface["launchHelper"]>
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/NativeWindowsWorkFactory") {}
export const layer = Layer.effect(Service, make())

/** A Registry target has its own scope. Closing it never renews or prematurely
 * retires the original Root factory shared by its file/command capabilities. */
export const imageRegistry = Layer.effectContext(Effect.gen(function* () {
  const factory = yield* Service
  const active = new WeakSet<object>()
  const description = Object.freeze({ target: factory.description.target, bootstrapHash: factory.description.bootstrapHash,
    closureHash: factory.description.closureHash, libraryEvidence: factory.description.libraryEvidence, supervisor: factory.description.supervisor,
    payload: factory.description.payload, libraries: factory.description.libraries })
  return Context.make(NativeWindowsImageFactory.Registered, {
    open: (installation) => NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() =>
      new NativeWindowsImageFactory.Error({ code: "WINDOWS_IMAGE_FACTORY_UNAVAILABLE", message: "Original Windows Work installation unavailable" })),
      Effect.flatMap(() => factory.current.pipe(Effect.mapError(() =>
        new NativeWindowsImageFactory.Error({ code: "WINDOWS_IMAGE_FACTORY_UNAVAILABLE", message: "Original Windows Work factory unavailable" })))),
      Effect.map(() => { const original = Object.freeze(Object.create(null)) as NativeWindowsImageFactory.NativeFactory; active.add(original); return original })),
    describe: (original) => active.has(original) && factory.isCurrent() ? description : undefined,
    revalidate: (original) => active.has(original) ? factory.current.pipe(Effect.mapError(() =>
      new NativeWindowsImageFactory.Error({ code: "WINDOWS_IMAGE_FACTORY_CHANGED", message: "Original Windows Work factory changed" }))) :
      Effect.fail(new NativeWindowsImageFactory.Error({ code: "WINDOWS_IMAGE_FACTORY_UNAVAILABLE", message: "Original Windows Work factory unavailable" })),
    close: (original) => Effect.sync(() => { active.delete(original) }),
  })
}))

function image(value: typeof Image.Type) {
  return Object.freeze({ assetPath: value.asset_path, path: value.path, bytes: value.bytes, sha256: value.sha256, system: value.system,
    identity: Object.freeze({ kind: "windows" as const, volumeSerial: value.identity.volume_serial, fileID: value.identity.file_id }) })
}
