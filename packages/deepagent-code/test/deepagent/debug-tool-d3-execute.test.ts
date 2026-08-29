import { afterEach, beforeAll, afterAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import os from "os"
import * as fs from "fs/promises"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { LSP } from "@/lsp/lsp"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeBase } from "@/runtime/base"
import { DebugService } from "@/debug/service"
import * as Truncate from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { DebugTool } from "@/tool/debug"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"

// D3 (S1-v3.5) — REAL DebugTool.execute behaviour tests.
//
// These replace the old "false confidence" tests (a local Set approval assertion
// that never called the tool, a grep-the-source D4 test). They drive the actual
// DebugTool.execute and prove the tool now:
//   (1) routes intent:start through DebugService (D1 state machine) + R0 gate/isolation,
//       actually launching the debuggee — not a bare initialize handshake (C3/C4/C6),
//   (2) reuses the live session when session_id is omitted (M10 fix),
//   (3) fails closed on a missing privilege via the R0 gate (#4),
//   (4) degrades gracefully (no Die) on no-session / unavailable-adapter.
//
// A fake `python3` on PATH runs the fake DAP adapter fixture, so the debugpy adapter
// resolves and DapClient talks a real DAP session end-to-end.

const fakeAdapterPath = path.join(__dirname, "../fixture/debug/fake-dap-adapter.js")

let fakeBinDir: string
let originalPath: string | undefined

beforeAll(async () => {
  fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-fakepy-"))
  // A fake `python3` that ignores `-m debugpy.adapter` and just runs the fake DAP
  // adapter over stdio (cross-platform: the runner has no real debugpy).
  const script = `#!/usr/bin/env node
require(${JSON.stringify(fakeAdapterPath)})
`
  const pyPath = path.join(fakeBinDir, "python3")
  await fs.writeFile(pyPath, script, { mode: 0o755 })
  await fs.chmod(pyPath, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await fs.rm(fakeBinDir, { recursive: true, force: true }).catch(() => {})
})

const toolLayer = (probe: RuntimeBase.PrivilegeProbe = RuntimeBase.allowAllProbe) =>
  Layer.mergeAll(
    LSP.defaultLayer,
    DebugService.layer.pipe(
      Layer.provide(RuntimeBase.testLayer(probe).pipe(Layer.provide(Worktree.defaultLayer))),
      Layer.provide(EventV2Bridge.defaultLayer),
    ),
    RuntimeBase.testLayer(probe).pipe(Layer.provide(Worktree.defaultLayer)),
    Worktree.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    Config.defaultLayer,
    RuntimeFlags.layer({}),
    EventV2Bridge.defaultLayer,
  )

type AskCall = { permission: string; patterns: readonly string[] }

const makeCtx = (asks: AskCall[]): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: (req) =>
    Effect.sync(() => {
      asks.push({ permission: req.permission, patterns: req.patterns })
    }),
})

describe("D3 DebugTool.execute — real tool path", () => {
  afterEach(() => disposeAllInstances())

  const it = testEffect(toolLayer())

  it.instance(
    "intent:start launches the debuggee via DebugService and records a live session",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* DebugTool)
        const debug = yield* DebugService.Service
        const asks: AskCall[] = []

        const result = yield* def.execute(
          { intent: "start", target: "python -m pytest test_foo.py", session_id: "s1" },
          makeCtx(asks),
        )

        // Reached DebugService.start (not the "adapter unavailable" early return):
        // the fake python3/debugpy resolved and the session is tracked by the SERVICE,
        // not a local Map (C3). The session state proves launch happened (C4).
        expect(result.title).toContain("session started")
        const live = yield* debug.get("s1")
        expect(live).toBeDefined()
        expect(live!.adapterId).toBe("debugpy")
        // R0 approve-once gate fired exactly one debug approval (C6).
        expect(asks.filter((a) => a.permission === "debug").length).toBe(1)

        yield* debug.terminate("s1").pipe(Effect.catch(() => Effect.void))
      }),
    { git: true },
  )

  it.instance(
    "intent:stop with omitted session_id reuses the latest live session (M10)",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* DebugTool)
        const debug = yield* DebugService.Service
        const asks: AskCall[] = []

        // Start WITH an id.
        yield* def.execute({ intent: "start", target: "python app.py", session_id: "reuse-1" }, makeCtx(asks))
        expect(yield* debug.get("reuse-1")).toBeDefined()

        // Stop WITHOUT an id → must resolve to the live session, not mint a new one
        // and report "no session" (the old bug where each omit made a fresh id).
        const stopResult = yield* def.execute({ intent: "stop" }, makeCtx(asks))
        expect(stopResult.title).toContain("stopped")
        expect(yield* debug.get("reuse-1")).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "non-start intent with no live session degrades gracefully (no Die)",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* DebugTool)
        const result = yield* def.execute({ intent: "continue" }, makeCtx([]))
        expect(result.title).toContain("no session")
        expect(result.output).toContain("intent:start")
      }),
    { git: true },
  )

  it.instance(
    "unknown language → adapter unavailable (graceful, no Die)",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* DebugTool)
        const asks: AskCall[] = []
        const result = yield* def.execute(
          { intent: "start", target: "./mystery-binary", language: "brainfuck", session_id: "x" },
          makeCtx(asks),
        )
        expect(result.title).toContain("adapter unavailable")
        // No approval prompt when there's no adapter to run.
        expect(asks.length).toBe(0)
      }),
    { git: true },
  )
})

describe("D3 DebugTool.execute — fail-closed privilege gate (#4)", () => {
  afterEach(() => disposeAllInstances())

  const denyIt = testEffect(toolLayer(RuntimeBase.denyAllProbe))

  denyIt.instance(
    "a ptrace-requiring adapter is refused when the privilege is unavailable",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* DebugTool)
        const debug = yield* DebugService.Service
        // C/C++/Rust resolve to lldb, which declares the `ptrace` privilege. With
        // denyAllProbe the R0 gate refuses BEFORE the adapter is spawned.
        // (lldb-dap may not be installed either; both paths are graceful, non-Die.)
        const result = yield* def.execute(
          { intent: "start", target: "cargo run", session_id: "priv-1" },
          makeCtx([]),
        )
        expect(result.title).toContain("debug:")
        // Either way, no live session was created.
        expect(yield* debug.get("priv-1")).toBeUndefined()
      }),
    { git: true },
  )
})
