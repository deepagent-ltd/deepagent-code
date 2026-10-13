import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createSidecarStop } from "./sidecar-stop"

test("kill acknowledgement without original exit is bounded, remains unconfirmed, and never redispatches", async () => {
  const exit = Promise.withResolvers<number>()
  const facts = { stops: 0, kills: 0, observations: [] as unknown[] }
  const stop = createSidecarStop({
    postStop: () => { facts.stops++ },
    kill: () => { facts.kills++; return true },
    exit: exit.promise,
    hasExited: () => false,
    gracefulMs: 10,
    forcedJoinMs: 10,
    onObservation: (observation) => { facts.observations.push(observation) },
  })
  const original = stop()
  expect(stop()).toBe(original)
  await expect(original).rejects.toMatchObject({ code: "SIDECAR_STOP_UNCONFIRMED", kind: "unconfirmed", killRequested: true, killAccepted: true })
  expect(facts.stops).toBe(1)
  expect(facts.kills).toBe(1)
  expect(stop()).toBe(original)
  exit.resolve(143)
  await exit.promise
  await Promise.resolve()
  await expect(stop()).rejects.toHaveProperty("code", "SIDECAR_STOP_UNCONFIRMED")
  expect(facts.observations).toEqual([
    { kind: "unconfirmed", killRequested: true, killAccepted: true },
    { kind: "late_exit", exitCode: 143, forced: true },
  ])
  expect(facts.stops).toBe(1)
  expect(facts.kills).toBe(1)
})

for (const scenario of ["normal", "forced"] as const) {
  test(`actual Electron ${scenario} stop only completes after the original utility exit`, async () => {
    const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-sidecar-stop-"))
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/sidecar-stop-main.ts"), path.join(import.meta.dir, "fixture/sidecar-stop-utility.ts")],
      outdir: root,
      target: "node",
      external: ["electron"],
    })
    expect(built.success).toBe(true)
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "sidecar-stop-main.js")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: root,
        DAC_SIDECAR_STOP_ROOT: root,
        DAC_SIDECAR_STOP_UTILITY: path.join(root, "sidecar-stop-utility.js"),
        DAC_SIDECAR_STOP_SCENARIO: scenario,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("SIDECAR_STOP_EVIDENCE", scenario, root)
    expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
    const facts = await Bun.file(path.join(root, "main.json")).json()
    const utility = await Bun.file(path.join(root, "utility.json")).json()
    expect(facts.childExit).toBe(true)
    expect(facts.childPID).toBe(utility.pid)
    expect(facts.joined).toBe(true)
    expect(facts.postStops).toBe(1)
    expect(utility.stops).toBe(1)
    expect(facts.killRequests).toBe(scenario === "forced" ? 1 : 0)
    expect(facts.completedAt).toBeGreaterThanOrEqual(facts.childExitedAt)
    expect(facts.observations).toEqual([{ kind: scenario, exitCode: facts.childCode }])
    if (scenario === "normal") {
      expect(facts.childCode).toBe(0)
      expect(utility.exitingAt - utility.acceptedAt).toBeGreaterThanOrEqual(100)
      return
    }
    expect(facts.killAccepted).toBe(true)
    expect(facts.completedAt - facts.startedAt).toBeGreaterThanOrEqual(6_000)
    expect(facts.completedAt - facts.startedAt).toBeLessThan(8_000)
    expect(utility.exitingAt).toBe(0)
  }, 20_000)
}
