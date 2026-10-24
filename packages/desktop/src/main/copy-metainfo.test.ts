import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

test("generated AppStream retains DAC product license and developer instead of upstream identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-metainfo-"))
  try {
    await fs.mkdir(path.join(directory, "resources"))
    const generated = await Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../../scripts/copy-metainfo.ts", import.meta.url)), "prod"],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      },
    ).exited
    expect(generated).toBe(0)
    const xml = await Bun.file(path.join(directory, "resources/ai.deepagent-code.desktop.metainfo.xml")).text()
    const product = await Bun.file(new URL("../../package.json", import.meta.url)).json()
    expect(xml).toContain(`<project_license>${product.license}</project_license>`)
    expect(xml).toContain(`<developer id="ltd.deepagent">`)
    expect(xml).toContain(`<name>${product.author.name}</name>`)
    expect(xml).not.toContain("Anomaly Innovations")
    expect(xml).not.toContain("<project_license>MIT</project_license>")
    expect(xml).toContain("https://github.com/deepagent-ltd/deepagent-code/issues")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
