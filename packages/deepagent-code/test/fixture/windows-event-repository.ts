import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { Cause, Effect, Exit } from "effect"
import { EventWorkGit } from "../../src/session/event-work-git"
import { windowsMcpStorage } from "./windows-mcp-storage"

export async function verifyEventRepository(root?: string) {
  const temporary = root ?? (process.platform === "win32"
    ? [process.env.RUNNER_TEMP, os.tmpdir()].find((directory) => directory && path.win32.parse(directory).root.toUpperCase() === "D:\\")
    : os.tmpdir())
  if (!temporary) throw new Error("Held Event repository requires a D: scratch root on Windows")
  const directory = await fs.realpath(await fs.mkdtemp(path.join(temporary, "dac-event-repository-")))
  try {
    expect(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status).toBe(0)
    const child = path.join(directory, "child")
    await fs.mkdir(child)
    expect(spawnSync("git", ["init", "--quiet"], { cwd: child }).status).toBe(0)
    const before = await fs.readdir(path.join(child, ".git/objects"))
    await Effect.runPromise(Effect.gen(function* () {
      const runtime = yield* EventWorkGit.pinRepository(directory, yield* EventWorkGit.capture)
      const refusedChild = yield* EventWorkGit.run({ directory: child, args: ["hash-object", "-w", "--stdin"], stdin: Buffer.from("foreign") })
        .pipe(Effect.provideService(EventWorkGit.Current, runtime), Effect.exit)
      expect(Exit.isFailure(refusedChild)).toBe(true)
      if (Exit.isFailure(refusedChild)) expect(Cause.squash(refusedChild.cause)).toMatchObject({ code: "EVENT_DAG_UNAVAILABLE" })
      yield* Effect.promise(async () => {
        await fs.rename(path.join(directory, ".git"), path.join(directory, "original-git"))
        await fs.writeFile(path.join(directory, ".git"), `gitdir: ${path.join(child, ".git")}\n`)
      })
      const refusedParent = yield* EventWorkGit.run({ directory, args: ["hash-object", "-w", "--stdin"], stdin: Buffer.from("foreign") })
        .pipe(Effect.provideService(EventWorkGit.Current, runtime), Effect.exit)
      expect(Exit.isFailure(refusedParent)).toBe(true)
      if (Exit.isFailure(refusedParent)) expect(Cause.squash(refusedParent.cause)).toMatchObject({ code: "EVENT_DAG_UNAVAILABLE" })
    }).pipe(Effect.scoped, Effect.provide(windowsMcpStorage)))
    expect(await fs.readdir(path.join(child, ".git/objects"))).toEqual(before)
    expect((await fs.readdir(path.join(directory, "original-git/objects"))).sort()).toEqual(["info", "pack"])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) await verifyEventRepository()
