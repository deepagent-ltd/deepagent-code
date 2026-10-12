import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspectProjectWriteScope, prepareProjectWrite } from "../resources/linux-work-provisioning/prepare-write.mjs"

const helper = "/opt/DeepAgent Code/resources/app.asar.unpacked/out/main/chunks/deepagent-work-file-helper"

test("offline observation binds actual owned project and private data identities without creating a stage", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-write-scope-")))
  try {
    const project = path.join(directory, "项目 code"), data = path.join(directory, "data")
    await fs.mkdir(project, { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 })
    const input = { helper, helperSHA256: "a".repeat(64), uid: process.getuid!(), project, data }
    const observed = await inspectProjectWriteScope(input)
    expect(observed.projectIdentity).toEqual({ kind: "posix", device: (await fs.stat(project, { bigint: true })).dev.toString(),
      inode: (await fs.stat(project, { bigint: true })).ino.toString() })
    expect(observed.dataIdentity).toEqual({ kind: "posix", device: (await fs.stat(data, { bigint: true })).dev.toString(),
      inode: (await fs.stat(data, { bigint: true })).ino.toString() })
    expect(Object.isFrozen(observed)).toBe(true)
    expect(await fs.readdir(data)).toEqual([])
    await fs.chmod(data, 0o755)
    await expect(inspectProjectWriteScope(input)).rejects.toMatchObject({ code: "DAC_WRITE_SCOPE_UNTRUSTED" })
    await fs.chmod(data, 0o700)
    await expect(inspectProjectWriteScope({ ...input, uid: input.uid + 1 })).rejects.toMatchObject({ code: "DAC_WRITE_SCOPE_UNTRUSTED" })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("symlinked scope or data, regular file and substituted directory cannot adopt the original observation", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-linux-write-no-follow-")))
  try {
    const project = path.join(directory, "project"), data = path.join(directory, "data"), alias = path.join(directory, "alias")
    await fs.mkdir(project, { mode: 0o700 }); await fs.mkdir(data, { mode: 0o700 }); await fs.symlink(project, alias)
    const input = { helper, helperSHA256: "a".repeat(64), uid: process.getuid!(), project, data }
    await expect(inspectProjectWriteScope({ ...input, project: alias })).rejects.toMatchObject({ code: "DAC_WRITE_SCOPE_CHANGED" })
    await expect(inspectProjectWriteScope({ ...input, data: alias })).rejects.toMatchObject({ code: "DAC_WRITE_SCOPE_CHANGED" })
    const original = await inspectProjectWriteScope(input)
    await fs.rename(project, path.join(directory, "original")); await fs.mkdir(project, { mode: 0o700 })
    expect((await inspectProjectWriteScope(input)).projectIdentity).not.toEqual(original.projectIdentity)
    await fs.writeFile(path.join(directory, "file"), "scope observation only")
    await expect(inspectProjectWriteScope({ ...input, project: path.join(directory, "file") })).rejects.toBeDefined()
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("off-platform or ordinary user cannot start administrator preparation, even with a supplied operation port", async () => {
  if (process.platform === "linux" && process.getuid!() === 0) return
  const counters = { read: 0, command: 0 }
  await expect(prepareProjectWrite({ prefix: "/opt/DeepAgent Code" }, { uid: 501, project: "/home/user/project", data: "/home/user/data" }, {
    readOwned: async () => { counters.read++; throw new Error("unexpected installation read") },
    command: async () => { counters.command++; throw new Error("unexpected setup launch") },
  })).rejects.toMatchObject({ code: "DAC_WRITE_SETUP_ROOT_REQUIRED" })
  expect(counters).toEqual({ read: 0, command: 0 })
})
