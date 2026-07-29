import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { MessageID, SessionID } from "@/session/schema"
import { CodeIntelV2Tool } from "@/tool/code_intel_v2"
import { ContextQueryTool } from "@/tool/context_query"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Effect, Layer } from "effect"

describe("v2 context tools", () => {
  test("use independent read-only permissions and return their versioned facade results", async () => {
    const permissions: string[] = []
    const app = Layer.mergeAll(
      Layer.succeed(CodeIntelFacade.Service, CodeIntelFacade.Service.of({
        execute: () => Effect.succeed(codeResult),
      })),
      Layer.succeed(ContextQueryFacade.Service, ContextQueryFacade.Service.of({
        execute: () => Effect.succeed(contextResult),
      })),
      Layer.succeed(Agent.Service, Agent.Service.of({
        get: () => Effect.succeed({} as Agent.Info),
      } as unknown as Agent.Interface)),
      Layer.succeed(Truncate.Service, Truncate.Service.of({
        output: (content: string) => Effect.succeed({ content, truncated: false }),
      } as unknown as Truncate.Interface)),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const code = yield* Tool.init(yield* CodeIntelV2Tool)
        const context = yield* Tool.init(yield* ContextQueryTool)
        const codeOutput = yield* code.execute({ intent: "search", query: "symbol" }, toolContext(permissions))
        const contextOutput = yield* context.execute({ intent: "search", query: "decision" }, toolContext(permissions))
        return { codeOutput, contextOutput }
      }).pipe(Effect.provide(app)),
    )

    expect(permissions).toEqual(["code_intel", "context_query"])
    expect(JSON.parse(result.codeOutput.output).schemaVersion).toBe(2)
    expect(JSON.parse(result.contextOutput.output).schemaVersion).toBe(1)
  })
})

function toolContext(permissions: string[]): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "general",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => permissions.push(input.permission)),
  }
}

const codeResult: CodeIntelFacade.Result = {
  schemaVersion: 2,
  summary: "No authorized code results.",
  index: {
    state: "ready",
    generation: 1,
    dirtyPathCount: 0,
    semanticCoverage: {},
    stale: false,
  },
  query: {
    status: { graph: "code", kind: "complete", state: "ready", outcome: "empty", revisions: [] },
    consistency: "stale_ok",
    freshnessSatisfied: true,
  },
  enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
  hits: [],
  truncated: false,
}

const contextResult: ContextQueryFacade.Result = {
  schemaVersion: 1,
  summary: "No authorized context results.",
  statuses: [],
  hits: [],
  truncated: false,
}
