// C1A-16 fixture child (two-process RUNTIME owner lock, S5/RI-43). A PRODUCTION-FREE
// harness child that acquires the lifetime runtime owner lock (<dbPath>.runtime.lock)
// and HOLDS it, printing HARNESS_READY and sleeping. A parent booting the same store
// (Database.bootstrap / the writable layer Server.listen builds) must observe a live
// owner and REFUSE writable admission (read_only_recovery / another_process_active ->
// maintenance surface 423) instead of preempting the lock. Killed or released, the
// lock is recoverable.
//
// Usage: bun run fixture-child-runtime-lock-holder.ts -- <dbPath>

import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { Effect } from "effect"

const dbPath = process.argv[2]!
const sleepMs = Number(process.env.CRASH_SLEEP_MS ?? "5000")

await Effect.runPromise(
  Effect.gen(function* () {
    const lock = yield* DatabaseMigrationLease.acquireProcessLock(`${dbPath}.runtime.lock`, {
      staleMs: 60_000,
      timeoutMs: 2_000,
    })
    console.log("HARNESS_READY")
    // Hold the lifetime owner lock for the whole window; the heartbeat keeps it non-stale.
    yield* Effect.sleep(sleepMs)
    yield* lock.release
  }),
)
