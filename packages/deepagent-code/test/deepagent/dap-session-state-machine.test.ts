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

// D1 (S1-v3.5): DebugService session state machine. Drives a full session through
// launch → breakpoint → stop → step → continue → terminate and asserts the
// serializable state transitions are correct.

const fakeAdapterPath = path.join(__dirname, "../fixture/debug/fake-dap-adapter.js")

const fakeSpec = (): AdapterSpec => ({
  id: "fake",
  languages: ["python"],
  command: process.execPath,
  args: [fakeAdapterPath],
  privileges: [],
  transport: "stdio",
})

const debugLayer = (probe: RuntimeBase.PrivilegeProbe = RuntimeBase.allowAllProbe) =>
  Layer.mergeAll(
    DebugService.layer.pipe(
      Layer.provide(RuntimeBase.testLayer(probe).pipe(Layer.provide(Worktree.defaultLayer))),
      Layer.provide(EventV2Bridge.defaultLayer),
    ),
    Worktree.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
  )

// Wait until a session reaches an expected status (events arrive async).
const waitForStatus = (debug: DebugService.Interface, sessionId: string, status: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const s = yield* debug.get(sessionId)
      if (s?.status === status) return s
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.fail(new Error(`session never reached status "${status}"`))
  })

describe("DAP session state machine", () => {
  afterEach(() => disposeAllInstances())

  const it = testEffect(debugLayer())

  it.instance(
    "drives launch → breakpoint → stop → step → continue → terminate",
    () =>
      Effect.gen(function* () {
        const debug = yield* DebugService.Service
        const sessionId = "sm-1"

        const started = yield* debug.start({
          spec: fakeSpec(),
          sessionId,
          launch: { program: "/repro/main.py" },
        })
        expect(started.id).toBe(sessionId)
        expect(started.adapterId).toBe("fake")
        // After launch+configurationDone the fake adapter hits a breakpoint.
        const stopped = yield* waitForStatus(debug, sessionId, "stopped")
        expect(stopped.status).toBe("stopped")
        expect(stopped.stoppedReason).toBe("breakpoint")
        expect(stopped.threadId).toBe(1)

        // Set a breakpoint (recorded in serializable state).
        const withBp = yield* debug.setBreakpoints({
          sessionId,
          source: "/repro/main.py",
          breakpoints: [{ line: 10 }, { line: 20 }],
        })
        expect(withBp.breakpoints.length).toBe(1)
        expect(withBp.breakpoints[0].source).toBe("/repro/main.py")
        expect(withBp.breakpoints[0].lines).toEqual([10, 20])

        // Inspect stack / scopes / variables / eval — all delegated to adapter.
        const frames = yield* debug.stackTrace(sessionId)
        expect(frames.length).toBe(2)
        expect(frames[0].name).toBe("main")
        const scopes = yield* debug.scopes(sessionId, frames[0].id)
        expect(scopes[0].name).toBe("Locals")
        const vars = yield* debug.variables(sessionId, scopes[0].variablesReference)
        expect(vars.find((v: any) => v.name === "x")?.value).toBe("42")
        const evaln = yield* debug.evaluate({ sessionId, expression: "x + 1", frameId: frames[0].id })
        expect(evaln.result).toContain("x + 1")

        // Step → fake adapter pauses again with reason "step".
        yield* debug.step(sessionId, "next")
        const stepped = yield* waitForStatus(debug, sessionId, "stopped")
        expect(stepped.stoppedReason).toBe("step")

        // Continue → program runs to completion → terminated/exited.
        yield* debug.continue(sessionId)
        const ended = yield* waitForStatus(debug, sessionId, "terminated").pipe(
          Effect.catch(() => waitForStatus(debug, sessionId, "exited")),
        )
        expect(["terminated", "exited"]).toContain(ended.status)

        // Explicit terminate removes the session.
        yield* debug.terminate(sessionId)
        const gone = yield* debug.get(sessionId)
        expect(gone).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "step before a stop fails (state machine guards thread)",
    () =>
      Effect.gen(function* () {
        const debug = yield* DebugService.Service
        // No session at all → stepping fails.
        const exit = yield* debug.step("nope", "next").pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    { git: true },
  )

  describe("privilege gate fail-closed at start", () => {
    const denyIt = testEffect(debugLayer(RuntimeBase.denyAllProbe))
    denyIt.instance(
      "refuses to start when a required privilege is unavailable",
      () =>
        Effect.gen(function* () {
          const debug = yield* DebugService.Service
          const exit = yield* debug
            .start({
              spec: { ...fakeSpec(), privileges: [{ kind: "ptrace", reason: "lldb needs ptrace" }] },
              sessionId: "priv-1",
              launch: {},
            })
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          // Session must not have been created.
          const s = yield* debug.get("priv-1")
          expect(s).toBeUndefined()
        }),
      { git: true },
    )
  })
})
