import { describe, expect } from "bun:test"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Worktree } from "@/worktree"
import { TaskConcurrency } from "@/tool/task-concurrency"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"

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
    // QUAL-007: the core SessionProjector materializes event-created sessions; without it message
    // writes hit the session FK.
    SessionProjector.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.layerFromPath(":memory:"),
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
  createReady: () =>
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

const timed = testEffect(layer({ subagentTimeoutMs: 50 }))
const timedWorktree = testEffect(
  Layer.mergeAll(layer({ subagentTimeoutMs: 50 }), worktreeMock),
)
const timedBackgroundWorktree = testEffect(
  Layer.mergeAll(layer({ subagentTimeoutMs: 50 }), worktreeMock),
)
const bounded = testEffect(layer({ subagentOutputMaxChars: 10 }))
const off = testEffect(layer({ subagentTimeoutMs: undefined, subagentOutputMaxChars: undefined }))

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

function failedReply(input: SessionPrompt.PromptInput, error: SessionV1.Assistant["error"]): SessionV1.WithParts {
  const result = reply(input, "")
  if (result.info.role !== "assistant") throw new Error("expected an assistant reply")
  result.info.finish = "error"
  result.info.error = error
  result.parts = []
  return result
}

const stubOps = (prompt: TaskPromptOps["prompt"]): TaskPromptOps => ({
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt,
})

const execCtx = (
  chat: { id: SessionID },
  assistant: { id: MessageID },
  promptOps: TaskPromptOps,
  abort = new AbortController().signal,
) => ({
  sessionID: chat.id,
  messageID: assistant.id,
  agent: "build",
  abort,
  extra: { promptOps },
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const subagentState = (metadata: unknown) =>
  (metadata as { deepagent?: { subagent?: { state?: string } } } | undefined)?.deepagent?.subagent?.state

describe("tool.task explicit recovery (no automatic replay)", () => {
  timed.instance("a hung subagent is interrupted without creating a replacement child", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        return Effect.never
      })

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          execCtx(chat, assistant, promptOps),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("[attempt_timeout]")
      expect(failure).toContain("Automatic retry is disabled")
      expect(failure).toContain("task_read")
      expect(failure).toContain(String(calls[0]))
      expect(calls).toHaveLength(1)

      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")
      expect(TaskConcurrency.activeSessionLimiters()).toBe(0)

      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("interrupted")
    }),
  )

  timed.instance(
    "a crashing subagent fails without replaying provider work",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: SessionID[] = []
        const promptOps = stubOps((input) => {
          calls.push(input.sessionID)
          return Effect.fail(new Error("boom"))
        })

        const exit = yield* def
          .execute(
            { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
            execCtx(chat, assistant, promptOps),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        expect(failure).toContain("[runtime_error]")
        expect(failure).toContain("not automatically retried")
        expect(failure).toContain("task_read")
        expect(calls).toHaveLength(1)

        const jobs = yield* BackgroundJob.Service
        expect((yield* jobs.get(calls[0]!))?.status).toBe("error")
        const sessions = yield* Session.Service
        expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("error")
      }),
    10_000,
  )

  timed.instance("timeout returns one bounded recovery pointer to the original child", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        return Effect.never
      })

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          execCtx(chat, assistant, promptOps),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("[attempt_timeout]")
      expect(failure).toContain("Automatic retry is disabled")
      expect(failure).toContain("task_read")
      expect(calls).toHaveLength(1)
      expect(failure).toContain(String(calls[0]))

      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")

      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("interrupted")
    }),
  )

  timed.instance("legacy token budget errors settle as terminal errors without replay", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        return Effect.succeed(
          failedReply(
            input,
            new SessionV1.TaskBudgetExceededError({
              message: "legacy token budget reached",
              budget: "tokens",
              limit: 200_000,
              used: 200_001,
            }).toObject(),
          ),
        )
      })

      const exit = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          execCtx(chat, assistant, promptOps),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("[budget_exhausted]")
      expect(calls).toHaveLength(1)

      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("error")
      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("error")
    }),
  )

  timed.instance("foreground abort cancels the job without relying on child-session cancellation", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: SessionID[] = []
      const abort = new AbortController()
      const promptOps = stubOps((input) => {
        calls.push(input.sessionID)
        return Effect.never
      })
      const fiber = yield* def
        .execute(
          { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
          execCtx(chat, assistant, promptOps, abort.signal),
        )
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        Effect.sync(() => (calls.length === 1 ? true : undefined)),
        "foreground task never started",
      )
      abort.abort()
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("Task interrupted by the user")
      expect(calls).toHaveLength(1)
      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")
      const sessions = yield* Session.Service
      expect(subagentState((yield* sessions.get(calls[0]!)).metadata)).toBe("interrupted")
    }),
  )

  timedWorktree.instance("timeout preserves the original worktree for explicit recovery", () =>
    Effect.gen(function* () {
      resetWorktreeLog()
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps(() => Effect.never)

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            isolation: "worktree",
          },
          execCtx(chat, assistant, promptOps),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("[attempt_timeout]")
      expect(wt.created).toHaveLength(1)
      expect(wt.removed).toEqual([])
      expect(wt.safeRemoved).toEqual([])
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

  timedBackgroundWorktree.instance("background timeout reports the original child without replay", () =>
    Effect.gen(function* () {
      resetWorktreeLog()
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
        return Effect.never
      })

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
          isolation: "worktree",
        },
        execCtx(chat, assistant, promptOps),
      )
      expect(started.output).toContain(`state="running"`)

      yield* pollWithTimeout(
        Effect.gen(function* () {
          return injected.length > 0 ? (true as const) : undefined
        }),
        "background timeout notification was not injected",
      )

      expect(calls).toHaveLength(1)
      expect(injected[0]).toContain("timed out")
      expect(injected[0]).toContain("Automatic retry is disabled")
      expect(injected[0]).toContain("task_read")
      expect(injected[0]).toContain(String(calls[0]))
      expect((yield* jobs.get(calls[0]!))?.status).toBe("cancelled")
      expect(wt.created).toHaveLength(1)
      expect(wt.removed).toEqual([])
      expect(wt.safeRemoved).toEqual([])
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
