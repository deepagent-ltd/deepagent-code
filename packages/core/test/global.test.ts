import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@deepagent-code/core/global"

describe("global paths", () => {
  test("tmp path is under the private data root", () => {
    expect(Global.Path.tmp).toBe(path.join(Global.Path.data, "tmp"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("software data defaults to the DeepAgent Code home", () => {
    if (process.platform === "win32" && !process.env.DEEPAGENT_CODE_TEST_HOME) {
      expect(Global.Path.data).toBe(path.join(process.env.LOCALAPPDATA!, "deepagent-code"))
    } else {
      expect(Global.Path.data).toBe(path.join(Global.Path.home, ".deepagent", "code"))
    }
    expect(Global.Path.agent.runs).toBe(path.join(Global.Path.data, "runs"))
  })

  test("config home matches the platform split (D-W1)", () => {
    if (process.platform === "win32" && !process.env.DEEPAGENT_CODE_TEST_HOME) {
      // Native Windows production: config/credentials roam, data stays machine-local.
      expect(Global.Path.config).toBe(path.join(process.env.APPDATA!, "deepagent-code"))
      expect(Global.Path.config).not.toBe(Global.Path.data)
      return
    }
    // POSIX, and any test-home-isolated process, keep the unified root.
    expect(Global.Path.config).toBe(Global.Path.data)
  })

  test("every private runtime path stays under its home root", () => {
    const dataPaths = [
      Global.Path.cache,
      Global.Path.state,
      Global.Path.tmp,
      Global.Path.bin,
      Global.Path.log,
      Global.Path.repos,
      ...Object.values(Global.Path.agent),
    ]
    expect(
      dataPaths.every((item) => item === Global.Path.data || item.startsWith(Global.Path.data + path.sep)),
    ).toBe(true)
    const config = Global.Path.config
    const underData = config === Global.Path.data || config.startsWith(Global.Path.data + path.sep)
    const roamingSplit = process.platform === "win32" && !process.env.DEEPAGENT_CODE_TEST_HOME
    expect(underData).toBe(!roamingSplit)
  })

  test("config directory is created on module load", async () => {
    expect((await fs.stat(Global.Path.config)).isDirectory()).toBe(true)
  })
})
