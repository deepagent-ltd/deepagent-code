import fs from "fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Context, Effect, Layer, RcMap, Schema } from "effect"
import { Tool } from "@deepagent-code/core/public"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Catalog } from "@deepagent-code/core/catalog"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PluginBoot } from "@deepagent-code/core/plugin/boot"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Location } from "@deepagent-code/core/location"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { tmpRoot, tmpdir, tmpRootShared } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Auth } from "../src/auth"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { ProjectReference } from "../src/project-reference"
import { LocationSearch } from "../src/location-search"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { Flag } from "../src/flag/flag"
import { BuiltInTools } from "../src/tool/builtins"

const applicationTools = ApplicationTools.layer
const it = testEffect(
  Layer.merge(
    applicationTools,
    LocationServiceMap.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Auth.defaultLayer,
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

describe("LocationServiceMap", () => {
  // ModelsDevPlugin.refresh() calls modelsDev.get() which acquires a cross-process
  // Flock on models.json. On a developer machine where the main app holds that lock,
  // PluginBoot.wait() never returns. Disable the models fetch for this test file so
  // boot completes instantly without any network or file-locking. Same pattern as
  // packages/core/test/models.test.ts.
  const ORIGINAL_DISABLE_FETCH = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
  const ORIGINAL_DATABASE = Flag.DEEPAGENT_CODE_DB
  const ORIGINAL_TEST_HOME = process.env.DEEPAGENT_CODE_TEST_HOME
  const ORIGINAL_DISABLE_DEFAULT_PLUGINS = process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS
  const testHome = mkdtempSync(tmpRootShared())
  beforeAll(() => {
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
    Flag.DEEPAGENT_CODE_DB = ":memory:"
    // Isolate the Global roots: the default layer otherwise resolves the real ~/.deepagent/code
    // and dies on any real user config field the V2 fail-closed contract rejects (config.ts).
    process.env.DEEPAGENT_CODE_TEST_HOME = testHome
    process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = "1"
  })
  afterAll(() => {
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
    Flag.DEEPAGENT_CODE_DB = ORIGINAL_DATABASE
    if (ORIGINAL_TEST_HOME === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
    if (ORIGINAL_TEST_HOME !== undefined) process.env.DEEPAGENT_CODE_TEST_HOME = ORIGINAL_TEST_HOME
    if (ORIGINAL_DISABLE_DEFAULT_PLUGINS === undefined) delete process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS
    if (ORIGINAL_DISABLE_DEFAULT_PLUGINS !== undefined)
      process.env.DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS = ORIGINAL_DISABLE_DEFAULT_PLUGINS
    rmSync(testHome, { recursive: true, force: true })
  })

  it.live(
    "reuses semantic Location identity across SQL-shaped refs and invalidates the same tree",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        (dirs) =>
          Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
      ).pipe(
        Effect.flatMap(([first, second]) =>
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap
            const directory = AbsolutePath.make(first.path)
            const ref = { directory }
            const sqlRef = { directory, workspaceID: undefined }
            const read = (ref: Location.Ref) => AgentV2.Service.pipe(Effect.provide(locations.get(ref)), Effect.scoped)
            const original = yield* read(ref)
            expect(yield* read(sqlRef)).toBe(original)
            expect(yield* read({ ...ref })).toBe(original)
            const mutable = { directory }
            const captured = locations.get(mutable)
            mutable.directory = AbsolutePath.make(second.path)
            expect(yield* AgentV2.Service.pipe(Effect.provide(captured), Effect.scoped)).toBe(original)
            expect(yield* Effect.all([read(ref), read(sqlRef)], { concurrency: "unbounded" })).toEqual([
              original,
              original,
            ])
            expect(
              yield* locations.contextEffect(sqlRef).pipe(
                Effect.map((context) => Context.get(context, AgentV2.Service)),
                Effect.scoped,
              ),
            ).toBe(original)
            expect(yield* AgentV2.Service.pipe(Effect.provide(LocationServiceMap.get(sqlRef)), Effect.scoped)).toBe(
              original,
            )
            expect(yield* read({ directory: AbsolutePath.make(second.path) })).not.toBe(original)
            const workspaceID = WorkspaceV2.ID.make("wrk_location_map_first")
            const explicit = yield* read({ directory, workspaceID })
            expect(explicit).not.toBe(original)
            expect(yield* read({ workspaceID, directory })).toBe(explicit)
            expect(yield* read({ directory, workspaceID: WorkspaceV2.ID.make("wrk_location_map_second") })).not.toBe(
              explicit,
            )
            const keys = [...(yield* RcMap.keys(locations.rcMap))]
            expect(keys).toHaveLength(4)
            expect(keys.every((key) => Object.isFrozen(key))).toBe(true)
            yield* locations.invalidate(sqlRef)
            const replacement = yield* read(ref)
            expect(replacement).not.toBe(original)
            expect(yield* read(sqlRef)).toBe(replacement)
            expect(yield* read({ directory, workspaceID })).toBe(explicit)
            yield* LocationServiceMap.invalidate(ref)
            expect(yield* read(sqlRef)).not.toBe(replacement)
          }),
        ),
      ),
    15000,
  )

  it.live(
    "isolates location state while sharing location policy with catalog",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        (dirs) =>
          Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
      ).pipe(
        Effect.flatMap(([blocked, allowed]) =>
          Effect.gen(function* () {
            yield* (yield* ApplicationTools.Service).register({
              application_context: Tool.make({
                description: "Read application context",
                input: Schema.Struct({}),
                output: Schema.Struct({ ok: Schema.Boolean }),
                execute: () => Effect.succeed({ ok: true }),
              }),
            })
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(blocked.path, "deepagent-code.json"),
                JSON.stringify({
                  experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
                }),
              ),
            )

            const update = (directory: string) =>
              Effect.gen(function* () {
                yield* PluginBoot.Service.use((boot) => boot.wait())
                yield* ProjectReference.Service
                yield* LocationSearch.Service
                const catalog = yield* Catalog.Service
                const agents = yield* AgentV2.Service
                const tools = yield* ToolRegistry.Service
                const transform = yield* catalog.transform()
                yield* transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
                return {
                  providers: yield* catalog.provider.all(),
                  tools: yield* toolDefinitions(tools),
                  researcherTools: yield* tools
                    .materialize((yield* agents.get(AgentV2.ID.make("researcher")))?.permissions)
                    .pipe(Effect.map((tools) => tools.definitions.map((tool) => tool.name).sort())),
                }
              }).pipe(
                Effect.scoped,
                Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(directory) })),
              )

            const blockedState = yield* update(blocked.path)
            expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
            const expectedTools = [
              "application_context",
              // This Core fixture has neither BrowserHost nor the graph runtime.
              ...[...BuiltInTools.builtinToolNames].filter(
                (name) => name !== "browser" && name !== "code_intel" && name !== "context_query",
              ),
            ].sort()
            expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
            expect(blockedState.tools.some((tool) => tool.name === "browser")).toBe(false)
            expect(blockedState.researcherTools).toEqual(["glob", "grep", "read", "webfetch", "websearch"])
            const allowedState = yield* update(allowed.path)
            // The V1 default-plugin kill switch must not remove the Core models-dev catalog producer.
            expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("deepagent"))).toBe(
              true,
            )
            expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
            expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
            expect(allowedState.tools.some((tool) => tool.name === "browser")).toBe(false)
            expect(allowedState.researcherTools).toEqual(["glob", "grep", "read", "webfetch", "websearch"])
          }),
        ),
      ),
    15000,
  )
})
