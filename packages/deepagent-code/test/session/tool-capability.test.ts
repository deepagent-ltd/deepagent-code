import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { SessionToolCapability } from "@/session/tool-capability"
import { ToolRegistry } from "@/tool/registry"
import { testEffect } from "../lib/effect"

const registry = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({
    ids: () => Effect.succeed(["custom_writer"]),
    all: () =>
      Effect.succeed([
        {
          id: "custom_writer",
          description: "custom writer",
          parameters: Schema.Unknown,
          provenance: { source: "custom" as const },
          execute: () => Effect.die("unused"),
        },
      ]),
    named: () => Effect.die("unused"),
    tools: () => Effect.die("unused"),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unused"),
    authenticate: () => Effect.die("unused"),
    finishAuth: () => Effect.die("unused"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated"),
    catalog: () => Effect.succeed([]),
    enableCatalogEntry: () => Effect.die("unused"),
  }),
)

const plugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (_name, _input, output) => Effect.succeed(output),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
)

const it = testEffect(Layer.mergeAll(registry, mcp, plugin))

it.effect("freezes custom tools as host-enforced permission boundaries", () =>
  Effect.gen(function* () {
    const first = yield* SessionToolCapability.snapshot()
    const second = yield* SessionToolCapability.snapshot()

    expect(first.tools).toEqual([
      {
        toolID: "custom_writer",
        source: "custom",
        definitionHash: expect.any(String),
        workspaceMutation: "possible",
        permissionKeys: ["custom_writer"],
        hostEnforced: true,
        evidence: "custom:custom_writer:host_permission",
      },
    ])
    expect(first.hash).toBe(second.hash)
  }),
)
