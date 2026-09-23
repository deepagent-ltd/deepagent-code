import { describe, expect, test } from "bun:test"
import { toV2Prompt } from "../src/v2-prompt.js"

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
})
