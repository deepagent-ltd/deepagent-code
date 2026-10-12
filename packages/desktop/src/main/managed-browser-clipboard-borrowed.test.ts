import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const actual = process.env.DAC_BROWSER_CLIPBOARD_BORROWED_ACTUAL === "1" ? test : test.skip

actual("borrowed child Document methods restore parent default clipboard guards synchronously", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-clipboard-borrowed-"))
  await fs.chmod(root, 0o700)
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-clipboard-borrowed.ts")],
    target: "node", external: ["electron"], outdir: root, naming: "main.mjs", sourcemap: "external" })
  expect(built.success, built.logs.map(String).join("\n")).toBe(true)
  console.log("BROWSER_CLIPBOARD_BORROWED_EVIDENCE", root)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.mjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, DAC_BROWSER_CLIPBOARD_BORROWED_ROOT: root },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  expect(code).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.windows).toBe(0)
  expect(result.clipboardNativeCalls).toBe(0)
  expect(result.syntheticEventsOnly).toBe(true)
  expect(result.facts).toHaveLength(3)
  for (const fact of result.facts) {
    expect(fact.guarded).toBe(true)
    expect(fact.defaultDenied).toEqual(["copy", "cut", "paste"].map((type) => ({ type, denied: true })))
    expect(fact.normalEditing).toBe(true)
  }
}, 15_000)
