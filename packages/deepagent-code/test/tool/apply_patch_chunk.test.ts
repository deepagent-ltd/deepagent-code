import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { MessageID, SessionID } from "@/session/schema"
import { ApplyPatchChunkTool } from "@/tool/apply_patch_chunk"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const context = (sessionID = SessionID.make("ses_patch_chunk")): Tool.Context => ({
  sessionID,
  messageID: MessageID.make("msg_patch_chunk"),
  callID: "call_patch_chunk",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
  })

describe("tool.apply_patch_chunk", () => {
  it.instance("stages chunks without touching the workspace and applies only on commit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* ApplyPatchChunkTool
      const tool = yield* info.init()
      const target = path.join(test.directory, "chunked.txt")
      const patch = "*** Begin Patch\n*** Add File: chunked.txt\n+chunked content\n*** End Patch"
      const first = yield* tool.execute({ action: "begin", patchText: patch.slice(0, 32) }, context())
      const transactionID = first.metadata.transactionID

      expect(transactionID).toBeString()
      expect(first.metadata.nextOffset).toBe(32)
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)

      const appended = yield* tool.execute(
        { action: "append", transactionID: String(transactionID), offset: 32, patchText: patch.slice(32) },
        context(),
      )
      expect(appended.metadata.nextOffset).toBe(new TextEncoder().encode(patch).byteLength)
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)

      yield* tool.execute(
        { action: "commit", transactionID: String(transactionID), offset: Number(appended.metadata.nextOffset) },
        context(),
      )
      expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("chunked content\n")
    }),
  )

  it.instance("rejects oversized chunks without creating a transaction", () =>
    Effect.gen(function* () {
      const info = yield* ApplyPatchChunkTool
      const tool = yield* info.init()

      yield* failure(
        tool.execute({ action: "begin", patchText: "x".repeat(12_001) }, context()),
        "split it into chunks",
      )
    }),
  )

  it.instance("does not allow another session to append or commit a transaction", () =>
    Effect.gen(function* () {
      const info = yield* ApplyPatchChunkTool
      const tool = yield* info.init()
      const started = yield* tool.execute(
        { action: "begin", patchText: "*** Begin Patch\n" },
        context(SessionID.make("ses_owner")),
      )

      yield* failure(
        tool.execute(
          { action: "append", transactionID: String(started.metadata.transactionID), patchText: "*** End Patch" },
          context(SessionID.make("ses_other")),
        ),
        "transaction not found",
      )
    }),
  )

  it.instance("rejects missing, duplicate, and out-of-order offsets without changing files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const info = yield* ApplyPatchChunkTool
      const tool = yield* info.init()
      const target = path.join(test.directory, "ordered.txt")
      const started = yield* tool.execute({ action: "begin", offset: 0, patchText: "*** Begin Patch\n" }, context())
      const transactionID = String(started.metadata.transactionID)
      const nextOffset = Number(started.metadata.nextOffset)

      yield* failure(
        tool.execute({ action: "append", transactionID, patchText: "*** End Patch" }, context()),
        "append requires offset",
      )
      yield* failure(
        tool.execute({ action: "append", transactionID, offset: 0, patchText: "*** End Patch" }, context()),
        "does not match next expected",
      )
      yield* failure(
        tool.execute({ action: "commit", transactionID, offset: nextOffset + 1 }, context()),
        "does not match next expected",
      )
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )
})
