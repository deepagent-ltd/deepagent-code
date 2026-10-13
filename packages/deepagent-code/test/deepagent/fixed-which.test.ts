import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { FixedWhich } from "../../src/util/fixed-which"

test("fixed resolver cannot search empty or relative PATH entries or fall through to cwd or PATHEXT", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-fixed-which-")))
  await fs.writeFile(path.join(root, "synthetic-command"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  await fs.mkdir(path.join(root, "directory"))
  expect(await FixedWhich.find("synthetic-command", { cwd: root, PATH: "/usr/bin:/bin" })).toBeUndefined()
  for (const PATH of ["", ":/bin", "/bin:", ".:/bin", `${root}::/bin`])
    expect(await FixedWhich.find("synthetic-command", { cwd: root, PATH })).toBeUndefined()
  expect(await FixedWhich.find("synthetic-command", { cwd: "", PATH: root })).toBeUndefined()
  expect(await FixedWhich.find("synthetic-command", { cwd: root, PATH: root, platform: "win32" })).toBeUndefined()
  expect(await FixedWhich.find("directory", { cwd: root, PATH: root })).toBeUndefined()
  expect(await FixedWhich.find("synthetic-command", { cwd: root, PATH: root })).toBe(
    path.join(root, "synthetic-command"),
  )
  expect(await FixedWhich.find("./synthetic-command", { cwd: root, PATH: "/bin" })).toBe(
    path.join(root, "synthetic-command"),
  )
  expect(await FixedWhich.find("sh;touch marker", { cwd: root, PATH: "/bin" })).toBeUndefined()
  expect(
    await fs.stat(path.join(root, "marker")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await fs.chmod(path.join(root, "synthetic-command"), 0o600)
  expect(await FixedWhich.find("synthetic-command", { cwd: root, PATH: root })).toBeUndefined()
})
