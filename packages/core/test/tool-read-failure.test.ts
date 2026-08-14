import { describe, expect } from "bun:test"
import { ToolFailure } from "@deepagent-code/llm"
import { recoverReadDefect } from "@deepagent-code/core/tool/read-failure"
import { Cause, Effect, Exit, Option } from "effect"
import { systemError } from "effect/PlatformError"
import { it } from "./lib/effect"

describe("ReadTool failure boundary", () => {
  it.effect("recovers missing paths as typed tool failures without swallowing defects or interruption", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.die(
        systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "realPath",
          pathOrDescriptor: "/workspace/README.md",
        }),
      ).pipe(
        Effect.catchDefect((defect) => recoverReadDefect("README.md", defect)),
        Effect.exit,
      )

      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) {
        expect(missing.cause.reasons.every(Cause.isFailReason)).toBe(true)
        expect(Option.getOrUndefined(Cause.findErrorOption(missing.cause))).toEqual(
          new ToolFailure({ message: "Unable to read README.md" }),
        )
      }

      const defect = new Error("filesystem invariant failed")
      expect(
        yield* Effect.die(defect).pipe(
          Effect.catchDefect((failure) => recoverReadDefect("README.md", failure)),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe(defect)

      const interrupted = yield* Effect.interrupt.pipe(
        Effect.catchDefect((failure) => recoverReadDefect("README.md", failure)),
        Effect.exit,
      )

      expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
    }),
  )
})
