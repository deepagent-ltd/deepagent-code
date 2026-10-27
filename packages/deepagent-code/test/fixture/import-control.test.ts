import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishImportFixturePacket } from "../../../app/test/components/fixture/import-control"

for (const existing of [false, true])
  test(`a polling fixture sees only complete control packets across actual publication (existing=${existing})`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-import-control-"))
    const file = path.join(root, "inspect.json")
    const entered = Promise.withResolvers<string>()
    const release = Promise.withResolvers<void>()
    const rename = fs.rename.bind(fs)
    const intercepted = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === file) {
        entered.resolve(String(source))
        await release.promise
      }
      return rename(source, target)
    })
    try {
      if (existing) await fs.writeFile(file, JSON.stringify({ jobID: "previous" }))
      const pending = publishImportFixturePacket(file, { jobID: "next" })
      const temporary = await entered.promise
      expect(await Bun.file(temporary).json()).toEqual({ jobID: "next" })
      expect(await Bun.file(file).exists()).toBe(existing)
      if (existing) expect(await Bun.file(file).json()).toEqual({ jobID: "previous" })
      release.resolve()
      await pending
      expect(await Bun.file(file).json()).toEqual({ jobID: "next" })
      expect(await fs.readdir(root)).toEqual(["inspect.json"])
    } finally {
      release.resolve()
      intercepted.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
