import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"
import { ToolPairing } from "@/session/llm/tool-pairing"

const INTERRUPTED = "[Tool execution was interrupted]"

function call(toolCallId: string, toolName = "bash") {
  return { type: "tool-call" as const, toolCallId, toolName, input: { cmd: "ls" } }
}

function result(toolCallId: string, toolName = "bash", value = "ok") {
  return { type: "tool-result" as const, toolCallId, toolName, output: { type: "text" as const, value } }
}

function toolMsg(...parts: ReturnType<typeof result>[]): ModelMessage {
  return { role: "tool", content: parts }
}

describe("ToolPairing.repairToolPairing - missing result synthesis", () => {
  test("synthesizes an error result right after the assistant message carrying the call", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [call("call_1")] },
      { role: "assistant", content: [{ type: "text", text: "continuing" }] },
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[1])
    expect(out[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "bash",
          output: { type: "error-text", value: INTERRUPTED },
        },
      ],
    })
    expect(out[3]).toBe(input[2])
  })

  test("synthesizes at the end when the dangling call is in the last message", () => {
    const input: ModelMessage[] = [{ role: "assistant", content: [call("call_last", "read")] }]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_last",
          toolName: "read",
          output: { type: "error-text", value: INTERRUPTED },
        },
      ],
    })
  })

  test("synthesizes only the unmatched call when siblings are paired", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_a"), call("call_b", "read")] },
      toolMsg(result("call_a")),
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(3)
    // synthetic for call_b sits between the call message and the result message
    expect((out[1] as any).content[0].toolCallId).toBe("call_b")
    expect((out[1] as any).content[0].output).toEqual({ type: "error-text", value: INTERRUPTED })
    expect(out[2]).toEqual(input[1])
  })

  test("does not mutate its input", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1")] },
      { role: "tool", content: [{ ...result("ghost") }] },
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    ToolPairing.repairToolPairing(input)
    expect(input).toEqual(snapshot)
  })
})

describe("ToolPairing.repairToolPairing - orphan result stripping", () => {
  test("strips tool results whose callID never appeared as a call", () => {
    const input: ModelMessage[] = [
      toolMsg(result("ghost_1"), result("ghost_2", "read")),
      { role: "assistant", content: [call("call_1")] },
      toolMsg(result("call_1")),
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(input[1])
    expect(out[1]).toBe(input[2])
  })

  test("drops a message entirely when all of its parts are stripped", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      toolMsg(result("ghost")),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[2])
  })

  test("strips a result that appears before its call (no preceding call)", () => {
    const input: ModelMessage[] = [
      toolMsg(result("call_1")),
      { role: "assistant", content: [call("call_1")] },
    ]
    const out = ToolPairing.repairToolPairing(input)
    // orphan result message dropped; dangling call gets a synthetic result
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(input[1])
    expect((out[1] as any).content[0].output).toEqual({ type: "error-text", value: INTERRUPTED })
  })

  test("keeps non-result parts inside tool messages", () => {
    const approvalResponse = { type: "tool-approval-response" as const, approvalId: "appr_1", approved: true }
    const input: ModelMessage[] = [{ role: "tool", content: [result("ghost"), approvalResponse] as any }]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(1)
    expect((out[0] as any).content).toEqual([approvalResponse])
  })
})

describe("ToolPairing.repairToolPairing - duplicate callID dedup", () => {
  test("keeps the first call and first result for a duplicated callID", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_dup"), call("call_dup")] },
      toolMsg(result("call_dup", "bash", "first"), result("call_dup", "bash", "second")),
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(2)
    expect((out[0] as any).content).toEqual([call("call_dup")])
    expect((out[1] as any).content).toEqual([result("call_dup", "bash", "first")])
  })

  test("keeps the first result when the duplicate call was dropped", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_x")] },
      { role: "assistant", content: [call("call_x")] },
      toolMsg(result("call_x", "bash", "keep")),
      toolMsg(result("call_x", "bash", "drop")),
    ]
    const out = ToolPairing.repairToolPairing(input)
    // duplicate call message is dropped entirely; duplicate result stripped
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(input[0])
    expect(out[1]).toBe(input[2])
  })
})

describe("ToolPairing.repairToolPairing - invariants", () => {
  test("well-formed history passes through with identical references", () => {
    const input: ModelMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "thinking" }, call("call_1")] },
      toolMsg(result("call_1")),
      { role: "assistant", content: [call("call_2", "read")] },
      toolMsg(result("call_2", "read", "file content")),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]
    const out = ToolPairing.repairToolPairing(input)
    expect(out).toHaveLength(input.length)
    input.forEach((msg, i) => expect(out[i]).toBe(msg))
  })
})

describe("ProviderTransform.message - UPD-001 integration", () => {
  const mistralModel = {
    id: "mistral/mistral-medium-latest",
    providerID: "mistral",
    api: { id: "mistral-medium-latest", url: "https://api.mistral.ai", npm: "@ai-sdk/mistral" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
  } as any

  const plainModel = {
    id: "openai/gpt-4o",
    providerID: "openai",
    api: { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
  } as any

  test("dedups callIDs that only collide after the mistral scrub", () => {
    // Both IDs scrub to "callabc12" (non-alphanumerics removed, truncated to 9)
    const id1 = "call_abc123XYZ"
    const id2 = "call_abc123!UV"
    const input: ModelMessage[] = [
      { role: "assistant", content: [call(id1, "bash"), call(id2, "read")] },
      toolMsg(result(id1, "bash", "first"), result(id2, "read", "second")),
    ]
    const out = ProviderTransform.message(input, mistralModel, {})
    const assistant = out.find((m) => m.role === "assistant")!
    const toolMsgs = out.filter((m) => m.role === "tool")
    const callIds = (assistant.content as any[]).filter((p) => p.type === "tool-call").map((p) => p.toolCallId)
    const resultIds = toolMsgs.flatMap((m) => (m.content as any[]).map((p) => p.toolCallId))
    expect(callIds).toEqual(["callabc12"])
    expect(resultIds).toEqual(["callabc12"])
    // kept result is the first one
    expect((toolMsgs[0].content as any[])[0].output).toEqual({ type: "text", value: "first" })
  })

  test("synthetic result before a user message gets the mistral assistant bridge", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_missing")] },
      { role: "user", content: "keep going" },
    ]
    const out = ProviderTransform.message(input, mistralModel, {})
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "user"])
    expect((out[1].content as any[])[0].output).toEqual({ type: "error-text", value: INTERRUPTED })
    expect(out[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "Done." }] })
  })

  test("well-formed message() output is structurally unchanged", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [call("call_1")] },
      toolMsg(result("call_1")),
      { role: "assistant", content: [{ type: "text", text: "all done" }] },
    ]
    const out = ProviderTransform.message(JSON.parse(JSON.stringify(input)), plainModel, {})
    expect(out).toEqual(input)
  })

  test("repairs dangling call on the plain (non-scrubbing) path too", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1")] },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
    ]
    const out = ProviderTransform.message(input, plainModel, {})
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"])
    expect((out[1].content as any[])[0]).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "bash",
      output: { type: "error-text", value: INTERRUPTED },
    })
  })
})

// UPD-001 telemetry: the RepairReport records exactly what the repairer changed so the receipt's
// pre-repair call_ids ↔ repaired wire body divergence is explainable.
describe("ToolPairing.repairToolPairing - RepairReport telemetry", () => {
  test("reports synthesized results for dangling calls", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1")] },
      { role: "assistant", content: [call("call_2")] },
    ]
    const report = ToolPairing.emptyRepairReport()
    ToolPairing.repairToolPairing(input, { report })
    expect(report.synthesizedResults.sort()).toEqual(["call_1", "call_2"])
    expect(report.strippedOrphanResults).toEqual([])
    expect(report.droppedDuplicates).toEqual([])
    expect(ToolPairing.repairReportIsEmpty(report)).toBe(false)
  })

  test("reports stripped orphan results and dropped duplicates", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1"), call("call_1")] },
      toolMsg(result("call_1"), result("call_1"), result("orphan_x")),
    ]
    const report = ToolPairing.emptyRepairReport()
    ToolPairing.repairToolPairing(input, { report })
    expect(report.droppedDuplicates).toEqual(["call_1", "call_1"])
    expect(report.strippedOrphanResults).toEqual(["orphan_x"])
    expect(report.synthesizedResults).toEqual([])
  })

  test("a clean history yields an empty report", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1")] },
      toolMsg(result("call_1")),
    ]
    const report = ToolPairing.emptyRepairReport()
    ToolPairing.repairToolPairing(input, { report })
    expect(ToolPairing.repairReportIsEmpty(report)).toBe(true)
  })

  test("counts bridged tool→user gaps when bridging is enabled", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [call("call_1")] },
      toolMsg(result("call_1")),
      { role: "user", content: "follow-up" },
    ]
    const report = ToolPairing.emptyRepairReport()
    ToolPairing.repairToolPairing(input, { bridgeToolUserGap: false, report })
    expect(report.bridgedToolUserGaps).toBe(0)
    const reportBridged = ToolPairing.emptyRepairReport()
    ToolPairing.repairToolPairing(
      [
        { role: "assistant", content: [call("call_1")] },
        { role: "user", content: "follow-up" },
      ],
      { bridgeToolUserGap: true, report: reportBridged },
    )
    expect(reportBridged.bridgedToolUserGaps).toBe(1)
    expect(reportBridged.synthesizedResults).toEqual(["call_1"])
  })
})
