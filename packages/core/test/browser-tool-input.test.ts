import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentV2 } from "../src/agent"
import { BrowserSchema } from "../src/browser/schema"
import { SharedBrowserSchema } from "../src/browser/shared-schema"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { BrowserToolInput } from "../src/tool/browser-input"
import { Tool } from "../src/tool/tool"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"

const context: Tool.Context = {
  sessionID: SessionSchema.ID.make("ses_browser_input"), agent: AgentV2.ID.make("test"),
  assistantMessageID: SessionMessage.ID.make("msg_browser_input"), toolCallID: "call_browser_input",
}
const digest = (input: unknown) => Hash.sha256(CanonicalJson.stringify(input))

test("reported malformed acquire inputs never fall through to a legacy execution", async () => {
  const base = { resourceID: "resource", operation: "acquire", expectedManualEpoch: "1" }
  const inputs = [base, { ...base, controlID: "resource", requestID: "req-reacquire" },
    { ...base, controlID: "resource", requestID: "req-reacquire", expectedManualEpoch: 1, command: { type: "tabs.list" } }]
  const old = Schema.Union([BrowserSchema.Invoke, SharedBrowserSchema.Invoke])
  const prior = await Effect.runPromise(Schema.decodeUnknownEffect(old)(inputs[2]))
  expect(prior).toEqual({ controlID: "resource", command: { type: "tabs.list" } })
  expect(digest(prior)).not.toBe(digest(inputs[2]))
  const executions: unknown[] = []
  const tool = Tool.make({ description: BrowserToolInput.description, input: BrowserToolInput.Input,
    decodeInput: BrowserToolInput.decode, output: Schema.String, execute: (input) => Effect.sync(() => {
      executions.push(input)
      return digest(input)
    }) })
  for (const input of inputs) {
    const result = await Effect.runPromise(Effect.result(Tool.settle(tool,
      { type: "tool-call", name: "browser", id: context.toolCallID, input }, context)))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Malformed shared input executed")
    expect(result.failure.message).toContain("shared browser acquire input")
    expect(result.failure.message).toContain("requestID, expectedManualEpoch (positive integer)")
    expect(result.failure.message).not.toContain("Missing key\n  at [\"controlID\"]")
  }
  expect(executions).toEqual([])
})

test("browser settlement preserves exact valid JSON and rejects mixed or nested extras", async () => {
  const executions: unknown[] = []
  const tool = Tool.make({ description: BrowserToolInput.description, input: BrowserToolInput.Input,
    decodeInput: BrowserToolInput.decode, output: Schema.String, execute: (input) => Effect.sync(() => {
      executions.push(input)
      return digest(input)
    }) })
  const inputs = [
    { operation: "status", resourceID: "resource" },
    { operation: "acquire", resourceID: "resource", requestID: "fresh-request", expectedManualEpoch: 1 },
    { operation: "execute", resourceID: "resource", command: { type: "tabs.list" }, timeoutMs: 1000 },
    { controlID: "legacy-control", command: { type: "tabs.list" }, timeoutMs: 1000 },
  ]
  for (const input of inputs) {
    const before = structuredClone(input)
    const output = await Effect.runPromise(Tool.settle(tool,
      { type: "tool-call", name: "browser", id: context.toolCallID, input }, context))
    expect(output.structured).toBe(digest(input))
    expect(input).toEqual(before)
  }
  expect(executions).toEqual(inputs)
  for (const input of [
    { operation: "status", resourceID: "resource", controlID: "legacy-control", command: { type: "tabs.list" } },
    { resourceID: "resource", controlID: "legacy-control", command: { type: "tabs.list" } },
    { operation: "execute", resourceID: "resource", command: { type: "tabs.list", extra: "discarded-before" } },
    { controlID: "legacy-control", command: { type: "tabs.list", extra: "discarded-before" } },
    { controlID: "legacy-control", command: { type: "tabs.list" }, extra: "discarded-before" },
    { operation: "acquire", resourceID: "resource", requestID: "fresh-request", expectedManualEpoch: "1" },
    { operation: "acquire", resourceID: "resource", requestID: "fresh-request", expectedManualEpoch: 1.5 },
  ]) {
    const result = await Effect.runPromise(Effect.result(Tool.settle(tool,
      { type: "tool-call", name: "browser", id: context.toolCallID, input }, context)))
    expect(result._tag).toBe("Failure")
  }
  expect(executions).toEqual(inputs)
  expect(Tool.definition("browser", tool).description).toContain('"expectedManualEpoch":1')
})

test("tools without the browser decoder retain their excess-property compatibility", async () => {
  const tool = Tool.make({ description: "Existing ordinary tool", input: Schema.Struct({ name: Schema.String }),
    output: Schema.String, execute: (input) => Effect.succeed(CanonicalJson.stringify(input)) })
  const output = await Effect.runPromise(Tool.settle(tool, { type: "tool-call", name: "ordinary", id: context.toolCallID,
    input: { name: "unchanged", extra: "previously-ignored" } }, context))
  expect(output.structured).toBe('{"name":"unchanged"}')
})
