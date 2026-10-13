import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("original kernel source service reaches enrolled Core propose/accept and refuses missing current authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dac-kernel-task-source-authority-")))
  await Promise.all(
    ["home", "config", "data", "cache", "state", "tmp", "project"].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  )
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/kernel-task-source-authority.ts")], {
    cwd: join(root, "project"),
    env: {
      PATH: process.env.PATH,
      DAC_KERNEL_TASK_SOURCE_AUTHORITY_ROOT: root,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      TMPDIR: join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: join(root, "home"),
      DEEPAGENT_CODE_HOME: join(root, "data"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 55_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await writeFile(join(root, "child.log"), stdout + stderr, { mode: 0o600 })
    expect({ code, result: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, result: "ok" })
    expect(await Bun.file(join(root, "result.json")).json()).toEqual({
      sources: 2,
      requests: 2,
      grants: 1,
      sessions: 0,
      inputs: 0,
      work: 0,
      providers: 0,
      counts: 0,
      dispatches: 0,
      intents: 0,
      noWitness: true,
      copy: true,
      expired: true,
      tupleMismatch: true,
      ownerConflict: true,
      mappingRevoked: true,
      ordinaryLocal: true,
      fixedProofAcrossReadProgress: true,
      remoteMembers: 0,
      closed: true,
    })
  } finally {
    clearTimeout(deadline)
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
