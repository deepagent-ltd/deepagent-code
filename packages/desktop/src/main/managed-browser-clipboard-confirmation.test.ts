import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const actual = process.env.DAC_BROWSER_CLIPBOARD_CONFIRMATION_ACTUAL === "1" ? test : test.skip
actual("actual native clipboard consent: Cancel, unchecked Allow, checked Allow, close and shared lease without OS clipboard access", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-clipboard-confirmation-"))
  await fs.chmod(root, 0o700)
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-clipboard-confirmation.ts")], target: "node",
    conditions: ["node"], external: ["electron"], outdir: root, naming: "main.cjs", format: "cjs" })
  expect(build.success, build.logs.map(String).join("\n")).toBe(true)
  console.log("CLIPBOARD_CONFIRMATION_EVIDENCE", root)
  const child = Bun.spawn([path.join(import.meta.dir, "../../node_modules/.bin/electron"), path.join(root, "main.cjs")], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      DAC_BROWSER_CLIPBOARD_CONFIRMATION_ROOT: root }, stdout: "pipe", stderr: "pipe", timeout: 175_000,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  await fs.writeFile(path.join(root, "process.log"), stdout + "\n" + stderr, { mode: 0o600 })
  const failure = await Bun.file(path.join(root, "failure.json")).exists() ? await Bun.file(path.join(root, "failure.json")).json() : undefined
  expect(code, failure ? JSON.stringify(failure) : stderr.slice(-1000)).toBe(0)
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.success).toBe(true)
  expect(result.electron).toBe("41.10.3")
  expect(result.blocked).toBe("BROWSER_DRIVER_UNAVAILABLE")
  expect(result.facts.clipboardInspected).toBe(false)
  expect(result.facts.dispatched).toBe(0)
  expect(result.facts.windows).toBe(0)
  expect(result.facts.leaseDenied).toBe("BROWSER_CAPACITY")
  expect(result.facts.cases.map((value: { name: string; approved: boolean }) => [value.name, value.approved])).toEqual([
    ["cancel-read", false], ["unchecked-write", false], ["checked-read", true], ["close-write", false],
  ])
  expect(result.facts.cases.map((value: { currentChecks: number; observationChecks: number }) => [value.currentChecks, value.observationChecks]))
    .toEqual([[1, 1], [1, 1], [2, 2], [1, 1]])
}, 180_000)
