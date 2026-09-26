import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifySdkBuild } from "../script/verify-build"

test("SDK release requires every exported JavaScript and declaration in packed dist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepagent-sdk-package-"))
  try {
    await mkdir(join(directory, "dist"))
    const packageJson = {
      files: ["dist"],
      exports: { ".": "./src/index.ts", "./client": "./src/client.ts" },
    }
    await Bun.write(join(directory, "package.json"), JSON.stringify(packageJson))
    await Bun.write(join(directory, "dist/index.js"), "export {}")
    await Bun.write(join(directory, "dist/index.d.ts"), "export {}")
    await expect(verifySdkBuild(directory)).rejects.toThrow("dist/client.js")
    await Bun.write(join(directory, "dist/client.js"), "export {}")
    await Bun.write(join(directory, "dist/client.d.ts"), "export {}")
    await expect(verifySdkBuild(directory)).resolves.toBeUndefined()
    await Bun.write(join(directory, "package.json"), JSON.stringify({ ...packageJson, files: [] }))
    await expect(verifySdkBuild(directory)).rejects.toThrow("SDK package excludes dist")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
