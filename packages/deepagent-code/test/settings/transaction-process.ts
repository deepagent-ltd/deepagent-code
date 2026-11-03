import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { NativeWindowsBootstrap } from "@/installation/windows-native-bootstrap"
import { WindowsSettingsStorage } from "@/installation/windows-settings-storage"
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
const resultID = process.argv[5]
if (!root || !mode || !resultID || !/^[a-f0-9-]{36}$/.test(resultID))
  throw new Error("Private settings fixture arguments required")
const writes: string[] = []
async function published(leaf: string, kind: "rename" | "native") {
  writes.push(leaf)
  if (stage !== leaf) return
  await fs.writeFile(path.join(root, "paused"), JSON.stringify({ kind, stage, pid: process.pid }), {
    mode: 0o600,
    flag: "wx",
  })
  await new Promise(() => {})
}

const rename = fs.rename
fs.rename = async (source, target) => {
  await rename(source, target)
  await published(path.basename(String(target)), "rename")
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
const posixDirect = Effect.tryPromise({
  try: async () => {
    if (mode === "read") await SettingsStore.read()
    if (mode === "direct") await SettingsStore.update({ deepagent: { selfLearning: "auto" } })
  },
  catch: (error: unknown) => (error instanceof Error ? error : new Error("Private fixture read failed")),
})
const configProgram = program.pipe(Effect.asVoid, Effect.provide(Layer.mergeAll(config, instances)))
const nativeProgram = Effect.gen(function* () {
  const context = yield* Layer.build(WindowsSettingsStorage.standaloneLayer)
  const bootstrap = Context.getOrUndefined(context, NativeWindowsBootstrap.Service)
  const settings = Context.get(context, WindowsSettingsStorage.Current)
  if (!bootstrap || !settings) throw new Error("The original Native settings port is required")
  yield* bootstrap.requireCurrent

  if (mode === "seed") {
    const leaf = "settings.json"
    const before = yield* settings.read(leaf)
    yield* settings.publish(leaf, JSON.stringify({ deepagent: { agentMode: "general", selfLearning: "manual" } }), before?.witness ?? null)
    return
  }
  const transaction =
    mode === "read" ? SettingsStore.readEffect :
    mode === "direct" ? SettingsStore.updateEffect({ deepagent: { selfLearning: "auto" } }).pipe(
      Effect.provide(EffectFlock.defaultLayer), Effect.provide(FSUtil.defaultLayer),
    ) : configProgram
  yield* transaction.pipe(
    Effect.provideService(WindowsSettingsStorage.Current, {
      ...settings,
      publish: (name, text, expected) => settings.publish(name, text, expected).pipe(
        Effect.tap(() => Effect.promise(() => published(name, "native"))),
      ),
    }),
    Effect.provide(context),
  )
})
const result = process.platform === "win32"
  ? await Effect.runPromiseExit(nativeProgram.pipe(Effect.scoped))
  : await Effect.runPromiseExit(mode === "read" || mode === "direct" ? posixDirect : configProgram)

const error = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined
await fs.writeFile(
  path.join(root, `child-result-${resultID}.json`),
  JSON.stringify({
    ok: Exit.isSuccess(result),
    error: error instanceof Error ? error.message : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    writes,
  }),
  { mode: 0o600 },
)
process.exit(Exit.isSuccess(result) ? 0 : 1)
