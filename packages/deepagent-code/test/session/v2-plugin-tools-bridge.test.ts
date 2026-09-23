import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect"
import { Schema } from "effect"
import { ToolCallID, ToolFailure } from "@deepagent-code/llm"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Tool } from "@deepagent-code/core/tool/tool"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { V2PluginToolsBridge } from "@/session/v2-plugin-tools-bridge"
import { InstanceRegistry } from "@/effect/instance-registry"
import { ToolRegistry } from "@/tool/registry"
import type { InstanceContext } from "@/project/instance-context"
import * as V1Tool from "@/tool/tool"

const instance: InstanceContext = {
  directory: "/fixture/project",
  worktree: "/fixture/project",
  project: { id: "/fixture/project" },
} as InstanceContext

// Ambient V2 execution-context fakes. In production these are the Location runner's
// PermissionV2/EventV2 services, present in the settle fiber's context when the Core
// registry settles a tool call; the bridge reads them through serviceOption.
const approvedPermission = PermissionV2.Service.of({
  ask: () => Effect.die("unused"),
  assert: () => Effect.void,
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})

const deniedPermission = (error: PermissionV2.Error) =>
  PermissionV2.Service.of({
    ask: () => Effect.die("unused"),
    assert: () => Effect.fail(error),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  })

const recordingEvents = (published: Array<{ type: string; data: unknown }>) =>
  EventV2.Service.of({
    publish: ((definition: { type: string }, data: unknown) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return data
      })) as EventV2.Interface["publish"],
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: (() => Effect.void) as EventV2.Interface["project"],
    replay: (() => Effect.void) as EventV2.Interface["replay"],
    replayAll: (() => Effect.succeed(undefined)) as EventV2.Interface["replayAll"],
    snapshot: () => Effect.succeed(undefined),
    checkpoint: () => Effect.die("unused"),
    claim: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    importSnapshot: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    canonicalizeLegacyArtifacts: () => Effect.die("unused"),
  })

const settleContext = {
  sessionID: SessionSchema.ID.make("ses_" + "a".repeat(64)),
  agent: AgentV2.ID.make("default"),
  assistantMessageID: SessionMessage.ID.create(),
  toolCallID: "call_plugin",
} satisfies Tool.Context

const call = (name: string) => ({ type: "tool-call" as const, id: ToolCallID.make("call_1"), name, input: { x: 1 } })

const settle = (name: string) =>
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const entry = applications.entries().get(name)
    if (!entry) return yield* Effect.die(`tool not registered: ${name}`)
    return yield* Tool.settle(entry.tool, call(name), settleContext)
  })

function waitFor(condition: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (condition()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not reached in time"))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe("V2PluginToolsBridge native execution semantics", () => {
  const metadataTool: V1Tool.Def = {
    id: "meta_tool",
    description: "publishes a titled result with metadata",
    parameters: Schema.Unknown,
    execute: () =>
      Effect.gen(function* () {
        return { title: "counted", metadata: { rows: 2 }, output: "did work" }
      }),
  }

  const progressTool: V1Tool.Def = {
    id: "progress_tool",
    description: "pushes live metadata updates",
    parameters: Schema.Unknown,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.metadata({ title: "step one", metadata: { step: 1 } })
        return { title: "", metadata: {}, output: "ok" }
      }),
  }

  const attachmentTool: V1Tool.Def = {
    id: "attachment_tool",
    description: "returns a remote attachment for Core materialization",
    parameters: Schema.Unknown,
    execute: () =>
      Effect.succeed({
        title: "remote image",
        metadata: {},
        output: "Image attached",
        attachments: [
          { type: "file", mime: "image/png", url: "https://assets.example.test/image.png", filename: "image.png" },
        ],
      }),
  }

  const askingTool: V1Tool.Def = {
    id: "asking_tool",
    description: "asks for permission through ctx.ask",
    parameters: Schema.Unknown,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "asking_tool", patterns: ["*"], metadata: { args }, always: ["*"] })
        return { title: "", metadata: {}, output: "ran" }
      }),
  }

  const slowTool = () => {
    const state = { started: false, aborted: false }
    const def: V1Tool.Def = {
      id: "slow_tool",
      description: "long-running plugin body that only stops on ctx.abort",
      parameters: Schema.Unknown,
      execute: (args, ctx) =>
        Effect.promise(
          () =>
            new Promise<V1Tool.ExecuteResult>((resolve) => {
              state.started = true
              ctx.abort.addEventListener(
                "abort",
                () => {
                  state.aborted = true
                  resolve({ title: "", metadata: {}, output: "aborted" })
                },
                { once: true },
              )
            }),
        ),
    }
    return { def, state }
  }

  // One shared runtime/instance: registration is instance-scoped in production, and a single
  // initializeInstance registers every tool below exactly once.
  const slow = slowTool()
  const rt = ManagedRuntime.make(
    Layer.mergeAll(
      ApplicationTools.layer,
      InstanceRegistry.layer,
      V2PluginToolsBridge.layer.pipe(
        Layer.provide(ApplicationTools.layer),
        Layer.provide(InstanceRegistry.layer),
        Layer.provide(
          Layer.succeed(
            ToolRegistry.Service,
            ToolRegistry.Service.of({
              ids: () => Effect.succeed([]),
              all: () => Effect.succeed([]),
              custom: () => Effect.succeed([metadataTool, progressTool, attachmentTool, askingTool, slow.def]),
              named: () => Effect.die("unused"),
              tools: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    ),
  )
  beforeAll(async () => {
    await rt.runPromise(InstanceRegistry.initializeInstance(instance))
  })
  afterAll(async () => {
    await rt.dispose()
  })

  test("settle persists title/metadata through the structured tool output", async () => {
    const output = await rt.runPromise(settle("meta_tool"))
    const structured = output.structured as Record<string, unknown>
    expect(structured["output"]).toBe("did work")
    expect(structured["title"]).toBe("counted")
    expect(structured["metadata"]).toEqual({ rows: 2 })
    expect(output.content[0]).toEqual({ type: "text", text: "did work" })
  })

  test("keeps remote plugin attachments for the Core artifact materializer", async () => {
    const output = await rt.runPromise(settle("attachment_tool"))
    expect(output.content[1]).toEqual({
      type: "file",
      source: { type: "url", url: "https://assets.example.test/image.png" },
      mime: "image/png",
      name: "image.png",
    })
  })

  test("ctx.metadata publishes a durable Tool.Progress event through EventV2", async () => {
    const published: Array<{ type: string; data: unknown }> = []
    const output = await rt.runPromise(
      settle("progress_tool").pipe(Effect.provideService(EventV2.Service, recordingEvents(published))),
    )
    expect((output.structured as Record<string, unknown>)["output"]).toBe("ok")
    const progress = published.find((event) => event.type === SessionEvent.Tool.Progress.type)
    expect(progress).toBeDefined()
    expect((progress?.data as { callID: string }).callID).toBe("call_plugin")
    expect((progress?.data as { structured: Record<string, unknown> }).structured).toEqual({ step: 1 })
    expect((progress?.data as { content: Array<{ type: string; text: string }> }).content).toEqual([
      { type: "text", text: "step one" },
    ])
  })

  test("ctx.ask approval routes through PermissionV2 and the tool runs", async () => {
    const output = await rt.runPromise(
      settle("asking_tool").pipe(Effect.provideService(PermissionV2.Service, approvedPermission)),
    )
    expect((output.structured as Record<string, unknown>)["output"]).toBe("ran")
  })

  test("ctx.ask rejection is a typed tool failure, never a die inside settle", async () => {
    const exit = await rt.runPromiseExit(
      settle("asking_tool").pipe(
        Effect.provideService(PermissionV2.Service, deniedPermission(new PermissionV2.RejectedError())),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    // The denial must surface as a typed ToolFailure error, not a defect/die.
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(error instanceof ToolFailure).toBe(true)
    expect((error as ToolFailure).message).toContain("rejected")
  })

  test("ctx.ask rule denial is a typed tool failure naming the rules", async () => {
    const exit = await rt.runPromiseExit(
      settle("asking_tool").pipe(
        Effect.provideService(
          PermissionV2.Service,
          deniedPermission(
            new PermissionV2.DeniedError({
              rules: [{ action: "asking_tool", resource: "*", effect: "deny" }],
            }),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(error instanceof ToolFailure).toBe(true)
  })

  test("interrupting the settle fiber aborts the plugin body through ctx.abort", async () => {
    const interrupted = await rt.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          settle("slow_tool").pipe(Effect.provideService(PermissionV2.Service, approvedPermission)),
        )
        // Wait until the plugin body actually started before cancelling the turn.
        yield* Effect.promise(() => waitFor(() => slow.state.started, 1_000))
        return yield* Fiber.interrupt(fiber).pipe(Effect.timeoutOption("2 seconds"))
      }),
    )
    expect(Option.isSome(interrupted)).toBe(true)
    expect(slow.state.aborted).toBe(true)
  })

  test("instance disposal detaches the batch and reload re-registers", async () => {
    const reloadRt = ManagedRuntime.make(
      Layer.mergeAll(
        ApplicationTools.layer,
        InstanceRegistry.layer,
        V2PluginToolsBridge.layer.pipe(
          Layer.provide(ApplicationTools.layer),
          Layer.provide(InstanceRegistry.layer),
          Layer.provide(
            Layer.succeed(
              ToolRegistry.Service,
              ToolRegistry.Service.of({
                ids: () => Effect.succeed([]),
                all: () => Effect.succeed([]),
                custom: () => Effect.succeed([metadataTool]),
                named: () => Effect.die("unused"),
                tools: () => Effect.die("unused"),
              }),
            ),
          ),
        ),
      ),
    )
    const registered = () =>
      reloadRt.runPromise(
        Effect.map(Effect.service(ApplicationTools.Service), (applications) => applications.entries().has("meta_tool")),
      )

    await reloadRt.runPromise(InstanceRegistry.initializeInstance(instance))
    expect(await registered()).toBe(true)

    await reloadRt.runPromise(InstanceRegistry.disposeInstanceState(instance))
    expect(await registered()).toBe(false)

    const reloaded: InstanceContext = {
      directory: "/fixture/project",
      worktree: "/fixture/project",
      project: { id: "/fixture/project" },
    } as InstanceContext
    await reloadRt.runPromise(InstanceRegistry.initializeInstance(reloaded))
    expect(await registered()).toBe(true)
    await reloadRt.dispose()
  })
})
