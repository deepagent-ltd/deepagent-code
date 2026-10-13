import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MediaIntent } from "@deepagent-code/core/im/media-intent"
import { createMediaIntentStore } from "../../../src/util/im-media-intent"
import { readMediaFile, publishMediaFile } from "../../../src/component/im-media"
import { tmpdir } from "../../fixture/fixture"

const scope = {
  server: "http://127.0.0.1:1234",
  directory: "/project",
  workspaceID: "/project",
  groupID: "group",
  memberID: "server",
}

for (const kind of ["directory permissions", "record permissions", "directory symlink", "record symlink"] as const) {
  test.skipIf(process.platform === "win32")(
    `private client facts reject existing ${kind} before a real dispatch`,
    async () => {
      await using dir = await tmpdir()
      const directory = path.join(dir.path, "im-media-v1")
      const file = path.join(directory, "records.json")
      await fs.mkdir(directory, { mode: 0o700 })
      await fs.writeFile(file, "[]", { mode: 0o600 })
      if (kind === "directory permissions") await fs.chmod(directory, 0o777)
      if (kind === "record permissions") await fs.chmod(file, 0o644)
      if (kind === "directory symlink") {
        await fs.rename(directory, path.join(dir.path, "other"))
        await fs.symlink(path.join(dir.path, "other"), directory)
      }
      if (kind === "record symlink") {
        await fs.rename(file, path.join(dir.path, "other.json"))
        await fs.symlink(path.join(dir.path, "other.json"), file)
      }
      let calls = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          calls++
          return new Response("unexpected dispatch")
        },
      })
      const record = MediaIntent.create(scope, {
        name: "private",
        mime: "application/octet-stream",
        sizeBytes: 1,
        checksum: "a".repeat(64),
      })
      try {
        const result = await createMediaIntentStore(dir.path)
          .put(record)
          .then(() => fetch(server.url, { method: "POST" }))
          .then(
            () => "dispatched",
            () => "rejected",
          )
        expect(result).toBe("rejected")
        expect(calls).toBe(0)
        await expect(createMediaIntentStore(dir.path).list(scope)).rejects.toThrow()
        expect(await fs.readFile(file, "utf8")).toBe("[]")
      } finally {
        await server.stop(true)
      }
    },
  )
}

test.skipIf(process.platform === "win32" || !process.getuid)(
  "real store ownership must match the current process principal",
  async () => {
    await using dir = await tmpdir()
    const store = createMediaIntentStore(dir.path)
    await store.list(scope)
    const owner = (await fs.lstat(path.join(dir.path, "im-media-v1"))).uid
    // A normal test account cannot chown to another uid. Keep real filesystem stats;
    // only the current-process identity boundary changes, never stat/open/read data.
    const identity = spyOn(process, "getuid").mockReturnValue(owner + 1)
    try {
      await expect(store.list(scope)).rejects.toThrow()
    } finally {
      identity.mockRestore()
    }
  },
)

test("actual private store commits before dispatch and rejects concurrent stale writers and storage obstruction", async () => {
  await using dir = await tmpdir()
  const record = MediaIntent.create(scope, {
    name: "file",
    mime: "application/octet-stream",
    sizeBytes: 1,
    checksum: "a".repeat(64),
  })
  const store = createMediaIntentStore(dir.path)
  await store.put(record)
  const next = MediaIntent.change(record, "uploading")
  const results = await Promise.allSettled([store.put(next, 0), createMediaIntentStore(dir.path).put(next, 0)])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  const reopened = await createMediaIntentStore(dir.path).list(scope)
  expect(reopened).toHaveLength(1)
  expect(MediaIntent.observedPhase(reopened[0])).toBe("upload_outcome_unknown")
  expect(reopened[0].requestID).toBe(record.requestID)
  expect((await fs.stat(path.join(dir.path, "im-media-v1", "records.json"))).mode & 0o777).toBe(0o600)
  await fs.writeFile(path.join(dir.path, "blocked"), "not a directory")
  await expect(createMediaIntentStore(path.join(dir.path, "blocked")).put(record)).rejects.toThrow()
})

test("real file reader rejects symlinks/oversize and atomic publish never replaces a file or symlink", async () => {
  await using dir = await tmpdir()
  const source = path.join(dir.path, "source")
  await fs.writeFile(source, "payload")
  const loaded = await readMediaFile(source, new AbortController().signal)
  expect(loaded.file.sizeBytes).toBe(7)
  const linked = path.join(dir.path, "linked")
  await fs.symlink(source, linked)
  await expect(readMediaFile(linked, new AbortController().signal)).rejects.toThrow()
  const large = await fs.open(path.join(dir.path, "large"), "w")
  await large.truncate(50 * 1024 * 1024 + 1)
  await large.close()
  await expect(readMediaFile(path.join(dir.path, "large"), new AbortController().signal)).rejects.toThrow()
  const createdAt = Date.now()
  const attachment = MediaIntent.attachment({
    id: "attachment",
    workspaceID: scope.workspaceID,
    groupID: "group",
    projectID: null,
    messageID: "message",
    uploadedBy: "server",
    filename: "file",
    mime: loaded.file.mime,
    sizeBytes: 7,
    checksum: loaded.file.checksum,
    createdAt,
    expiresAt: createdAt + 86_400_000,
    preview: false,
  })
  const target = path.join(dir.path, "target")
  await publishMediaFile(target, loaded.bytes, attachment, new AbortController().signal)
  expect(await fs.readFile(target, "utf8")).toBe("payload")
  await expect(publishMediaFile(target, loaded.bytes, attachment, new AbortController().signal)).rejects.toThrow()
  await expect(publishMediaFile(linked, loaded.bytes, attachment, new AbortController().signal)).rejects.toThrow()
  expect(await fs.readFile(source, "utf8")).toBe("payload")
  expect((await fs.readdir(dir.path)).filter((name) => name.endsWith(".part"))).toEqual([])
})

test("an opened real fd cannot hide a path replacement before its bounded read", async () => {
  await using dir = await tmpdir()
  const source = path.join(dir.path, "changing")
  await fs.writeFile(source, "original")
  const opened = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  // Scheduling gate only: retain the actual OS descriptor and perform all real file I/O.
  const gate = spyOn(fs, "open").mockImplementation(async (...args) => {
    gate.mockRestore()
    const handle = await fs.open(...args)
    if (args[0] === source && typeof args[1] === "number") {
      opened.resolve()
      await release.promise
    }
    return handle
  })
  try {
    const read = readMediaFile(source, new AbortController().signal)
    void read.catch(() => undefined)
    await Promise.race([
      opened.promise,
      Bun.sleep(1000).then(() => {
        throw new Error("Real file open was not reached")
      }),
    ])
    await fs.rename(source, path.join(dir.path, "old"))
    await Bun.write(source, "replacement")
    release.resolve()
    await expect(read).rejects.toThrow()
    expect(await fs.readFile(source, "utf8")).toBe("replacement")
  } finally {
    release.resolve()
    gate.mockRestore()
  }
})
