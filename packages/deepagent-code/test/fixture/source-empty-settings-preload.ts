import { mock } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { NativeWindowsBootstrap } from "../../src/installation/windows-native-bootstrap"
import { EmptySettingsFixture } from "./empty-settings"

// Only explicitly selected source Bun children install this composition seam.
// Compiled Native children and the production registration/capture stay real.
if (process.platform === "win32") {
  if (!process.versions.bun || /(?:\$bunfs|[Bb]:[\\/]~BUN)/.test(Bun.main + import.meta.url))
    throw new Error("Empty settings Root preload requires a source Bun child")
  if (!process.env.DEEPAGENT_CODE_TEST_HOME || !path.isAbsolute(process.env.DEEPAGENT_CODE_TEST_HOME))
    throw new Error("Empty settings Root preload requires an isolated test root")

  const imported = await import("../../src/effect/root")
  const original = { ...imported }
  const windowsStorageLayer = original.windowsStorageLayer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          if (yield* NativeWindowsBootstrap.Registered)
            return yield* Effect.die(new Error("Empty settings Root preload cannot replace registered Native storage"))
          return EmptySettingsFixture.layer
        }),
      ),
    ),
  )
  const root = { ...original.Root, windowsStorageLayer }
  Object.defineProperty(root, "Root", { value: root })
  Object.freeze(root)
  const modulePath = fileURLToPath(import.meta.resolve("../../src/effect/root"))
  mock.module(modulePath, () => ({ ...original, windowsStorageLayer, Root: root }))
  const loaded = await import("../../src/effect/root")
  if (Object.keys(loaded).sort().join("\n") !== Object.keys(original).sort().join("\n"))
    throw new Error("Empty settings Root preload changed the Root exports")
  for (const name of Object.keys(original) as (keyof typeof original)[]) {
    if (name === "Root" || name === "windowsStorageLayer") continue
    if (loaded[name] !== original[name] || loaded.Root[name] !== original.Root[name])
      throw new Error(`Empty settings Root preload replaced ${name}`)
  }
  if (
    loaded.windowsStorageLayer !== windowsStorageLayer ||
    loaded.Root.windowsStorageLayer !== windowsStorageLayer ||
    loaded.Root.Root !== loaded.Root ||
    loaded.embeddedServerMemoMap() !== original.embeddedServerMemoMap()
  )
    throw new Error("Empty settings Root preload did not preserve the original root identities")
}
