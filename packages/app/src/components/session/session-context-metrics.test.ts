import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@deepagent-code/sdk/v2/client"
import { getConversationTokens, getSessionContextMetrics, getSubagentTokens } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    // Retained context = input + cache.read + cache.write (300 + 25 + 25); output/reasoning excluded.
    expect(metrics.context?.total).toBe(350)
    expect(metrics.context?.usage).toBe(35)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })
})

const session = (
  id: string,
  parentID: string | undefined,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
) =>
  ({
    id,
    parentID,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
  }) as unknown as Session

describe("getSubagentTokens", () => {
  test("sums all token buckets of a session's persisted total", () => {
    const s = session("s1", undefined, { input: 100, output: 40, reasoning: 10, read: 5, write: 5 })
    expect(getSubagentTokens(s)).toBe(160)
  })

  test("undefined session -> 0", () => {
    expect(getSubagentTokens(undefined)).toBe(0)
  })
})

describe("getConversationTokens", () => {
  test("sums root + all descendant subagent sessions", () => {
    const sessions = [
      session("root", undefined, { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }),
      session("child1", "root", { input: 50, output: 0, reasoning: 0, read: 0, write: 0 }),
      session("grandchild", "child1", { input: 20, output: 0, reasoning: 0, read: 0, write: 0 }),
      session("child2", "root", { input: 30, output: 0, reasoning: 0, read: 0, write: 0 }),
      session("unrelated", undefined, { input: 999, output: 0, reasoning: 0, read: 0, write: 0 }),
    ]
    // root(100) + child1(50) + grandchild(20) + child2(30) = 200; unrelated excluded.
    expect(getConversationTokens(sessions, "root")).toBe(200)
  })

  test("no root id -> 0", () => {
    expect(getConversationTokens([], undefined)).toBe(0)
  })

  test("root with no children -> just its own total", () => {
    const sessions = [session("root", undefined, { input: 10, output: 5, reasoning: 0, read: 0, write: 0 })]
    expect(getConversationTokens(sessions, "root")).toBe(15)
  })
})
