import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { EventWorkPlacementHost } from "../../src/installation/event-work-placement"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform === "win32")("retained event directory checks the original inode and releases its scoped descriptor", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "original")
  await fs.mkdir(directory)
  const identity = await fs.lstat(directory, { bigint: true })
  const original = { kind: "posix" as const, device: identity.dev.toString(), inode: identity.ino.toString() }
  const scope = await Effect.runPromise(Scope.make())
  const lease = await Effect.runPromise(EventWorkPlacementHost.retainDirectory(directory, original).pipe(Effect.provideService(Scope.Scope, scope)))
  try {
    expect(lease.isCurrent()).toBe(true)
    expect(await Effect.runPromise(lease.current.pipe(Effect.exit))).toMatchObject({ _tag: "Success" })
    await fs.rename(directory, path.join(tmp.path, "renamed"))
    await fs.mkdir(directory)
    // A held observer remains owned after a name replacement; it cannot observe that
    // replacement as the original directory or mint another execution witness.
    expect(lease.isCurrent()).toBe(true)
    expect(await Effect.runPromise(lease.current.pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromise(EventWorkPlacementHost.retainDirectory(directory, original).pipe(Effect.scoped, Effect.exit)))
      .toMatchObject({ _tag: "Failure" })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
  expect(lease.isCurrent()).toBe(false)
  expect(await Effect.runPromise(lease.current.pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
})
