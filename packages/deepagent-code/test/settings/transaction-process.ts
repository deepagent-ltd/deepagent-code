import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Config } from "@/config/config"
import { ConfigFileWrite } from "@/config/file-write"
import { SettingsStore } from "@/settings/store"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Env } from "@/env"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { HttpClient } from "effect/unstable/http"

const root = process.argv[2]
const mode = process.argv[3]
const stage = process.argv[4]
if (!root || !mode) throw new Error("Private settings fixture arguments required")
const writes: string[] = []
const rename = fs.rename
fs.rename = async (source, target) => {
  await rename(source, target)
  writes.push(path.basename(String(target)))
  if (stage === path.basename(String(target))) {
    await fs.writeFile(path.join(root, "paused"), JSON.stringify({ kind: "actual_original_rename_completed", stage }), {
      mode: 0o600,
      flag: "wx",
    })
    await new Promise(() => {})
  }
}
const config = Config.layer.pipe(
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
const program = Effect.gen(function* () {
  if (mode === "read") return yield* Effect.promise(() => SettingsStore.read())
  if (mode === "direct")
    return yield* Effect.promise(() => SettingsStore.update({ deepagent: { selfLearning: "auto" } }))
  const service = yield* Config.Service
  return yield* (yield* InstanceStore.Service).provide(
    { directory: path.join(root, "workspace") },
    Effect.gen(function* () {
      if (mode === "load") return yield* service.get()
      const expected =
        mode === "stale" ? yield* ConfigFileWrite.read(path.join(root, "storage", "config.jsonc")) : undefined
      if (expected)
        yield* Effect.promise(() => fs.writeFile(expected.path, '{"model":"changed/current"}', { mode: 0o600 }))
      const probe = mode === "depth59" || mode === "depth60"
        ? Array.from({ length: mode === "depth59" ? 59 : 60 }).reduce<unknown>((value) => ({ next: value }), "Unicode 中文")
        : undefined
      return yield* service.updateGlobal(
        { model: "fixture/current", provider: { deepagent: { options: { agentMode: "high", ...(probe === undefined ? {} : { probe }) } } } },
        expected,
      )
    }),
  )
})
const result =
  mode === "read" || mode === "direct"
    ? await Effect.runPromiseExit(
        Effect.tryPromise({
          try: async () => {
            if (mode === "read") await SettingsStore.read()
            if (mode === "direct") await SettingsStore.update({ deepagent: { selfLearning: "auto" } })
          },
          catch: (error: unknown) => (error instanceof Error ? error : new Error("Private fixture read failed")),
        }),
      )
  : await Effect.runPromiseExit(program.pipe(Effect.asVoid, Effect.provide(Layer.mergeAll(config, instances))))

const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
await fs.writeFile(
  path.join(root, `child-result-${process.pid}.json`),
  JSON.stringify({ ok: Exit.isSuccess(result), error: error instanceof Error ? error.message : undefined, writes }),
  { mode: 0o600 },
)
process.exit(Exit.isSuccess(result) ? 0 : 1)
