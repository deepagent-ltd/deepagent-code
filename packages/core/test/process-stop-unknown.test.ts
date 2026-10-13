import { expect, test } from "bun:test"
import path from "node:path"
import { Duration, Effect, Exit } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@deepagent-code/core/process"
import { ProcessStopUnknown } from "@deepagent-code/core/process-stop-unknown"
import { tmpdir } from "./fixture/tmpdir"

test("an owned TERM-ignoring process is joined after escalation without claiming unknown", async () => {
  const start = performance.now()
  const exit = await Effect.runPromise(Effect.gen(function* () {
    const process = yield* AppProcess.Service
    return yield* process.run(ChildProcess.make(globalThis.process.execPath, ["-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},10)"], { forceKillAfter: Duration.millis(50), detached: globalThis.process.platform !== "win32" }),
      { timeout: Duration.millis(300) })
  }).pipe(Effect.provide(AppProcess.defaultLayer), Effect.exit))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(performance.now() - start).toBeLessThan(3500)
  if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect instanceof ProcessStopUnknown.Error)).toBe(false)
}, 5000)

test.skipIf(process.platform === "win32")("escaped inherited pipes produce a bounded unknown stop, then the private fixture is reclaimed", async () => {
  await using root = await tmpdir()
  const marker = path.join(root.path, "leaf.pid")
  const heartbeat = path.join(root.path, "leaf.heartbeat")
  const leaf = path.join(root.path, "owned-leaf.ts")
  const parent = path.join(root.path, "owned-parent.ts")
  await Bun.write(leaf, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),10);`)
  await Bun.write(parent, `import { spawn } from 'node:child_process'; process.on('SIGTERM',()=>{}); spawn(process.execPath,[${JSON.stringify(leaf)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref(); setInterval(()=>{},10);`)
  const start = performance.now()
  try {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const process = yield* AppProcess.Service
      const handle = yield* process.spawn(ChildProcess.make(globalThis.process.execPath, [parent], { detached: true,
        forceKillAfter: Duration.millis(50) }))
      yield* Effect.promise(() => Bun.sleep(300))
      return yield* handle.kill({ forceKillAfter: Duration.millis(50) })
    }).pipe(Effect.scoped, Effect.provide(AppProcess.defaultLayer), Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(performance.now() - start).toBeLessThan(4000)
    if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect instanceof ProcessStopUnknown.Error)).toBe(true)
    const before = await Bun.file(heartbeat).text()
    await Bun.sleep(40)
    expect(await Bun.file(heartbeat).text()).not.toBe(before)
  } finally {
    if (await Bun.file(marker).exists()) {
      const pid = Number(await Bun.file(marker).text())
      const owner = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]).stdout.toString()
      // Kill only the fresh child whose command still names this unique private script.
      if (Number.isSafeInteger(pid) && pid > 0 && owner.includes(leaf)) {
        process.kill(pid, "SIGKILL")
        const deadline = Date.now() + 1000
        while (Date.now() < deadline && Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]).stdout.toString().includes(leaf)) await Bun.sleep(10)
        expect(Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]).stdout.toString().includes(leaf)).toBe(false)
      }
    }
  }
}, 7000)
