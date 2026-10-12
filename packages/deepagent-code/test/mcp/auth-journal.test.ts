import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"

const fixture = path.resolve(import.meta.dir, "../fixture/mcp-auth-journal.ts")

async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-journal-"))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(directory, name), { mode: 0o700 })))
  return fs.realpath(directory)
}

function child(directory: string, mode: string, node?: string) {
  return Bun.spawn(node ? ["node", node, mode] : [process.execPath, fixture, mode], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(directory, "home"),
      TMPDIR: path.join(directory, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
      DAC_MCP_JOURNAL_ROOT: directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function collect(directory: string, label: string, process: ReturnType<typeof child>) {
  const timer = setTimeout(() => process.kill(), 15000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    await fs.writeFile(path.join(directory, `${label}.log`), stdout + stderr)
    expect({ code, error: code === 0 ? null : stdout + stderr }).toEqual({ code: 0, error: null })
    return JSON.parse(stdout.trim().split("\n").at(-1)!)
  } finally {
    clearTimeout(timer)
  }
}

test("private journal primitive checks and rollback use actual Bun and Node adapters", async () => {
  const directory = await root()
  const output = path.join(directory, "fixture.mjs")
  const build = await Bun.build({ entrypoints: [fixture], target: "node", format: "esm", external: ["bun"] })
  expect(build.success).toBe(true)
  await fs.writeFile(output, await build.outputs[0].text())
  const bundle = await fs.readFile(output, "utf8")
  expect(bundle).not.toMatch(/from\s*["']bun:/)
  const bun = await collect(directory, "bun-primitive", child(directory, "primitive"))
  const other = await root()
  const node = await collect(other, "node-primitive", child(other, "primitive", output))
  expect(bun.transactionRollback).toBe(true)
  expect(node.transactionRollback).toBe(true)
  expect(bun.blobRejected && node.blobRejected).toBe(true)
  console.info("MCP_JOURNAL_RUNTIME_EVIDENCE", directory, other)
}, 40000)

test("cold read does not initialize a missing private directory", async () => {
  const directory = await root()
  expect((await collect(directory, "missing-read", child(directory, "missing-read"))).created).toBe(false)
})

test("actual journal capacities, ACL and schema changes fail closed, and refresh uses each credential revision once", async () => {
  for (const mode of ["refresh", "capacity", "security"]) {
    const directory = await root()
    const result = await collect(directory, mode, child(directory, mode))
    expect(result.mode).toBe(mode)
    console.info("MCP_JOURNAL_BOUNDARY_EVIDENCE", mode, directory)
  }
}, 40000)

test("two real processes acquire one flow and a dispatched exchange survives SIGKILL without replay", async () => {
  const directory = await root()
  await collect(directory, "init", child(directory, "init"))
  const first = child(directory, "contend")
  const second = child(directory, "contend")
  const results = await Promise.all([collect(directory, "contend-1", first), collect(directory, "contend-2", second)])
  expect(results.filter((result) => result.admitted).length).toBe(1)
  const killed = child(directory, "dispatch-kill")
  const deadline = Date.now() + 10000
  try {
    while (
      !(await fs.stat(path.join(directory, "dispatched.json")).then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() >= deadline) throw new Error("private journal dispatch barrier timed out")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const original = JSON.parse(await fs.readFile(path.join(directory, "dispatched.json"), "utf8"))
    killed.kill("SIGKILL")
    await killed.exited
    const file = path.join(directory, "private", "auth.sqlite")
    const before = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex")
    const observed = await collect(directory, "cold-read", child(directory, "read"))
    expect(observed.unknown).toBe(true)
    expect(observed.pid).not.toBe(original.pid)
    expect(observed.device).toBe(original.device)
    expect(observed.inode).toBe(original.inode)
    expect(
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    ).toBe(before)
    expect((await collect(directory, "cold-retry", child(directory, "retry"))).automaticRetry).toBe(false)
    await fs.writeFile(
      path.join(directory, "cold-evidence.json"),
      JSON.stringify({ original, observed, readonlyBeforeAndAfterHash: before }, null, 2),
    )
    console.info("MCP_JOURNAL_COLD_EVIDENCE", directory)
  } finally {
    killed.kill()
  }
}, 40000)
