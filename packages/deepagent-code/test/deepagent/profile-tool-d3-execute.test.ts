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
import * as Truncate from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { ProfileTool, type ProfileMetadata } from "@/tool/profile"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"

// P3A (S1-v3.5) — REAL ProfileTool.execute behaviour tests.
//
// These replace the old "false confidence" tests that called ProfileService.run
// directly (never through the tool). They drive the actual ProfileTool.execute and
// prove the tool now:
//   (1) routes through ProfileService.run → writes a real PROFILE_RESULT.json artifact
//       (C1: the P4A evidence loop is live from the tool path),
//   (2) goes through the R0 privilege gate fail-closed (C2/#4: denyAllProbe blocks),
//   (3) reports roofline + artifactPath in metadata.
//
// A fake `perf` binary is injected on PATH so the real adapter (real probe, real
// collect→parse→normalize) runs end-to-end without needing Linux perf installed.

let fakeBinDir: string
let originalPath: string | undefined

const PERF_REPORT = `# Overhead  Command  Shared Object  Symbol
    62.50%  bench    bench          [.] compute_kernel
    20.00%  bench    bench          [.] data_loader
     5.30%  bench    bench          [.] io_thread_main
`

const PERF_STAT = ` Performance counter stats for './bench':

       2,000,000      cycles                    #    1.500 GHz
       1,000,000      instructions              #    0.50  insn per cycle
          50,000      cache-misses              #   50.000 % of all cache refs
         100,000      cache-references
          10,000      branch-misses             #    5.000 % of all branches
         200,000      branches
`

beforeAll(async () => {
  fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-fakeperf-"))
  // A fake `perf` that answers record/report/stat like the real one. Node shebang
  // keeps it cross-platform (macOS test runner has no real perf).
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
const sub = args[0]
if (sub === "record") { process.exit(0) }
if (sub === "report") { process.stdout.write(${JSON.stringify(PERF_REPORT)}); process.exit(0) }
if (sub === "stat") { process.stdout.write(${JSON.stringify(PERF_STAT)}); process.exit(0) }
process.exit(0)
`
  const perfPath = path.join(fakeBinDir, "perf")
  await fs.writeFile(perfPath, script, { mode: 0o755 })
  await fs.chmod(perfPath, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await fs.rm(fakeBinDir, { recursive: true, force: true }).catch(() => {})
})

// Build the tool with the R0 gate probe injectable so we can test both allow + deny.
const toolLayer = (probe: RuntimeBase.PrivilegeProbe = RuntimeBase.allowAllProbe) =>
  Layer.mergeAll(
    LSP.defaultLayer,
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

describe("P3A ProfileTool.execute — real tool path", () => {
  afterEach(() => disposeAllInstances())

  const it = testEffect(toolLayer())

  it.instance(
    "runs collect→parse→normalize via ProfileService.run and writes PROFILE_RESULT.json",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* ProfileTool)
        const asks: AskCall[] = []
        const result = yield* def.execute({ target: "./bench", adapter: "perf" }, makeCtx(asks))
        const meta = result.metadata as ProfileMetadata

        // Reached the pipeline (not the "not available" early return): perf binary
        // was found on PATH and ProfileService.run produced a normalized profile.
        expect(meta.available).toBe(true)
        expect(meta.adapterId).toBe("perf")
        expect(meta.domain).toBe("cpu_sampling")

        // C1: a real artifact was written by ProfileService.run.
        expect(meta.artifactPath).toBeTruthy()
        const artifactRaw = yield* Effect.promise(() => fs.readFile(meta.artifactPath!, "utf8"))
        const artifact = JSON.parse(artifactRaw)
        expect(artifact.evidence_kind).toBe("profile")
        expect(artifact.profile.adapterId).toBe("perf")
        expect(artifact.roofline).toBeDefined()

        // Roofline classification is surfaced in metadata + top hotspot is compute_kernel.
        expect(meta.roofline).toBeDefined()
        expect(meta.hotspots?.[0]?.symbol).toBe("compute_kernel")

        // Output points at the real artifact, not a fabricated "read this file" note.
        expect(result.output).toContain("PROFILE_RESULT.json")

        // The execution approval was requested once through ctx.ask.
        expect(asks.filter((a) => a.permission === "execute").length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "unknown adapter returns available:false before touching the gate",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* ProfileTool)
        const asks: AskCall[] = []
        const result = yield* def.execute({ target: "./bench", adapter: "definitely-not-a-profiler" }, makeCtx(asks))
        const meta = result.metadata as ProfileMetadata
        expect(meta.available).toBe(false)
        // No approval prompt for an adapter we can't even resolve.
        expect(asks.length).toBe(0)
      }),
    { git: true },
  )
})

describe("P3A ProfileTool.execute — fail-closed privilege gate (#4)", () => {
  afterEach(() => disposeAllInstances())

  const denyIt = testEffect(toolLayer(RuntimeBase.denyAllProbe))

  denyIt.instance(
    "denyAllProbe blocks perf (perf_event_paranoid unavailable) → privilege_blocked, no run",
    () =>
      Effect.gen(function* () {
        const def = yield* Tool.init(yield* ProfileTool)
        const asks: AskCall[] = []
        const result = yield* def.execute({ target: "./bench", adapter: "perf" }, makeCtx(asks))
        const meta = result.metadata as ProfileMetadata

        // Binary IS present (fake perf on PATH), so we reach the gate — and it refuses.
        expect(meta.available).toBe(false)
        expect(meta.privilege_blocked).toBe(true)
        expect(result.output.toLowerCase()).toContain("privilege")
        // Fail-closed happens BEFORE approval (never prompt for an op that can't run).
        expect(asks.length).toBe(0)
      }),
    { git: true },
  )
})
