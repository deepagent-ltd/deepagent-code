import { LLMEvent, LLMResponse, type Usage } from "../../src/schema"

export function assertTextResponse(response: LLMResponse.Output) {
  const text = LLMResponse.text(response).trim()
  if (!text) throw new Error("Provider response did not contain assistant text")
  const finish = response.events.findLast(LLMEvent.is.finish)
  if (!finish) throw new Error("Provider response did not contain a finish event")
  const usage = LLMResponse.usage(response)
  assertUsage(usage)
  return { textLength: text.length, finishReason: finish.reason, usage: usageSummary(usage) }
}

export function assertToolResponse(response: LLMResponse.Output, name: string, expectedInput: unknown) {
  const calls = LLMResponse.toolCalls(response).filter((event) => event.name === name)
  if (calls.length !== 1) throw new Error(`Expected one ${name} tool call, received ${calls.length}`)
  const actual = JSON.stringify(calls[0].input)
  const expected = JSON.stringify(expectedInput)
  if (actual !== expected) {
    const mismatch = Array.from({ length: Math.max(actual.length, expected.length) }).findIndex(
      (_, index) => actual[index] !== expected[index],
    )
    throw new Error(
      `${name} tool input did not survive the provider round trip: ` +
        `expected length/hash ${expected.length}/${Bun.hash(expected).toString(16)}, ` +
        `actual ${actual.length}/${Bun.hash(actual).toString(16)}, first mismatch ${mismatch} ` +
        `(expected ${expected.codePointAt(mismatch) ?? "EOF"}, actual ${actual.codePointAt(mismatch) ?? "EOF"})`,
    )
  }
  const lifecycle = ["tool-input-start", "tool-input-end", "tool-call"]
  for (const type of lifecycle) {
    if (!response.events.some((event) => event.type === type)) {
      throw new Error(`Provider response is missing ${type}`)
    }
  }
  const finish = response.events.findLast(LLMEvent.is.finish)
  if (!finish || finish.reason !== "tool-calls") {
    throw new Error(`Expected tool-calls finish, received ${finish?.reason ?? "none"}`)
  }
  const usage = LLMResponse.usage(response)
  assertUsage(usage)
  return {
    callIDLength: calls[0].id.length,
    finishReason: finish.reason,
    usage: usageSummary(usage),
  }
}

type ValidUsage = Usage & { inputTokens: number; outputTokens: number; totalTokens: number }

function assertUsage(usage: Usage | undefined): asserts usage is ValidUsage {
  if (!usage) throw new Error("Provider response did not contain usage")
  if (usage.inputTokens === undefined || usage.inputTokens <= 0)
    throw new Error("Provider input token usage is invalid")
  if (usage.outputTokens === undefined || usage.outputTokens <= 0)
    throw new Error("Provider output token usage is invalid")
  if (usage.totalTokens === undefined || usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new Error("Provider total token usage is invalid")
  }
}

function usageSummary(usage: ValidUsage) {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    reasoningTokens: usage?.reasoningTokens,
    totalTokens: usage?.totalTokens,
  }
}
