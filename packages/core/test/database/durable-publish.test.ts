import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { DurablePublish } from "@deepagent-code/core/database/durable-publish"
import { tmpdir } from "../fixture/tmpdir"

describe.skipIf(process.platform !== "win32")("Windows/NTFS durable database publication", () => {
  test("publishes adjacent Unicode paths through structured input and refuses an existing backup", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "源 ' $(literal).tmp")
    const target = path.join(tmp.path, "备份 ' $(literal).db")
    await fs.writeFile(source, "known-good")
    await Effect.runPromise(DurablePublish.windows(source, target, false))
    expect(await fs.readFile(target, "utf8")).toBe("known-good")
    expect(await fs.exists(source)).toBe(false)

    await fs.writeFile(source, "next")
    const result = await Effect.runPromise(DurablePublish.windows(source, target, false).pipe(Effect.exit))
    expect(result._tag).toBe("Failure")
    expect(await fs.readFile(target, "utf8")).toBe("known-good")
    expect(await fs.readFile(source, "utf8")).toBe("next")
  }, 30_000)

  test("replaces a restore target and refuses nonadjacent publication without changing either file", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "restore.tmp")
    const target = path.join(tmp.path, "live.db")
    await fs.writeFile(source, "restored")
    await fs.writeFile(target, "incident")
    await Effect.runPromise(DurablePublish.windows(source, target, true))
    expect(await fs.readFile(target, "utf8")).toBe("restored")
    expect(await fs.exists(source)).toBe(false)

    await fs.mkdir(path.join(tmp.path, "other"))
    const foreign = path.join(tmp.path, "other", "source.tmp")
    await fs.writeFile(foreign, "foreign")
    const result = await Effect.runPromise(DurablePublish.windows(foreign, target, true).pipe(Effect.exit))
    expect(result._tag).toBe("Failure")
    expect(await fs.readFile(target, "utf8")).toBe("restored")
    expect(await fs.readFile(foreign, "utf8")).toBe("foreign")
  }, 30_000)

  test("interruption reports failure without assuming a namespace outcome", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "cancel.tmp")
    const target = path.join(tmp.path, "cancel.db")
    await fs.writeFile(source, "owned-cancel")
    const fiber = Effect.runFork(DurablePublish.windows(source, target, false))
    await Bun.sleep(25)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag).toBe("Failure")
    // Cancellation can race a completed kernel rename. Either namespace outcome is valid;
    // neither an interrupted caller nor the bridge may turn it into a success or auto-replay.
    const current = await fs.readFile(target, "utf8").catch(() => fs.readFile(source, "utf8"))
    expect(current).toBe("owned-cancel")
  }, 30_000)
})
