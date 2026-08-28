import { describe, expect, test } from "bun:test"
import { generateText, InvalidToolInputError, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Schema } from "effect"
import { SessionTools } from "../../src/session/tools"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import { Parameters as Shell } from "../../src/tool/shell"

describe("session tool input validation", () => {
  test("routes missing bash arguments through AI SDK validation without executing", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    })
    const executed: unknown[] = []
    const repairErrors: unknown[] = []

    const result = await generateText({
      model,
      prompt: "Run a command",
      tools: {
        bash: tool({
          inputSchema: SessionTools.validatedToolInputSchema(Shell, ToolJsonSchema.fromSchema(Shell)),
          execute(input) {
            executed.push(input)
            return "unexpected"
          },
        }),
      },
      async experimental_repairToolCall(failed) {
        repairErrors.push(failed.error)
        return null
      },
    })

    expect(repairErrors).toHaveLength(1)
    expect(InvalidToolInputError.isInstance(repairErrors[0])).toBe(true)
    if (InvalidToolInputError.isInstance(repairErrors[0])) {
      expect(String(repairErrors[0].cause)).toContain('["command"]')
    }
    expect(executed).toHaveLength(0)
    expect(result.toolCalls).toMatchObject([{ toolName: "bash", invalid: true }])
  })

  test("preserves wire input after validation so execution owns schema transformations", async () => {
    const parameters = Schema.Struct({ count: Schema.NumberFromString })
    const input = { count: "7" }
    const inputSchema = SessionTools.validatedToolInputSchema(parameters, ToolJsonSchema.fromSchema(parameters))

    expect(inputSchema.validate).toBeDefined()
    const result = await inputSchema.validate!(input)

    expect(result).toEqual({ success: true, value: input })
    if (result.success) expect(result.value).toBe(input)
  })

  test("maps MCP error results to durable tool failures", () => {
    expect(
      SessionTools.mcpResultError("fixture_failure", {
        isError: true,
        content: [
          { type: "image" },
          { type: "text", text: "fixture rejected" },
          { type: "text", text: "no side effect" },
        ],
      })?.message,
    ).toBe("fixture rejected\n\nno side effect")
    expect(SessionTools.mcpResultError("fixture_success", { content: [{ type: "text", text: "ok" }] })).toBeUndefined()
    expect(SessionTools.mcpResultError("fixture_empty", { isError: true, content: [] })?.message).toBe(
      "MCP tool fixture_empty returned an error",
    )
  })
})
