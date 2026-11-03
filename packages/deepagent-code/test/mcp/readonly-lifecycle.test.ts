import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"

if (process.platform === "win32") await import("../fixture/source-empty-settings-preload")
const { testEffect } = await import("../lib/effect")
const { TestInstance, tmpdir } = await import("../fixture/fixture")
const { configWatch, publicEndpoint, refreshRotation } = await import("./fixture/readonly-lifecycle")
const { Config } = await import("../../src/config/config")
const { MCP } = await import("../../src/mcp/index")
const { McpAuthScope } = await import("../../src/mcp/auth-scope")
const { McpAuthJournalSchema } = await import("../../src/mcp/auth-journal-schema")
const { McpReadModel } = await import("../../src/mcp/read-model")
const { SecretStore } = await import("../../src/mcp/secret-store")
const { AppRuntime } = await import("../../src/effect/app-runtime")
const { InstanceStore } = await import("../../src/project/instance-store")
const { InstanceRef } = await import("../../src/effect/instance-ref")

const it = testEffect(Layer.mergeAll(MCP.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer))
const state: { cohort?: Awaited<ReturnType<typeof import("../fixture/windows-native-node-cohort").build>> } = {}

beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native readonly lifecycle tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  const { build } = await import("../fixture/windows-native-node-cohort")
  state.cohort = await build({
    directory: await fs.mkdtemp(path.join(runner, "dac-readonly-lifecycle-build-")),
    nodeEntry: path.resolve(import.meta.dir, "fixture/windows-native-readonly-lifecycle-host.ts"),
  })
}, 240_000)

afterAll(async () => {
  await state.cohort?.dispose()
})

async function runNative(mode: "config-watch" | "public-endpoint" | "refresh-rotation") {
  const result = await state.cohort!.run(mode)
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
  const evidence = JSON.parse(await fs.readFile(path.join(result.root, "readonly-lifecycle.json"), "utf8"))
  expect(evidence).toMatchObject({ mode, nativePreloaded: true, nativeCurrent: true })
  console.info("WINDOWS_READONLY_LIFECYCLE_EVIDENCE", result.root)
}

if (process.platform === "win32")
  test(
    "actual config watch fences a pending scope without OAuth, secret migration or journal writes",
    () => runNative("config-watch"),
    300_000,
  )
if (process.platform !== "win32")
  it.instance(
    "actual config watch fences a pending scope without OAuth, secret migration or journal writes",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        yield* configWatch(instance.directory)
      }),
    { config: { mcp: {} } },
  )

if (process.platform === "win32")
  test(
    "OAuth-optional public endpoints stay idle on reads and connect only on an explicit action",
    () => runNative("public-endpoint"),
    300_000,
  )
if (process.platform !== "win32")
  it.instance(
    "OAuth-optional public endpoints stay idle on reads and connect only on an explicit action",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        yield* publicEndpoint(instance.directory)
      }),
    { config: { mcp: {} } },
  )

if (process.platform === "win32")
  test(
    "actual SDK refresh rotates each credential revision once and an unknown later refresh blocks reconnect",
    () => runNative("refresh-rotation"),
    300_000,
  )
if (process.platform !== "win32")
  it.instance(
    "actual SDK refresh rotates each credential revision once and an unknown later refresh blocks reconnect",
    () => refreshRotation(),
    { config: { mcp: {} } },
  )

test(
  "readonly deduplication keeps observed freshness and cold/command/unsafe boundaries",
  async () => {
    await using directory = await tmpdir({ config: { mcp: {} } })
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const instances = yield* InstanceStore.Service
        yield* instances.load({ directory: directory.path })
        const configuration = yield* Config.Service
        const calls = { snapshot: 0 }
        const controlled = {
          ...configuration,
          readonlySnapshot: () =>
            Effect.gen(function* () {
              calls.snapshot++
              return yield* Effect.die(new Error("full command observation must only run when consumed"))
            }),
        }
        const services = yield* Layer.build(Layer.fresh(McpReadModel.layer)).pipe(
          Effect.provideService(Config.Service, controlled),
        )
        const read = Context.get(services, McpReadModel.Service)
        expect(yield* read.status({ directory: directory.path })).toEqual({})
        expect(yield* read.resources({ directory: directory.path })).toEqual({})
        expect(calls.snapshot).toBe(0)
        expect((yield* read.commands({ directory: directory.path }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(calls.snapshot).toBe(1)
        const coldServices = yield* Layer.build(Layer.fresh(McpReadModel.layer)).pipe(
          Effect.provideService(Config.Service, controlled),
          Effect.provideService(InstanceStore.Service, { ...instances, peek: () => Effect.succeed(undefined) }),
        )
        const cold = Context.get(coldServices, McpReadModel.Service)
        expect((yield* cold.status({ directory: directory.path }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(calls.snapshot).toBe(2)
        expect(yield* cold.resources({ directory: directory.path })).toEqual({})
        expect(calls.snapshot).toBe(2)
        expect((yield* read.status({ directory: path.parse(directory.path).root }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        expect(
          (yield* read
            .status({ directory: directory.path, workspaceID: WorkspaceV2.ID.make("wrk_readonly_fixture") })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect(calls.snapshot).toBe(2)
        yield* instances.disposeDirectory(directory.path)
      }).pipe(Effect.scoped),
    )
  },
  process.platform === "linux" ? 15_000 : 60_000,
)

test("readonly deduplication reuses only successful scope-change metadata and preserves failure retry and unknown", async () => {
  await using directory = await tmpdir({ config: { mcp: {} } })
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      const instance = yield* instances.load({ directory: directory.path })
      const configuration = yield* Config.Service
      const view: { snapshot: import("../../src/config/config").McpSnapshot } = {
        snapshot: { config: { mcp: {} }, source: "before" },
      }
      const reads = { count: 0, mode: "success" }
      const metadata = () =>
        Effect.suspend(() => {
          reads.count++
          return reads.mode === "failed" || (reads.mode === "recover" && reads.count === 1)
            ? Effect.fail(new McpAuthJournalSchema.Error("unavailable"))
            : Effect.succeed({ tokens: false, expired: false, unknown: reads.mode === "unknown", legacy: false })
        })
      const services = yield* Layer.build(
        Layer.fresh(MCP.layer).pipe(
          Layer.provide(SecretStore.defaultLayer),
          Layer.provide(CrossSpawnSpawner.defaultLayer),
          Layer.provide(
            Layer.succeed(
              McpAuthScope.Service,
              McpAuthScope.Service.of({
                configure: () => Effect.void,
                retire: () => Effect.void,
                begin: () => Effect.die("readonly fixture must not begin OAuth"),
                metadata,
                metadataAt: metadata,
                remove: () => Effect.die("readonly fixture must not remove credentials"),
              }),
            ),
          ),
        ),
      ).pipe(
        Effect.provideService(Config.Service, {
          ...configuration,
          mcpSnapshot: () => Effect.succeed(view.snapshot),
        }),
      )
      const mcp = Context.get(services, MCP.Service)
      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(InstanceRef, instance))
      yield* run(mcp.reconcileConfig!())
      view.snapshot = {
        config: { mcp: { fixture: { type: "remote", url: "http://127.0.0.1:9/mcp" } } },
        source: "after",
      }
      yield* run(mcp.reconcileConfig!())
      reads.count = 0
      expect((yield* run(mcp.status())).fixture).toEqual({
        status: "disconnected",
        authStatus: "not_authenticated",
        reason: "scope_changed",
      })
      expect(reads.count).toBe(1)
      reads.count = 0
      reads.mode = "unknown"
      expect((yield* run(mcp.status())).fixture).toEqual({
        status: "disconnected",
        authStatus: "unknown",
        reason: "unknown_outcome",
      })
      expect(reads.count).toBe(1)
      reads.count = 0
      reads.mode = "recover"
      expect((yield* run(mcp.status())).fixture).toEqual({
        status: "disconnected",
        authStatus: "not_authenticated",
        reason: "scope_changed",
      })
      expect(reads.count).toBe(2)
      reads.count = 0
      reads.mode = "failed"
      expect((yield* run(mcp.status())).fixture).toEqual({
        status: "failed",
        error: "MCP authentication storage or scope is unavailable",
      })
      expect(reads.count).toBe(2)
      yield* instances.disposeDirectory(directory.path)
    }).pipe(Effect.scoped),
  )
}, 15000)
