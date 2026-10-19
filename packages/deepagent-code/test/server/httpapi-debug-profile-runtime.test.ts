import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { DebugAdapter } from "@/debug/adapter"
import { ProfileAdapterRegistry } from "@/profile/adapters/index"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

const missingPerf = !ProfileAdapterRegistry.make().resolveById("perf").available
if (missingPerf)
  it.live(
    "generated SDK and original profile HTTP keep a missing tool failure queryable and directory scoped",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const other = yield* tmpdirScoped()
        const client = createDeepAgentCodeClient({
          baseUrl: HttpServer.formatAddress((yield* HttpServer.HttpServer).address),
          directory,
          throwOnError: true,
        })
        expect((yield* Effect.promise(() => client.profile.runs())).data).toEqual([])
        const run = yield* Effect.promise(() =>
          client.profile.run({ profileRunBody: { program: "/usr/bin/true", profiler: "perf" } }),
        )
        expect(run.data).toMatchObject({ status: "error" })
        expect(run.data!.error).toContain("binary not found")
        expect(run.data!.error).toContain("Install Linux perf")
        const runId = run.data!.runId
        expect((yield* Effect.promise(() => client.profile.result({ runId }))).data).toEqual({
          status: "error",
          error: run.data!.error,
        })
        expect((yield* Effect.promise(() => client.profile.hotspots({ runId }))).data).toEqual([])
        expect((yield* Effect.promise(() => client.profile.runs())).data).toEqual([run.data!])
        expect((yield* Effect.promise(() => client.profile.runs({ directory: other }))).data).toEqual([])
        expect((yield* Effect.promise(() => client.profile.result({ runId, directory: other }))).data).toEqual({
          status: "error",
          error: "runId not found",
        })
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(directory, ".deepagent/profiles", runId, "PROFILE_RESULT.json")).exists(),
          ),
        ).toBe(false)
      }),
    15_000,
  )
if (!missingPerf)
  it.live.skip(
    "generated SDK and original profile HTTP keep a missing tool failure queryable and directory scoped",
    Effect.void,
  )

// Run this case with only the test subprocess PATH containing Xcode's lldb-dap.
// It launches a compiled temporary C child through the original HTTP/privilege/DAP path.
if (process.platform === "darwin" && DebugAdapter.make().resolveById("lldb").available)
  it.live(
    "original debug HTTP launches and inspects an actual isolated C program using the installed LLDB adapter",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const source = path.join(directory, "main.c")
        const program = path.join(directory, "debug-program")
        const gate = path.join(directory, "continue-fixture")
        yield* Effect.promise(() =>
          Bun.write(
            source,
            "#include <unistd.h>\nint main(int argc, char **argv) {\n  while (access(argv[1], F_OK) != 0) usleep(1000);\n  volatile int answer = 41;\n  answer += 1;\n  return answer == 42 ? 0 : 1;\n}\n",
          ),
        )
        const compiler = Bun.spawn(["/usr/bin/xcrun", "clang", "-g", "-O0", source, "-o", program], {
          stdout: "ignore",
          stderr: "pipe",
        })
        expect(yield* Effect.promise(() => compiler.exited)).toBe(0)
        const client = createDeepAgentCodeClient({
          baseUrl: HttpServer.formatAddress((yield* HttpServer.HttpServer).address),
          directory,
          throwOnError: true,
        })
        const started = yield* Effect.promise(() =>
          client.debug.start({
            debugStartBody: { adapter: "lldb", program, args: [gate], sessionId: "actual-lldb-own-program" },
          }),
        )
        expect(started.data?.error).toBeUndefined()
        const sessionId = started.data!.sessionId!
        expect(sessionId).toBe("actual-lldb-own-program")
        const lifecycle = { terminated: false }
        yield* Effect.addFinalizer(() =>
          lifecycle.terminated
            ? Effect.void
            : Effect.promise(() => client.debug.terminate({ debugTerminateBody: { sessionId } })).pipe(
                Effect.catchCause(() => Effect.void),
              ),
        )
        yield* Effect.promise(() =>
          client.debug.breakpoints({ debugBreakpointsBody: { sessionId, file: source, breakpoints: [{ line: 5 }] } }),
        )
        yield* Effect.promise(() => Bun.write(gate, "release own debuggee\n"))
        const deadline = Date.now() + 5_000
        const stopped = yield* Effect.promise(async () => {
          while (Date.now() < deadline) {
            const sessions = await client.debug.sessions()
            if (sessions.data!.sessions.some((session) => session.id === sessionId && session.status === "stopped"))
              return true
            await Bun.sleep(20)
          }
          return false
        })
        expect(stopped).toBe(true)
        const stack = yield* Effect.promise(() => client.debug.stack({ sessionId }))
        const frames = stack.data!.frames as Array<{
          id: number
          name: string
          source?: { path?: string }
          line: number
        }>
        expect(frames[0].name).toBe("main")
        expect(frames[0].source?.path).toBe(source)
        expect(frames[0].line).toBe(5)
        const scopes = yield* Effect.promise(() => client.debug.scopes({ sessionId, frameId: String(frames[0].id) }))
        expect(scopes.data!.scopes.length).toBeGreaterThan(0)
        const value = yield* Effect.promise(() =>
          client.debug.evaluate({ debugEvaluateBody: { sessionId, frameId: frames[0].id, expression: "answer" } }),
        )
        expect(JSON.stringify(value.data!.result)).toContain("41")
        const step = yield* Effect.promise(() => client.debug.step({ debugStepBody: { sessionId, kind: "next" } }))
        expect(step.response?.status).toBe(200)
        const terminated = yield* Effect.promise(() => client.debug.terminate({ debugTerminateBody: { sessionId } }))
        expect(terminated.data?.state.status).toBe("terminated")
        lifecycle.terminated = true
        expect((yield* Effect.promise(() => client.debug.sessions())).data).toEqual({ sessions: [] })
      }),
    30_000,
  )
