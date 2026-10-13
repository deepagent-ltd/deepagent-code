import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"

test("actual Chromium refuses invalidated targets at the last admission wait", async () => {
  const root = await realpath(await mkdtemp("/tmp/dac-browser-input-race-"))
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-input-race.ts")],
    outdir: root, target: "node", external: ["electron"],
  })
  expect(build.success).toBe(true)
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), build.outputs[0]!.path, root], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("MANAGED_BROWSER_INPUT_RACE_EVIDENCE", root)
  expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.cases).toHaveLength(4)
  for (const value of result.cases) {
    expect(value.injection).toBeGreaterThan(0)
    expect(value.dispatched).toBe(0)
    expect(value.error).toBe("BROWSER_STALE_TARGET")
    expect(value.value).toBe(value.operation === "select" ? "a" : "before")
  }
}, 20_000)
