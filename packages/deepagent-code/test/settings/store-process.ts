import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { ConfigFileWrite } from "@/config/file-write"
import { NativeWindowsBootstrap } from "@/installation/windows-native-bootstrap"
import { WindowsSettingsStorage } from "@/installation/windows-settings-storage"
import { SettingsStore } from "@/settings/store"
import { registerSettingsStoreCases } from "./store.cases"

const name = process.argv[2]
assert(name, "A SettingsStore case name is required")
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(WindowsSettingsStorage.standaloneLayer)
  const bootstrap = Context.getOrUndefined(context, NativeWindowsBootstrap.Service)
  assert(bootstrap, "The original Native bootstrap is required")
  yield* bootstrap.requireCurrent
  const settings = Context.get(context, WindowsSettingsStorage.Current)
  assert(settings, "The original Native settings port is required")

  const cases = new Map<string, () => Promise<void>>()
  registerSettingsStoreCases((name, run) => {
    cases.set(name, () => run({
      file: SettingsStore.file(),
      store: {
        read: () => Effect.runPromise(SettingsStore.readEffect.pipe(Effect.provide(context))),
        update: (patch) => ConfigFileWrite.run(SettingsStore.updateEffect(patch).pipe(Effect.provide(context))),
        invalidate: SettingsStore.invalidate,
      },
      // Seed legacy and malformed bytes through the fixed private leaf so Native custody stays intact.
      writeFixture: (text) => Effect.runPromise(Effect.gen(function* () {
        const current = yield* settings.read("settings.json")
        yield* settings.publish("settings.json", text, current?.witness ?? null)
      })),
    }))
  })
  const run = cases.get(name)
  assert(run, "A registered SettingsStore case is required")
  yield* Effect.promise(run)
})))
console.log(JSON.stringify({ name, native: true }))
