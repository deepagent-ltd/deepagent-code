export * as NativeWindowsImageFactory from "./windows-image-factory"

import { Context, Effect, Option, Schema } from "effect"
import { WorkCommandWindowsSchema } from "@deepagent-code/core/session/work-command-windows.schema"
import { WorkWindowsPathSchema } from "@deepagent-code/core/session/work-windows-path.schema"
import type { NativeInstallation } from "./native-installation"

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Image = Schema.Struct({ assetPath: Schema.NullOr(Schema.String), system: Schema.Boolean, path: WorkWindowsPathSchema.Absolute,
  identity: WorkCommandWindowsSchema.Identity, sha256: Digest,
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(268_435_456)) })
export const Description = Schema.Struct({ libraryEvidence: Schema.Literal("original-system32-import-leases.v1"), target: WorkCommandWindowsSchema.Target, bootstrapHash: Digest,
  closureHash: Digest, supervisor: Image, payload: Image,
  libraries: Schema.Array(Image).check(Schema.isMaxLength(128)) }).check(Schema.makeFilter((value) =>
    value.supervisor.bytes + value.payload.bytes + value.libraries.reduce((bytes, image) => bytes + image.bytes, 0) <= 536_870_912 &&
    new Set([value.supervisor, value.payload, ...value.libraries].map((image) => `${image.identity.volumeSerial}:${image.identity.fileID}`)).size === value.libraries.length + 2))
export type Description = typeof Description.Type
export class Error extends Schema.TaggedErrorClass<Error>()("WindowsImageFactoryError", {
  code: Schema.Literals(["WINDOWS_IMAGE_FACTORY_UNAVAILABLE", "WINDOWS_IMAGE_FACTORY_CHANGED"]), message: Schema.String,
}) {}
const unavailable = () => new Error({ code: "WINDOWS_IMAGE_FACTORY_UNAVAILABLE", message: "Trusted Windows native image factory is unavailable" })
declare const originalNativeFactory: unique symbol
export interface NativeFactory { readonly [originalNativeFactory]: true }
declare const originalTargetCapture: unique symbol
export interface TargetCapture { readonly [originalTargetCapture]: true }

/** Only the registered in-process native installation loader may provide this
 * port. A named require/dlopen/spawn is not that loader: the original bootstrap
 * must already have held its own image/DLL/ancestor chain under installation ACL.
 * The default stays absent until that TCB has a real implementation and proof. */
export const Registered = Context.Reference<{
  open: (installation: NativeInstallation.VerifiedInstalledComponents) => Effect.Effect<NativeFactory, Error>
  // Original object/lifetime lookup only; filesystem rechecks belong to revalidate.
  describe: (original: NativeFactory) => Description | undefined
  revalidate: (original: NativeFactory) => Effect.Effect<void, Error>
  close: (original: NativeFactory) => Effect.Effect<void, Error>
} | undefined>("NativeWindowsImageFactory.Registered", { defaultValue: () => undefined })

export const requireRegistered = Effect.gen(function* () {
  const original = yield* Registered
  if (!original || process.platform !== "win32") return yield* unavailable()
  return original
})

const targets = new WeakMap<TargetCapture, { current: () => Description | undefined; description: Description }>()
/** A pure transaction getter: no filesystem/native request or permission renewal.
 * Original kernel leases remain held by the native factory for the entire Scope. */
export function describeTarget(original: TargetCapture) {
  const entry = targets.get(original)
  return entry?.current() === entry?.description ? entry?.description.target : undefined
}

export const make = Effect.fn("NativeWindowsImageFactory.make")(function* (
  installation: NativeInstallation.VerifiedInstalledComponents,
) {
  const registered = yield* requireRegistered
  const { NativeInstallation } = yield* Effect.promise(() => import("./native-installation"))
  yield* NativeInstallation.requireCurrent(installation).pipe(Effect.mapError(() => unavailable()))
  const inventory = yield* NativeInstallation.inventory(installation).pipe(Effect.mapError(() => unavailable()))
  const native = yield* registered.open(installation)
  yield* Effect.addFinalizer(() => registered.close(native).pipe(Effect.orDie))
  const description = registered.describe(native)
  const decoded = Schema.decodeUnknownOption(Description, { onExcessProperty: "error" })(description)
  if (Option.isNone(decoded) || !description || description.target !== `${process.platform}-${process.arch}` ||
    !Object.isFrozen(description) || !Object.isFrozen(description.libraries) ||
    ![description.supervisor, description.payload, ...description.libraries].every((image) => Object.isFrozen(image) && Object.isFrozen(image.identity))) return yield* unavailable()
  const prefix = `packages/work-file-helper/bin/${description.target}/`
  const { NativeWindowsBootstrap } = yield* Effect.promise(() => import("./windows-native-bootstrap"))
  const bootstrap = yield* Effect.serviceOption(NativeWindowsBootstrap.Service)
  if (Option.isNone(bootstrap)) return yield* unavailable()
  yield* bootstrap.value.requireCurrent.pipe(Effect.mapError(unavailable))
  const matches = (image: Description["supervisor"]) => !image.system && inventory.some((entry) => entry.path === image.assetPath &&
    entry.sha256 === image.sha256 && entry.bytes === image.bytes)
  const system = (image: Description["supervisor"]) => image.system && image.assetPath === null &&
    description.libraryEvidence === "original-system32-import-leases.v1"
  if (description.supervisor.assetPath !== `${prefix}deepagent-work-process-supervisor.exe` ||
    description.payload.assetPath !== `${prefix}bun-command-runtime.exe` ||
    !inventory.some((entry) => entry.path === `${prefix}native-image-factory.node` && entry.sha256 === description.bootstrapHash) ||
    ![description.supervisor, description.payload].every(matches) || !description.libraries.every(system)) return yield* unavailable()
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  // Native describe must return the same original frozen descriptor. A renewed,
  // copied or cold-reconstructed object never inherits this capture's authority.
  const current = () => lifetime.active && registered.describe(native) === description ? description : undefined
  const target = Object.freeze(Object.create(null)) as TargetCapture
  targets.set(target, { current, description })
  return {
    captureTarget: () => current() ? Effect.succeed(target) : Effect.fail(unavailable()),
    current: Effect.suspend(() => {
      const actual = describeTarget(target)
      return actual ? Effect.succeed(actual) : Effect.fail(unavailable())
    }),
    revalidate: registered.revalidate(native).pipe(Effect.tap(() => current() ? Effect.void : Effect.fail(unavailable()))),
  }
})

export type Interface = Effect.Success<ReturnType<typeof make>>
