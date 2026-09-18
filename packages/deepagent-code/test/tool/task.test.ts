import { describe, expect } from "bun:test"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SUBAGENT_DEPTH_META_KEY } from "@/agent/subagent-permissions"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { SessionV2 } from "@deepagent-code/core/session"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskTool, TaskWriteAuthorizationError, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"

// Policy-gate coverage for the V2-authority TaskTool: every test here exercises a refusal that
// fires BEFORE the durable submission (permission, agent, depth, isolation fail-closed, schema,
// resume validation, and the honest missing-runtime failure). The durable
// submit/execute/settle E2E lives in task-v2-authority.test.ts against the real V2 runner.

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Store-backed V2 session reads: the tool resolves parent/child identity through the V2 store
// (SessionTable is shared with V1 writers), so the gate tests only need real reads — every
// mutating member stays unused on the pre-submission refusal paths under test.
const sessionV2Reads = Layer.effect(
  SessionV2.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const die = () => Effect.die("unused in gate tests")
    return SessionV2.Service.of({
      list: die,
      create: die,
      get: (id) =>
        store.get(id).pipe(
          Effect.flatMap((info) => (info ? Effect.succeed(info) : new SessionV2.NotFoundError({ sessionID: id }))),
        ),
      messages: die,
      message: die,
      context: die,
      events: () => Stream.never,
      switchAgent: die,
      switchModel: die,
      setPermissions: die,
      prompt: die,
      shell: die,
      skill: die,
      compact: die,
      wait: die,
      resume: die,
      interrupt: die,
    })
  }),
).pipe(Layer.provide(SessionStore.layer.pipe(Layer.provide(Database.defaultLayer))))

const baseLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionProjector.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const layer = (flags: Partial<RuntimeFlags.Info> = {}) => baseLayer(flags).pipe(Layer.provideMerge(sessionV2Reads))

const it = testEffect(layer())
const noBackground = testEffect(layer({ experimentalBackgroundSubagents: false }))
const noV2Runtime = testEffect(baseLayer())

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

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: () => Effect.die("promptOps.prompt is not on the V2 authority path"),
  }
}

function execCtx(input: {
  sessionID: SessionID
  messageID: MessageID
  promptOps?: TaskPromptOps
  ask?: () => Effect.Effect<void>
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: "tool_test_call",
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.promptOps ?? stubOps() },
    messages: [],
    metadata: () => Effect.void,
    ask: () => (input.ask ? input.ask() : Effect.void),
  }
}

describe("tool.task (V2 authority entry policy gates)", () => {
  noBackground.instance("background subagents refuse when the flag is off", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "probe", prompt: "p", subagent_type: "explore", background: true },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("DEEPAGENT_CODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
    }),
  )

  it.instance("permission denial fails the launch before any durable write", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "probe", prompt: "p", subagent_type: "explore" },
          execCtx({
            sessionID: chat.id,
            messageID: assistant.id,
            ask: () => Effect.die(new Error("denied: task")),
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("denied: task")
    }),
  )

  it.instance("unknown agent type refuses the launch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "probe", prompt: "p", subagent_type: "does-not-exist" },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("Unknown agent type: does-not-exist")
    }),
  )

  it.instance("unknown named output schema refuses the launch", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "probe", prompt: "p", subagent_type: "explore", output_schema: "NoSuchSchema" },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("Unknown output schema: NoSuchSchema")
    }),
  )

  // W6 fail-closed write authorization under the single V2 owner: the authority's children share
  // the parent workspace, so both explicit isolation requests and write-capable agents must fail
  // with the typed TaskWriteAuthorizationError instead of silently un-isolating writes.
  it.instance("explicit isolation=worktree fails closed with the typed authorization error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "probe", prompt: "p", subagent_type: "explore", isolation: "worktree" },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(TaskWriteAuthorizationError)
      expect((error as TaskWriteAuthorizationError).code).toBe("isolation_unavailable")
    }),
  )

  it.instance("a write-capable agent fails closed in the shared workspace", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "implement", prompt: "p", subagent_type: "general" },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(TaskWriteAuthorizationError)
      expect((error as TaskWriteAuthorizationError).detail).toContain("write-capable agent type")
    }),
  )

  it.instance("resume validation rejects an unknown task_id", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "continue", prompt: "p", subagent_type: "explore", task_id: "ses_missing_child" },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain('Cannot resume task "ses_missing_child": unknown session')
    }),
  )

  it.instance("resume validation rejects a session that is not a direct child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const other = yield* sessions.create({ title: "not a child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "continue", prompt: "p", subagent_type: "explore", task_id: other.id },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("it is not a direct child of the current session")
    }),
  )

  it.instance("resume validation rejects an agent-type mismatch", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ title: "child", parentID: chat.id, agent: "explore" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "continue", prompt: "p", subagent_type: "reviewer", task_id: child.id },
          execCtx({ sessionID: chat.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain('its agent type is "explore"')
    }),
  )

  it.instance("depth ceiling refuses a spawn beyond MAX_SUBAGENT_DEPTH", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: root.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      // Chain sessions to the hard depth ceiling; the deepest caller must not spawn further.
      let parent = root
      for (let depth = 1; depth <= 3; depth++) {
        const child = yield* sessions.create({
          title: `depth-${depth}`,
          parentID: parent.id,
          metadata: { deepagent: { [SUBAGENT_DEPTH_META_KEY]: depth } },
        })
        parent = child
      }
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { description: "too deep", prompt: "p", subagent_type: "researcher" },
          execCtx({ sessionID: parent.id, messageID: assistant.id }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(failure).toContain("Subagent depth limit reached")
    }),
  )

  noV2Runtime.instance(
    "a composition without the V2 session runtime fails honestly instead of executing",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const exit = yield* def
          .execute(
            { description: "probe", prompt: "p", subagent_type: "researcher" },
            execCtx({ sessionID: chat.id, messageID: assistant.id }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const failure = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
        expect(failure).toContain("task is unavailable")
        expect(failure).toContain("sessions: missing")
      }),
  )
})
