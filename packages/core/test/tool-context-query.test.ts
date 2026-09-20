import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { ContextQueryTools } from "@deepagent-code/core/tool/context-query-tools"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { testEffect } from "./lib/effect"

const assertions: PermissionV2.AssertInput[] = []
const calls: Array<{ readonly tool: string; readonly intent: string; readonly sessionID: string }> = []

const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) =>
    Effect.sync(() => {
      assertions.push(input)
    }),
})
const runtime = Layer.succeed(
  ContextToolRuntime.Service,
  ContextToolRuntime.Service.of({
    available: true,
    codeIntel: (input) =>
      Effect.sync(() => {
        calls.push({ tool: "code_intel", intent: input.request.intent, sessionID: input.sessionID })
        return JSON.stringify({ schemaVersion: 2, summary: "code result" })
      }),
    contextQuery: (input) =>
      Effect.sync(() => {
        calls.push({ tool: "context_query", intent: input.request.intent, sessionID: input.sessionID })
        return JSON.stringify({ schemaVersion: 1, summary: "context result" })
      }),
  }),
)
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input: ToolOutputStore.BoundInput) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))
const tools = ContextQueryTools.layer.pipe(
  Layer.provide(ContextToolRuntime.seam),
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(runtime),
)
const it = testEffect(Layer.mergeAll(registry, permission, runtime, tools))
const sessionID = SessionV2.ID.make("ses_context_tools")
const agent = AgentV2.ID.make("researcher")

beforeEach(() => {
  assertions.length = 0
  calls.length = 0
})

const settle = (name: string, input: unknown) =>
  ToolRegistry.Service.use((registry) =>
    Effect.flatMap(registry.materialize(), (materialized) =>
      materialized.settle({
        sessionID,
        agent,
        assistantMessageID: SessionMessage.ID.make("msg_context_tools"),
        call: { type: "tool-call", id: `call-${name}`, name, input },
      }),
    ),
  )

describe("Core V2 context tools", () => {
  it.effect("advertises both canonical definitions", () =>
    ToolRegistry.Service.use((registry) =>
      Effect.map(registry.materialize(), (materialized) => {
        expect(materialized.definitions.map((definition) => definition.name).sort()).toEqual([
          "code_intel",
          "context_query",
        ])
      }),
    ),
  )

  it.effect("settles code_intel through the host runtime with canonical permission context", () =>
    Effect.gen(function* () {
      const result = yield* settle("code_intel", { intent: "definition", symbol: "answer" })
      expect(result.result.type).toBe("text")
      expect(String(result.result.value)).toContain("code result")
      expect(calls).toEqual([{ tool: "code_intel", intent: "definition", sessionID }])
      expect(assertions[0]).toMatchObject({
        action: "code_intel",
        resources: ["definition"],
        sessionID,
        agent,
        source: { type: "tool", messageID: "msg_context_tools", callID: "call-code_intel" },
      })
    }),
  )

  it.effect("settles context_query through the same host seam", () =>
    Effect.gen(function* () {
      const result = yield* settle("context_query", { intent: "search", query: "decision" })
      expect(result.result.type).toBe("text")
      expect(String(result.result.value)).toContain("context result")
      expect(calls).toEqual([{ tool: "context_query", intent: "search", sessionID }])
      expect(assertions[0]?.action).toBe("context_query")
    }),
  )
})
