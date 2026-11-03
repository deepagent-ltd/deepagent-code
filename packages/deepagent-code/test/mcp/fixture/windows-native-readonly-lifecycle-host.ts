import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Config } from "../../../src/config/config"
import { NativeInstallation } from "../../../src/installation/native-installation"
import { NativeWindowsBootstrap } from "../../../src/installation/windows-native-bootstrap"
import { NativeWindowsWorkFactory } from "../../../src/installation/windows-work-factory"
import { WindowsPrivateStorage } from "../../../src/installation/windows-private-storage"
import { WindowsSettingsStorage } from "../../../src/installation/windows-settings-storage"
import { MCP } from "../../../src/mcp/index"
import { McpWindowsStorage } from "../../../src/mcp/windows-storage"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { configWatch, publicEndpoint, refreshRotation } from "./readonly-lifecycle"

export async function main() {
  const mode = process.argv[2]
  assert(mode === "config-watch" || mode === "public-endpoint" || mode === "refresh-rotation")
  const root = process.env.DAC_NATIVE_NODE_COHORT_ROOT!
  await NativeWindowsBootstrap.installFixedEntry()
  const registered = await Effect.runPromise(NativeWindowsBootstrap.Registered)
  assert(registered)
  assert(registered.preloaded(registered.capture))
  assert(registered.current(registered.capture))
  const directory = await fs.mkdtemp(path.join(root, "readonly-instance-"))
  await fs.writeFile(
    path.join(directory, "deepagent-code.json"),
    JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", mcp: {} }),
  )
  const privateStorage = Layer.unwrap(
    Effect.gen(function* () {
      const installation = yield* NativeInstallation.current()
      const bootstrap = yield* NativeWindowsBootstrap.make(installation)
      assert.equal(bootstrap.description.preloaded, true)
      assert(NativeWindowsBootstrap.describe(bootstrap.capture))
      const native = Layer.succeed(NativeWindowsBootstrap.Service, bootstrap)
      yield* Layer.build(WindowsSettingsStorage.layer.pipe(Layer.provide(native)))
      yield* WindowsPrivateStorage.make("mcp_secret_envelopes", true).pipe(
        Effect.asVoid,
        Effect.scoped,
        Effect.provideService(NativeWindowsBootstrap.Service, bootstrap),
        Effect.catchTag("WindowsPrivateStorageError", () => Effect.void),
      )
      const work = yield* Layer.build(NativeWindowsWorkFactory.layer.pipe(Layer.provide(native)))
      return Layer.mergeAll(
        native,
        McpWindowsStorage.layer.pipe(
          Layer.provide(native),
          Layer.provide(Layer.succeedContext(work)),
          Layer.provide(EffectFlock.defaultLayer),
        ),
      )
    }),
  )
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Layer.build(privateStorage)
        const noopBootstrap = Layer.succeed(
          InstanceBootstrap.Service,
          InstanceBootstrap.Service.of({ run: Effect.void }),
        )
        const services = Layer.mergeAll(
          MCP.defaultLayer,
          Config.defaultLayer,
          CrossSpawnSpawner.defaultLayer,
          InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
        ).pipe(Layer.provideMerge(Layer.succeedContext(storage)))
        return yield* Effect.gen(function* () {
          const instances = yield* InstanceStore.Service
          if (mode === "config-watch") return yield* instances.provide({ directory }, configWatch(directory))
          if (mode === "public-endpoint") return yield* instances.provide({ directory }, publicEndpoint(directory))
          return yield* instances.provide({ directory }, refreshRotation())
        }).pipe(Effect.provide(services))
      }),
    ),
  )
  const evidence = { mode, nativePreloaded: true, nativeCurrent: true, ...result }
  await fs.writeFile(path.join(root, "readonly-lifecycle.json"), JSON.stringify(evidence, null, 2))
  console.log("WINDOWS_READONLY_LIFECYCLE", JSON.stringify(evidence))
}
