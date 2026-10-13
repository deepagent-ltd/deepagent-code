import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("ordinary package import and real HTTP still work in Node without loading Bun's native factory", async () => {
  const node = Bun.which("node")
  expect(node).toBeDefined()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-node-"))
  const output = path.join(directory, "ordinary.mjs")
  const fixture = path.join(import.meta.dir, "fixture/native-node-ordinary.ts")
  const build = await Bun.build({
    entrypoints: [fixture],
    target: "node",
    format: "esm",
    external: ["bun"],
    naming: "ordinary.mjs",
    outdir: directory,
  })
  expect(build.success).toBe(true)
  const child = Bun.spawn([node!, output], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(directory, "node.log"), stdout + stderr)
    console.info("NATIVE_NODE_EVIDENCE", directory)
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect(result.bun).toBe(false)
    expect(result.requests).toBe(1)
    expect(result.auth).toBe("Bearer node-fixture-key")
    expect(result.model).toBe("node-fixture")
  } finally {
    clearTimeout(timer)
    child.kill()
  }
})
