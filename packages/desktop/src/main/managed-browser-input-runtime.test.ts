import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"

test("the fixed native runtime contract rejects a package upgrade before compilation", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-runtime-"))
  await mkdir(path.join(root, "scripts"))
  await mkdir(path.join(root, "native/managed-browser-input"), { recursive: true })
  try {
    await Bun.write(path.join(root, "scripts/managed-browser-input-runtime.ts"),
      await Bun.file(path.resolve(import.meta.dir, "../../scripts/managed-browser-input-runtime.ts")).text())
    await Bun.write(path.join(root, "native/managed-browser-input/runtime.json"), JSON.stringify(managedBrowserInputRuntime))
    for (const version of [managedBrowserInputRuntime.electronVersion, "0.0.0-unqualified"]) {
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: version } }))
      const child = Bun.spawn([process.execPath, "./scripts/managed-browser-input-runtime.ts"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      })
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code).toBe(version === managedBrowserInputRuntime.electronVersion ? 0 : 1)
      if (code) expect(error).toContain("MANAGED_BROWSER_INPUT_PACKAGE_RUNTIME_UNQUALIFIED")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
