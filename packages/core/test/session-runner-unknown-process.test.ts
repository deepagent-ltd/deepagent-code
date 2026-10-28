import { afterAll, beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Reuse the full runner fixture in isolated processes. The external tool and provider are
// deterministic seams; SessionV2, runner, input promotion, admissions and file DB are real.
// This is a clean process-reopen oracle, not a SIGKILL during the external side effect.
const scenarios = [
  { gate: "normal", providerFailed: false },
  { gate: "reminder", providerFailed: false },
  { gate: "normal", providerFailed: true },
  { gate: "reminder", providerFailed: true },
]
const roots = new Map<string, string>()

// This oracle tests durable dispatch/reopen, not empty-schema migration cost. Prepare only
// the official empty schema; each original child still opens and closes its own real DB.
beforeAll(async () => {
  const started = performance.now()
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const scenario of scenarios) {
        const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "runner-unknown-process-")))
        roots.set(JSON.stringify(scenario), root)
        yield* Effect.promise(() =>
          Promise.all(["home", "tmp", "config", "data", "cache", "state", "workspace"].map((name) => mkdir(path.join(root, name)))),
        )
        console.error(JSON.stringify({ test: "runner-unknown-schema", phase: "open", ...scenario,
          elapsedMs: Math.round(performance.now() - started) }))
        yield* Database.Service.pipe(
          Effect.provide(Database.layerFromPath(path.join(root, "authority.sqlite"))),
          Effect.scoped,
        )
        console.error(JSON.stringify({ test: "runner-unknown-schema", phase: "closed", ...scenario,
          elapsedMs: Math.round(performance.now() - started) }))
      }
    }).pipe(Effect.timeout("110 seconds")),
  )
}, 120_000)

afterAll(async () => {
  await Promise.all([...roots.values()].map((root) => rm(root, { recursive: true, force: true })))
})

test.each(scenarios)(
  "unknown tool outcome survives process reopen (%j)",
  async (scenario) => {
    const root = roots.get(JSON.stringify(scenario))
    if (!root) throw new Error("Unknown-outcome schema fixture was not prepared")
    const filename = path.join(root, "authority.sqlite")
    try {
      for (const phase of ["dispatch", "recover"]) {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "test",
            "./test/session-runner.test.ts",
            "--test-name-pattern",
            "quarantines an unknown tool outcome without replaying its body",
            "--timeout",
            "20000",
          ],
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH,
            HOME: path.join(root, "home"),
            TMPDIR: path.join(root, "tmp"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            DEEPAGENT_TEST_RUNNER_EFFECT_DB: filename,
            DEEPAGENT_TEST_RUNNER_DIRECTORY: path.join(root, "workspace"),
            DEEPAGENT_TEST_RUNNER_EFFECT_PHASE: phase,
            DEEPAGENT_TEST_RUNNER_UNKNOWN_GATE: scenario.gate,
            DEEPAGENT_TEST_RUNNER_PROVIDER_FAILED: String(scenario.providerFailed),
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        stderr.split("\n")
          .filter((line) => line.startsWith('{"test":"runner-unknown-process"'))
          .forEach((line) => console.error(line))
        expect({ phase, status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({
          phase,
          status: 0,
          output: "ok",
        })
      }
      const dispatched = await Bun.file(`${filename}.dispatch.json`).json()
      const recovered = await Bun.file(`${filename}.recover.json`).json()
      const providerState = scenario.providerFailed ? "indeterminate_after_crash" : "settled"
      expect(dispatched).toMatchObject({ providerCalls: 1, toolBodies: 1, providerState, pending: 1 })
      expect(recovered).toMatchObject({ providerCalls: 0, toolBodies: 0, providerState, pending: 1 })
      expect(recovered.pid).not.toBe(dispatched.pid)
      expect(recovered.admissionID).toBe(dispatched.admissionID)
      expect(recovered.receiptID).toBe(dispatched.receiptID)
      expect(recovered.inputID).toBe(dispatched.inputID)
      expect(await Bun.file(`${filename}.body`).text()).toBe("dispatched\n")
      expect((await Bun.file(filename).stat()).size).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
