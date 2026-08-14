import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { Permission } from "../../src/permission"
import { executeWithHostPermissionAdmission, executeWithPermissionAuthority } from "../../src/session/tools"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool/tool"

const started = {
  receiptID: "permission-effect:permission-1",
  requestID: "permission-1",
  activityKind: "legacy" as const,
  activityID: "activity-1",
  sessionID: "session-1",
  projectID: "project-1",
  toolMessageID: "message-1",
  toolCallID: "call-1",
  toolName: "bash",
  consumerID: "tool:message-1:call-1",
  ownerID: "runtime-1",
  state: "started" as const,
  version: 1,
  startedAt: 1,
} satisfies Permission.EffectGrant

test("permission effect chokepoint rebuilds terminal success without executing the tool", async () => {
  let executions = 0
  const result = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () =>
          Effect.succeed([
            {
              ...started,
              state: "settled",
              version: 2,
              outcome: "success",
              result: { output: "durable" },
              resultHash: "a".repeat(64),
              settledAt: 2,
            },
          ]),
      }),
      context: context(),
      toolName: "bash",
      execute: Effect.sync(() => {
        executions++
        return { output: "executed" }
      }),
    }),
  )

  expect(result).toEqual({ output: "durable" })
  expect(executions).toBe(0)
})

for (const state of ["started", "unknown"] as const) {
  test(`permission effect chokepoint fails closed for ${state} without executing the tool`, async () => {
    let executions = 0
    const exit = await Effect.runPromise(
      executeWithPermissionAuthority({
        permission: permission({ effectsForToolCall: () => Effect.succeed([{ ...started, state }]) }),
        context: context(),
        toolName: "bash",
        execute: Effect.sync(() => {
          executions++
          return { output: "executed" }
        }),
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(executions).toBe(0)
  })
}

test("permission effect chokepoint settles success after the tool obtains a grant", async () => {
  const ctx = context()
  const settled: Array<{ outcome: "success" | "failure"; result: unknown }> = []
  const result = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () => Effect.succeed([]),
        settleEffect: (input) =>
          Effect.sync(() => {
            settled.push({ outcome: input.outcome, result: input.result })
            return { ...input.grant, state: "settled", version: 2, outcome: input.outcome, result: input.result }
          }),
      }),
      context: ctx,
      toolName: "bash",
      execute: Effect.sync(() => {
        ctx.permissionEffectGrants!.push(started)
        return { output: "fresh" }
      }),
    }),
  )

  expect(result).toEqual({ output: "fresh" })
  expect(settled).toEqual([{ outcome: "success", result: { output: "fresh" } }])
})

test("permission effect chokepoint settles failure before preserving the original tool failure", async () => {
  const ctx = context()
  const settled: Array<{ outcome: "success" | "failure"; result: unknown }> = []
  const exit = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () => Effect.succeed([]),
        settleEffect: (input) =>
          Effect.sync(() => {
            settled.push({ outcome: input.outcome, result: input.result })
            return { ...input.grant, state: "settled", version: 2, outcome: input.outcome, result: input.result }
          }),
      }),
      context: ctx,
      toolName: "bash",
      execute: Effect.gen(function* () {
        ctx.permissionEffectGrants!.push(started)
        return yield* Effect.fail(new Error("tool failed"))
      }),
    }).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(settled).toHaveLength(1)
  expect(settled[0]?.outcome).toBe("failure")
  expect(settled[0]?.result).toMatchObject({ message: expect.stringContaining("tool failed") })
})

test("permission effect chokepoint rotates authority before propagating a tool interruption", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ctx = context()
      const startedEffect = yield* Deferred.make<void>()
      let rotations = 0
      let settlements = 0
      const fiber = yield* executeWithPermissionAuthority({
        permission: permission({
          effectsForToolCall: () => Effect.succeed([]),
          rotateOwnerIfCurrent: () =>
            Effect.sync(() => ({
              previousOwnerID: "runtime-1",
              ownerID: "runtime-2",
              quarantinedEffectCount: ++rotations,
              recoveredPendingCount: 0,
            })),
          settleEffect: (input) =>
            Effect.sync(() => {
              settlements++
              return { ...input.grant, state: "settled", version: 2, outcome: input.outcome, result: input.result }
            }),
        }),
        context: ctx,
        toolName: "bash",
        execute: Effect.gen(function* () {
          ctx.permissionEffectGrants!.push(started)
          yield* Deferred.succeed(startedEffect, undefined)
          return yield* Effect.never
        }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(startedEffect)
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      return { interrupted, rotations, settlements }
    }),
  )

  expect(Exit.isFailure(result.interrupted)).toBe(true)
  if (Exit.isFailure(result.interrupted)) expect(Cause.hasInterruptsOnly(result.interrupted.cause)).toBe(true)
  expect(result.rotations).toBe(1)
  expect(result.settlements).toBe(0)
})

test("permission effect chokepoint quarantines a started effect when settlement fails", async () => {
  const ctx = context()
  let executions = 0
  let rotations = 0
  const exit = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () => Effect.succeed(ctx.permissionEffectGrants ?? []),
        settleEffect: () => Effect.die(new Error("settlement unavailable")),
        rotateOwnerIfCurrent: () =>
          Effect.sync(() => ({
            previousOwnerID: "runtime-1",
            ownerID: "runtime-2",
            quarantinedEffectCount: ++rotations,
            recoveredPendingCount: 0,
          })),
      }),
      context: ctx,
      toolName: "bash",
      execute: Effect.sync(() => {
        executions++
        ctx.permissionEffectGrants!.push(started)
        return { output: "external side effect completed" }
      }),
    }).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(executions).toBe(1)
  expect(rotations).toBe(1)
})

test("permission effect chokepoint quarantines before propagating an interrupt during settlement", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ctx = context()
      const settling = yield* Deferred.make<void>()
      let executions = 0
      let rotations = 0
      const fiber = yield* executeWithPermissionAuthority({
        permission: permission({
          effectsForToolCall: () => Effect.succeed(ctx.permissionEffectGrants ?? []),
          settleEffect: () => Deferred.succeed(settling, undefined).pipe(Effect.andThen(Effect.never)),
          rotateOwnerIfCurrent: () =>
            Effect.sync(() => ({
              previousOwnerID: "runtime-1",
              ownerID: "runtime-2",
              quarantinedEffectCount: ++rotations,
              recoveredPendingCount: 0,
            })),
        }),
        context: ctx,
        toolName: "bash",
        execute: Effect.sync(() => {
          executions++
          ctx.permissionEffectGrants!.push(started)
          return { output: "external side effect completed" }
        }),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(settling)
      yield* Fiber.interrupt(fiber)
      return { exit: yield* Fiber.await(fiber), executions, rotations }
    }),
  )

  expect(Exit.isFailure(result.exit)).toBe(true)
  if (Exit.isFailure(result.exit)) expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
  expect(result.executions).toBe(1)
  expect(result.rotations).toBe(1)
})

test("late settlement from a quarantined owner does not rotate the current owner", async () => {
  const ctx = context()
  ctx.permissionEffectGrants!.push(started)
  let rotations = 0
  const exit = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () => Effect.succeed([{ ...started, state: "unknown", version: 2, settledAt: 2 }]),
        settleEffect: () => Effect.die(new Error("stale settlement")),
        rotateOwnerIfCurrent: () =>
          Effect.sync(() => {
            rotations++
            return undefined
          }),
      }),
      context: ctx,
      toolName: "bash",
      execute: Effect.succeed({ output: "external side effect completed" }),
    }).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(rotations).toBe(0)
})

test("late settlement after a sibling rotation is a no-op for the new owner", async () => {
  const ctx = context()
  ctx.permissionEffectGrants!.push(started)
  let queries = 0
  let currentOwner = "runtime-2"
  let rotations = 0
  const exit = await Effect.runPromise(
    executeWithPermissionAuthority({
      permission: permission({
        effectsForToolCall: () => {
          queries++
          return Effect.succeed(
            queries === 1 ? [] : [{ ...started, state: "unknown", version: 2, ownerID: "runtime-1", settledAt: 2 }],
          )
        },
        settleEffect: () => Effect.die(new Error("late settlement")),
        rotateOwnerIfCurrent: (expectedOwnerID) =>
          Effect.sync(() => {
            if (expectedOwnerID !== currentOwner) return undefined
            rotations++
            currentOwner = "runtime-3"
            return undefined
          }),
      }),
      context: ctx,
      toolName: "bash",
      execute: Effect.sync(() => ({ output: "external side effect completed" })),
    }).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(queries).toBe(2)
  expect(rotations).toBe(0)
})

test("host permission admission rejects before plugin hooks or tool execution", async () => {
  const ctx = context()
  let hooks = 0
  let executions = 0
  ctx.ask = () => Effect.die(new Error("permission denied"))

  const exit = await Effect.runPromise(
    executeWithHostPermissionAdmission({
      context: ctx,
      admissionKey: "custom_writer",
      request: {
        permission: "custom_writer",
        patterns: ["*"],
        metadata: { args: { value: "must-not-run" } },
        always: ["*"],
      },
      execute: Effect.sync(() => {
        hooks++
        executions++
      }),
    }).pipe(Effect.exit),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(hooks).toBe(0)
  expect(executions).toBe(0)
  expect(ctx.hostPermissionAdmissions?.has("custom_writer")).toBe(false)
})

test("host permission admission records the exact custom boundary before hooks", async () => {
  const ctx = context()
  const order: string[] = []
  ctx.ask = () => Effect.sync(() => order.push("ask"))

  await Effect.runPromise(
    executeWithHostPermissionAdmission({
      context: ctx,
      admissionKey: "custom_writer",
      request: { permission: "custom_writer", patterns: ["*"], metadata: {}, always: ["*"] },
      execute: Effect.sync(() => {
        order.push(ctx.hostPermissionAdmissions?.has("custom_writer") ? "hook:admitted" : "hook:missing")
      }),
    }),
  )

  expect(order).toEqual(["ask", "hook:admitted"])
})

function permission(overrides: Partial<Permission.Interface>): Permission.Interface {
  return {
    ask: () => Effect.void,
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
    ...overrides,
  }
}

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("session-1"),
    messageID: MessageID.make("msg_permission-effect-1"),
    callID: "call-1",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    permissionEffectGrants: [],
    hostPermissionAdmissions: new Set(),
  }
}
