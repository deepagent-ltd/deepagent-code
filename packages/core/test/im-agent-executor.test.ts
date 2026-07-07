import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  AgentExecutorService,
  AgentExecutorFailFastLive,
  AGENT_EXECUTOR_NOT_IMPLEMENTED,
} from "../src/im/agent-executor"
import type { AgentContext } from "../src/im/agent-executor"

const emptyContext: AgentContext = {
  code: undefined,
  knowledge: [],
  memory: [],
  documents: [],
  conversation: { groupID: "g1", recentMessages: [] },
}

const executeInput = {
  workspaceID: "ws1",
  directory: "/tmp/ws1",
  groupID: "g1",
  messageID: "m1",
  agentID: "code-agent",
  userID: "u1",
  content: "hello",
  context: emptyContext,
  timeoutMs: 1000,
}

describe("AgentExecutor fail-fast default layer", () => {
  it("resolves the port but fails execute with the clear not-implemented message", async () => {
    const program = Effect.gen(function* () {
      const executor = yield* AgentExecutorService
      return yield* executor.execute(executeInput)
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(AgentExecutorFailFastLive)))

    expect(exit._tag).toBe("Failure")
    // The failure surfaces through the port's typed Error channel (not an opaque
    // missing-dependency defect) with the actionable message.
    const message = await Effect.runPromise(
      program.pipe(
        Effect.provide(AgentExecutorFailFastLive),
        Effect.catch((error) => Effect.succeed(error.message)),
      ),
    )
    expect(message).toBe(AGENT_EXECUTOR_NOT_IMPLEMENTED)
    expect(message).toContain("ServerAgentExecutorLive")
  })
})
