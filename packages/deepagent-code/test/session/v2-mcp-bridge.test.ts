import { describe, expect, test } from "bun:test"
import { jsonSchema } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from "effect"
import { ToolCallID, ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { EventV2 } from "@deepagent-code/core/event"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { V2McpBridge } from "@/session/v2-mcp-bridge"
import { InstanceRegistry } from "@/effect/instance-registry"
import { MCP } from "@/mcp"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ToolProvenance } from "@/tool/provenance"
import type { InstanceContext } from "@/project/instance-context"

const instance: InstanceContext = {
  directory: "/fixture/project",
  worktree: "/fixture/project",
  project: { id: "/fixture/project" },
} as InstanceContext

const settleContext = {
  sessionID: SessionSchema.ID.make("ses_" + "a".repeat(64)),
  agent: AgentV2.ID.make("default"),
  assistantMessageID: SessionMessage.ID.create(),
  toolCallID: "call_mcp",
} satisfies Tool.Context

const settle = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const entry = applications.entries().get(name)
    if (!entry) return yield* Effect.die(`tool not registered: ${name}`)
    return yield* Tool.settle(entry.tool, { type: "tool-call" as const, id: ToolCallID.make("call_9"), name, input }, settleContext)
  })

function waitFor(condition: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not reached in time"))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe("V2McpBridge abort parity", () => {
  const runtime = (tools: Record<string, unknown>, listeners = new Set<EventV2.Listener>()) => {
    for (const [key, item] of Object.entries(tools)) {
      const [server, name] = key.split(":")
      if (server && name)
        ToolProvenance.set(item as Parameters<typeof ToolProvenance.set>[0], {
          source: "mcp",
          mcpServer: server,
          mcpToolName: name,
        })
    }
    return ManagedRuntime.make(
      Layer.mergeAll(
        ApplicationTools.layer,
        InstanceRegistry.layer,
        V2McpBridge.layer.pipe(
          Layer.provide(ApplicationTools.layer),
          Layer.provide(InstanceRegistry.layer),
          Layer.provide(
            Layer.succeed(
              EventV2Bridge.Service,
              EventV2Bridge.Service.of({
                listen: (listener: EventV2.Listener) =>
                  Effect.sync(() => {
                    listeners.add(listener)
                    return Effect.sync(() => {
                      listeners.delete(listener)
                    })
                  }),
              } as unknown as EventV2.Interface),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              MCP.Service,
              MCP.Service.of({
                status: () => Effect.die("unused"),
                clients: () => Effect.die("unused"),
                tools: () => Effect.succeed(tools as never),
                prompts: () => Effect.die("unused"),
                resources: () => Effect.die("unused"),
                add: () => Effect.die("unused"),
                connect: () => Effect.die("unused"),
                disconnect: () => Effect.die("unused"),
                getPrompt: () => Effect.die("unused"),
                readResource: () => Effect.die("unused"),
                startAuth: () => Effect.die("unused"),
                authenticate: () => Effect.die("unused"),
                finishAuth: () => Effect.die("unused"),
                removeAuth: () => Effect.die("unused"),
                supportsOAuth: () => Effect.die("unused"),
                hasStoredTokens: () => Effect.die("unused"),
                getAuthStatus: () => Effect.die("unused"),
                catalog: () => Effect.succeed([]),
                enableCatalogEntry: () => Effect.die("unused"),
              }),
            ),
          ),
        ),
      ),
    )
  }

  test("registering settles an MCP tool result as model-visible text", async () => {
    const rt = runtime({
      "demo:echo": {
        description: "echoes",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ content: [{ type: "text", text: "mcp says hi" }] }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const output = await rt.runPromise(settle("mcp__demo__echo", { q: "hi" }))
      expect(output.content[0]).toEqual({ type: "text", text: "mcp says hi" })
    } finally {
      await rt.dispose()
    }
  })

  test("interrupting the settle fiber aborts the MCP tool call through its abortSignal", async () => {
    const state = { started: false, aborted: false }
    const rt = runtime({
      "demo:slow": {
        description: "never resolves on its own",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: (args: unknown, options: { abortSignal?: AbortSignal }) =>
          new Promise((resolve) => {
            state.started = true
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                state.aborted = true
                resolve({ content: [{ type: "text", text: "aborted" }] })
              },
              { once: true },
            )
          }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const interrupted = await rt.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(settle("mcp__demo__slow", { q: "hi" }))
          yield* Effect.promise(() => waitFor(() => state.started, 1_000))
          return yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"))
        }),
      )
      expect(Option.isSome(interrupted)).toBe(true)
      expect(state.aborted).toBe(true)
    } finally {
      await rt.dispose()
    }
  })

  test("a failing MCP tool call settles as a typed ToolFailure, never a die", async () => {
    const rt = runtime({
      "demo:broken": {
        description: "always throws",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          throw new Error("transport exploded")
        },
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const exit = await rt.runPromiseExit(settle("mcp__demo__broken", {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasDies(exit.cause)).toBe(false)
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error instanceof ToolFailure).toBe(true)
      expect((error as ToolFailure).message).toContain("demo:broken")
    } finally {
      await rt.dispose()
    }
  })

  test("refreshes the next tool snapshot across disconnect and reconnect", async () => {
    const listeners = new Set<EventV2.Listener>()
    let connected = true
    const tools: Record<string, unknown> = {
      "demo:echo": {
        description: "echoes",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          if (!connected) throw new Error("transport disconnected")
          return { content: [{ type: "text", text: "first connection" }] }
        },
      },
    }
    const rt = runtime(tools, listeners)
    const changed = {
      type: MCP.ToolsChanged.type,
      data: { server: "demo" },
      location: { directory: instance.directory },
    } as unknown as EventV2.Payload
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const entries = () =>
        rt.runPromise(ApplicationTools.Service.use((applications) => Effect.sync(() => applications.entries())))
      expect(Tool.permission((await entries()).get("mcp__demo__echo")!.tool, "mcp__demo__echo")).toBe("mcp")
      connected = false
      const failed = await rt.runPromiseExit(settle("mcp__demo__echo", {}))
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed))
        expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toBeInstanceOf(ToolFailure)

      delete tools["demo:echo"]
      await rt.runPromise(Effect.forEach([...listeners], (listener) => listener(changed), { discard: true }))
      expect((await entries()).has("mcp__demo__echo")).toBe(false)

      tools["demo:echo"] = {
        description: "echoes after reconnect",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ content: [{ type: "text", text: "reconnected" }] }),
      }
      ToolProvenance.set(tools["demo:echo"] as Parameters<typeof ToolProvenance.set>[0], {
        source: "mcp",
        mcpServer: "demo",
        mcpToolName: "echo",
      })
      await rt.runPromise(Effect.forEach([...listeners], (listener) => listener(changed), { discard: true }))
      expect(Tool.permission((await entries()).get("mcp__demo__echo")!.tool, "mcp__demo__echo")).toBe("mcp")
      expect((await rt.runPromise(settle("mcp__demo__echo", {}))).content[0]).toEqual({
        type: "text",
        text: "reconnected",
      })
      await rt.runPromise(InstanceRegistry.disposeInstanceState(instance))
      expect((await entries()).has("mcp__demo__echo")).toBe(false)
      expect(listeners.size).toBe(0)
    } finally {
      await rt.dispose()
    }
  })
})
