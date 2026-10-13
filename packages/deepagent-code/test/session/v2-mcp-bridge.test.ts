import { describe, expect, test } from "bun:test"
import { jsonSchema } from "ai"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from "effect"
import { ToolCallID, ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionStore } from "@deepagent-code/core/session/store"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
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

const location = Location.Service.of({
  directory: AbsolutePath.make(instance.directory),
  project: { id: Project.ID.global, directory: AbsolutePath.make(instance.directory) },
})
const session = new SessionSchema.Info({
  id: settleContext.sessionID,
  projectID: Project.ID.global,
  permissions: [],
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  title: "MCP fixture",
  location: { directory: location.directory },
})

const settle = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const entry = applications.entries({ directory: location.directory }).get(name)
    if (!entry) return yield* Effect.die(`tool not registered: ${name}`)
    return yield* Tool.settle(
      entry.tool,
      { type: "tool-call" as const, id: ToolCallID.make(settleContext.toolCallID), name, input },
      settleContext,
    )
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
  const runtime = (
    tools: Record<string, unknown>,
    listeners = new Set<EventV2.Listener>(),
    options: {
      authority?: boolean
      assert?: PermissionV2.Interface["assert"]
      location?: Location.Interface
      session?: SessionSchema.Info
      getSession?: SessionStore.Interface["get"]
    } = {},
  ) => {
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
        options.authority === false
          ? Layer.empty
          : Layer.mergeAll(
              Layer.mock(PermissionV2.Service, { assert: options.assert ?? (() => Effect.void) }),
              Layer.succeed(Location.Service, options.location ?? location),
              Layer.mock(SessionStore.Service, {
                get: options.getSession ?? (() => Effect.succeed(options.session ?? session)),
              }),
            ),
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

  test("asserts the canonical call identity before the MCP side effect", async () => {
    const order: string[] = []
    const rt = runtime(
      {
        "demo:echo": {
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            order.push("execute")
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      },
      undefined,
      {
        assert: (input) =>
          Effect.sync(() => {
            expect(input).toEqual({
              action: "mcp",
              resources: ["demo:echo"],
              metadata: { server: "demo", tool: "echo" },
              source: { type: "tool", messageID: settleContext.assistantMessageID, callID: settleContext.toolCallID },
              sessionID: settleContext.sessionID,
              agent: settleContext.agent,
            })
            order.push("assert")
          }),
      },
    )
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      await rt.runPromise(settle("mcp__demo__echo", {}))
      expect(order).toEqual(["assert", "execute"])
    } finally {
      await rt.dispose()
    }
  })

  test.each([
    ["missing authority", { authority: false }],
    ["different Location", { location: { ...location, directory: AbsolutePath.make("/other") } }],
    [
      "different Session placement",
      { session: new SessionSchema.Info({ ...session, location: { directory: AbsolutePath.make("/other") } }) },
    ],
    ["explicit workspace", { location: { ...location, workspaceID: WorkspaceV2.ID.make("wrk_fixture") } }],
  ])("rejects %s without executing MCP", async (_, options) => {
    const state = { calls: 0 }
    const rt = runtime(
      {
        "demo:echo": {
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            state.calls++
            return { content: [] }
          },
        },
      },
      undefined,
      options,
    )
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const exit = await rt.runPromiseExit(settle("mcp__demo__echo", {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(state.calls).toBe(0)
    } finally {
      await rt.dispose()
    }
  })

  test.each([new PermissionV2.RejectedError(), new PermissionV2.CorrectedError({ feedback: "wrong target" })])(
    "permission refusal remains typed and does not execute MCP: %s",
    async (error) => {
      const state = { calls: 0 }
      const rt = runtime(
        {
          "demo:echo": {
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => {
              state.calls++
              return { content: [] }
            },
          },
        },
        undefined,
        { assert: () => Effect.fail(error) },
      )
      try {
        await rt.runPromise(InstanceRegistry.initializeInstance(instance))
        const exit = await rt.runPromiseExit(settle("mcp__demo__echo", {}))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false)
          const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause))
          expect(failure).toBeInstanceOf(ToolFailure)
          expect((failure as ToolFailure).metadata?.failureCode).toBe(PermissionV2.permissionFailureCode(error))
        }
        expect(state.calls).toBe(0)
      } finally {
        await rt.dispose()
      }
    },
  )

  test("cancelling while permission is pending never calls the MCP body", async () => {
    const state = { waiting: false, calls: 0 }
    const rt = runtime(
      {
        "demo:echo": {
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            state.calls++
            return { content: [] }
          },
        },
      },
      undefined,
      {
        assert: () =>
          Effect.sync(() => {
            state.waiting = true
          }).pipe(Effect.andThen(Effect.never)),
      },
    )
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const exit = await rt.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(settle("mcp__demo__echo", {}))
          yield* Effect.promise(() => waitFor(() => state.waiting, 1000))
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(state.calls).toBe(0)
    } finally {
      await rt.dispose()
    }
  })

  test("preserves text and screenshot as separate native model content", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
    const rt = runtime({
      "demo:screenshot": {
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({
          content: [
            { type: "text", text: "page observed" },
            { type: "image", data: png, mimeType: "image/png" },
          ],
        }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const output = await rt.runPromise(settle("mcp__demo__screenshot", {}))
      expect(output.content).toEqual([
        { type: "text", text: "page observed" },
        { type: "file", source: { type: "data", data: png }, mime: "image/png" },
      ])
      expect(
        output.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).not.toContain(png)
    } finally {
      await rt.dispose()
    }
  })

  test("revalidates Session placement after permission before dispatch", async () => {
    const state = { moved: false, calls: 0 }
    const rt = runtime(
      {
        "demo:echo": {
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            state.calls++
            return { content: [] }
          },
        },
      },
      undefined,
      {
        getSession: () =>
          Effect.succeed(
            state.moved
              ? new SessionSchema.Info({ ...session, location: { directory: AbsolutePath.make("/moved") } })
              : session,
          ),
        assert: () =>
          Effect.sync(() => {
            state.moved = true
          }),
      },
    )
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      expect(Exit.isFailure(await rt.runPromiseExit(settle("mcp__demo__echo", {})))).toBe(true)
      expect(state.calls).toBe(0)
    } finally {
      await rt.dispose()
    }
  })

  test("preserves structured content alongside text and does not dereference resource links", async () => {
    const rt = runtime({
      "demo:result": {
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({
          content: [
            { type: "text", text: "summary" },
            {
              type: "resource_link",
              name: "evidence",
              uri: "https://example.invalid/evidence",
              description: "read separately",
            },
          ],
          structuredContent: { status: "failed", evidence: "report-1" },
        }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const output = await rt.runPromise(settle("mcp__demo__result", {}))
      const text = output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      expect(text).toContain('"status":"failed"')
      expect(text).toContain("https://example.invalid/evidence")
      expect(text).toContain("read separately")
      expect(output.structured).toMatchObject({ structuredContent: { status: "failed", evidence: "report-1" } })
    } finally {
      await rt.dispose()
    }
  })

  test("does not duplicate a structured result already present as exact JSON text", async () => {
    const rt = runtime({
      "demo:result": {
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({
          content: [{ type: "text", text: ' {"status":"ok"} ' }],
          structuredContent: { status: "ok" },
        }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const output = await rt.runPromise(settle("mcp__demo__result", {}))
      expect(output.content).toEqual([{ type: "text", text: ' {"status":"ok"} ' }])
      expect(output.structured).toMatchObject({ structuredContent: { status: "ok" } })
    } finally {
      await rt.dispose()
    }
  })

  test("preserves embedded resource images as native files", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
    const rt = runtime({
      "demo:resource": {
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({
          content: [
            {
              type: "resource",
              resource: {
                uri: "fixture://image",
                mimeType: "image/png",
                blob: png,
              },
            },
          ],
        }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const output = await rt.runPromise(settle("mcp__demo__resource", {}))
      expect(output.content).toContainEqual({ type: "file", source: { type: "data", data: png }, mime: "image/png" })
      expect(output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")).not.toContain(png)
    } finally {
      await rt.dispose()
    }
  })

  test.each([
    { content: [{ type: "image", data: "%%%", mimeType: "image/png" }] },
    { content: [{ type: "image", data: "AAAA", mimeType: "image/svg+xml" }] },
    { content: [{ type: "image", data: "AAAA".repeat(2 * 1024 * 1024), mimeType: "image/png" }] },
    { content: Array.from({ length: 9 }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" })) },
    { content: [{ type: "image", data: "AAAA" }] },
  ])("invalid or oversized images fail as typed tool errors", async (value) => {
    const rt = runtime({
      "demo:image": {
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => value,
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const exit = await rt.runPromiseExit(settle("mcp__demo__image", {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ToolFailure)
      }
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
      expect((error as ToolFailure).metadata).toMatchObject({ effectOutcome: "unknown" })
    } finally {
      await rt.dispose()
    }
  })

  test("an MCP isError result settles as a typed tool failure", async () => {
    const rt = runtime({
      "demo:failure": {
        description: "returns a protocol error",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ isError: true, content: [{ type: "text", text: "MCP_FIXTURE_FAILURE" }] }),
      },
    })
    try {
      await rt.runPromise(InstanceRegistry.initializeInstance(instance))
      const exit = await rt.runPromiseExit(settle("mcp__demo__failure", {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasDies(exit.cause)).toBe(false)
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error instanceof ToolFailure).toBe(true)
      expect((error as ToolFailure).message).toContain("MCP_FIXTURE_FAILURE")
      expect((error as ToolFailure).metadata?.effectOutcome).not.toBe("unknown")
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
        rt.runPromise(
          ApplicationTools.Service.use((applications) =>
            Effect.sync(() => applications.entries({ directory: location.directory })),
          ),
        )
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
