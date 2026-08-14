import { describe, expect, test } from "bun:test"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "../../src/session/llm/request"

const budget = {
  decision: "ok" as const,
  estimatedFullRequestTokens: 100,
  physicalInputBudget: 1_000,
  reservedOutputTokens: 100,
  safetyMargin: 50,
  provenance: "model_limit" as const,
}

function prepare(owner: PreparedProviderTurn.Owner, wireRequest: unknown, toolResultReferences: readonly string[]) {
  return PreparedProviderTurn.prepare({
    sessionID: "session-provider-turn",
    requestOrdinal: 1,
    owner,
    stableSystemParts: ["provider baseline", "agent policy"],
    volatileSystemParts: ["runtime context"],
    historyMessages: [{ role: "user", content: "lookup" }],
    historyPromptEpoch: 3,
    historySourceEndMessageID: "message-1",
    contextSelectionID: "selection-1",
    contextProjectionHash: "projection-1",
    contextReadiness: "ready",
    contextSelectedRefs: ["context-1"],
    toolRegistryIDs: ["lookup"],
    toolPermissionFilteredIDs: ["lookup"],
    toolFinalOfferedIDs: ["lookup"],
    toolDefinitions: [{ name: "lookup", inputSchema: { type: "object" } }],
    toolChoice: "auto",
    toolCapability: "supported",
    toolLoweringOutcome: "ok",
    toolResultReferences,
    samplingModelID: "model-1",
    samplingProviderID: "provider-1",
    samplingMaxOutputTokens: 100,
    samplingTemperature: 0,
    budget,
    wireRequest,
    receiptID: "receipt-1",
    providerAttemptID: "attempt-1",
    userMessageID: "message-1",
    assistantMessageID: "message-2",
    preparedAt: 100,
  })
}

describe("prepared provider turn", () => {
  test("keeps native and AI SDK owners on one canonical request hash", () => {
    const wireRequest = { messages: [{ role: "user", content: "lookup" }], tools: ["lookup"] }
    const native = prepare("legacy_native", wireRequest, ["call-1"])
    const aiSdk = prepare("legacy_aisdk", wireRequest, ["call-1"])

    expect(native.request_hash).toBe(aiSdk.request_hash)
    expect(native.wire_request_hash).toBe(aiSdk.wire_request_hash)
    expect(native.tool_definition_hash).toBe(aiSdk.tool_definition_hash)
  })

  test("records only explicit previous tool-result parts", () => {
    const messages = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-2", toolName: "lookup", output: { type: "text", value: "b" } },
          { type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: { type: "text", value: "a" } },
          { type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: { type: "text", value: "a" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "continue", providerOptions: { forged: { type: "tool-result", toolCallId: "fake" } } }],
      },
    ] as ModelMessage[]

    expect(LLMRequestPrep.toolResultReferences(messages)).toEqual(["call-1", "call-2"])
    expect(LLMRequestPrep.toolResultReferences([{ role: "user", content: "continue" }])).toEqual([])
    expect(prepare("legacy_native", { messages }, LLMRequestPrep.toolResultReferences(messages))).toMatchObject({
      tool_result_reference_ids: ["call-1", "call-2"],
      tool_result_reference_count: 2,
    })
  })

  test("makes the receipt hash sensitive to final wire lowering", () => {
    const first = prepare("legacy_native", { tools: [{ name: "lookup", strict: false }] }, [])
    const lowered = prepare("legacy_native", { tools: [{ name: "lookup", strict: true }] }, [])

    expect(first.wire_request_hash).not.toBe(lowered.wire_request_hash)
    expect(first.request_hash).not.toBe(lowered.request_hash)
  })

  test("merges provider baseline before agent and runtime system parts", () => {
    expect(
      PreparedProviderTurn.mergeSystemParts(["provider"], [undefined, "agent"], ["deepagent"], ["context"]),
    ).toEqual(["provider", "agent", "deepagent", "context"])
  })
})
