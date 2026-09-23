import path from "node:path"
import { Flock } from "@deepagent-code/core/util/flock"
import { Effect } from "effect"

/** Serialize migration, backup governance, and reclaim across processes for one backup root. */
export function withMaintenanceLock<A, E, R>(backupDir: string, body: Effect.Effect<A, E, R>) {
  const root = path.resolve(backupDir)
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`maintenance:${root}`, {
        dir: path.join(path.dirname(root), ".deepagent-maintenance-locks"),
        timeoutMs: 60 * 60_000,
      })
      return yield* body
    }),
  )
}
