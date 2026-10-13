import path from "node:path"
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { WorkCommandSchema } from "@deepagent-code/core/session/work-command.schema"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { NativeWindowsWorkFactory } from "./windows-work-factory"
import { WindowsWorkCommandDescription } from "./windows-work-command-description"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Identity = Schema.Struct({ kind: Schema.Literal("windows"),
  volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const Description = Schema.Struct({ version: Schema.Literal(1), directory: WorkWindowsPathSchema.Absolute, identity: Identity })
const Output = Schema.Struct({ version: Schema.Literal(1), relative: WorkWindowsPathSchema.MemberRelative,
  identity: Identity, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16_777_216)),
  sha256: Digest, snapshot: Schema.Literal("stream_observation") })
const Cleaned = Schema.Struct({ version: Schema.Literal(1), state: Schema.Literal("cleaned"), identity: Identity })
export class Error extends Schema.TaggedErrorClass<Error>()("WindowsWorkCommandRuntimeError", {
  code: Schema.Literals(["WINDOWS_WORKSPACE_UNAVAILABLE", "WINDOWS_WORKSPACE_CHANGED", "WINDOWS_WORKSPACE_UNKNOWN"]),
}) {}
const unavailable = () => new Error({ code: "WINDOWS_WORKSPACE_UNAVAILABLE" })
const changed = () => new Error({ code: "WINDOWS_WORKSPACE_CHANGED" })
const unknown = () => new Error({ code: "WINDOWS_WORKSPACE_UNKNOWN" })
declare const originalWorkspace: unique symbol
export interface Workspace {
  readonly [originalWorkspace]: true
  readonly kind: "windows"
  readonly directory: string
  readonly identity: { readonly kind: "windows"; readonly volumeSerial: string; readonly fileID: string }
}
const retained = new Set<() => void>()

/** Constructed once in the original Root. Command scopes cannot release the
 * held workspace before later output publication and known cleanup finish. */
export const make = Effect.fn("WindowsWorkCommandRuntime.make")(function* () {
  const global = yield* Global.Service
  const factory = yield* NativeWindowsWorkFactory.Service
  const native = factory.workspace
  if (process.platform !== "win32" || !native || !Schema.is(WorkWindowsPathSchema.Absolute)(global.data))
    return yield* unavailable()
  const lifetime = { active: true }
  const leases = new Set<{ lease: object; active: boolean; cleaned: boolean }>()
  const commands = new WeakMap<Workspace, Effect.Success<ReturnType<NativeWindowsWorkFactory.Interface["launchCommand"]>>>()
  const originals = new WeakMap<Workspace, { lease: object; active: boolean; cleaned: boolean;
    description: typeof Description.Type }>()
  const close = (original: { lease: object; active: boolean; cleaned: boolean }) => {
    if (!original.active) return
    native.close(original.lease)
    original.active = false
    leases.delete(original)
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    lifetime.active = false
    for (const original of leases) {
      const finish = () => { close(original); retained.delete(finish) }
      try { finish() } catch { retained.add(finish) }
    }
  }))
  const lookup = (workspace: Workspace) => {
    const original = originals.get(workspace)
    return lifetime.active && original?.active && !original.cleaned ? original : undefined
  }
  const currentWorkspace = Effect.fn("WindowsWorkCommandRuntime.currentWorkspace")(function* (workspace: Workspace) {
    const original = lookup(workspace)
    if (!original) return yield* changed()
    yield* factory.current.pipe(Effect.mapError(changed))
    const actual = yield* Effect.try({ try: () => native.current(original.lease), catch: changed }).pipe(
      Effect.flatMap((text) => decode(Description, text, changed)))
    if (actual.directory !== original.description.directory || !sameIdentity(actual.identity, original.description.identity))
      return yield* changed()
  })
  return {
    data: global.data,
    createWorkspace: Effect.fn("WindowsWorkCommandRuntime.createWorkspace")(function* (basename: string, project: string) {
      if (!lifetime.active || !/^cmd_[a-f0-9]{32}$/.test(basename) ||
        !Schema.is(WorkWindowsPathSchema.Absolute)(project) || [...leases].filter((entry) => entry.active).length >= WorkCommandSchema.MAX_CUSTODY)
        return yield* unavailable()
      const directory = path.win32.join(global.data, "work-command-stage", basename)
      const projectKey = project.toUpperCase()
      const directoryKey = directory.toUpperCase()
      if (projectKey === directoryKey || projectKey.startsWith(`${directoryKey}\\`) || directoryKey.startsWith(`${projectKey}\\`))
        return yield* unavailable()
      yield* factory.current.pipe(Effect.mapError(unavailable))
      const opened = yield* Effect.try({ try: () => native.open({ root: global.data, basename, project }), catch: unavailable })
      if (!opened || typeof opened.lease !== "object" || opened.lease === null) return yield* unknown()
      const original = { lease: opened.lease, active: true, cleaned: false }
      leases.add(original)
      const description = yield* decode(Description, opened.metadata, unknown)
      if (description.directory !== directory) return yield* unknown()
      const workspace = Object.freeze({ kind: "windows", directory, identity: Object.freeze({ kind: "windows",
        volumeSerial: description.identity.volume_serial, fileID: description.identity.file_id }) }) as Workspace
      // The registry and Root finalizer share the same mutable lifetime; a
      // copied state would leave a closed lease counted and close it twice.
      originals.set(workspace, Object.assign(original, { description }))
      yield* currentWorkspace(workspace)
      return workspace
    }),
    currentWorkspace,
    launchCommand: Effect.fn("WindowsWorkCommandRuntime.launchCommand")(function* (workspace: Workspace, request: NativeWindowsWorkFactory.CommandRequest) {
      yield* currentWorkspace(workspace)
      const original = lookup(workspace)
      if (!original) return yield* changed()
      if (commands.has(workspace)) return yield* changed()
      const command = yield* factory.launchCommand(original.lease, request).pipe(Effect.mapError(unavailable))
      commands.set(workspace, command)
      return command
    }),
    commandDescription: Effect.fn("WindowsWorkCommandRuntime.commandDescription")(function* (workspace: Workspace) {
      if (!lookup(workspace)) return yield* changed()
      yield* factory.current.pipe(Effect.mapError(changed))
      const command = commands.get(workspace)
      if (!command) return yield* changed()
      const text = yield* Effect.try({ try: () => command.describe(), catch: changed })
      const description = WindowsWorkCommandDescription.decode(text)
      if (Option.isNone(description) || !sameIdentity(description.value.inventory.root_identity,
        { kind: "windows", volume_serial: workspace.identity.volumeSerial, file_id: workspace.identity.fileID })) return yield* changed()
      return description.value
    }),
    readOutput: Effect.fn("WindowsWorkCommandRuntime.readOutput")(function* (workspace: Workspace, relative: string, limit = 1_048_576) {
      if (!Schema.is(WorkWindowsPathSchema.MemberRelative)(relative) || !Number.isSafeInteger(limit) || limit < 0 || limit > 16_777_216)
        return yield* unavailable()
      yield* currentWorkspace(workspace)
      const original = lookup(workspace)
      if (!original) return yield* changed()
      const observed = yield* Effect.try({ try: () => native.readOutput(original.lease, { relative, limit }), catch: changed })
      const output = yield* decode(Output, observed.metadata, changed)
      if (!Buffer.isBuffer(observed.bytes) || output.relative !== relative || output.bytes !== observed.bytes.length || output.bytes > limit ||
        output.sha256 !== createHash("sha256").update(observed.bytes).digest("hex")) return yield* changed()
      yield* currentWorkspace(workspace)
      return { description: { relative, identity: { kind: "windows" as const, volumeSerial: output.identity.volume_serial,
        fileID: output.identity.file_id }, bytes: output.bytes, sha256: output.sha256 }, bytes: observed.bytes }
    }),
    cleanupWorkspace: Effect.fn("WindowsWorkCommandRuntime.cleanupWorkspace")(function* (workspace: Workspace,
      expected: readonly { relative: string; sha256: string; bytes: number }[], preparedDirectories: readonly string[] = [".dac-home", ".dac-tmp"]) {
      if (expected.length > 288 || !WorkWindowsPathSchema.nonOverlapping(expected.map((entry) => entry.relative)) ||
        expected.some((entry) => !Schema.is(WorkWindowsPathSchema.MemberRelative)(entry.relative) || !Schema.is(Digest)(entry.sha256) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 16_777_216) ||
        expected.reduce((bytes, entry) => bytes + entry.bytes, 0) > 100_663_296 || preparedDirectories.length > 4610 ||
        !WorkWindowsPathSchema.unique(preparedDirectories) || preparedDirectories.some((entry) =>
          !Schema.is(WorkWindowsPathSchema.DirectoryRelative)(entry))) return yield* unavailable()
      yield* currentWorkspace(workspace)
      const original = lookup(workspace)
      if (!original) return yield* changed()
      const result = yield* Effect.try({ try: () => native.cleanup(original.lease,
        { expected: expected.map((entry) => ({ relative: entry.relative, bytes: entry.bytes, sha256: entry.sha256 })),
          directories: [...preparedDirectories] }), catch: unknown }).pipe(
        Effect.flatMap((text) => decode(Cleaned, text, unknown)))
      if (!sameIdentity(result.identity, original.description.identity)) return yield* unknown()
      original.cleaned = true
    }),
    closeWorkspace: (workspace: Workspace) => Effect.try({ try: () => {
      const original = originals.get(workspace)
      if (!original) throw unavailable()
      close(original)
    }, catch: unknown }),
  }
})
export type Interface = Effect.Success<ReturnType<typeof make>>
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/WindowsWorkCommandRuntime") {}
export const layer = Layer.effect(Service, make())

function sameIdentity(first: typeof Identity.Type, second: typeof Identity.Type) {
  return first.volume_serial === second.volume_serial && first.file_id === second.file_id
}
function decode<A>(schema: Schema.Codec<A>, text: unknown, failure: () => Error) {
  const decoded = typeof text === "string" && Buffer.byteLength(text) <= 65_536
    ? Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
      Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })) : Option.none<A>()
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure())
}

export * as WindowsWorkCommandRuntime from "./windows-work-command-runtime"
