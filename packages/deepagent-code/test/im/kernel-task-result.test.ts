import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("original kernel task outbox sends actual SDK PUB/ACK and current reader locates revoked history without execution", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dac-kernel-task-result-")))
  await Promise.all(
    ["home", "config", "data", "cache", "state", "tmp", "project"].map((name) =>
      mkdir(join(root, name), { mode: 0o700 }),
    ),
  )
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/kernel-task-result.ts")], {
    cwd: join(root, "project"),
    env: {
      PATH: process.env.PATH,
      DAC_KERNEL_TASK_RESULT_ROOT: root,
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
  await writeFile(join(root, "fixture-env.json"), JSON.stringify({
    PATH: process.env.PATH, DAC_KERNEL_TASK_RESULT_ROOT: root, HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
    DEEPAGENT_CODE_TEST_HOME: join(root, "home"), DEEPAGENT_CODE_HOME: join(root, "data"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "", DEEPAGENT_IM_AGENT_RESPONDER: "off",
  }), { mode: 0o600 })
  const completed = { value: false }
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
      sessions: 1, inputs: 1, work: 1, providers: 0, counts: 0, dispatches: 0,
      sources: 1, requests: 1, grants: 1, wire: 1, acknowledged: true,
      revokedHistoryAvailable: true, getZeroWrites: true, noReaderUnlinked: true, sourceMessageUnlinked: true, closed: true,
    })
    completed.value = true
  } finally {
    clearTimeout(deadline)
    child.kill()
    if (completed.value) await rm(root, { recursive: true, force: true })
    if (!completed.value) process.stderr.write(`KERNEL_RESULT_PRIVATE_DIAG_ROOT ${root}\n`)
  }
}, 60_000)
