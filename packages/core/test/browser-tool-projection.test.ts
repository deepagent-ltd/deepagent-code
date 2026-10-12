import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src/tool/tool"
import { AgentV2 } from "../src/agent"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"

const context: Tool.Context = { sessionID: SessionSchema.ID.make("ses_projection"), agent: AgentV2.ID.make("test"),
  assistantMessageID: SessionMessage.ID.make("msg_projection"), toolCallID: "call_projection" }

test("typed native media projection retains metadata separately without duplicating base64", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const tool = Tool.make({ input: Schema.Struct({}), output: Schema.Struct({ summary: Schema.String, png: Schema.String }),
    description: "Native image projection fixture", execute: () => Effect.succeed({ summary: "one actual image", png }),
    toStructuredOutput: ({ output }) => ({ summary: output.summary }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.summary }, { type: "file", mime: "image/png", data: output.png }],
  })
  const output = await Effect.runPromise(Tool.settle(tool, { type: "tool-call", id: context.toolCallID, name: "browser", input: {} }, context))
  expect(output.structured).toEqual({ summary: "one actual image" })
  expect(output.content).toEqual([{ type: "text", text: "one actual image" },
    { type: "file", mime: "image/png", source: { type: "data", data: png }, name: undefined }])
  expect(JSON.stringify(output.structured)).not.toContain(png)
})

test("ordinary typed tools retain their existing structured and text output", async () => {
  const tool = Tool.make({ input: Schema.Struct({}), output: Schema.String,
    description: "Ordinary unchanged projection", execute: () => Effect.succeed("unchanged") })
  const output = await Effect.runPromise(Tool.settle(tool, { type: "tool-call", id: context.toolCallID, name: "ordinary", input: {} }, context))
  expect(output.structured).toBe("unchanged")
  expect(output.content).toEqual([{ type: "text", text: "unchanged" }])
})
