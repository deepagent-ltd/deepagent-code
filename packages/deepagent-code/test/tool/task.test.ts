import { describe, expect } from "bun:test"
import path from "node:path"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
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
import { Git } from "@/git"
import { PRQueue } from "@/agent/pr-queue"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"

// Read the agent_mode_override a task injected onto the child session's first user-message metadata.
const childOverride = (input: SessionPrompt.PromptInput | undefined): string | undefined => {
  const deepagent = (input?.metadata as { deepagent?: { agent_mode_override?: unknown } } | undefined)?.deepagent
  return typeof deepagent?.agent_mode_override === "string" ? deepagent.agent_mode_override : undefined
}

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

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
const worktreeFixture = { directory: "", safeRemoved: 0 }
const worktreeIsolation = testEffect(
  Layer.mergeAll(
    layer(),
    Layer.mock(Worktree.Service, {
      create: () =>
        Effect.sync(() => ({
          name: "canonical-path-test",
          branch: "deepagent-code/canonical-path-test",
          directory: worktreeFixture.directory,
        })),
      createReady: () =>
        Effect.sync(() => ({
          name: "canonical-path-test",
          branch: "deepagent-code/canonical-path-test",
          directory: worktreeFixture.directory,
        })),
      remove: () => Effect.succeed(true),
      safeRemove: () =>
        Effect.sync(() => {
          worktreeFixture.safeRemoved++
          return true
        }),
    }),
  ),
)
const automaticWorktree = testEffect(Layer.mergeAll(layer(), Worktree.defaultLayer, Git.defaultLayer, PRQueue.layer))
const automaticWorktreeWithTimeout = testEffect(
  Layer.mergeAll(layer({ subagentTimeoutMs: 5_000 }), Worktree.defaultLayer, Git.defaultLayer, PRQueue.layer),
)
// U5: background subagents are ON by default now; this variant explicitly disables them to assert
// the rejection path still works when a user opts out.
const noBackground = testEffect(layer({ experimentalBackgroundSubagents: false }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
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

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

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
      ...(input.format?.type === "json_schema" ? { structured: sampleSchema(input.format.schema) } : {}),
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function sampleSchema(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0)
    return sampleSchema(schema.anyOf[0] as Record<string, unknown>)
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
    return Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [key, sampleSchema(value)]))
  }
  if (schema.type === "array") return []
  if (schema.type === "number" || schema.type === "integer") return 0
  if (schema.type === "boolean") return true
  if (schema.type === "null") return null
  return "done"
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  // Task 6 (§5 auto-mount): a native reviewer/researcher subagent goes through the structured-output
  // path by default (format set on the subagent prompt) even when the model did NOT pass output_schema.
  it.instance("auto-mounts the structured output schema for a native reviewer subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "review the change",
          prompt: "critique this diff",
          subagent_type: "reviewer",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // No output_schema was passed, yet the subagent prompt is driven through json_schema.
      expect(seen?.format?.type).toBe("json_schema")
      const schema = seen?.format?.type === "json_schema" ? (seen.format.schema as Record<string, unknown>) : undefined
      expect((schema?.properties as Record<string, unknown>)?.verdict).toBeDefined()
    }),
  )

  it.instance("does NOT auto-mount a schema for a plain (non-orchestration) subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.format).toBeUndefined()
    }),
  )

  // §5a: N concurrent foreground `task` calls on ONE parent session never exceed the configured
  // code-layer concurrency cap. The prompt op blocks on a shared latch while recording live count.
  it.instance(
    "throttles concurrent foreground subagents to the configured maxConcurrency",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        let live = 0
        let peak = 0
        const release = defer<void>()
        let started = 0
        const allStarted = defer<void>()
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              live += 1
              peak = Math.max(peak, live)
              started += 1
              if (started >= 4) allStarted.resolve()
              // Hold the slot until every fiber that CAN start has started, so the peak is observable.
              yield* Effect.promise(() => Promise.race([release.promise, delay(500)]))
              live -= 1
              return reply(input, "done")
            }),
        }

        const exec = () =>
          def.execute(
            {
              description: "research module",
              prompt: "research the module",
              subagent_type: "reviewer",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

        const fiber = yield* Effect.all([exec(), exec(), exec(), exec(), exec(), exec()], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild)

        // Give the semaphore time to admit the first batch, then release everyone.
        yield* Effect.sleep("150 millis")
        release.resolve()
        yield* Fiber.join(fiber)

        // width configured to 2 below ⇒ peak concurrency must never exceed 2.
        expect(peak).toBeLessThanOrEqual(2)
        expect(peak).toBe(2)
      }),
    {
      config: {
        experimental: {
          orchestration: { max_concurrency: 2 },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.get(input.sessionID))?.status).toBe("cancelled")
      const sessions = yield* Session.Service
      expect((yield* sessions.get(input.sessionID)).metadata?.deepagent?.subagent?.state).toBe("interrupted")
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  worktreeIsolation.instance("persists the canonical worktree directory on the child session", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const root = await mkdtemp("/tmp/deepagent-code-task-worktree-")
        const target = `${root}/target`
        const alias = `${root}/alias`
        await mkdir(target)
        await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
        worktreeFixture.directory = alias
        worktreeFixture.safeRemoved = 0
        return { root, target, alias }
      }),
      ({ target, alias }) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              description: "inspect isolated bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              isolation: "worktree",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)
          expect(child.directory).toBe(FSUtil.resolve(target))
          expect(child.directory).not.toBe(alias)
          expect(worktreeFixture.safeRemoved).toBe(0)
        }),
      ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  )

  automaticWorktree.instance(
    "serializes write subagents in a shared directory when Git worktrees are unavailable",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const childDirectories = new Set<string>()
        let active = 0
        let maxActive = 0

        const execute = (name: string) =>
          def.execute(
            { description: `fallback ${name}`, prompt: name, subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: `tool_fallback_${name}`,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: (input) =>
                    Effect.gen(function* () {
                      const child = yield* sessions.get(input.sessionID)
                      childDirectories.add(child.directory)
                      active += 1
                      maxActive = Math.max(maxActive, active)
                      yield* Effect.promise(() => Bun.write(path.join(child.directory, `${name}.txt`), `${name}\n`))
                      yield* Effect.sleep("75 millis")
                      active -= 1
                      return reply(input, `completed ${name}`)
                    }),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

        const results = yield* Effect.all([execute("alpha"), execute("beta")], { concurrency: "unbounded" })

        expect(results.map((result) => result.output)).toEqual([
          expect.stringContaining("completed alpha"),
          expect.stringContaining("completed beta"),
        ])
        expect(maxActive).toBe(1)
        expect([...childDirectories]).toEqual([directory])
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "alpha.txt")).text())).toBe("alpha\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "beta.txt")).text())).toBe("beta\n")
        expect(yield* worktree.list()).toEqual([])
        expect((yield* queue.list()).filter((entry) => entry.parentID === chat.id)).toEqual([])
      }),
    15_000,
  )

  automaticWorktree.instance(
    "rejects a dirty Git parent before starting a write subagent or creating a worktree",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        yield* Effect.promise(() => Bun.write(path.join(directory, "user-change.txt"), "preserve me\n"))
        let promptCalls = 0
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* Effect.exit(
          def.execute(
            { description: "must not start", prompt: "write generated.txt", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: "tool_dirty_parent",
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: stubOps({
                  onPrompt: () => {
                    promptCalls++
                  },
                }),
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(promptCalls).toBe(0)
        expect(yield* worktree.list()).toEqual([])
        expect((yield* queue.list()).filter((entry) => entry.parentID === chat.id)).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "user-change.txt")).text())).toBe(
          "preserve me\n",
        )
      }),
    { git: true },
  )

  automaticWorktree.instance(
    "commits and queues an automatically isolated write subagent for review",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const git = yield* Git.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let childDirectory = ""

        const result = yield* def.execute(
          {
            description: "implement isolated worker change",
            prompt: "write worker-output.txt",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                cancel: () => Effect.void,
                resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                prompt: (input) =>
                  Effect.gen(function* () {
                    childDirectory = (yield* sessions.get(input.sessionID)).directory
                    yield* Effect.promise(() => Bun.write(path.join(childDirectory, "worker-output.txt"), "worker\n"))
                    return reply(input, "implemented")
                  }),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("implemented")
        expect(result.output).toContain('state="awaiting_review"')
        expect(childDirectory).not.toBe(directory)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-output.txt")).exists())).toBe(false)
        expect((yield* worktree.list()).map((item) => item.directory)).toContain(childDirectory)
        expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
        expect(yield* git.branch(directory)).toBe(`deepagent-code/session-${chat.id}`)
        const pr = yield* queue.get(String(result.metadata.prId))
        expect(pr?.status).toBe("awaiting_review")
        expect(pr?.workerID).toBe(result.metadata.sessionId)
        const workerCommit = yield* git.commitMetadata(childDirectory, "HEAD")
        expect(workerCommit?.author).toEqual({ name: "coauthor-deepagent", email: "coauthor@deepagent.ltd" })
      }),
    { git: true },
    15_000,
  )

  automaticWorktree.instance(
    "settles, queues, and notifies an automatically isolated background writer",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const notifications: SessionPrompt.PromptInput[] = []

        const result = yield* def.execute(
          {
            description: "implement background worker change",
            prompt: "write background-output.txt",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                cancel: () => Effect.void,
                resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                prompt: (input) =>
                  Effect.gen(function* () {
                    if (input.sessionID === chat.id) {
                      notifications.push(input)
                      return reply(input, "notification accepted")
                    }
                    const child = yield* sessions.get(input.sessionID)
                    yield* Effect.promise(() =>
                      Bun.write(path.join(child.directory, "background-output.txt"), "background\n"),
                    )
                    return reply(input, "background implemented")
                  }),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain('state="running"')
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const child = yield* sessions.get(result.metadata.sessionId)
            const queued = (yield* queue.list()).find((entry) => entry.workerID === child.id)
            const preserved = (yield* worktree.list()).length === 1
            return child.metadata?.deepagent?.subagent?.state === "completed" &&
              queued &&
              preserved &&
              notifications.length === 1
              ? child
              : undefined
          }),
          "background writer did not settle, queue, and notify",
          "10 seconds",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "background-output.txt")).exists())).toBe(
          false,
        )
        expect(notifications).toHaveLength(1)
        expect(notifications[0]?.parts[0]?.type === "text" ? notifications[0].parts[0].text : "").toContain(
          'state="awaiting_review"',
        )
        expect(notifications[0]?.metadata?.deepagent?.task_notification).toBeDefined()
      }),
    { git: true },
    15_000,
  )

  automaticWorktree.instance(
    "resumes a requested-change author in the original worktree and resubmits the same PR",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const queue = yield* PRQueue.Service
        const worktree = yield* Worktree.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              const child = yield* sessions.get(input.sessionID)
              const revision = input.parts.some((part) => part.type === "text" && part.text.includes("revise"))
                ? "revised\n"
                : "initial\n"
              yield* Effect.promise(() => Bun.write(path.join(child.directory, "revision.txt"), revision))
              return reply(input, revision.trim())
            }),
        }
        const context = (callID: string) => ({
          sessionID: chat.id,
          messageID: assistant.id,
          callID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })

        const first = yield* def.execute(
          { description: "implement revision", prompt: "write initial revision", subagent_type: "general" },
          context("tool_revision_initial"),
        )
        const initial = yield* queue.get(String(first.metadata.prId))
        expect(initial?.status).toBe("awaiting_review")
        expect(
          yield* queue.verdict({
            id: initial!.id,
            reviewerID: initial!.reviewerID,
            sha: initial!.workerHead!,
            verdict: "changes_requested",
          }),
        ).toMatchObject({ status: "changes_requested", redoCount: 1 })
        const originalDirectory = (yield* sessions.get(first.metadata.sessionId)).directory

        const revised = yield* def.execute(
          {
            description: "revise implementation",
            prompt: "revise revision.txt",
            subagent_type: "general",
            task_id: String(first.metadata.sessionId),
          },
          context("tool_revision_fix"),
        )
        const resubmitted = yield* queue.get(initial!.id)

        expect(revised.metadata.prId).toBe(initial!.id)
        expect((yield* sessions.get(first.metadata.sessionId)).directory).toBe(originalDirectory)
        expect((yield* worktree.list()).map((item) => item.directory)).toEqual([originalDirectory])
        expect(resubmitted?.status).toBe("awaiting_review")
        expect(resubmitted?.redoCount).toBe(1)
        expect(resubmitted?.workerHead).not.toBe(initial?.workerHead)
        expect(yield* Effect.promise(() => Bun.file(path.join(originalDirectory, "revision.txt")).text())).toBe(
          "revised\n",
        )
      }),
    { git: true },
    15_000,
  )

  automaticWorktreeWithTimeout.instance(
    "commits and queues uncommitted worker output through the timeout-supervised path",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "implement supervised worker change",
            prompt: "write supervised-output.txt",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                cancel: () => Effect.void,
                resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                prompt: (input) =>
                  Effect.gen(function* () {
                    const child = yield* sessions.get(input.sessionID)
                    yield* Effect.promise(() =>
                      Bun.write(path.join(child.directory, "supervised-output.txt"), "supervised\n"),
                    )
                    return reply(input, "supervised implementation complete")
                  }),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.output).toContain("supervised implementation complete")
        expect(result.output).toContain('state="awaiting_review"')
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "supervised-output.txt")).exists())).toBe(
          false,
        )
        expect(yield* worktree.list()).toHaveLength(1)
        expect((yield* queue.list()).filter((entry) => entry.parentID === chat.id)).toHaveLength(1)
      }),
    { git: true },
    15_000,
  )

  automaticWorktree.instance(
    "runs two write subagents concurrently and queues both isolated commits in one review batch",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const git = yield* Git.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const bothStarted = yield* Deferred.make<void>()
        const childDirectories: string[] = []
        let started = 0

        const execute = (file: string) =>
          def.execute(
            {
              description: `implement ${file}`,
              prompt: `write ${file}`,
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: (input) =>
                    Effect.gen(function* () {
                      const childDirectory = (yield* sessions.get(input.sessionID)).directory
                      childDirectories.push(childDirectory)
                      yield* Effect.promise(() => Bun.write(path.join(childDirectory, file), `${file}\n`))
                      started += 1
                      if (started === 2) yield* Deferred.succeed(bothStarted, undefined)
                      yield* Deferred.await(bothStarted)
                      return reply(input, `implemented ${file}`)
                    }),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

        const results = yield* Effect.all([execute("worker-a.txt"), execute("worker-b.txt")], {
          concurrency: "unbounded",
        })

        expect(results.map((result) => result.output)).toEqual([
          expect.stringContaining("implemented worker-a.txt"),
          expect.stringContaining("implemented worker-b.txt"),
        ])
        expect(new Set(childDirectories).size).toBe(2)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-a.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "worker-b.txt")).exists())).toBe(false)
        expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
        expect(yield* worktree.list()).toHaveLength(2)
        const queued = (yield* queue.list()).filter((entry) => entry.parentID === chat.id)
        expect(queued.map((entry) => entry.status)).toEqual(["awaiting_review", "awaiting_review"])
        expect(new Set(queued.map((entry) => entry.reviewerID)).size).toBe(1)
        expect(new Set(queued.map((entry) => entry.metadata?.batchID))).toEqual(new Set([assistant.id]))
        const workerAuthors = yield* Effect.forEach(childDirectories, (childDirectory) =>
          git.commitMetadata(childDirectory, "HEAD"),
        )
        expect(workerAuthors.map((commit) => commit?.author)).toEqual([
          { name: "coauthor-deepagent", email: "coauthor@deepagent.ltd" },
          { name: "coauthor-deepagent", email: "coauthor@deepagent.ltd" },
        ])
      }),
    { git: true },
    15_000,
  )

  automaticWorktree.instance(
    "keeps both worktrees available when one concurrent worker fails without replay",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const bothStarted = yield* Deferred.make<void>()
        const children: SessionID[] = []
        let started = 0

        const execute = (file: string, fail: boolean) =>
          def.execute(
            {
              description: `implement ${file}`,
              prompt: `write ${file}`,
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: (input) =>
                    Effect.gen(function* () {
                      const child = yield* sessions.get(input.sessionID)
                      children.push(child.id)
                      yield* Effect.promise(() => Bun.write(path.join(child.directory, file), `${file}\n`))
                      started++
                      if (started === 2) yield* Deferred.succeed(bothStarted, undefined)
                      yield* Deferred.await(bothStarted)
                      if (fail) return yield* Effect.fail(new Error("injected worker failure"))
                      return reply(input, `implemented ${file}`)
                    }),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

        const [failed, succeeded] = yield* Effect.all(
          [Effect.exit(execute("failed.txt", true)), Effect.exit(execute("successful.txt", false))],
          { concurrency: "unbounded" },
        )

        expect(Exit.isFailure(failed)).toBe(true)
        expect(Exit.isSuccess(succeeded)).toBe(true)
        expect(children).toHaveLength(2)
        const childStates = yield* Effect.forEach(children, (childID) =>
          sessions
            .get(childID)
            .pipe(Effect.map((child) => ({ childID, state: child.metadata?.deepagent?.subagent?.state }))),
        )
        expect(childStates.map((child) => child.state).sort()).toEqual(["completed", "error"])
        const successfulChild = childStates.find((child) => child.state === "completed")
        if (!successfulChild) return yield* Effect.die("successful sibling session is missing")
        const failedChild = childStates.find((child) => child.state === "error")
        if (!failedChild) return yield* Effect.die("failed sibling session is missing")
        const queued = (yield* queue.list()).filter((entry) => entry.parentID === chat.id)
        expect(queued).toHaveLength(1)
        expect(queued[0]?.workerID).toBe(successfulChild.childID)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "successful.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "failed.txt")).exists())).toBe(false)
        const failedSession = yield* sessions.get(failedChild.childID)
        expect(yield* Effect.promise(() => Bun.file(path.join(failedSession.directory, "failed.txt")).exists())).toBe(
          true,
        )
        expect(yield* worktree.list()).toHaveLength(2)
      }),
    { git: true },
    15_000,
  )

  automaticWorktree.instance(
    "queues parallel conflicting writes without touching the parent before review",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const git = yield* Git.Service
        const worktree = yield* Worktree.Service
        const queue = yield* PRQueue.Service
        yield* Effect.promise(() => Bun.write(path.join(directory, "shared.txt"), "base\n"))
        expect(
          (yield* git.commitScoped(directory, {
            paths: ["shared.txt"],
            message: "test: add shared fixture",
            author: { name: "Test", email: "test@example.com" },
          })).exitCode,
        ).toBe(0)
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const bothStarted = yield* Deferred.make<void>()
        const childSessionIDs: SessionID[] = []
        let started = 0

        const execute = (content: string) =>
          def.execute(
            {
              description: `write conflicting value ${content}`,
              prompt: `replace shared.txt with ${content}`,
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: (input) =>
                    Effect.gen(function* () {
                      const child = yield* sessions.get(input.sessionID)
                      childSessionIDs.push(child.id)
                      yield* Effect.promise(() => Bun.write(path.join(child.directory, "shared.txt"), `${content}\n`))
                      started += 1
                      if (started === 2) yield* Deferred.succeed(bothStarted, undefined)
                      yield* Deferred.await(bothStarted)
                      return reply(input, `wrote ${content}`)
                    }),
                } satisfies TaskPromptOps,
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

        const exits = yield* Effect.all([Effect.exit(execute("alpha")), Effect.exit(execute("beta"))], {
          concurrency: "unbounded",
        })

        expect(exits.filter(Exit.isSuccess)).toHaveLength(2)
        expect(exits.filter(Exit.isFailure)).toHaveLength(0)
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, "shared.txt")).text())).toBe("base\n")
        expect((yield* git.porcelainStatus(directory))?.clean).toBe(true)
        expect(yield* git.resolveRef(directory, "MERGE_HEAD")).toBeUndefined()
        const remaining = yield* worktree.list()
        expect(remaining).toHaveLength(2)
        expect((yield* queue.list()).filter((entry) => entry.parentID === chat.id)).toHaveLength(2)
        const childStates = yield* Effect.forEach(childSessionIDs, (sessionID) =>
          sessions.get(sessionID).pipe(Effect.map((session) => session.metadata?.deepagent?.subagent?.state)),
        )
        expect(childStates.sort()).toEqual(["completed", "completed"])
      }),
    { git: true },
    15_000,
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let research: SessionPrompt.PromptInput | undefined
        let finalizer: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({
          onPrompt: (input) => {
            if (input.format?.type === "json_schema") finalizer = input
            else research = input
          },
        })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.metadata?.deepagent?.subagent).toMatchObject({
          finished: true,
          state: "completed",
          phase: "settled",
          reason: "structured_output_valid",
          generation: 1,
          attempts: 1,
          run_id: expect.any(String),
          raw_result_ref: expect.any(String),
          settled_at: expect.any(Number),
        })
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(research?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
        expect(finalizer?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  noBackground.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      expect((yield* sessions.get(started.metadata.sessionId)).metadata?.deepagent?.subagent).toMatchObject({
        generation: 1,
        state: "completed",
        finished: true,
      })
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  // Subagent work-intensity — "downgrade": the child's prompt carries an agent_mode_override exactly
  // one strength below the parent's EFFECTIVE agentMode (AgentGateway snapshot). Parent = max ⇒ child = xhigh.
  it.instance(
    "downgrade intensity injects agent_mode_override one level below the parent mode",
    () =>
      Effect.gen(function* () {
        AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: undefined })
        try {
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(childOverride(seen)).toBe("xhigh")
        } finally {
          AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
        }
      }),
    {
      config: {
        provider: { deepagent: { name: "DeepAgent", options: { subagentIntensity: "downgrade" }, models: {} } },
      },
    },
  )

  // "inherit" (default): nothing is injected, so the child naturally runs at the process-global mode.
  it.instance(
    "inherit intensity injects no agent_mode_override",
    () =>
      Effect.gen(function* () {
        AgentGateway.configure({ enabled: true, agentMode: "max", runsDir: undefined })
        try {
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

          yield* def.execute(
            { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(childOverride(seen)).toBeUndefined()
        } finally {
          AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
        }
      }),
    {
      config: { provider: { deepagent: { name: "DeepAgent", options: { subagentIntensity: "inherit" }, models: {} } } },
    },
  )

  // Per-request isolation: many concurrent downgraded subagents each carry their OWN override on their
  // OWN child-session prompt. The override rides per-prompt metadata (never the process-global mode),
  // so parallel children never cross-contaminate — every one sees the same correct downgraded value.
  it.instance(
    "concurrent downgraded subagents each get an independent, uncontaminated override",
    () =>
      Effect.gen(function* () {
        AgentGateway.configure({ enabled: true, agentMode: "ultra", runsDir: undefined })
        try {
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const byChild = new Map<string, string | undefined>()
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.gen(function* () {
                // Yield so fibers interleave; if the channel leaked to shared state this would surface.
                yield* Effect.sleep("5 millis")
                byChild.set(input.sessionID, childOverride(input))
                return reply(input, "done")
              }),
          }

          const exec = () =>
            def.execute(
              { description: "research module", prompt: "research the module", subagent_type: "researcher" },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra: { promptOps },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )

          yield* Effect.all([exec(), exec(), exec(), exec()], { concurrency: "unbounded" })

          // Four distinct child sessions, each independently pinned to ultra→max. None missing/leaked.
          expect(byChild.size).toBe(4)
          for (const value of byChild.values()) expect(value).toBe("max")
        } finally {
          AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined })
        }
      }),
    {
      config: {
        provider: { deepagent: { name: "DeepAgent", options: { subagentIntensity: "downgrade" }, models: {} } },
      },
    },
  )
})
