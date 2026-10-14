import { expect, test } from "bun:test"
import { mkdtemp, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("actual Chromium keeps page clipboard commands denied across frames and document replacement", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "dac-browser-clipboard-policy-")))
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-clipboard-policy.ts")],
    outdir: root, target: "node", external: ["electron"] })
  expect(build.success).toBe(true)
  await symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, build.outputs[0]!.path, root], {
    cwd: root, env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 10_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  await Bun.write(path.join(root, "process.log"), stdout + stderr)
  console.log("MANAGED_BROWSER_CLIPBOARD_POLICY_EVIDENCE", root)
  expect({code,error:code ? stdout + stderr : null}).toEqual({code:0,error:null})
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.rounds).toHaveLength(2)
  for (const round of result.rounds) {
    for (const field of ["normal", "initialFrame", "srcdocFrame", "replacement"]) {
      expect(round[field]).toEqual({guarded:true,results:[false,false,false]})
    }
    for (const field of ["immutable", "singleConversion", "defaultDenied", "normalEditing"]) expect(round[field]).toBe(true)
  }
  expect(result.clipboardNativeCalls).toBe(0)
}, 15_000)
