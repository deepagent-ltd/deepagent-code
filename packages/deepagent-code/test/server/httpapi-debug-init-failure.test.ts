import { expect } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { DebugAdapter } from "@/debug/adapter"
import { DebugPaths, DebugStartResult } from "@/server/routes/instance/httpapi/groups/debug"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Exercise the real interpreter/module failure, DAP EOF, R0 isolation and HTTP
// response. Environments with debugpy installed exercise their positive adapter
// suite instead; this integration case must not replace an installed adapter.
const resolution = DebugAdapter.make().resolveById("debugpy")
const missingModule = resolution.available && await Bun.spawn([
  resolution.spec.command,
  "-c",
  "import importlib.util; raise SystemExit(1 if importlib.util.find_spec('debugpy') is None else 0)",
], { stdout: "ignore", stderr: "ignore" }).exited === 1
const it = testEffect(httpApiLayer)

if (missingModule) it.live("original debug HTTP reports failed DAP initialization and releases its session", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(() => Bun.write(path.join(directory, "main.py"), "print('debug initialization fixture')\n"))
    const before = yield* requestInDirectory(DebugPaths.sessions, directory)
    expect(before.status).toBe(200)
    expect(yield* before.json).toEqual({ sessions: [] })

    const started = Date.now()
    const response = yield* requestInDirectory(DebugPaths.start, directory, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapter: "debugpy", program: "main.py", sessionId: "missing-debugpy-init" }),
    })
    expect(response.status).toBe(200)
    const result = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DebugStartResult)))
    expect(result.error).toBe("adapter_unavailable")
    expect(result.message).toContain("could not initialize")
    expect(result.message).toContain("pip install debugpy")
    expect(result.sessionId).toBeUndefined()
    expect(result.state).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)

    const after = yield* requestInDirectory(DebugPaths.sessions, directory)
    expect(after.status).toBe(200)
    expect(yield* after.json).toEqual({ sessions: [] })
  }), 30_000)

if (!missingModule) it.live.skip("original debug HTTP reports failed DAP initialization and releases its session", Effect.void)
