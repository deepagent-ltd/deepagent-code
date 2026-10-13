import { describe, expect } from "bun:test"
import { Tool } from "@deepagent-code/core/public"
import { settle } from "@deepagent-code/core/tool/tool"
import { ToolCallID } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Location } from "@deepagent-code/core/location"
import { Project } from "@deepagent-code/core/project"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { Tools } from "@deepagent-code/core/tool/tools"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"

const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.void,
})
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const it = testEffect(Layer.mergeAll(applications, registry))

const sessionID = SessionV2.ID.make("ses_application_tool")
const agent = AgentV2.ID.make("build")
const assistantMessageID = SessionMessage.ID.make("msg_application_tool")
const contextual = (contexts: Tool.Context[]) =>
  Tool.make({
    description: "Read application context",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.Struct({ answer: Schema.String }),
    execute: ({ query }, context) =>
      Effect.sync(() => {
        contexts.push(context)
        return { answer: query.toUpperCase() }
      }),
    toModelOutput: ({ output }) => [
      { type: "text", text: output.answer },
      { type: "file", data: "aGVsbG8=", mime: "image/png", name: "result.png" },
    ],
  })

describe("ApplicationTools", () => {
  it.effect("materializes and executes independent registries for two Locations", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const contextsA: Tool.Context[] = []
      const contextsB: Tool.Context[] = []
      const a = { directory: AbsolutePath.make("/registry-a") }
      const b = { directory: AbsolutePath.make("/registry-b") }
      yield* applications.register({ same: contextual(contextsA) }, a)
      yield* applications.register({ same: contextual(contextsB) }, b)
      const materializations = yield* Effect.forEach([a, b], (location) =>
        ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
          Effect.provide(
            Layer.fresh(ToolRegistry.layer).pipe(
              Layer.provide(ToolOutputStore.defaultLayer),
              Layer.provide(Layer.succeed(ApplicationTools.Service, applications)),
              Layer.provide(
                Layer.succeed(Location.Service, {
                  ...location,
                  project: { id: Project.ID.make("project-placement"), directory: location.directory },
                }),
              ),
            ),
          ),
        ),
      )
      expect(materializations.map((entry) => entry.registeredIDs)).toEqual([["same"], ["same"]])
      const input = {
        sessionID,
        agent,
        assistantMessageID,
        call: {
          type: "tool-call" as const,
          id: ToolCallID.make("call-location-registry"),
          name: "same",
          input: { query: "ok" },
        },
      }
      yield* materializations[0].settle(input)
      expect(contextsA).toHaveLength(1)
      expect(contextsB).toHaveLength(0)
      yield* materializations[1].settle(input)
      expect(contextsA).toHaveLength(1)
      expect(contextsB).toHaveLength(1)
    }),
  )

  it.effect("isolates same-name application registrations by placement and retains global fallback", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const contextsA: Tool.Context[] = []
      const contextsB: Tool.Context[] = []
      const toolA = contextual(contextsA)
      const toolB = contextual(contextsB)
      const global = contextual([])
      const a = { directory: AbsolutePath.make("/a") }
      const b = { directory: AbsolutePath.make("/b") }
      const scope = yield* Scope.make()
      yield* applications.register({ same: global })
      yield* applications.register({ same: toolA }, a)
      yield* applications.register({ same: toolB }, b).pipe(Scope.provide(scope))
      expect(applications.entries(a).get("same")?.tool).toBe(toolA)
      expect(applications.entries(b).get("same")?.tool).toBe(toolB)
      expect(applications.entries().get("same")?.tool).toBe(global)
      const call = {
        type: "tool-call" as const,
        id: ToolCallID.make("call-placement"),
        name: "same",
        input: { query: "ok" },
      }
      const context = { sessionID, agent, assistantMessageID, toolCallID: call.id }
      yield* settle(applications.entries(a).get("same")!.tool, call, context)
      yield* settle(applications.entries(b).get("same")!.tool, call, context)
      expect(contextsA).toEqual([context])
      expect(contextsB).toEqual([context])
      yield* Scope.close(scope, Exit.void)
      expect(applications.entries(a).get("same")?.tool).toBe(toolA)
      expect(applications.entries(b).get("same")?.tool).toBe(global)
    }),
  )

  it.effect("keeps the Core carrier opaque and executes its single handler", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      const tool = contextual(contexts)
      expect(Object.keys(tool)).toEqual([])

      yield* applications.register({ opaque: tool })
      expect(
        yield* executeTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-opaque", name: "opaque", input: { query: "once" } },
        }),
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "ONCE" },
          { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "result.png" },
        ],
      })
      expect(contexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-opaque" }])
    }),
  )

  it.effect("exposes narrow scoped Location registration and validates names", () =>
    Effect.gen(function* () {
      const tools: Tools.Interface = yield* Tools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* tools.register({ location_tool: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["location_tool"])
      expect(yield* Effect.flip(tools.register({ "invalid name": contextual([]) }))).toBeInstanceOf(
        Tool.RegistrationError,
      )

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("filters an application tool by its name without adding execution authorization", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* applications.register({ application_context: contextual(contexts) })

      expect(
        yield* toolDefinitions(registry, [{ action: "application_context", resource: "*", effect: "deny" }]),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-denied", name: "application_context", input: { query: "hello" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(contexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-denied" }])
    }),
  )

  it.effect("advertises and executes a scoped application tool with Session context", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []

      yield* applications.register({ application_context: contextual(contexts) })

      expect(yield* toolDefinitions(registry)).toMatchObject([
        { name: "application_context", description: "Read application context" },
      ])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-context", name: "application_context", input: { query: "hello" } },
        }),
      ).toEqual({
        result: {
          type: "content",
          value: [
            { type: "text", text: "HELLO" },
            { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "result.png" },
          ],
        },
        output: {
          structured: { answer: "HELLO" },
          content: [
            { type: "text", text: "HELLO" },
            { type: "file", source: { type: "data", data: "aGVsbG8=" }, mime: "image/png", name: "result.png" },
          ],
        },
      })
      expect(contexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-context" }])
    }),
  )

  it.effect("removes an application tool when its registration scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()

      yield* applications.register({ temporary: contextual([]) }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["temporary"])

      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("removes a tool before settling a call produced from an earlier definition", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registrationScope = yield* Scope.make()
      yield* applications.register({ contextual: contextual([]) }).pipe(Scope.provide(registrationScope))
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])

      yield* Scope.close(registrationScope, Exit.void)
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-removed", name: "contextual", input: { query: "hello" } },
        }),
      ).toEqual({ result: { type: "error", value: "Unknown tool: contextual" } })
    }),
  )

  it.effect("does not leak a registration into an already closed scope", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      yield* Scope.close(scope, Exit.void)

      yield* applications.register({ closed: contextual([]) }).pipe(Scope.provide(scope))

      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted application registration until its scope closes", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* applications
        .register({ interrupted: contextual([]) })
        .pipe(
          Effect.andThen(Deferred.succeed(registered, undefined)),
          Effect.andThen(Effect.never),
          Scope.provide(scope),
          Effect.forkChild,
        )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["interrupted"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* toolDefinitions(registry)).toEqual([])
    }),
  )

  it.effect("captures the registered record before later State rebuilds", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const registered = { stable: contextual([]) }
      yield* applications.register(registered)
      Object.assign(registered, { late: contextual([]) })

      yield* Effect.scoped(applications.register({ temporary: contextual([]) }))

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["stable"])
    }),
  )

  it.effect("settles with the current same-name application tool and restores earlier registrations", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const firstContexts: Tool.Context[] = []
      const secondContexts: Tool.Context[] = []
      const scope = yield* Scope.make()
      yield* applications.register({ contextual: contextual(firstContexts) })
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["contextual"])
      yield* applications.register({ contextual: contextual(secondContexts) }).pipe(Scope.provide(scope))

      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-second", name: "contextual", input: { query: "second" } },
      })
      yield* Scope.close(scope, Exit.void)
      yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call-first", name: "contextual", input: { query: "first" } },
      })

      expect(secondContexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-second" }])
      expect(firstContexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-first" }])
    }),
  )

  it.effect("keeps the Location tool when an application tool has the same name", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      const locationContexts: Tool.Context[] = []
      const applicationContexts: Tool.Context[] = []
      const location = contextual(locationContexts)
      yield* registry.register({ shared: location })
      yield* applications.register({ shared: contextual(applicationContexts) })

      expect(
        (yield* toolDefinitions(registry, [{ action: "shared", resource: "*", effect: "deny" }])).map(
          (definition) => definition.name,
        ),
      ).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          agent,
          assistantMessageID,
          call: { type: "tool-call", id: "call-shared", name: "shared", input: { query: "location" } },
        }),
      ).toMatchObject({ result: { type: "content" } })
      expect(locationContexts).toEqual([{ sessionID, agent, assistantMessageID, toolCallID: "call-shared" }])
      expect(applicationContexts).toEqual([])
    }),
  )

  it.effect("bounds application tool names and per-name overlays", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      yield* applications.register(
        Object.fromEntries(
          Array.from({ length: ApplicationTools.MAX_APPLICATION_TOOL_NAMES }, (_, index) => [
            `tool_${index}`,
            contextual([]),
          ]),
        ),
      )
      expect(yield* Effect.flip(applications.register({ overflow: contextual([]) }))).toMatchObject({
        _tag: "Tool.RegistrationError",
      })

      for (let index = 1; index < ApplicationTools.MAX_TOOL_OVERLAYS_PER_NAME; index++)
        yield* applications.register({ tool_0: contextual([]) })
      expect(yield* Effect.flip(applications.register({ tool_0: contextual([]) }))).toMatchObject({
        _tag: "Tool.RegistrationError",
      })
    }),
  )
})
