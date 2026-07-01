import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Result, Schema } from "effect"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Search } from "@deepagent-code/core/filesystem/search"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Worktree } from "@/worktree"

const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".deepagent-code")])),
})

type RegistryLayerOptions = {
  flags?: Partial<RuntimeFlags.Info>
  plugin?: Layer.Layer<Plugin.Service>
}

const registryLayer = (opts: RegistryLayerOptions = {}) =>
  ToolRegistry.layer
    .pipe(
      // V3.5: debug/profile tools route through DebugService (D1) + RuntimeBase (R0).
      // Provided closest to the base so the merged EventV2Bridge below (applied last)
      // satisfies DebugService's requirement, mirroring ToolRegistry.defaultLayer.
      Layer.provide(DebugService.layer),
      Layer.provide(RuntimeBase.layer),
      Layer.provide(Worktree.defaultLayer),
      Layer.provide(
        Layer.mergeAll(
          configLayer,
          opts.plugin ?? Plugin.defaultLayer,
          Question.defaultLayer,
          Todo.defaultLayer,
          Skill.defaultLayer,
          Agent.defaultLayer,
          Session.defaultLayer,
          SessionStatus.defaultLayer,
          BackgroundJob.defaultLayer,
          Provider.defaultLayer,
          Git.defaultLayer,
          RepositoryCache.defaultLayer,
          Reference.defaultLayer,
          LSP.defaultLayer,
          Instruction.defaultLayer,
          FSUtil.defaultLayer,
          EventV2Bridge.defaultLayer,
          FetchHttpClient.layer,
          Format.defaultLayer,
          node,
          Database.defaultLayer,
          Search.defaultLayer,
          Truncate.defaultLayer,
        ),
      ),
    )
    .pipe(Layer.provide(RuntimeFlags.layer(opts.flags ?? {})))

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const it = testEffect(Layer.mergeAll(registryLayer(), node, Agent.defaultLayer))
// U5: a registry with background subagents explicitly disabled, to assert the task schema hides the
// background param in that mode (the default is now ON).
const itNoBackground = testEffect(
  Layer.mergeAll(registryLayer({ flags: { experimentalBackgroundSubagents: false } }), node, Agent.defaultLayer),
)
const withBrokenPlugin = testEffect(
  Layer.mergeAll(registryLayer({ plugin: brokenPluginLayer }), node, Agent.defaultLayer),
)
// L6: a registry with code_intel explicitly disabled, to assert grep survives and code_intel is gone.
const itNoCodeIntel = testEffect(
  Layer.mergeAll(registryLayer({ flags: { codeIntelTool: false } }), node, Agent.defaultLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("exposes the task background parameter by default (U5: stable local capability)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.make("deepagent-code"),
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      // background subagents are on by default now; the param is part of the live schema (jsonSchema
      // override is undefined so the full Parameters schema — including background — is used).
      expect(task).toBeDefined()
      expect(task?.jsonSchema).toBeUndefined()
    }),
  )

  itNoBackground.instance("hides task background parameter when background subagents are explicitly disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.make("deepagent-code"),
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .deepagent-code/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".deepagent-code")
      const tool = path.join(configDir, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("ignores non-tool exports in .deepagent-code/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".deepagent-code", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression: a single broken custom-tool file (unresolvable import, syntax error)
  // must NOT crash registry initialization / the prompt. Before, the dynamic import
  // rejection became a Die defect inside prompt_async -> silent no-reply (notably in the
  // Electron/Node sidecar, where a `.js` specifier that only resolves under Bun fails).
  // The bad file is logged and skipped; valid sibling tools still load.
  it.instance("skips a broken custom tool file and still loads valid ones", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".deepagent-code", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(path.join(tool, "broken.ts"), 'import { nope } from "@this/does-not-exist"\nexport default nope\n'),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "ok.ts"),
          [
            "export default {",
            "  description: 'ok tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("ok")
      expect(ids).not.toContain("broken")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".deepagent-code", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-deepagent-code` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
    }),
  )

  it.instance("loads tools from .deepagent-code/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".deepagent-code")
      const tools = path.join(configDir, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".deepagent-code", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.make("deepagent-code"),
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const configDir = path.join(test.directory, ".deepagent-code")
        const customTools = path.join(configDir, "tools")
        const plugin = path.join(configDir, "node_modules", "@deepagent-code", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(configDir, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@deepagent-code/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@deepagent-code/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".deepagent-code", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".deepagent-code", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  // M2 (S1-v3.4) acceptance (e): the `tools()` projection must carry provenance
  // through. It previously returned only {id,description,parameters,jsonSchema,execute,
  // formatValidationError}, dropping provenance and forcing request.ts to guess.
  it.instance("tools() projection carries builtin provenance through", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const projected = yield* registry.tools({
        providerID: ProviderV2.ID.make("deepagent-code"),
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const read = projected.find((t) => t.id === "read")
      if (!read) throw new Error("read tool missing from projection")
      expect(read.provenance).toEqual({ source: "builtin" })
    }),
  )

  it.instance("tools() projection marks custom tools as custom provenance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".deepagent-code", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "customprov.ts"),
          [
            "export default {",
            "  description: 'custom prov tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const projected = yield* registry.tools({
        providerID: ProviderV2.ID.make("deepagent-code"),
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const custom = projected.find((t) => t.id === "customprov")
      if (!custom) throw new Error("custom tool missing from projection")
      expect(custom.provenance).toEqual({ source: "custom" })
    }),
  )

  // L6 (S1-v3.4): code_intel is promoted out of the experimental gate and is visible by default;
  // grep is never disabled. `codeIntelTool=false` removes code_intel but leaves grep intact.
  it.instance("L6: code_intel is visible by default and grep is always present", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("code_intel")
      expect(ids).toContain("grep")
    }),
  )

  itNoCodeIntel.instance("L6: codeIntelTool=false hides code_intel but keeps grep", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("code_intel")
      expect(ids).toContain("grep")
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const configDir = path.join(test.directory, ".deepagent-code")
      const tools = path.join(configDir, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(configDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@deepagent-code/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(configDir, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@deepagent-code/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(configDir, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})
