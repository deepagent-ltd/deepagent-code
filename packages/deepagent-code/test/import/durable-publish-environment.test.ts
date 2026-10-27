import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Exit, Option, Schema } from "effect"
import { DurablePublish } from "@deepagent-code/core/database/durable-publish"
import { importFixtureEnvironment } from "../../../app/test/components/fixture/import-environment"
import { DurablePublishEnvironment } from "../fixture/durable-publish-environment"

const Ready = Schema.Struct({ phase: Schema.Literal("ready"), pid: Schema.Int })
const Receipt = Schema.Struct({
  pid: Schema.Int,
  bridgeReceipt: Schema.Boolean,
  sourceGone: Schema.Boolean,
  targetEqual: Schema.Boolean,
  elapsedMs: Schema.Int,
})
const Phase = Schema.Struct({
  phase: Schema.Literals([
    "input-wait",
    "input-read",
    "compile-start",
    "compile-done",
    "publish-start",
    "publish-done",
  ]),
  atMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  receivedMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

test("actual durable publication compares narrow and merged owned Windows environments", async () => {
  const parent = process.platform === "win32" ? path.resolve(import.meta.dir, "../../.artifacts/unit") : os.tmpdir()
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, "durable-env-")))
  if (process.platform !== "win32") {
    try {
      const source = path.join(root, "source.tmp")
      const target = path.join(root, "target.db")
      await fs.writeFile(source, Buffer.alloc(1024, 0x5a))
      const result = await Effect.runPromiseExit(DurablePublish.windows(source, target, false))
      expect(Exit.isFailure(result)).toBe(true)
      expect(await fs.readFile(source)).toEqual(Buffer.alloc(1024, 0x5a))
      expect(await fs.exists(target)).toBe(false)
      console.info(
        "DURABLE_PUBLISH_ENV_RESULT",
        JSON.stringify({ phase: "non-windows-bridge-refused", windowsExecuted: false }),
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
    return
  }
  assert.equal(path.win32.parse(root).root.toUpperCase(), "D:\\")
  const core = await fs.realpath(path.resolve(import.meta.dir, "../../../core/src/database/durable-publish.ts"))
  const instrumented = DurablePublishEnvironment.instrument(await fs.readFile(core, "utf8"))
  const loaded = { count: 0 }
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../fixture/durable-publish-environment.ts")],
    outdir: root,
    naming: "durable-publish-environment.js",
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "test-only-original-durable-publish-phases",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]database[/\\]durable-publish\.ts$/ }, async (input) => {
            if ((await fs.realpath(input.path)) !== core) return
            loaded.count++
            return { contents: instrumented, loader: "ts" }
          })
        },
      },
    ],
  })
  expect(build.success).toBe(true)
  expect(loaded.count).toBe(1)
  const entry = path.join(root, "durable-publish-environment.js")
  expect(await fs.exists(entry)).toBe(true)
  const results = []
  // Keep this order explicit. A failed narrow leg still yields the merged facts;
  // an unconfirmed child-tree retirement aborts before starting another leg.
  for (const mode of ["narrow", "merged"] as const) {
    const directory = path.join(root, mode)
    await Promise.all(
      ["home", "config", "data", "cache", "state"].map((name) =>
        fs.mkdir(path.join(directory, name), { recursive: true, mode: 0o700 }),
      ),
    )
    const narrow = importFixtureEnvironment(directory)
    const env: Record<string, string | undefined> =
      mode === "narrow"
        ? narrow
        : {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => !Object.keys(narrow).some((key) => key.toUpperCase() === name.toUpperCase()),
              ),
            ),
            ...narrow,
          }
    // Explicit inherited caches must not write back into the runner's profile.
    for (const [name, relative] of [
      ["PSModuleAnalysisCachePath", "cache/ps-module-analysis"],
      ["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "cache/bun"],
      ["DOTNET_CLI_HOME", "cache/dotnet"],
    ] as const) {
      const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())
      if (!key || !env[key]) continue
      env[key] = path.join(directory, relative)
      await fs.mkdir(path.dirname(env[key]!), { recursive: true, mode: 0o700 })
    }
    const result = await observe(directory, env, entry)
    results.push({ mode, ...result })
    console.info("DURABLE_PUBLISH_ENV_RESULT", JSON.stringify({ mode, ...result }))
  }
  expect(results.map((result) => result.mode)).toEqual(["narrow", "merged"])
  // Assert only after both actual legs have published their independent facts.
  for (const result of results) {
    expect(result.phase).toBe("completed")
    expect(result.code).toBe(0)
    expect(result.receipt).toMatchObject({ bridgeReceipt: true, sourceGone: true, targetEqual: true })
    expect(result.sourceGone).toBe(true)
    expect(result.targetEqual).toBe(true)
    expect(result.phases.map((value) => value.phase)).toEqual([
      "input-wait",
      "input-read",
      "compile-start",
      "compile-done",
      "publish-start",
      "publish-done",
    ])
  }
}, 150_000)

async function observe(root: string, env: Record<string, string | undefined>, entry: string) {
  const started = performance.now()
  const child = Bun.spawn([process.execPath, entry, root], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const state = {
    phase: "setup",
    stopping: undefined as Promise<void> | undefined,
    setupMs: 0,
    started: false,
    treeStopped: false,
  }
  const stop = () =>
    (state.stopping ??= (async () => {
      const deadline = Date.now() + 5_000
      const tree = { failed: false }
      if (child.exitCode === null) {
        const killer = Bun.spawn(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          timeout: 5_000,
          killSignal: "SIGKILL",
        })
        const code = await killer.exited
        if (code !== 0) {
          tree.failed = true
          if (child.exitCode === null) child.kill("SIGKILL")
        }
        if (code === 0) state.treeStopped = true
      }
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(
        () => timeout.reject(new Error("Durable publish oracle owned child-tree join is unknown")),
        Math.max(1, deadline - Date.now()),
      )
      try {
        await Promise.race([Promise.all([child.exited, output]), timeout.promise])
      } finally {
        clearTimeout(timer)
      }
      if (tree.failed) throw new Error("Durable publish oracle owned child-tree retirement is unknown")
    })())
  const setupTimer = setTimeout(() => {
    state.phase = "setup-deadline"
    void stop().catch(() => undefined)
  }, 30_000)
  const business: { timer?: ReturnType<typeof setTimeout> } = {}
  try {
    const deadline = Date.now() + 30_000
    while (!(await fs.exists(path.join(root, "ready.json")))) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Durable publish oracle setup failed")
      await Bun.sleep(25)
    }
    const ready = Schema.decodeUnknownSync(Ready)(await Bun.file(path.join(root, "ready.json")).json())
    assert.equal(ready.pid, child.pid)
    assert.equal(child.exitCode, null)
    clearTimeout(setupTimer)
    state.setupMs = Math.round(performance.now() - started)
    state.phase = "bridge"
    // The original bridge owns 30s. The extra 5s only lets its stop/join finish.
    business.timer = setTimeout(() => {
      state.phase = "bridge-deadline"
      void stop().catch(() => undefined)
    }, 35_000)
    state.started = true
    child.stdin.write("GO\n")
    await child.stdin.flush()
    await child.stdin.end()
    await child.exited
    if (state.phase === "bridge") state.phase = "completed"
  } catch {
    if (state.phase === "setup") state.phase = "setup-failed"
    if (state.phase === "bridge") state.phase = "bridge-failed"
  } finally {
    clearTimeout(setupTimer)
    clearTimeout(business.timer)
    const retired = await stop().then(
      () => true,
      () => false,
    )
    if (!retired) {
      console.info(
        "DURABLE_PUBLISH_ENV_RESULT",
        JSON.stringify({ phase: "retirement-unknown", elapsedMs: Math.round(performance.now() - started) }),
      )
      throw new Error("Durable publish oracle owned child-tree retirement is unknown")
    }
    const logs = await output
    await Promise.all(
      logs.map((value, index) => fs.writeFile(path.join(root, index ? "stderr.log" : "stdout.log"), value)),
    )
  }
  const bytes = await fs.readFile(path.join(root, "result.json")).catch(() => undefined)
  const receipt =
    bytes && bytes.length <= 4096
      ? Schema.decodeUnknownOption(Schema.fromJsonString(Receipt))(bytes.toString())
      : Option.none()
  if (state.started && Option.isNone(receipt) && !state.treeStopped) {
    console.info(
      "DURABLE_PUBLISH_ENV_RESULT",
      JSON.stringify({ phase: "retirement-unknown", elapsedMs: Math.round(performance.now() - started) }),
    )
    throw new Error("Durable publish oracle child exited without a bridge-cleanup receipt or owned tree stop")
  }
  if (Option.isSome(receipt)) assert.equal(receipt.value.pid, child.pid)
  const phases = (await output)[1]!
    .split(/\r?\n/)
    .flatMap((line) => {
      const prefix = "DURABLE_PUBLISH_PS_PHASE "
      if (!line.startsWith(prefix) || line.length > 256) return []
      const value = Schema.decodeUnknownOption(Schema.fromJsonString(Phase), { onExcessProperty: "error" })(
        line.slice(prefix.length),
      )
      return Option.isSome(value) ? [value.value] : []
    })
    .slice(-32)
  return {
    phase: state.phase,
    code: child.exitCode,
    setupMs: state.setupMs,
    elapsedMs: Math.round(performance.now() - started),
    receipt: Option.map(receipt, (value) => ({
      bridgeReceipt: value.bridgeReceipt,
      sourceGone: value.sourceGone,
      targetEqual: value.targetEqual,
      elapsedMs: value.elapsedMs,
    })).pipe(Option.getOrUndefined),
    sourceGone: !(await fs.exists(path.join(root, "source.tmp"))),
    phases: phases.map((value) => ({
      phase: value.phase,
      elapsedMs: value.atMs - (phases[0]?.atMs ?? value.atMs),
      receivedMs: value.receivedMs,
    })),
    targetEqual: await fs.readFile(path.join(root, "target.db")).then(
      (value) => value.equals(Buffer.alloc(1024, 0x5a)),
      () => false,
    ),
  }
}
