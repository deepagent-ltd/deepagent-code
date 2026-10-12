import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { AttachmentStorage } from "../src/im/attachment-storage"
import { AttachmentTable } from "../src/im/sql"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"

test("hard media limit only shrinks and durable attachment reservations enforce one instance budget", async () => {
  await using root = await tmpdir()
  const previous = process.env.IM_MAX_ATTACHMENT_BYTES
  try {
    process.env.IM_MAX_ATTACHMENT_BYTES = String(100 * 1024 * 1024)
    expect(AttachmentStorage.maxAttachmentBytes()).toBe(10 * 1024 * 1024)
  } finally {
    if (previous === undefined) delete process.env.IM_MAX_ATTACHMENT_BYTES
    else process.env.IM_MAX_ATTACHMENT_BYTES = previous
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* IMRepository
      const db = (yield* Database.Service).db
      const input = {
        workspaceID: "private-capacity",
        uploadedBy: "server",
        storagePath: "/private/fixture",
        filename: "large.bin",
        mime: "application/octet-stream",
        sizeBytes: 10 * 1024 * 1024,
        checksum: "a".repeat(64),
      }
      for (let index = 0; index < 102; index++) yield* repo.createAttachment({ ...input, id: `ima_capacity_${index}` })
      const denied = yield* repo.createAttachment({ ...input, id: "ima_over_budget" }).pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
      expect(yield* db.select().from(AttachmentTable)).toHaveLength(102)
      const concurrent = yield* Effect.promise(() => reserveTogether(root.path))
      expect(concurrent.filter((result) => result.reserved)).toHaveLength(1)
      expect(yield* db.select().from(AttachmentTable)).toHaveLength(103)
      yield* repo.expireAttachment("ima_capacity_0")
      const replacement = yield* repo.createAttachment({ ...input, id: "ima_replacement" })
      expect(replacement.id).toBe("ima_replacement")
      expect(yield* db.select().from(AttachmentTable)).toHaveLength(104)
    }).pipe(
      Effect.provide(
        Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(path.join(root.path, "media.sqlite"))),
      ),
    ),
  )
}, 20_000)

async function reserveTogether(root: string) {
  const children = ["a", "b"].map((suffix) => ({
    suffix,
    child: Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "fixture/im-media-capacity-process.ts"), root, suffix],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DEEPAGENT_CODE_TEST_HOME: root,
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  }))
  const timer = setTimeout(() => children.forEach(({ child }) => child.kill()), 15_000)
  try {
    for (let index = 0; ; index++) {
      if (
        (
          await Promise.all(
            children.map(({ suffix }) =>
              fs.stat(path.join(root, `ready-${suffix}`)).then(
                () => true,
                () => false,
              ),
            ),
          )
        ).every(Boolean)
      )
        break
      if (index === 500) throw new Error("Private capacity children were not ready")
      await Bun.sleep(10)
    }
    await fs.writeFile(path.join(root, "reserve-now"), "reserve", { mode: 0o600 })
    return await Promise.all(
      children.map(async ({ child }) => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stderr).toBe(0)
        return JSON.parse(stdout.trim()) as { reserved: boolean }
      }),
    )
  } finally {
    clearTimeout(timer)
    for (const { child } of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map(({ child }) => child.exited))
  }
}
