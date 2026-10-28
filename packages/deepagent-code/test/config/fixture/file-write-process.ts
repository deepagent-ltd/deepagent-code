import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { ConfigFileWrite } from "@/config/file-write"
import { Config } from "@/config/config"
import { addMcpToConfig, editMcpInConfig, removeMcpFromConfig } from "@/cli/cmd/mcp"
import { rewriteMcpEntry } from "@/mcp"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Env } from "@/env"
import { AuthTest } from "../../fake/auth"
import { AccountTest } from "../../fake/account"
import { NpmTest } from "../../fake/npm"
import { HttpClient } from "effect/unstable/http"

const phase = (value: string) => console.error("CONFIG_FILE_WRITE_CHILD_PHASE", value)
phase("imports-complete")
const directory = process.argv[2]
const mode = process.argv[3]
const expectedPath = process.argv[4]
if (!directory || !mode) throw new Error("Private writer fixture arguments required")
const root = await fs.realpath(directory)
const file = path.join(root, "deepagent-code.json")
const expected: ConfigFileWrite.Observation | undefined = expectedPath ? await Bun.file(expectedPath).json() : undefined
const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected network")),
    ),
  ),
)
const instances = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
// The compiled Windows launcher captures all homes before this business import.
// Reuse production Root storage; source POSIX children keep their original layer.
const { windowsStorageLayer } = process.platform === "win32"
  ? await import("@/effect/root") : { windowsStorageLayer: Layer.empty }
const layer = Layer.mergeAll(configLayer, instances, CrossSpawnSpawner.defaultLayer).pipe(
  Layer.provideMerge(windowsStorageLayer),
)
phase("layer-enter")
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    phase("body-enter")
    if (mode === "config" || mode === "load" || mode === "global") {
      const service = yield* Config.Service
      const instances = yield* InstanceStore.Service
      return yield* instances.provide(
        { directory: root },
        Effect.gen(function* () {
          if (mode === "load") return yield* service.get()
          if (mode === "global")
            return yield* service.updateGlobal(
              { mcp: { config_writer: { type: "local", command: ["fixture"] } } },
              expected,
            )
          yield* service.update({ mcp: { config_writer: { type: "local", command: ["fixture"] } } }, expected)
        }),
      )
    }
    if (mode === "cli-add")
      return yield* Effect.tryPromise({
        try: () => addMcpToConfig("cli_writer", { type: "local", command: ["fixture"] }, file, expected),
        catch: (error) => error,
      })
    if (mode === "cli-edit")
      return yield* Effect.tryPromise({
        try: () => editMcpInConfig("original", file, { command: ["updated"] }, expected),
        catch: (error) => error,
      })
    if (mode === "cli-remove")
      return yield* Effect.tryPromise({
        try: () => removeMcpFromConfig("original", file, expected),
        catch: (error) => error,
      })
    if (mode === "rewrite")
      return yield* Effect.tryPromise({
        try: () => rewriteMcpEntry(file, "original", { type: "local", command: ["rewritten"] }, expected),
        catch: (error) => error,
      })
    throw new Error("Unknown private writer fixture")
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
phase("body-exit")
if (Exit.isSuccess(result)) {
  console.log(JSON.stringify({ state: "written" }))
  process.exit(0)
}
const error = Cause.pretty(result.cause)
console.log(JSON.stringify({ state: "refused", changed: error.includes("Configuration file changed") }))
if (!error.includes("Configuration file changed")) console.error(error)
process.exit(error.includes("Configuration file changed") ? 3 : 1)
