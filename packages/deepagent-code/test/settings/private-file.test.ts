import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SettingsPrivateFile } from "../../src/settings/private-file"

for (const change of ["sibling", "parent", "permissions", "target"] as const)
  test.skipIf(process.platform === "win32")(
    `private settings read isolates an actual ${change} change after open`,
    async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-settings-read-")))
      const directory = path.join(root, "storage")
      const file = path.join(directory, "settings.json")
      const text = '{"deepagent":{"selfLearning":"manual"}}'
      await fs.mkdir(directory, { mode: 0o700 })
      await fs.writeFile(file, text, { mode: 0o600 })
      const open = fs.open.bind(fs)
      const changed = { value: false }
      // This is a race barrier around the real open. Reads, replacements, stat
      // observations and permission checks all run against actual filesystem objects.
      const intercepted = spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
        const handle = await open(filename, flags, mode)
        if (filename !== file || changed.value) return handle
        changed.value = true
        if (change === "sibling") await fs.writeFile(path.join(directory, "unrelated"), "sibling", { mode: 0o600 })
        if (change === "parent") {
          await fs.rename(directory, path.join(root, "previous"))
          await fs.mkdir(directory, { mode: 0o700 })
          await fs.rename(path.join(root, "previous", "settings.json"), file)
        }
        if (change === "permissions") await fs.chmod(directory, 0o750)
        if (change === "target") {
          await fs.rename(file, path.join(directory, "previous.json"))
          await fs.writeFile(file, text, { mode: 0o600 })
        }
        return handle
      })
      try {
        if (change === "sibling") expect((await SettingsPrivateFile.read(file))?.text).toBe(text)
        if (change !== "sibling") await expect(SettingsPrivateFile.read(file)).rejects.toThrow("changed")
        expect(changed.value).toBe(true)
        expect(await Bun.file(file).text()).toBe(text)
      } finally {
        intercepted.mockRestore()
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )
