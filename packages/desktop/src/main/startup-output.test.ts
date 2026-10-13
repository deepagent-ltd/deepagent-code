import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("original Electron Vite output preserves relative Main preload and sidecar assets after splitting", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-desktop-startup-output-"))
  await fs.chmod(root, 0o700)
  const desktop = path.resolve(import.meta.dir, "../..")
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
  await Bun.write(path.join(root, "entry.ts"), 'const main = await import("./main"); console.log(JSON.stringify(main.assets))')
  await Bun.write(path.join(root, "main.ts"), 'export const assets = { sidecar: new URL("./sidecar.js", import.meta.url).pathname, preload: new URL("../preload/index.js", import.meta.url).pathname }')
  await Bun.write(path.join(root, "build.mjs"), `
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
const { resolveConfig } = await import(pathToFileURL(${JSON.stringify(path.join(desktop, "node_modules/electron-vite/dist/index.js"))}))
const { build } = await import(pathToFileURL(${JSON.stringify(path.join(desktop, "node_modules/vite/dist/node/index.js"))}))
const resolved = await resolveConfig({ root: ${JSON.stringify(desktop)} }, "build", "development")
await build({ ...resolved.config.main, plugins: resolved.config.main.plugins.filter(p => p?.name !== "deepagent-code:copy-server-assets"), build: {
  ...resolved.config.main.build, outDir: ${JSON.stringify(path.join(root, "out/main"))}, rollupOptions: {
    ...resolved.config.main.build.rollupOptions, input: { index: ${JSON.stringify(path.join(root, "entry.ts"))} }
  }
} })
`)
  const build = Bun.spawn([process.execPath, path.join(root, "build.mjs")], { cwd: desktop,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root, DEEPAGENT_CODE_CHANNEL: "dev" }, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()])
  await fs.writeFile(path.join(root, "build.log"), stdout + stderr, { mode: 0o600 })
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const child = Bun.spawn(["node", path.join(root, "out/main/index.js")], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [exit, result] = await Promise.all([child.exited, new Response(child.stdout).text()])
  expect(exit).toBe(0)
  expect(JSON.parse(result)).toEqual({ sidecar: path.join(root, "out/main/sidecar.js"), preload: path.join(root, "out/preload/index.js") })
  console.log("DESKTOP_STARTUP_OUTPUT_EVIDENCE", root)
}, 15000)
