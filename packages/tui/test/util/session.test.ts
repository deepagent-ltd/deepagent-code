import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@deepagent-code/sdk/v2"
import {
  acquireForkIntent,
  completeForkIntent,
  contextUsage,
  isDefaultTitle,
  requestSessionFork,
} from "../../src/util/session"

const user = (id: string) =>
  ({
    id,
    sessionID: "ses_test",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "user-provider", modelID: "user-model" },
  }) as Message

const assistant = (
  id: string,
  parentID: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
) =>
  ({
    id,
    parentID,
    sessionID: "ses_test",
    role: "assistant",
    time: { created: 2 },
    modelID: "summary-model",
    providerID: "summary-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
  }) as Message

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("reuses an unresolved fork intent and releases it only after completion", () => {
    const key = "session:message"
    const intentID = acquireForkIntent(key)

    expect(intentID).toStartWith("fork_")
    expect(acquireForkIntent(key)).toBe(intentID)
    completeForkIntent(key, "fork_not_the_owner")
    expect(acquireForkIntent(key)).toBe(intentID)
    completeForkIntent(key, intentID)
    expect(acquireForkIntent(key)).not.toBe(intentID)
  })

  test("retries failed fork requests with the same intent and releases it after success", async () => {
    const key = "session:retry"
    const intents: string[] = []
    const failed = await requestSessionFork({
      key,
      request: async (intentID) => {
        intents.push(intentID)
        return { error: { data: { message: "temporarily unavailable" } } }
      },
    })

    expect(failed).toEqual({ error: { data: { message: "temporarily unavailable" } } })
    const recovered = await requestSessionFork({
      key,
      request: async (intentID) => {
        intents.push(intentID)
        return { data: { id: "ses_child" } }
      },
    })

    expect(recovered).toEqual({ sessionID: "ses_child" })
    expect(intents[0]).toBe(intents[1])
    expect(acquireForkIntent(key)).not.toBe(intents[0])
  })

  test("turns thrown fork failures into retryable outcomes", async () => {
    const key = "session:throw"
    const error = new Error("connection lost")
    const firstIntent = acquireForkIntent(key)

    expect(
      await requestSessionFork({
        key,
        request: async () => {
          throw error
        },
      }),
    ).toEqual({ error })
    expect(acquireForkIntent(key)).toBe(firstIntent)

    completeForkIntent(key, firstIntent)
  })

  test("coalesces concurrent fork requests for one intent", async () => {
    const key = "session:concurrent"
    let finish!: (value: { data: { id: string } }) => void
    const response = new Promise<{ data: { id: string } }>((resolve) => {
      finish = resolve
    })
    let calls = 0
    const request = () =>
      requestSessionFork({
        key,
        request: async () => {
          calls++
          return response
        },
      })

    const first = request()
    const second = request()
    expect(first).toBe(second)
    expect(calls).toBe(0)
    finish({ data: { id: "ses_single" } })
    expect(await Promise.all([first, second])).toEqual([{ sessionID: "ses_single" }, { sessionID: "ses_single" }])
    expect(calls).toBe(1)
  })

  test("counts only retained provider context", () => {
    const usage = contextUsage(
      [user("usr_1"), assistant("ast_1", "usr_1", { input: 300, output: 100, reasoning: 50, read: 25, write: 10 })],
      () => [],
    )

    expect(usage).toEqual({
      tokens: 335,
      providerID: "summary-provider",
      modelID: "summary-model",
      source: "provider",
    })
  })

  test("uses the committed compaction snapshot until a later provider turn", () => {
    const marker = user("usr_compact")
    const summary = {
      ...assistant("ast_summary", marker.id, { input: 80_000, output: 1_000, reasoning: 0, read: 0, write: 0 }),
      summary: true,
      finish: "stop",
    } as Message
    const part = {
      id: "prt_compact",
      sessionID: "ses_test",
      messageID: marker.id,
      type: "compaction",
      auto: true,
      context_tokens: 4_200,
    } as Part
    const parts = (messageID: string) => (messageID === marker.id ? [part] : [])

    expect(contextUsage([marker, summary], parts)).toEqual({
      tokens: 4_200,
      providerID: "user-provider",
      modelID: "user-model",
      source: "compaction",
    })

    const next = assistant("ast_next", "usr_next", { input: 4_500, output: 200, reasoning: 100, read: 500, write: 0 })
    expect(contextUsage([marker, summary, user("usr_next"), next], parts)).toEqual({
      tokens: 5_000,
      providerID: "summary-provider",
      modelID: "summary-model",
      source: "provider",
    })
  })

  test("does not trust a compaction snapshot before the summary is terminal", () => {
    const marker = user("usr_pending")
    const summary = {
      ...assistant("ast_pending", marker.id, { input: 12_000, output: 200, reasoning: 0, read: 500, write: 0 }),
      summary: true,
    } as Message
    const part = {
      id: "prt_pending",
      sessionID: "ses_test",
      messageID: marker.id,
      type: "compaction",
      auto: true,
      context_tokens: 3_000,
    } as Part

    expect(contextUsage([marker, summary], () => [part])?.tokens).toBe(12_500)
    expect(contextUsage([marker, summary], () => [part])?.source).toBe("provider")
  })
})
