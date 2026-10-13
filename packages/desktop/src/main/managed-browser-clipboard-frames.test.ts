import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"

test("actual first party cross-origin frame keeps clipboard policy and normal Chinese editing", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-clipboard-frames-"))
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-clipboard-frames.ts")],
    outdir: root, target: "node", external: ["electron"] })
  expect(build.success).toBe(true)
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const executable = path.join(import.meta.dir, "../../node_modules/electron/dist",
    process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron")
  const child = Bun.spawn([executable, build.outputs[0]!.path, root], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 10_000)
  const code = await child.exited
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("MANAGED_BROWSER_CLIPBOARD_FRAMES_EVIDENCE", root)
  expect({code,error:code ? stdout + stderr : null}).toEqual({code:0,error:null})
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.crossOrigin).toBe(true)
  expect(result.outOfProcess).toBe(true)
  expect(result.frame).toEqual({guarded:true,defaultDenied:true,inserted:true,undone:true,focused:true})
  expect(result.nativeClipboardCalls).toBe(0)
}, 15_000)
