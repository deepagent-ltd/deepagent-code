import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { withMaintenanceLock } from "../../src/server/maintenance-lock"
import { tmpdir } from "../fixture/fixture"

test("maintenance actions sharing a backup root cannot enter concurrently", async () => {
  await using tmp = await tmpdir()
  const backupDir = path.join(tmp.path, "backups")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = Effect.runPromise(
    withMaintenanceLock(
      backupDir,
      Effect.promise(async () => {
        entered.resolve()
        await release.promise
      }),
    ),
  )
  await entered.promise
  let secondEntered = false
  const second = Effect.runPromise(
    withMaintenanceLock(backupDir, Effect.sync(() => {
      secondEntered = true
    })),
  )
  await Bun.sleep(150)
  expect(secondEntered).toBeFalse()
  release.resolve()
  await Promise.all([first, second])
  expect(secondEntered).toBeTrue()
})
