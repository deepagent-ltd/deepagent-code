export * as WindowsEventGit from "./windows-event-git"

import path from "node:path"
import { Effect, Context, Option, Schema } from "effect"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import type { EventWorkPlacement } from "@deepagent-code/core/deepagent/event-work-placement"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeWindowsWorkFactory } from "../installation/windows-work-factory"
import { WorkFileHelper } from "../installation/work-file-helper"

const Identity = Schema.Struct({ kind: Schema.Literal("windows"), volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
  file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) })
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Image = Schema.Struct({ basename: Schema.String.check(Schema.isMaxLength(255)), identity: Identity,
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(134_217_728)), sha256: Digest })
const RuntimeSchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("fixed-event-git-plumbing"), filename: Schema.String,
  sha256: Digest, closure_hash: Digest, images: Schema.Array(Image).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  isolation: Schema.Literal("trusted-internal-producer-original-user"), work_authority: Schema.Literal(false) })
const RepositorySchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("fixed-event-git-repository"), directory: Schema.String,
  git_directory: Schema.String, root: Identity, git_root: Identity, runtime: RuntimeSchema, work_authority: Schema.Literal(false) })
const DirectorySchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("event-namespace-observation"), directory: Schema.String,
  identity: Identity, work_authority: Schema.Literal(false) })
const IndexSchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("fixed-event-private-index"), filename: Schema.String,
  directory: Schema.String, identity: Identity, work_authority: Schema.Literal(false) })
const ResultSchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("fixed-event-git-result"), exit_code: Schema.Int,
  tree_retired: Schema.Literal(true), dual_eof: Schema.Literal(true), writer_joined: Schema.Literal(true), work_authority: Schema.Literal(false) })
const AllocationSchema = Schema.Struct({ version: Schema.Literal(1), allocated_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(16_777_216)) })
const ParentSchema = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal("fixed-event-parent-namespace"), directory: Schema.String,
  identity: Identity, work_authority: Schema.Literal(false) })
const failure = (unknown = false) => new EventWorkDagSchema.Error({ code: unknown ? "EVENT_DAG_UNKNOWN" : "EVENT_DAG_UNAVAILABLE",
  message: "Original fixed Windows builtin Git or held Event namespace is unavailable or its physical outcome is unknown" })
const map = (error: unknown) => failure(!!error && typeof error === "object" && "code" in error && error.code === "WINDOWS_EVENT_GIT_UNKNOWN")
type Port = NonNullable<NativeWindowsWorkFactory.Interface["eventGit"]>
type Original = { factory: NativeWindowsWorkFactory.Interface; port: Port; runtime: object; lease?: object;
  metadata: string; active: boolean; scoped: boolean }
const originals = new WeakMap<object, Original>()
/** Captured lifetime only. Native image and namespace observations still run
 * through current outside SQL before each physical operation. */
export const isCurrent = (token: object) => {
  const original = originals.get(token)
  return !!original?.scoped && original.active && original.factory.isCurrent()
}
const PrivateIndex = Context.Reference<object | undefined>("@deepagent-code/WindowsEventGit/PrivateIndex", { defaultValue: () => undefined })
const decode = <A, I>(schema: Schema.Codec<A, I>, text: string) => Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
  Schema.decodeUnknownOption(schema, { onExcessProperty: "error" }))
const current = (token: object) => Effect.gen(function* () {
  const value = originals.get(token)
  if (!value?.active || !value.scoped) return yield* failure()
  yield* value.factory.current.pipe(Effect.mapError(map))
  const observed = yield* Effect.try({ try: () => value.lease ? value.port.currentRepository(value.lease) : value.port.current(value.runtime), catch: map })
  if (observed !== value.metadata) return yield* failure()
})

/** A runtime is optional. Missing fixed Git leaves ordinary file/command/CLI
 * capabilities intact and rejects E2 before its custody reservation. */
export const capture = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (process.platform !== "win32" || Option.isNone(supplied) || !supplied.value.eventGit) return yield* failure()
  const factory = supplied.value
  const port = factory.eventGit!
  yield* factory.current.pipe(Effect.mapError(map))
  const opened = yield* Effect.acquireRelease(Effect.try({ try: () => port.open(), catch: map }),
    (opened) => Effect.try({ try: () => port.close(opened.lease), catch: map }).pipe(Effect.orDie))
  const runtime = decode(RuntimeSchema, opened.metadata)
  if (Option.isNone(runtime) || !path.isAbsolute(runtime.value.filename) || !/[/\\]Git[/\\]mingw64[/\\]bin[/\\]git\.exe$/i.test(runtime.value.filename) ||
    runtime.value.images.reduce((sum, image) => sum + image.bytes, 0) > 536_870_912 ||
    new Set(runtime.value.images.map((image) => `${image.identity.volume_serial}:${image.identity.file_id}`)).size !== runtime.value.images.length)
    return yield* failure()
  const token = Object.freeze({})
  const original = { factory, port, runtime: opened.lease, metadata: opened.metadata, active: true, scoped: true }
  originals.set(token, original)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    original.scoped = false
    original.active = false
    originals.delete(token)
  }))
  return { filename: runtime.value.filename, hash: runtime.value.sha256, repository: undefined as undefined | {
    directory: string; gitDirectory: string; current: Effect.Effect<void, EventWorkDagSchema.Error> }, windows: token, current: current(token).pipe(Effect.asVoid) }
})

export const pinRepository = (directory: string, runtime: Effect.Success<typeof capture>) => Effect.gen(function* () {
  const original = originals.get(runtime.windows)
  if (!original || original.lease || !original.scoped || !original.active) return yield* failure()
  yield* current(runtime.windows)
  const root = yield* WorkFileHelper.inspectRoot(directory).pipe(Effect.mapError(map))
  if (root.rootIdentity.kind !== "windows") return yield* failure()
  const expected = { kind: "windows" as const, volume_serial: root.rootIdentity.volumeSerial, file_id: root.rootIdentity.fileID }
  const opened = yield* Effect.acquireRelease(Effect.try({ try: () => original.port.openRepository(original.runtime, CanonicalJson.stringify({ directory, expected })), catch: map }),
    (opened) => Effect.try({ try: () => original.port.closeRepository(opened.lease), catch: map }).pipe(Effect.orDie))
  const repository = decode(RepositorySchema, opened.metadata)
  if (Option.isNone(repository) || repository.value.directory !== directory || !path.isAbsolute(repository.value.git_directory) ||
    CanonicalJson.stringify(repository.value.root) !== CanonicalJson.stringify(expected) || repository.value.runtime.sha256 !== runtime.hash) return yield* failure()
  const token = Object.freeze({})
  const value: Original = { ...original, lease: opened.lease, metadata: opened.metadata }
  originals.set(token, value)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    value.scoped = false
    value.active = false
    originals.delete(token)
  }))
  return { ...runtime, windows: token, current: current(token).pipe(Effect.asVoid), repository: { directory, gitDirectory: repository.value.git_directory, current: current(token).pipe(Effect.asVoid).pipe(Effect.asVoid) } }
})

export const withPrivateIndex = <A, E, R>(token: object, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  yield* current(token)
  const original = originals.get(token)
  if (!original?.lease) return yield* failure()
  const text = yield* Effect.acquireRelease(Effect.try({ try: () => original.port.openIndex(original.lease!), catch: map }),
    () => Effect.try({ try: () => original.port.closeIndex(original.lease!), catch: map }).pipe(Effect.orDie))
  const index = decode(IndexSchema, text)
  if (Option.isNone(index) || path.dirname(index.value.filename) !== index.value.directory || path.basename(index.value.filename) !== "index") return yield* failure()
  return yield* effect.pipe(Effect.provideService(PrivateIndex, token))
}).pipe(Effect.scoped)
export const indexAllocation = Effect.gen(function* () {
  const token = yield* PrivateIndex
  if (!token) return yield* failure()
  yield* current(token)
  const original = originals.get(token)
  if (!original?.lease) return yield* failure()
  const text = yield* Effect.try({ try: () => original.port.indexAllocation(original.lease!), catch: map })
  const result = decode(AllocationSchema, text)
  if (Option.isNone(result)) return yield* failure()
  return result.value.allocated_bytes
})
export const prepareParent = (token: object, repositoryRoot: string, parent: string) => Effect.gen(function* () {
  yield* current(token)
  const original = originals.get(token)
  if (!original?.lease) return yield* failure()
  const repository = decode(RepositorySchema, original.metadata)
  if (Option.isNone(repository) || repository.value.directory !== repositoryRoot) return yield* failure()
  const text = yield* Effect.try({ try: () => original.port.prepareParent(original.lease!), catch: map })
  const observed = decode(ParentSchema, text)
  if (Option.isNone(observed) || observed.value.directory !== parent) return yield* failure()
  yield* current(token)
  return observed.value.directory
})
export const run = (token: object, input: { directory: string; args: readonly string[]; stdin?: Buffer; blob?: boolean; commitTime?: number }) => Effect.gen(function* () {
  yield* current(token)
  const original = originals.get(token)
  if (!original?.lease) return yield* failure()
  const repository = decode(RepositorySchema, original.metadata)
  if (Option.isNone(repository) || repository.value.directory !== input.directory) return yield* failure()
  const result = yield* Effect.try({ try: () => original.port.run(original.lease!, CanonicalJson.stringify({ args: input.args,
    blob: input.blob ?? false, commit_time: input.commitTime ?? null }), input.stdin ?? Buffer.alloc(0)), catch: map })
  const metadata = decode(ResultSchema, result.metadata)
  const limit = input.blob ? 16_777_216 : input.args[0] === "rev-list" ? 2_097_152 : 1_048_576
  if (Option.isNone(metadata) || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) || result.stdout.byteLength > limit || result.stderr.byteLength > 1_048_576)
    return yield* failure(true)
  yield* current(token)
  if (metadata.value.exit_code === 0 && input.args[0] === "rev-parse" && input.args[1] === "--show-toplevel") {
    const reported = result.stdout.toString().trimEnd()
    // This is a representation conversion for the already captured repository,
    // not a new filesystem lookup or an additional namespace authorization.
    if (reported.includes("\n") || reported.includes("\r") || path.win32.normalize(reported) !== repository.value.directory) return yield* failure()
    return { exitCode: 0, stdout: Buffer.from(`${repository.value.directory}\n`), stderr: result.stderr }
  }
  return { exitCode: metadata.value.exit_code, stdout: result.stdout, stderr: result.stderr }
})

/** This unscoped lease is released by Placement's original Scope. Its pure
 * isCurrent is only a captured ownership fence; current performs native I/O. */
export const retain = (directory: string, identity: EventWorkPlacement.Description["parentRootIdentity"]) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(NativeWindowsWorkFactory.Service)
  if (process.platform !== "win32" || identity.kind !== "windows" || Option.isNone(supplied) || !supplied.value.eventGit) return yield* failure()
  const factory = supplied.value
  const port = factory.eventGit!
  yield* restore(factory.current.pipe(Effect.mapError(map)))
  const expected = { kind: "windows" as const, volume_serial: identity.volumeSerial, file_id: identity.fileID }
  const opened = yield* Effect.try({ try: () => port.openDirectory(CanonicalJson.stringify({ directory, expected })), catch: map })
  const observed = decode(DirectorySchema, opened.metadata)
  if (Option.isNone(observed) || observed.value.directory !== directory || CanonicalJson.stringify(observed.value.identity) !== CanonicalJson.stringify(expected)) {
    yield* Effect.try({ try: () => port.closeDirectory(opened.lease), catch: map })
    return yield* failure()
  }
  const state = { active: true }
  const isCurrent = () => state.active && factory.isCurrent()
  return { isCurrent, current: Effect.gen(function* () {
    if (!isCurrent()) return yield* failure()
    yield* factory.current.pipe(Effect.mapError(map))
    const text = yield* Effect.try({ try: () => port.currentDirectory(opened.lease), catch: map })
    if (text !== opened.metadata) return yield* failure()
  }), close: Effect.try({ try: () => { if (!state.active) return; port.closeDirectory(opened.lease); state.active = false }, catch: map }) }
}))
