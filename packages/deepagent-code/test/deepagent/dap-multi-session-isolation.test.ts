import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeBase } from "@/runtime/base"
import { DebugService } from "@/debug/service"
import type { AdapterSpec } from "@/debug/types"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// D1 (S1-v3.5): two concurrent debug sessions, each its own adapter process, with
// independent serializable state. Stepping one must not perturb the other.

const fakeAdapterPath = path.join(__dirname, "../fixture/debug/fake-dap-adapter.js")

const fakeSpec = (): AdapterSpec => ({
  id: "fake",
  languages: ["python"],
  command: process.execPath,
  args: [fakeAdapterPath],
  privileges: [],
  transport: "stdio",
})

const debugLayer = Layer.mergeAll(
  DebugService.layer.pipe(
    Layer.provide(RuntimeBase.testLayer(RuntimeBase.allowAllProbe).pipe(Layer.provide(Worktree.defaultLayer))),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
  Worktree.defaultLayer,
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Git.defaultLayer,
)

const waitForStatus = (debug: DebugService.Interface, sessionId: string, status: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const s = yield* debug.get(sessionId)
      if (s?.status === status) return s
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.fail(new Error(`session ${sessionId} never reached "${status}"`))
  })

describe("DAP multi-session isolation", () => {
  afterEach(() => disposeAllInstances())

  const it = testEffect(debugLayer)

  it.instance(
    "two concurrent sessions have independent adapter processes + state",
    () =>
      Effect.gen(function* () {
        const debug = yield* DebugService.Service

        yield* debug.start({ spec: fakeSpec(), sessionId: "a", launch: { program: "/repro/a.py" } })
        yield* debug.start({ spec: fakeSpec(), sessionId: "b", launch: { program: "/repro/b.py" } })

        const a0 = yield* waitForStatus(debug, "a", "stopped")
        const b0 = yield* waitForStatus(debug, "b", "stopped")
        expect(a0.stoppedReason).toBe("breakpoint")
        expect(b0.stoppedReason).toBe("breakpoint")

        // list() reports both, independently.
        const all = yield* debug.list()
        expect(all.map((s) => s.id).sort()).toEqual(["a", "b"])

        // Different breakpoints on each session — must not bleed across.
        yield* debug.setBreakpoints({ sessionId: "a", source: "/repro/a.py", breakpoints: [{ line: 1 }] })
        yield* debug.setBreakpoints({ sessionId: "b", source: "/repro/b.py", breakpoints: [{ line: 99 }] })
        const a1 = yield* debug.get("a")
        const b1 = yield* debug.get("b")
        expect(a1?.breakpoints[0].lines).toEqual([1])
        expect(b1?.breakpoints[0].lines).toEqual([99])

        // Continue A to completion; B must remain stopped.
        yield* debug.continue("a")
        yield* waitForStatus(debug, "a", "terminated").pipe(
          Effect.catch(() => waitForStatus(debug, "a", "exited")),
        )
        const bStill = yield* debug.get("b")
        expect(bStill?.status).toBe("stopped")

        // Terminate A; B still present and independent.
        yield* debug.terminate("a")
        const afterTerminate = yield* debug.list()
        expect(afterTerminate.map((s) => s.id)).toEqual(["b"])

        yield* debug.terminate("b")
        expect((yield* debug.list()).length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "starting a session id that already exists is rejected",
    () =>
      Effect.gen(function* () {
        const debug = yield* DebugService.Service
        yield* debug.start({ spec: fakeSpec(), sessionId: "dup", launch: {} })
        const exit = yield* debug.start({ spec: fakeSpec(), sessionId: "dup", launch: {} }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        yield* debug.terminate("dup")
      }),
    { git: true },
  )
})
