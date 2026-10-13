import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "../../src/cross-spawn-spawner"
import { ProcessStopUnknown } from "../../src/process-stop-unknown"

const initial = CrossSpawnSpawner.inspectCustody()
assert.deepEqual(initial, { limit: 128, live: 0, quarantine: 0 })

if (process.argv[2] === "capacity") {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    for (const _ of Array.from({ length: CrossSpawnSpawner.PROCESS_CUSTODY_LIMIT })) {
      yield* spawner.spawn(ChildProcess.make("/bin/sleep", ["60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
    }
    assert.deepEqual(CrossSpawnSpawner.inspectCustody(), { limit: 128, live: 128, quarantine: 0 })
    const refused = yield* Effect.exit(spawner.spawn(ChildProcess.make("/bin/sleep", ["60"])))
    assert(Exit.isFailure(refused))
    const cause = Cause.squash(refused.cause)
    assert(cause instanceof Error && cause.cause instanceof Error)
    assert.equal(cause.cause.message, "PROCESS_CUSTODY_CAPACITY")
  })).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)))
  assert.deepEqual(CrossSpawnSpawner.inspectCustody(), initial)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(ChildProcess.make("/bin/sleep", ["0"]))
    assert.equal(yield* proc.exitCode, 0)
  })).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)))
  assert.deepEqual(CrossSpawnSpawner.inspectCustody(), initial)
  console.log(JSON.stringify({ case: "capacity", reserved: 128, refusedBeforeSpawn: true, knownScopeReleased: true, nextSpawnSucceeded: true }))
}

if (process.argv[2] === "unknown") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-process-custody-"))
  const childPIDFile = path.join(directory, "owned-descendant-pid")
  const node = Bun.which("node")
  assert(node)
  const child = { pid: 0 }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const proc = yield* spawner.spawn(ChildProcess.make(node, ["-e", `
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });
        fs.writeFileSync(process.argv[1], String(child.pid)); child.unref(); process.exit(0);
      `, childPIDFile]))
      const deadline = Date.now() + 2000
      while (!(yield* Effect.promise(() => Bun.file(childPIDFile).exists()))) {
        assert(Date.now() < deadline)
        yield* Effect.sleep(10)
      }
      child.pid = Number(yield* Effect.promise(() => Bun.file(childPIDFile).text()))
      assert(child.pid > 0)
      // The original root has exited; its escaped child still owns inherited pipes.
      yield* Effect.sleep(100)
      const stopped = yield* Effect.exit(proc.kill({ forceKillAfter: 10 }))
      assert(Exit.isFailure(stopped) && Cause.squash(stopped.cause) instanceof ProcessStopUnknown.Error)
      const repeated = yield* Effect.exit(proc.kill({ forceKillAfter: 10 }))
      assert(Exit.isFailure(repeated) && Cause.squash(repeated.cause) instanceof ProcessStopUnknown.Error)
      process.kill(child.pid, 0)
      assert.deepEqual(CrossSpawnSpawner.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
    })).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)))
    assert.deepEqual(CrossSpawnSpawner.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
    process.kill(child.pid, "SIGKILL")
    child.pid = 0
    await Bun.sleep(30)
    assert.deepEqual(CrossSpawnSpawner.inspectCustody(), { limit: 128, live: 0, quarantine: 1 })
    console.log(JSON.stringify({ case: "unknown", quarantine: 1, repeatedStopRefused: true, scopeAndCloseCannotRelease: true, descendantStoppedByFixtureOnly: true, nativeTreeProofClaimed: false }))
  } finally {
    if (child.pid) process.kill(child.pid, "SIGKILL")
    await fs.rm(directory, { recursive: true, force: true })
  }
}
