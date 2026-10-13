export * as NativeWindowsBootstrap from "./windows-native-bootstrap"

import { Context, Effect, Option, Schema } from "effect"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { NativeInstallation } from "./native-installation"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Image = Schema.Struct({
  path: WorkWindowsPathSchema.Absolute,
  identity: Schema.Struct({ kind: Schema.Literal("windows"),
    volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
    file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)),
  sha256: Digest,
  system: Schema.Boolean,
})
export const Description = Schema.Struct({
  version: Schema.Literal(1), target: Schema.Literals(["win32-x64", "win32-arm64"]),
  bootstrap: Image, host: Image, libraries: Schema.Array(Image).check(Schema.isMaxLength(126)),
  closure_hash: Digest, preloaded: Schema.Boolean, preload_hash: Schema.NullOr(Digest), mapping_exclusion: Schema.Literal("original-read-share-only"), work_authority: Schema.Literal(false),
}).check(Schema.makeFilter((value) =>
  value.bootstrap.bytes + value.host.bytes + value.libraries.reduce((bytes, image) => bytes + image.bytes, 0) <= 536_870_912 &&
  new Set([value.bootstrap, value.host, ...value.libraries].map((image) => `${image.identity.volume_serial}:${image.identity.file_id}`)).size === value.libraries.length + 2))
export type Description = typeof Description.Type
export class Error extends Schema.TaggedErrorClass<Error>()("WindowsNativeBootstrapError", {
  code: Schema.Literals(["WINDOWS_FIRST_LOADER_UNAVAILABLE", "WINDOWS_FIRST_LOADER_CHANGED"]), message: Schema.String,
}) {}
const unavailable = () => new Error({ code: "WINDOWS_FIRST_LOADER_UNAVAILABLE", message: "Original Windows native bootstrap is unavailable" })

/** Original in-process registration only. This port does not load an addon by
 * filename, renew its original external, or grant managed Work authority. The
 * production preloader still has to hold the image before OS LoadLibrary. */
export type Port = Readonly<{
  capture: object
  describe: (capture: object) => string
  current: (capture: object) => boolean
  close: (capture: object) => void
  preloaded: (capture: object) => boolean
  compiledCli?: (capture: object) => boolean
  readInstallation: (capture: object) => string
  openPrivate?: (capture: object, request: string) => object
  currentPrivate?: (capture: object, lease: object) => boolean
  readPrivate?: (capture: object, lease: object, name: string) => { metadata: string; bytes: Buffer }
  pinPrivateInstallation?: (capture: object, lease: object) => { metadata: string; bytes: Buffer }
  currentPrivateInstallation?: (capture: object, lease: object) => boolean
  publishPrivate?: (capture: object, lease: object, request: string, bytes: Buffer) => string
  closePrivate?: (capture: object, lease: object) => void
  openWorkFactory?: (capture: object) => object
  readWorkFactory?: (capture: object, factory: object) => string
  closeWorkFactory?: (capture: object, factory: object) => void
  launchWorkHelper?: (capture: object, factory: object) => { lease: object; pid: number }
  writeWorkChild?: (capture: object, factory: object, child: object, bytes: Buffer) => void
  endWorkChild?: (capture: object, factory: object, child: object) => void
  readWorkChild?: (capture: object, factory: object, child: object) => { metadata: string; bytes: Buffer }
  stopWorkChild?: (capture: object, factory: object, child: object) => void
  closeWorkChild?: (capture: object, factory: object, child: object) => boolean
  launchWorkCommand?: (capture: object, factory: object, workspace: object, request: string) => { lease: object; pid: number }
  controlWorkCommand?: (capture: object, factory: object, command: object, action: string) => void
  readWorkCommand?: (capture: object, factory: object, command: object) => { metadata: string; bytes: Buffer }
  describeWorkCommand?: (capture: object, factory: object, command: object) => string
  cancelWorkCommand?: (capture: object, factory: object, command: object) => void
  closeWorkCommand?: (capture: object, factory: object, command: object) => boolean
  openEventGit?: (capture: object, factory: object) => { lease: object; metadata: string }
  currentEventGit?: (capture: object, factory: object, lease: object) => string
  closeEventGit?: (capture: object, factory: object, lease: object) => void
  openEventGitRepository?: (capture: object, factory: object, runtime: object, request: string) => { lease: object; metadata: string }
  currentEventGitRepository?: (capture: object, factory: object, lease: object) => string
  closeEventGitRepository?: (capture: object, factory: object, lease: object) => void
  runEventGit?: (capture: object, factory: object, lease: object, request: string, bytes: Buffer) => { metadata: string; stdout: Buffer; stderr: Buffer }
  openEventGitIndex?: (capture: object, factory: object, lease: object) => string
  prepareEventGitParent?: (capture: object, factory: object, lease: object) => string
  eventGitIndexAllocation?: (capture: object, factory: object, lease: object) => string
  closeEventGitIndex?: (capture: object, factory: object, lease: object) => void
  openEventDirectory?: (capture: object, factory: object, request: string) => { lease: object; metadata: string }
  currentEventDirectory?: (capture: object, factory: object, lease: object) => string
  closeEventDirectory?: (capture: object, factory: object, lease: object) => void
  openKnownCommandCleanup?: (capture: object, factory: object, request: string) => { lease: object; metadata: string }
  currentKnownCommandCleanup?: (capture: object, factory: object, lease: object) => string
  collectKnownCommandCleanup?: (capture: object, factory: object, lease: object) => string
  closeKnownCommandCleanup?: (capture: object, factory: object, lease: object) => void
  openWorkWorkspace?: (capture: object, factory: object, request: string) => { lease: object; metadata: string }
  currentWorkWorkspace?: (capture: object, factory: object, workspace: object) => string
  readWorkWorkspaceOutput?: (capture: object, factory: object, workspace: object, request: string) => { metadata: string; bytes: Buffer }
  cleanupWorkWorkspace?: (capture: object, factory: object, workspace: object, request: string) => string
  closeWorkWorkspace?: (capture: object, factory: object, workspace: object) => void
}>
export const Registered = Context.Reference<Port | undefined>("NativeWindowsBootstrap.Registered", { defaultValue: () => installed })

let installed: Port | undefined
/** The sealed Node entry observes the same already-loaded native module after
 * the parent-held receipt has been accepted. No port/object/path is supplied. */
export async function installFixedEntry() {
  if (installed) return
  if (process.platform !== "win32" || process.versions.bun || !import.meta.url.startsWith("file:") ||
    !new URL(import.meta.url).pathname.endsWith("/node.js")) throw unavailable()
  const { createRequire } = await import("node:module")
  const { fileURLToPath } = await import("node:url")
  const native = createRequire(import.meta.url)(fileURLToPath(new URL("./native-image-factory.node", import.meta.url))) as Port
  if (!native || !Object.isFrozen(native) || typeof native.preloaded !== "function" ||
    !native.preloaded(native.capture) || !native.current(native.capture)) throw unavailable()
  installed = native
}

/** A compiled CLI registers only its original child receipt and fixed loaded
 * addon. Bun development entrypoints cannot synthesize that Native purpose. */
export async function installCompiledEntry() {
  if (installed) {
    if (!installed.compiledCli?.(installed.capture) || !installed.current(installed.capture)) throw unavailable()
    return
  }
  if (process.platform !== "win32" || !process.versions.bun ||
    !/[/\\]deepagent-code\.exe$/i.test(process.execPath) ||
    !(import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("B:/~BUN/") ||
      import.meta.url.startsWith("file:///B:/~BUN/") ||
      // Bun 1.4 keeps source import URLs inside compiled Windows executables.
      // Only the compiled entry uses this virtual main; Native still verifies
      // the original EXE FileID, compiled purpose and parent-held receipt.
      (typeof Bun !== "undefined" && Bun.main.startsWith("B:/~BUN/")))) throw unavailable()
  const { createRequire } = await import("node:module")
  const { pathToFileURL, fileURLToPath } = await import("node:url")
  const native = createRequire(pathToFileURL(process.execPath))(
    fileURLToPath(new URL("./native-image-factory.node", pathToFileURL(process.execPath)))) as Port
  if (!native || !Object.isFrozen(native) || typeof native.compiledCli !== "function" ||
    !native.compiledCli(native.capture) || !native.preloaded(native.capture) || !native.current(native.capture)) throw unavailable()
  installed = native
}

const InstalledFile = Schema.Struct({ identity: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  hash: Digest, bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)), text: Schema.NullOr(Schema.String) })
const InstalledFiles = Schema.Struct({ version: Schema.Literal(1), artifact: InstalledFile, manifest: InstalledFile, runtime: InstalledFile })
/** Fixed original Native handles only. Caller names/paths cannot select files. */
export function readInstallation() {
  const native = installed
  if (!native || !native.preloaded(native.capture) || !native.current(native.capture) || typeof native.readInstallation !== "function") throw unavailable()
  const text = native.readInstallation(native.capture)
  if (typeof text !== "string" || Buffer.byteLength(text) > 131_072) throw unavailable()
  const decoded = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
    Schema.decodeUnknownOption(InstalledFiles, { onExcessProperty: "error" }))
  if (Option.isNone(decoded) || !native.preloaded(native.capture) || !native.current(native.capture)) throw unavailable()
  return decoded.value
}

declare const originalCapture: unique symbol
export interface Capture { readonly [originalCapture]: true }
const originals = new WeakMap<Capture, { description: Description; current: () => boolean }>()
/** Pure original-object lookup; descriptions never reconstruct native leases. */
export function describe(capture: Capture) {
  const entry = originals.get(capture)
  return entry?.current() ? entry.description : undefined
}

export const make = Effect.fn("NativeWindowsBootstrap.make")(function* (
  installation: NativeInstallation.VerifiedInstalledComponents,
) {
  const native = yield* Registered
  if (process.platform !== "win32" || !native || !Object.isFrozen(native) ||
    typeof native.capture !== "object" || native.capture === null) return yield* unavailable()
  if (typeof native.preloaded !== "function" || !native.preloaded(native.capture)) return yield* unavailable()
  yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => unavailable()))
  const inventory = yield* NativeInstallation.inventory(installation).pipe(Effect.mapError(() => unavailable()))
  const observed = yield* Effect.try({ try: () => native.describe(native.capture), catch: () => unavailable() })
  if (Buffer.byteLength(observed) > 65_536) return yield* unavailable()
  const decoded = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(observed),
    Schema.decodeUnknownOption(Description, { onExcessProperty: "error" }))
  if (Option.isNone(decoded) || !decoded.value.preloaded || !decoded.value.preload_hash || decoded.value.target !== `${process.platform}-${process.arch}` ||
    !inventory.some((entry) => entry.path === `packages/work-file-helper/bin/${decoded.value.target}/native-image-factory.node` &&
      entry.sha256 === decoded.value.bootstrap.sha256 && entry.bytes === decoded.value.bootstrap.bytes)) return yield* unavailable()
  const description = freeze(decoded.value)
  const lifetime = { active: true }
  const current = () => lifetime.active && native.preloaded(native.capture) && native.current(native.capture)
  const capture = Object.freeze(Object.create(null)) as Capture
  originals.set(capture, { description, current: () => lifetime.active })
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.active = false
    originals.delete(capture)
    native.close(native.capture)
  }))
  if (!current()) return yield* unavailable()
  return {
    capture,
    description,
    workFactory: native.openWorkFactory && native.readWorkFactory && native.closeWorkFactory
      ? Object.freeze({
        open: () => native.openWorkFactory!(native.capture),
        describe: (factory: object) => native.readWorkFactory!(native.capture, factory),
        close: (factory: object) => native.closeWorkFactory!(native.capture, factory),
        eventGit: native.openEventGit && native.currentEventGit && native.closeEventGit && native.openEventGitRepository && native.currentEventGitRepository && native.closeEventGitRepository &&
          native.runEventGit && native.prepareEventGitParent && native.openEventGitIndex && native.eventGitIndexAllocation && native.closeEventGitIndex && native.openEventDirectory && native.currentEventDirectory && native.closeEventDirectory
          ? Object.freeze({
            open: (factory: object) => native.openEventGit!(native.capture, factory),
            current: (factory: object, lease: object) => native.currentEventGit!(native.capture, factory, lease),
            close: (factory: object, lease: object) => native.closeEventGit!(native.capture, factory, lease),
            openRepository: (factory: object, runtime: object, request: string) => native.openEventGitRepository!(native.capture, factory, runtime, request),
            currentRepository: (factory: object, lease: object) => native.currentEventGitRepository!(native.capture, factory, lease),
            closeRepository: (factory: object, lease: object) => native.closeEventGitRepository!(native.capture, factory, lease),
            run: (factory: object, lease: object, request: string, bytes: Buffer) => native.runEventGit!(native.capture, factory, lease, request, bytes),
            openIndex: (factory: object, lease: object) => native.openEventGitIndex!(native.capture, factory, lease),
            prepareParent: (factory: object, lease: object) => native.prepareEventGitParent!(native.capture, factory, lease),
            indexAllocation: (factory: object, lease: object) => native.eventGitIndexAllocation!(native.capture, factory, lease),
            closeIndex: (factory: object, lease: object) => native.closeEventGitIndex!(native.capture, factory, lease),
            openDirectory: (factory: object, request: string) => native.openEventDirectory!(native.capture, factory, request),
            currentDirectory: (factory: object, lease: object) => native.currentEventDirectory!(native.capture, factory, lease),
            closeDirectory: (factory: object, lease: object) => native.closeEventDirectory!(native.capture, factory, lease),
          }) : undefined,
        knownCommandCleanup: native.openKnownCommandCleanup && native.currentKnownCommandCleanup && native.collectKnownCommandCleanup && native.closeKnownCommandCleanup
          ? Object.freeze({
            open: (factory: object, request: string) => native.openKnownCommandCleanup!(native.capture, factory, request),
            current: (factory: object, lease: object) => native.currentKnownCommandCleanup!(native.capture, factory, lease),
            collect: (factory: object, lease: object) => native.collectKnownCommandCleanup!(native.capture, factory, lease),
            close: (factory: object, lease: object) => native.closeKnownCommandCleanup!(native.capture, factory, lease),
          }) : undefined,
        workspace: native.openWorkWorkspace && native.currentWorkWorkspace && native.readWorkWorkspaceOutput && native.cleanupWorkWorkspace && native.closeWorkWorkspace
          ? Object.freeze({
            open: (factory: object, request: string) => native.openWorkWorkspace!(native.capture, factory, request),
            current: (factory: object, workspace: object) => native.currentWorkWorkspace!(native.capture, factory, workspace),
            readOutput: (factory: object, workspace: object, request: string) => native.readWorkWorkspaceOutput!(native.capture, factory, workspace, request),
            cleanup: (factory: object, workspace: object, request: string) => native.cleanupWorkWorkspace!(native.capture, factory, workspace, request),
            close: (factory: object, workspace: object) => native.closeWorkWorkspace!(native.capture, factory, workspace),
          }) : undefined,
        command: native.launchWorkCommand && native.controlWorkCommand && native.readWorkCommand && native.describeWorkCommand && native.cancelWorkCommand && native.closeWorkCommand
          ? Object.freeze({
            launch: (factory: object, workspace: object, request: string) => native.launchWorkCommand!(native.capture, factory, workspace, request),
            control: (factory: object, command: object, action: string) => native.controlWorkCommand!(native.capture, factory, command, action),
            read: (factory: object, command: object) => native.readWorkCommand!(native.capture, factory, command),
            describe: (factory: object, command: object) => native.describeWorkCommand!(native.capture, factory, command),
            cancel: (factory: object, command: object) => native.cancelWorkCommand!(native.capture, factory, command),
            close: (factory: object, command: object) => native.closeWorkCommand!(native.capture, factory, command),
          }) : undefined,
        launchHelper: native.launchWorkHelper && native.writeWorkChild && native.endWorkChild && native.readWorkChild && native.stopWorkChild && native.closeWorkChild
          ? Object.freeze({
            launch: (factory: object) => native.launchWorkHelper!(native.capture, factory),
            write: (factory: object, child: object, bytes: Buffer) => native.writeWorkChild!(native.capture, factory, child, bytes),
            end: (factory: object, child: object) => native.endWorkChild!(native.capture, factory, child),
            read: (factory: object, child: object) => native.readWorkChild!(native.capture, factory, child),
            stop: (factory: object, child: object) => native.stopWorkChild!(native.capture, factory, child),
            close: (factory: object, child: object) => native.closeWorkChild!(native.capture, factory, child),
          }) : undefined,
      }) : undefined,
    privateStorage: native.openPrivate && native.currentPrivate && native.readPrivate && native.publishPrivate && native.closePrivate
      ? Object.freeze({
        open: (request: string) => native.openPrivate!(native.capture, request),
        current: (lease: object) => native.currentPrivate!(native.capture, lease),
        read: (lease: object, name: string) => native.readPrivate!(native.capture, lease, name),
        installation: native.pinPrivateInstallation && native.currentPrivateInstallation ? Object.freeze({
          pin: (lease: object) => native.pinPrivateInstallation!(native.capture, lease),
          current: (lease: object) => native.currentPrivateInstallation!(native.capture, lease),
        }) : undefined,
        publish: (lease: object, request: string, bytes: Buffer) => native.publishPrivate!(native.capture, lease, request, bytes),
        close: (lease: object) => native.closePrivate!(native.capture, lease),
      }) : undefined,
    requireCurrent: NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => unavailable()),
      Effect.flatMap(() => Effect.try({ try: () => {
        if (!current() || native.describe(native.capture) !== observed) throw unavailable()
      }, catch: () => new Error({ code: "WINDOWS_FIRST_LOADER_CHANGED", message: "Original Windows native bootstrap changed" }) }))),
  }
})

export type Interface = Effect.Success<ReturnType<typeof make>>
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/NativeWindowsBootstrap") {}

function freeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.values(value).forEach(freeze)
  return Object.freeze(value)
}
