import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@deepagent-code/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "deepagent-code"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("software data defaults to the DeepAgent Code home", () => {
    expect(Global.Path.data).toBe(path.join(Global.Path.home, ".deepagent", "code"))
    expect(Global.Path.agent.runs).toBe(path.join(Global.Path.data, "runs"))
  })

  test("config shares the data root after unification", () => {
    expect(Global.Path.config).toBe(Global.Path.data)
  })

  test("config directory is created on module load", async () => {
    expect((await fs.stat(Global.Path.config)).isDirectory()).toBe(true)
  })
})
