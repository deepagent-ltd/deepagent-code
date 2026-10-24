export * as WindowsSettingsStorage from "./windows-settings-storage"

import { Context, Effect, Layer } from "effect"
import { NativeWindowsBootstrap } from "./windows-native-bootstrap"
import { WindowsPrivateStorage } from "./windows-private-storage"

export type Port = {
  read: (name: string) => Effect.Effect<Readonly<{ text: string; hash: string; witness: WindowsPrivateStorage.Snapshot }> | undefined, WindowsPrivateStorage.Error>
  publish: (name: string, text: string, expected: WindowsPrivateStorage.Snapshot | null) => Effect.Effect<WindowsPrivateStorage.Snapshot, WindowsPrivateStorage.Error>
  parent: Effect.Effect<void, WindowsPrivateStorage.Error>
}

/** Root-owned reference. Promise adapters cannot manufacture another bootstrap or
 * close/reopen the original native capture to obtain a settings reader. */
export const Current = Context.Reference<Port | undefined>("WindowsSettingsStorage.Current", { defaultValue: () => undefined })

/** Installation and the original preloader precede Settings. This one explicit
 * startup preparation creates/protects the fixed directory; cold readers do not. */
export const layer = Layer.effectContext(Effect.gen(function* () {
  const bootstrap = yield* NativeWindowsBootstrap.Service
  yield* WindowsPrivateStorage.make("settings", true).pipe(Effect.asVoid, Effect.scoped)
  const lifetime = { active: true }
  yield* Effect.addFinalizer(() => Effect.sync(() => { lifetime.active = false }))
  const invoke = <A>(run: (storage: Effect.Success<ReturnType<typeof WindowsPrivateStorage.make>>) => Effect.Effect<A, WindowsPrivateStorage.Error>) =>
    Effect.suspend(() => lifetime.active
      ? WindowsPrivateStorage.make("settings").pipe(Effect.flatMap(run), Effect.scoped,
        Effect.provideService(NativeWindowsBootstrap.Service, bootstrap))
      : Effect.fail(new WindowsPrivateStorage.Error({ reason: "changed" })))
  return Context.make(Current, {
    read: (name) => invoke((storage) => storage.read(name)),
    publish: (name, text, expected) => invoke((storage) => storage.publish(name, text, expected)),
    parent: invoke((storage) => storage.current),
  })
}))

/** Config for serve/web is read before the listener opens its database root.
 * Prepare only the original Native settings port; no Work/MCP/DB services boot. */
export const standaloneLayer = Layer.effectContext(Effect.gen(function* () {
  if (process.platform !== "win32" || !(yield* NativeWindowsBootstrap.Registered)) return Context.empty()
  const { NativeInstallation } = yield* Effect.promise(() => import("./native-installation"))
  const bootstrap = yield* NativeWindowsBootstrap.make(yield* NativeInstallation.current())
  const native = Context.make(NativeWindowsBootstrap.Service, bootstrap)
  const settings = yield* Layer.build(layer.pipe(Layer.provide(Layer.succeedContext(native))))
  return Context.merge(native, settings)
}))
