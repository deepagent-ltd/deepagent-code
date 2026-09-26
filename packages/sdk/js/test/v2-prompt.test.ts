import { describe, expect, test } from "bun:test"
import type { DeepAgentCodeClient } from "../src/gen/sdk.gen.js"
import { toV2Prompt, waitForV2PromptTerminal } from "../src/v2-prompt.js"

describe("V2 prompt compatibility conversion", () => {
  test("retains text, file and agent attachments plus selected execution context", () => {
    const prompt = toV2Prompt({
      messageID: "msg_one",
      intentID: "intent_one",
      intentSource: "composer",
      intentVariant: "rewritten",
      agent: "auto",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      variant: "fast",
      metadata: { deepagent: { prompt_pipeline: { mode: "intelligence" } } },
      parts: [
        { type: "text", text: "inspect" },
        { type: "file", url: "file:///tmp/example.png", mime: "image/png", filename: "example.png" },
        { type: "agent", name: "reviewer", source: { value: "@reviewer", start: 0, end: 9 } },
      ],
    })
    expect(prompt).toMatchObject({
      text: "inspect",
      files: [{ uri: "file:///tmp/example.png", mime: "image/png", name: "example.png" }],
      agents: [{ name: "reviewer", source: { text: "@reviewer", start: 0, end: 9 } }],
      model: { providerID: "deepseek", id: "deepseek-chat", variant: "fast" },
      agent: "auto",
      metadata: { deepagent: { prompt_pipeline: { mode: "intelligence" } } },
      intent: { id: "intent_one", source: "composer", variant: "rewritten" },
    })
  })

  test("refuses a subtask part instead of silently dropping it", () => {
    expect(() => toV2Prompt({ parts: [{ type: "subtask", prompt: "do it", description: "task", agent: "auto" }] }))
      .toThrow("Subtask prompt parts")
  })

  test("reads the completed assistant across pages after V2 wait", async () => {
    const calls: string[] = []
    const client = { v2: { session: {
      wait: async () => { calls.push("wait") },
      messages: async (input: { cursor?: string }) => {
        calls.push(input.cursor ?? "first")
        return input.cursor
          ? { data: { data: [{ id: "assistant", type: "assistant", time: { completed: 42 }, finish: "stop" }], cursor: {} } }
          : { data: { data: [{ id: "user", type: "user" }], cursor: { next: "second" } } }
      },
    } } } as unknown as DeepAgentCodeClient
    const assistant = await waitForV2PromptTerminal(client, { sessionID: "session", messageID: "user" })
    expect(assistant.id).toBe("assistant")
    expect(calls).toEqual(["wait", "first", "second"])
  })

  test("refuses an unrelated later user without a terminal", async () => {
    const client = { v2: { session: {
      wait: async () => undefined,
      messages: async () => ({ data: { data: [{ id: "user", type: "user" }, { id: "other", type: "user" }], cursor: {} } }),
    } } } as unknown as DeepAgentCodeClient
    expect(waitForV2PromptTerminal(client, { sessionID: "session", messageID: "user" }))
      .rejects.toThrow("ambiguous terminal")
  })
})
