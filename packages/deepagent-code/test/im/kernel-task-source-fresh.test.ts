import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("provider boundary captures a fresh original SDK source before consuming a near-expiry cache", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dac-kernel-task-source-fresh-")))
  await Promise.all(["home", "config", "data", "cache", "state", "tmp", "project"].map((name) => mkdir(join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/kernel-task-source-fresh.ts")], {
    cwd: join(root, "project"),
    env: {
      PATH: process.env.PATH,
      DAC_KERNEL_TASK_SOURCE_FRESH_ROOT: root,
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: join(root, "home"), DEEPAGENT_CODE_HOME: join(root, "data"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "", DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
    }, stdout: "pipe", stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await writeFile(join(root, "child.log"), stdout + stderr, { mode: 0o600 })
    expect({ code, failure: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, failure: "" })
    expect(await Bun.file(join(root, "result.json")).json()).toEqual({
      sources: 0, requests: 0, grants: 0, work: 0, providers: 0,
      nearExpiryCacheReplaced: true, originalProofUnchanged: true, freshConcurrentCallers: 5,
      oneFreshPhysicalCapture: true, cancelledWaiterIsolated: true, ordinaryPendingNotFresh: true,
      validCacheRetainedDuringCapture: true, membershipDenialNoFallback: true, lateOwnerRefused: true, closed: true,
    })
  } finally {
    clearTimeout(deadline)
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
}, 50_000)
