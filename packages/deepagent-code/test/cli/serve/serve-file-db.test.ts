// P0 regression oracle: a FILE-backed `deepagentCode serve` must boot the business route tree,
// not the read-only maintenance shell. The regression: effectCmd ran the serve handler inside
// AppRuntime, whose root graph opened + migrated + lifetime-locked the DB before Server.listen;
// startListener's own preflight then classified the process's OWN runtime lock as
// another_process_active and every business route 404'd (/bootstrap/status 423
// read_only_recovery). The in-process suites never saw it because test/preload.ts pins
// DEEPAGENT_CODE_DB=:memory: — these cases pass an explicit named DB to the child.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { MaintenancePaths } from "../../../src/server/routes/instance/httpapi/groups/maintenance"
import { cliIt } from "../../lib/cli-process"

describe("deepagentCode serve with a file database (subprocess)", () => {
  cliIt.live(
    "boots the business routes on a fresh file-backed DB (no self-lock misclassification)",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const databaseName = "serve-file-boot.db"
        const server = yield* deepagentCode.serve({
          env: { DEEPAGENT_CODE_DB: databaseName },
        })

        const health = yield* Effect.promise(() => fetch(`${server.url}/global/health`))
        expect(health.status).toBe(200)

        const status = yield* Effect.promise(() => fetch(new URL(MaintenancePaths.bootstrapStatus, server.url)))
        expect(status.status).toBe(200)
        expect(yield* Effect.promise(() => status.json())).toMatchObject({ mode: "ready", ready: true })

        // The full business composition (not the incident-only shell) is serving.
        const digest = yield* Effect.promise(() => fetch(`${server.url}/composition/digest`))
        expect(digest.status).toBe(200)
        const digestBody = yield* Effect.promise(() => digest.json())
        // Suffix match: macOS tmp homes resolve through the /var -> /private/var symlink, so the
        // child's live connection path may differ from the test-side join by that prefix only.
        expect(digestBody).toMatchObject({ database: {} })
        expect((digestBody as { database: { path: string } }).database.path.endsWith(`/${databaseName}`)).toBe(true)
      }),
    90_000,
  )

  cliIt.live(
    "a live foreign runtime-lock owner still boots the maintenance shell (423, no preemption)",
    ({ deepagentCode, home }) =>
      Effect.gen(function* () {
        const databaseName = "serve-foreign-lock.db"
        const databasePath = path.join(home, ".deepagent", "code", databaseName)
        // Held by the TEST process: from the child's perspective a live, same-host, different-pid
        // owner — the S5 contract that a real second process must never be preempted.
        const lock = yield* Effect.promise(() =>
          Effect.runPromise(
            DatabaseMigrationLease.acquireProcessLock(`${databasePath}.runtime.lock`, {
              staleMs: 15_000,
              timeoutMs: 2_000,
            }),
          ),
        )
        try {
          const server = yield* deepagentCode.serve({
            env: { DEEPAGENT_CODE_DB: databaseName },
          })

          const status = yield* Effect.promise(() => fetch(new URL(MaintenancePaths.bootstrapStatus, server.url)))
          expect(status.status).toBe(423)
          expect(yield* Effect.promise(() => status.json())).toMatchObject({
            name: "ApiLocked",
            data: { actual: "read_only_recovery" },
          })

          const health = yield* Effect.promise(() => fetch(`${server.url}/global/health`))
          expect(health.status).toBe(404)
          // No preemption: the foreign owner lock is still live after the child booted.
          expect(yield* Effect.promise(() => DatabaseMigrationLease.processLockActive(`${databasePath}.runtime.lock`))).toBe(true)
        } finally {
          yield* Effect.promise(() => Effect.runPromise(lock.release))
        }
      }),
    90_000,
  )
})
