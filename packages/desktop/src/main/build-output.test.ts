import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { preserveBuildOutput } from "../../scripts/build"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-desktop-build-"))
  const output = path.join(root, "out")
  await mkdir(output)
  await Bun.write(path.join(output, "previous.js"), "previous")
  return {
    root,
    output,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

describe("Desktop build output preservation", () => {
  test("restores the last good output when a build command fails", async () => {
    await using directory = await fixture()
    const exitCode = await preserveBuildOutput(directory.output, async () => {
      await mkdir(directory.output)
      await Bun.write(path.join(directory.output, "incomplete.js"), "incomplete")
      return 7
    })

    expect(exitCode).toBe(7)
    expect(await Bun.file(path.join(directory.output, "previous.js")).text()).toBe("previous")
    expect(await Bun.file(path.join(directory.output, "incomplete.js")).exists()).toBe(false)
  })

  test("commits the new output only after a successful build", async () => {
    await using directory = await fixture()
    const exitCode = await preserveBuildOutput(directory.output, async () => {
      await mkdir(directory.output)
      await Bun.write(path.join(directory.output, "current.js"), "current")
      return 0
    })

    expect(exitCode).toBe(0)
    expect(await Bun.file(path.join(directory.output, "previous.js")).exists()).toBe(false)
    expect(await Bun.file(path.join(directory.output, "current.js")).text()).toBe("current")
  })

  test("restores the last good output when the build throws", async () => {
    await using directory = await fixture()
    await expect(
      preserveBuildOutput(directory.output, async () => {
        await mkdir(directory.output)
        throw new Error("build exploded")
      }),
    ).rejects.toThrow("build exploded")

    expect(await Bun.file(path.join(directory.output, "previous.js")).text()).toBe("previous")
  })
})
