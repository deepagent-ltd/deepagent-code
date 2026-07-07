// Unit tests for ServerAgentExecutor — THE canonical live implementation of the
// core `AgentExecutor` port (SessionPrompt-driven). These drive the executor
// through its `ServerAgentExecutorLive` layer with mocked `Session.Service` and
// `SessionPrompt.Service` to assert timeout normalization, error normalization,
// model resolution, and text extraction — WITHOUT booting the full server stack
// (the real-stack e2e lives in test/server/httpapi-im-agent.test.ts).

import { describe, it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentContext } from "@deepagent-code/core/im/agent-executor"
import { AgentExecutorService } from "@deepagent-code/core/im/agent-executor"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { ServerAgentExecutorLive } from "@/im/agent-executor-server"

const emptyContext: AgentContext = {
  code: undefined,
  knowledge: [],
  memory: [],
  documents: [],
  conversation: { groupID: "g1", recentMessages: [] },
}

const baseInput = {
  workspaceID: "wrk_123",
  directory: "/tmp/ws1",
  groupID: "g1",
  messageID: "m1",
  agentID: "build",
  userID: "u1",
  content: "hello",
  context: emptyContext,
  timeoutMs: 5000,
}

// A recorder so tests can assert what `create` received (e.g. workspaceID gating).
type CreateCall = { agent?: string; directory?: string; workspaceID?: unknown }

function makeLayer(opts: {
  prompt: (input: unknown) => Effect.Effect<SessionV1.WithParts, unknown>
  onCreate?: (call: CreateCall) => void
}) {
  const sessionMock = {
    create: (input?: CreateCall) =>
      Effect.sync(() => {
        opts.onCreate?.(input ?? {})
        return { id: "ses_test" } as unknown as Session.Info
      }),
  } as unknown as Session.Interface

  const promptMock = {
    prompt: opts.prompt,
  } as unknown as SessionPrompt.Interface

  return ServerAgentExecutorLive.pipe(
    Layer.provide(Layer.succeed(Session.Service, sessionMock)),
    Layer.provide(Layer.succeed(SessionPrompt.Service, promptMock)),
  )
}

function reply(texts: string[]): SessionV1.WithParts {
  return {
    info: { id: "msg_reply" },
    parts: texts.map((text) => ({ type: "text", text }) as SessionV1.TextPart),
  } as unknown as SessionV1.WithParts
}

const run = (layer: Layer.Layer<AgentExecutorService>, input = baseInput) =>
  Effect.gen(function* () {
    const executor = yield* AgentExecutorService
    return yield* executor.execute(input)
  }).pipe(Effect.provide(layer), Effect.runPromise)

describe("ServerAgentExecutor", () => {
  it("extracts concatenated TextParts as the reply on success", async () => {
    const result = await run(makeLayer({ prompt: () => Effect.succeed(reply(["hello ", " world"])) }))
    expect(result.success).toBe(true)
    expect(result.timeout).toBe(false)
    expect(result.content).toBe("hello\n\nworld")
    expect(result.messageID).toBe("msg_reply")
  })

  it("returns NO_RESPONSE when the agent produces no text", async () => {
    const result = await run(makeLayer({ prompt: () => Effect.succeed(reply([" ", ""])) }))
    expect(result.success).toBe(false)
    expect(result.timeout).toBe(false)
    expect(result.error?.code).toBe("NO_RESPONSE")
    expect(result.error?.retryable).toBe(false)
  })

  it("normalizes an executor failure into a structured AGENT_EXECUTION_ERROR result", async () => {
    const result = await run(
      makeLayer({ prompt: () => Effect.fail(new Error("boom from prompt")) }),
    )
    expect(result.success).toBe(false)
    expect(result.timeout).toBe(false)
    expect(result.error?.code).toBe("AGENT_EXECUTION_ERROR")
    expect(result.error?.message).toBe("boom from prompt")
    expect(result.error?.retryable).toBe(false)
  })

  it("normalizes a slow run into a timeout result once timeoutMs elapses", async () => {
    const layer = makeLayer({ prompt: () => Effect.never })
    const result = await run(layer, { ...baseInput, timeoutMs: 20 })
    expect(result.success).toBe(false)
    expect(result.timeout).toBe(true)
    expect(result.error?.code).toBe("AGENT_TIMEOUT")
    expect(result.error?.retryable).toBe(true)
  })

  it("forwards a genuine wrk-prefixed workspaceID to session create", async () => {
    let captured: CreateCall | undefined
    await run(
      makeLayer({
        prompt: () => Effect.succeed(reply(["ok"])),
        onCreate: (c) => {
          captured = c
        },
      }),
    )
    expect(captured?.workspaceID).toBe("wrk_123")
    expect(captured?.directory).toBe("/tmp/ws1")
    expect(captured?.agent).toBe("build")
  })

  it("does NOT forward a non-wrk workspaceID (directory-fallback routing)", async () => {
    let captured: CreateCall | undefined
    await run(
      makeLayer({
        prompt: () => Effect.succeed(reply(["ok"])),
        onCreate: (c) => {
          captured = c
        },
      }),
      { ...baseInput, workspaceID: "/some/dir" },
    )
    expect(captured?.workspaceID).toBeUndefined()
    expect(captured?.directory).toBe("/tmp/ws1")
  })
})
