export * as WindowsPrivateStorage from "./windows-private-storage"

import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { Global } from "@deepagent-code/core/global"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import { NativeWindowsBootstrap } from "./windows-native-bootstrap"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Observation = Schema.Struct({
  identity: Schema.Struct({ kind: Schema.Literal("windows"),
    volume_serial: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)),
    file_id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)) }),
  stamp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_048_576)),
  sha256: Digest,
})
const Metadata = Schema.Struct({ version: Schema.Literal(1),
  status: Schema.Literals(["observed", "missing", "published"]), observation: Schema.NullOr(Observation),
  payload_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_048_576)) })
export class Error extends Schema.TaggedErrorClass<Error>()("WindowsPrivateStorageError", {
  reason: Schema.Literals(["unavailable", "changed", "invalid", "capacity", "unknown"]),
}) {
  override get message() { return `Windows private storage ${this.reason}` }
}
export type Purpose = "settings" | "local_operator"
declare const originalSnapshot: unique symbol
export interface Snapshot { readonly [originalSnapshot]: true }
const originals = new WeakMap<Snapshot, { purpose: Purpose; name: string; capture: NativeWindowsBootstrap.Capture;
  observation: typeof Observation.Type }>()
/** Data from an original witness; returning a description does not reconstruct a witness. */
export function describe(snapshot: Snapshot) {
  const original = originals.get(snapshot)
  return original && NativeWindowsBootstrap.describe(original.capture) ? original.observation : undefined
}
const permitted = (purpose: Purpose, name: string) => purpose === "local_operator" ? name === "installation.json"
  : ["settings.json", ".settings-operation.json", ".settings-receipt.json"].includes(name)
const limit = (purpose: Purpose) => purpose === "local_operator" ? 1024 : 1_048_576

/** A short held-directory lease from the one original Root bootstrap. No caller
 * chooses a directory, native image, command line, or reconstructed observation. */
export const make = Effect.fn("WindowsPrivateStorage.make")(function* (purpose: Purpose, prepare = false) {
  const available = yield* Effect.serviceOption(NativeWindowsBootstrap.Service)
  if (process.platform !== "win32" || Option.isNone(available) || !available.value.privateStorage ||
    !NativeWindowsBootstrap.describe(available.value.capture)) return yield* new Error({ reason: "unavailable" })
  const bootstrap = available.value
  const native = bootstrap.privateStorage!
  const root = purpose === "settings" ? Global.Path.config : path.join(Global.Path.data, "local-operator")
  if (!Schema.is(WorkWindowsPathSchema.Absolute)(root)) return yield* new Error({ reason: "unavailable" })
  yield* bootstrap.requireCurrent.pipe(Effect.mapError(() => new Error({ reason: "changed" })))
  const lease = yield* Effect.acquireRelease(Effect.try({ try: () => native.open(JSON.stringify({ version: 1,
    purpose, root, prepare, deadline_ms: 30_000 })), catch: error }),
    (lease) => Effect.sync(() => native.close(lease)))
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  const current = Effect.gen(function* () {
    if (!lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture)) return yield* new Error({ reason: "changed" })
    yield* bootstrap.requireCurrent.pipe(Effect.mapError(() => new Error({ reason: "changed" })))
    yield* Effect.try({ try: () => { if (!native.current(lease)) throw new Error({ reason: "changed" }) }, catch: error })
  })
  const snapshot = (name: string, observation: typeof Observation.Type) => {
    const witness = Object.freeze(Object.create(null)) as Snapshot
    originals.set(witness, { purpose, name, capture: bootstrap.capture,
      observation: Object.freeze({ ...observation, identity: Object.freeze({ ...observation.identity }) }) })
    return witness
  }
  return {
    current,
    holdInstallation: Effect.gen(function* () {
      if (purpose !== "local_operator" || !native.installation) return yield* new Error({ reason: "unavailable" })
      yield* current
      const observed = yield* Effect.try({ try: () => native.installation!.pin(lease), catch: error })
      if (!Buffer.isBuffer(observed.bytes)) return yield* new Error({ reason: "invalid" })
      const text = yield* Effect.gen(function* () {
        const metadata = yield* decode(observed.metadata)
        if (metadata.status !== "observed" || !metadata.observation ||
          observed.bytes.length > 1024 || observed.bytes.length !== metadata.payload_bytes ||
          metadata.observation.bytes !== observed.bytes.length ||
          createHash("sha256").update(observed.bytes).digest("hex") !== metadata.observation.sha256)
          return yield* new Error({ reason: "invalid" })
        yield* current
        return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes),
          catch: () => new Error({ reason: "invalid" }) })
      }).pipe(Effect.ensuring(Effect.sync(() => observed.bytes.fill(0))))
      // Native rechecks the original held leaf and actual <=1024 byte hash on
      // each use. Scope expiry closes the pin; copied text is never that proof.
      const pinnedCurrent = Effect.try({ try: () => {
        if (!lifetime.active || !NativeWindowsBootstrap.describe(bootstrap.capture) ||
          !native.installation!.current(lease)) throw new Error({ reason: "changed" })
      }, catch: error })
      return Object.freeze({ text, current: pinnedCurrent })
    }),
    read: Effect.fn("WindowsPrivateStorage.read")(function* (name: string) {
      if (!permitted(purpose, name)) return yield* new Error({ reason: "invalid" })
      yield* current
      const observed = yield* Effect.try({ try: () => native.read(lease, name), catch: error })
      const metadata = yield* decode(observed.metadata)
      if (!Buffer.isBuffer(observed.bytes) || observed.bytes.length !== metadata.payload_bytes || observed.bytes.length > limit(purpose))
        return yield* new Error({ reason: "invalid" })
      yield* current
      if (metadata.status === "missing" && metadata.observation === null && observed.bytes.length === 0) return undefined
      if (metadata.status !== "observed" || !metadata.observation || metadata.observation.bytes !== observed.bytes.length ||
        createHash("sha256").update(observed.bytes).digest("hex") !== metadata.observation.sha256)
        return yield* new Error({ reason: "invalid" })
      const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes),
        catch: () => new Error({ reason: "invalid" }) })
      return Object.freeze({ text, hash: metadata.observation.sha256, witness: snapshot(name, metadata.observation) })
    }),
    publish: Effect.fn("WindowsPrivateStorage.publish")(function* (name: string, text: string, expected: Snapshot | null) {
      if (!permitted(purpose, name)) return yield* new Error({ reason: "invalid" })
      const previous = expected && originals.get(expected)
      if (expected && (!previous || previous.capture !== bootstrap.capture || previous.purpose !== purpose || previous.name !== name))
        return yield* new Error({ reason: "changed" })
      const bytes = Buffer.from(text, "utf8")
      if (bytes.length > limit(purpose) || bytes.toString("utf8") !== text) return yield* new Error({ reason: "capacity" })
      yield* current
      const observed = yield* Effect.try({ try: () => native.publish(lease, JSON.stringify({ version: 1,
        id: randomBytes(16).toString("hex"), name, expected: previous ? previous.observation : null,
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }), bytes), catch: error })
      // A post-publication failure remains unknown; no retry, copy/delete, or
      // compensating overwrite turns an uncertain namespace result into success.
      return yield* Effect.gen(function* () {
        const metadata = yield* decode(observed)
        yield* current
        if (metadata.status !== "published" || !metadata.observation || metadata.payload_bytes !== 0 ||
          metadata.observation.bytes !== bytes.length || metadata.observation.sha256 !== createHash("sha256").update(bytes).digest("hex"))
          return yield* new Error({ reason: "invalid" })
        return snapshot(name, metadata.observation)
      }).pipe(Effect.mapError(() => new Error({ reason: "unknown" })))
    }),
  }
})

function decode(text: unknown) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) return Effect.fail(new Error({ reason: "invalid" }))
  const decoded = Option.flatMap(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
    Schema.decodeUnknownOption(Metadata, { onExcessProperty: "error" }))
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(new Error({ reason: "invalid" }))
}
function error(value: unknown) {
  if (value instanceof Error) return value
  const code = typeof value === "object" && value !== null && "code" in value ? value.code : undefined
  return new Error({ reason: code === "PRIVATE_STORAGE_PUBLICATION_UNKNOWN" ? "unknown"
    : code === "PRIVATE_STORAGE_CHANGED" ? "changed" : "unavailable" })
}
