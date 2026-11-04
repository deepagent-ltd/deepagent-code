import { afterEach, beforeAll, expect } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"

if (process.platform === "win32") await import("../fixture/source-empty-settings-preload")
const [
  { InstanceLayer },
  { InstanceStore },
  { disposeAllInstances, tmpdirScoped },
  { testEffect },
  { waitGlobalBusEvent },
  { registerDisposer, registerInitializer },
  { bootstrap },
] = await Promise.all([
  import("../../src/project/instance-layer"),
  import("../../src/project/instance-store"),
  import("../fixture/fixture"),
  import("../lib/effect"),
  import("../server/global-bus"),
  import("@/effect/instance-registry"),
  import("../../src/cli/bootstrap"),
])

const it = testEffect(Layer.mergeAll(InstanceLayer.layer, CrossSpawnSpawner.defaultLayer))

// Pay the one-time Windows AppRuntime boot outside the bootstrap-order case budget.
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { AppRuntime } = await import("../../src/effect/app-runtime")
  await AppRuntime.runPromise(Effect.void)
}, 60_000)

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "deepagent-code.json"),
      JSON.stringify({
        $schema: "https://ai.deepagent.ltd/config.schema.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  return { directory: dir, marker }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("instance readiness does not eagerly build Location indexes", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service
    const indexRoot = path.join(Global.Path.cache, "context-indexes")
    const before = existsSync(indexRoot) ? readdirSync(indexRoot).sort() : []

    yield* store.load({ directory: tmp.directory })

    expect(existsSync(indexRoot) ? readdirSync(indexRoot).sort() : []).toEqual(before)
  }),
)

it.live(
  "CLI bootstrap runs InstanceBootstrap before callback",
  () =>
    Effect.gen(function* () {
      const tmp = yield* bootstrapFixture

      yield* Effect.promise(() => bootstrap(tmp.directory, async () => "ok"))

      expect(existsSync(tmp.marker)).toBe(true)
    }),
  15_000,
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      bootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("InstanceStore runs registered recovery lifecycle with the resolved instance context", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service
    const initialized: string[] = []
    const disposed: string[] = []
    const unregisterInitializer = yield* registerInitializer((ctx) => {
      initialized.push(ctx.directory)
      return Promise.resolve()
    })
    const unregisterDisposer = yield* registerDisposer((directory) => {
      disposed.push(directory)
      return Promise.resolve()
    })

    const ctx = yield* store.load({ directory: tmp.directory })
    yield* store.dispose(ctx)
    unregisterInitializer()
    unregisterDisposer()

    expect(initialized).toEqual([tmp.directory])
    expect(disposed).toEqual([tmp.directory])
  }),
)

it.live("a failed recovery initializer is observable but does not brick workspace startup", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service
    const unregister = yield* registerInitializer(() => Promise.reject(new Error("recovery unavailable")))

    const ctx = yield* store.load({ directory: tmp.directory })
    unregister()

    expect(ctx.directory).toBe(tmp.directory)
  }),
)
