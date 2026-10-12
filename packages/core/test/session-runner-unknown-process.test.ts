import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Reuse the full runner fixture in isolated processes. The external tool and provider are
// deterministic seams; SessionV2, runner, input promotion, admissions and file DB are real.
// This is a clean process-reopen oracle, not a SIGKILL during the external side effect.
test.each([
  { gate: "normal", providerFailed: false },
  { gate: "reminder", providerFailed: false },
  { gate: "normal", providerFailed: true },
  { gate: "reminder", providerFailed: true },
])(
  "unknown tool outcome survives process reopen (%j)",
  async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "runner-unknown-process-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
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
