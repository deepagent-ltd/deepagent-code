import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("explicit zero OAuth lifetime stays expired in the actual persistent provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-auth-expiry-"))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(root, name))))
  const child = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "../fixture/mcp-auth-store.ts"), "expiry"],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DAC_MCP_AUTH_STORE_ROOT: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr)
    console.info("MCP_AUTH_EXPIRY_EVIDENCE", root)
    expect({ code, diagnostic: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, diagnostic: "ok" })
    expect(await Bun.file(path.join(root, "expiry.json")).json()).toEqual({
      epochExpired: true,
      epochRemaining: 0,
      deadlinePresent: true,
      deadlineInSaveWindow: true,
      immediateRemaining: 0,
    })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 15_000)

test("actual MCP credential file rejects damage and commits concurrent updates durably", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-auth-store-"))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(root, name))))
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../fixture/mcp-auth-store.ts")], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DAC_MCP_AUTH_STORE_ROOT: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill(), 20_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr)
    console.info("MCP_AUTH_STORE_EVIDENCE", root)
    expect({ code, diagnostic: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, diagnostic: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.corruptionRejected).toBe(true)
    expect(result.concurrentFields).toBe(true)
    expect(result.originalPreserved).toBe(true)
    expect(result.oversizeRejected).toBe(true)
    expect(result.multibyteRejected).toBe(true)
    expect(result.symlinkRejected).toBe(true)
    expect(result.fileMode).toBe(0o600)
    expect(result.actualHttpRequests).toBe(0)
  } finally {
    clearTimeout(deadline)
    child.kill()
  }
}, 25_000)

test("real independent processes preserve concurrent fields and cold SIGKILL publication windows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-auth-cold-"))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(root, name))))
  const spawn = (mode: string, expected?: string, directory = root) =>
    Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "../fixture/mcp-auth-store.ts"),
        mode,
        ...(expected ? [expected] : []),
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(directory, "home"),
          TMPDIR: path.join(directory, "tmp"),
          DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
          DAC_MCP_AUTH_STORE_ROOT: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
  const run = async (mode: string, expected?: string, directory = root) => {
    const child = spawn(mode, expected, directory)
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(directory, `${mode}-${expected ?? ""}.log`), stdout + stderr)
      expect({ code, diagnostic: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, diagnostic: "ok" })
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }
  await run("setup")
  await Promise.all([run("update_tokens"), run("update_client")])
  await run("read_concurrent")
  const windows: { stage: string; code: number; expected: string }[] = []
  for (const stage of ["before_rename", "after_rename", "after_sync"]) {
    const directory = path.join(root, stage)
    await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(directory, name), { recursive: true })))
    await run("setup", undefined, directory)
    const child = spawn(stage, undefined, directory)
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const ready = path.join(directory, "ready.json")
      const deadline = Date.now() + 9000
      while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(20)
      expect(await Bun.file(ready).exists()).toBe(true)
      expect((await Bun.file(ready).json()).pid).toBe(child.pid)
      child.kill("SIGKILL")
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(directory, `${stage}.log`), stdout + stderr)
      expect(code).not.toBe(0)
      const expected = stage === "before_rename" ? "old" : "new"
      await run("read", expected, directory)
      windows.push({ stage, code, expected })
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }
  await Bun.write(path.join(root, "windows.json"), JSON.stringify(windows))
  console.info("MCP_AUTH_COLD_EVIDENCE", root)
}, 45_000)

test("issuer discovery and generation survive an actual cold credential-store reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-issuer-store-"))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(root, name))))
  for (const mode of ["issuer", "issuer_cold"]) {
    const child = Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "../fixture/mcp-auth-store.ts"), mode],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
          DAC_MCP_AUTH_STORE_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(root, `${mode}.log`), stdout + stderr)
      expect({ code, diagnostic: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, diagnostic: "ok" })
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }
  expect(await Bun.file(path.join(root, "issuer.json")).json()).toEqual({
    legacyReadOnly: true,
    durableGeneration: true,
    wrongIssuerRejected: true,
    resourceReset: true,
  })
  expect(await Bun.file(path.join(root, "issuer-cold.json")).json()).toEqual({
    coldDiscovery: true,
    issuerBound: true,
    wrongIssuerRejected: true,
  })
  console.info("MCP_ISSUER_STORE_EVIDENCE", root)
}, 25_000)
