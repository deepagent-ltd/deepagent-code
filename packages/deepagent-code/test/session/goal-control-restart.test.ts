import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

for (const scenario of ["paused", "unknown", "wake-before", "wake-after"] as const)
  test(`Goal ${scenario} survives real SIGKILL and cold production-port rejection`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "goal-control-process-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const processes: ReturnType<typeof Bun.spawn>[] = []
    const launch = async (phase: string) => {
      const child = Bun.spawn({
        cmd: [process.execPath, "test/fixture/goal-control-process.ts", root, phase],
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      processes.push(child)
      const errors = new Response(child.stderr).text()
      const ready = (async () => {
        const reader = child.stdout.getReader()
        while (true) {
          const next = await reader.read()
          if (next.done) return false
          if (Buffer.from(next.value).toString().includes("GOAL_CONTROL_READY")) return true
        }
      })()
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15000)
      const ok = await ready
      clearTimeout(deadline)
      if (!ok) throw new Error(await errors)
      return child
    }
    try {
      const first = await launch(scenario === "unknown" ? "permit" : scenario === "wake-after" ? "publish-gap" : "seed")
      first.kill("SIGKILL")
      await first.exited
      expect(first.signalCode).toBe("SIGKILL")
      if (scenario === "paused") {
        const control = await launch("pause")
        control.kill("SIGKILL")
        await control.exited
        expect(control.signalCode).toBe("SIGKILL")
      }
      const last = await launch(`verify-${scenario}`)
      const evidence = await Bun.file(path.join(root, `verify-${scenario}.json`)).json()
      if (scenario.startsWith("wake")) {
        expect(evidence).toEqual({ events: { count: 1 }, deliveries: { count: 1 }, wakeState: "published" })
      } else {
        expect(evidence.accesses).toEqual([])
        expect(evidence.snapshot).toMatchObject(
          scenario === "paused"
            ? { requestedPhase: "paused", revision: 2, inFlight: false }
            : { requestedPhase: "running", running: false, inFlight: true, recoveryRequired: true },
        )
      }
      last.kill("SIGKILL")
      await last.exited
      const db = new Database(path.join(root, "authority.sqlite"), { readonly: true })
      expect(db.query("SELECT count(*) AS count FROM session_input").get()).toEqual({ count: 0 })
      expect(db.query("SELECT count(*) AS count FROM session_provider_attempt").get()).toEqual({ count: 0 })
      expect(db.query("SELECT count(*) AS count FROM session").get()).toEqual({ count: 1 })
      db.close()
      console.log(
        "GOAL_CONTROL_SIGKILL_PASS",
        JSON.stringify({ scenario, pids: processes.map((item) => item.pid), ...evidence }),
      )
    } finally {
      for (const child of processes) {
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
