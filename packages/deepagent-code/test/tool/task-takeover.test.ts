import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { Effect, Exit, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Worktree } from "@/worktree"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(flags),
  )

// Mock Worktree service that records create/remove/safeRemove so 1d teardown is assertable without
// real git. Any other method intentionally throws UnimplementedError (Layer.mock) as a tripwire.
const wt = { created: [] as string[], removed: [] as string[], safeRemoved: [] as string[] }
const worktreeMock = Layer.mock(Worktree.Service, {
  create: () =>
    Effect.promise(async () => {
      const directory = `/tmp/dac-takeover-wt-${wt.created.length}`
      await mkdir(directory, { recursive: true })
      wt.created.push(directory)
      return {
        name: `dac-takeover-wt-${wt.created.length}`,
        branch: `deepagent-code/dac-takeover-wt-${wt.created.length}`,
        directory,
      }
    }),
  remove: (input) => {
    wt.removed.push(input.directory)
    return Effect.succeed(true)
  },
  safeRemove: (input) => {
    wt.safeRemoved.push(input.directory)
    return Effect.succeed(true)
  },
})

const takeover = testEffect(layer({ subagentTimeoutMs: 50, subagentTakeoverLimit: 2 }))
const takeoverOnce = testEffect(layer({ subagentTimeoutMs: 50, subagentTakeoverLimit: 1 }))
const takeoverWorktree = testEffect(
  Layer.mergeAll(layer({ subagentTimeoutMs: 50, subagentTakeoverLimit: 1 }), worktreeMock),
)
const e2e = testEffect(
  Layer.mergeAll(
    layer({ subagentTimeoutMs: 50, subagentTakeoverLimit: 2, subagentOutputMaxChars: 10 }),
    worktreeMock,
  ),
)
const bounded = testEffect(layer({ subagentOutputMaxChars: 10 }))
const off = testEffect(layer())

const resetWorktreeLog = () => {
  wt.created.length = 0
  wt.removed.length = 0
  wt.safeRemoved.length = 0
}

const seed = Effect.fn("TaskTakeoverTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

const stubOps = (prompt: TaskPromptOps["prompt"]): TaskPromptOps => ({
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt,
})

const execCtx = (chat: { id: SessionID }, assistant: { id: MessageID }, promptOps: TaskPromptOps) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort: new AbortController().signal,
  extra: { promptOps },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const subagentState = (metadata: unknown) =>
  (metadata as { deepagent?: { subagent?: { state?: string } } } | undefined)?.deepagent?.subagent?.state

describe("tool.task takeover (v4.0.4 block1 1a+1b)", () => {
  takeover.instance("a hung subagent is cancelled and retried, and the retry result is delivered", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        if (calls.length === 1) return Effect.never
        return Effect.succeed(reply(input, "recovered"))
      })

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain("recovered")
      expect(result.metadata.sessionId).toBe(calls[1])
      expect(calls).toHaveLength(2)
      expect(calls[0]).not.toBe(calls[1])

      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")
      expect((yield* jobs.get(calls[1]!))?.status).toBe("completed")

      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("cancelled")
      expect(subagentState((yield* sessions.get(calls[1]!)).metadata)).toBe("completed")
    }),
  )

  takeover.instance("a crashing subagent is retried and the retry result is delivered", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        if (calls.length === 1) return Effect.fail(new Error("boom"))
        return Effect.succeed(reply(input, "ok after retry"))
      })

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain("ok after retry")
      expect(calls).toHaveLength(2)
      expect(calls[0]).not.toBe(calls[1])
    }),
  )

  takeoverOnce.instance("exhausting the takeover limit surfaces a bounded failure to the parent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        return Effect.never
      })

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain(`state="error"`)
      expect(result.output).toContain("takeover")
      expect(calls).toHaveLength(2)

      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")
      expect((yield* jobs.get(calls[1]!))?.status).toBe("cancelled")

      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[1]!)).metadata)).toBe("error")
    }),
  )

  takeoverWorktree.instance("takeover recycles the worktree and teardown happens at completion points", () =>
    Effect.gen(function* () {
      resetWorktreeLog()
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps(() => Effect.never)

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          isolation: "worktree",
        },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain(`state="error"`)
      // one worktree per attempt (same fork base, fresh name), the first is force-recycled on
      // takeover, the last is teardown-safed when the limit is reached.
      expect(wt.created).toHaveLength(2)
      expect(wt.removed).toEqual([wt.created[0]])
      expect(wt.safeRemoved).toEqual([wt.created[1]])
    }),
  )

  off.instance("with the timeout flag off a crashing subagent fails immediately without retry", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let calls = 0
      const promptOps = stubOps(() => {
        calls += 1
        return Effect.fail(new Error("boom"))
      })

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          execCtx(chat, assistant, promptOps),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toBe(1)
    }),
  )

  takeover.instance("background tasks drive the timeout-takeover-inject chain end to end", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const injected: string[] = []
      const promptOps = stubOps((input) => {
        if (input.sessionID === chat.id) {
          const part = input.parts.find((item) => item.type === "text")
          if (part?.type === "text") injected.push(part.text)
          return Effect.succeed(reply(input, "injected"))
        }
        calls.push(input.sessionID)
        if (calls.length === 1) return Effect.never
        return Effect.succeed(reply(input, "background recovered"))
      })

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        execCtx(chat, assistant, promptOps),
      )
      expect(started.output).toContain(`state="running"`)

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* jobs.list()
          const done = list.find((job) => job.status === "completed" && job.output === "background recovered")
          return done ? (true as const) : undefined
        }),
        "background takeover chain never completed",
      )

      expect(calls).toHaveLength(2)
      expect(injected.length).toBeGreaterThan(0)
      expect(injected[0]).toContain("background recovered")
      expect(injected[0]).toContain("takeover")
    }),
  )

  e2e.instance("spawn → timeout → takeover → teardown → bounded injection (block1 chain)", () =>
    Effect.gen(function* () {
      resetWorktreeLog()
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        if (calls.length === 1) return Effect.never
        return Effect.succeed(reply(input, "z".repeat(50)))
      })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          isolation: "worktree",
        },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain("…[truncated")
      expect(result.output).toContain("z".repeat(10))
      expect(result.output).not.toContain("z".repeat(50))
      expect(calls).toHaveLength(2)
      expect(calls[0]).not.toBe(calls[1])
      expect(wt.created).toHaveLength(2)
      expect(wt.removed).toEqual([wt.created[0]])
      expect(wt.safeRemoved).toEqual([wt.created[1]])
    }),
  )
})

describe("tool.task bounded output (v4.0.4 block1 1e)", () => {
  bounded.instance("parent receives a bounded excerpt with a session pointer when the cap is set", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps((input) => Effect.succeed(reply(input, "x".repeat(200))))

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain("…[truncated")
      expect(result.output).toContain("x".repeat(10))
      expect(result.output).not.toContain("x".repeat(200))
      expect(result.output).toContain(String(result.metadata.sessionId))
    }),
  )

  off.instance("without the cap the parent receives the full text (status quo)", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps((input) => Effect.succeed(reply(input, "y".repeat(200))))

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain("y".repeat(200))
      expect(result.output).not.toContain("…[truncated")
    }),
  )

  // 1e codepoint safety: truncation must slice on whole codepoints, never mid-surrogate, so a
  // multibyte character on the boundary is not corrupted into a replacement char. With the cap at 10,
  // an all-emoji output must keep exactly 10 intact emoji and no U+FFFD.
  bounded.instance("truncation never splits a multibyte codepoint", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // 20 four-byte emoji (each is a surrogate pair in UTF-16); a naive slice(0,10) would cut the
      // 5th emoji in half and emit a lone surrogate / replacement char.
      const promptOps = stubOps((input) => Effect.succeed(reply(input, "😀".repeat(20))))

      const result = yield* def.execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
        execCtx(chat, assistant, promptOps),
      )

      expect(result.output).toContain("…[truncated")
      // Exactly 10 intact emoji kept, and no replacement char from a mid-surrogate cut.
      expect(result.output).toContain("😀".repeat(10))
      expect(result.output).not.toContain("�")
      // The pointer to the full subagent session always survives the truncation.
      expect(result.output).toContain(String(result.metadata.sessionId))
    }),
  )
})
