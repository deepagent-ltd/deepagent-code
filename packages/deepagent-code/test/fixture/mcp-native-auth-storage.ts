export * as NativeAuthStorage from "./mcp-native-auth-storage"

import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { NativeWindowsBootstrap } from "../../src/installation/windows-native-bootstrap"
import { NativeWindowsWorkFactory } from "../../src/installation/windows-work-factory"
import { WindowsPrivateStorage } from "../../src/installation/windows-private-storage"
import { WindowsSettingsStorage } from "../../src/installation/windows-settings-storage"
import { McpWindowsStorage } from "../../src/mcp/windows-storage"

export type Services =
  | NativeWindowsBootstrap.Service
  | typeof WindowsSettingsStorage.Current
  | typeof McpWindowsStorage.Current

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Layer.build(WindowsSettingsStorage.standaloneLayer)
    const bootstrap = Context.getOrUndefined(context, NativeWindowsBootstrap.Service)
    assert(bootstrap, "The original Native bootstrap is required")
    yield* bootstrap.requireCurrent
    const native = Layer.succeed(NativeWindowsBootstrap.Service, bootstrap)
    yield* WindowsPrivateStorage.make("mcp_secret_envelopes", true).pipe(
      Effect.asVoid,
      Effect.scoped,
      Effect.provide(native),
    )
    const work = yield* Layer.build(NativeWindowsWorkFactory.layer.pipe(Layer.provide(native)))
    const mcp = yield* Layer.build(
      McpWindowsStorage.layer.pipe(
        Layer.provide(native),
        Layer.provide(Layer.succeedContext(work)),
        Layer.provide(EffectFlock.defaultLayer),
      ),
    )
    return Layer.succeedContext(Context.merge(context, mcp) as Context.Context<Services>)
  }),
)

export async function run(body: (storage: Layer.Layer<Services>, port: McpWindowsStorage.Port) => Promise<void>) {
  if (!(await Effect.runPromise(NativeWindowsBootstrap.Registered))) await NativeWindowsBootstrap.installFixedEntry()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const storage = yield* Layer.build(layer)
        const port = Context.get(storage, McpWindowsStorage.Current)
        assert(port, "The original Native MCP storage is required")
        yield* Effect.promise(() => body(Layer.succeedContext(storage), port))
      }),
    ),
  )
}
