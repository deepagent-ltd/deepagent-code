import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

for (const expiry of [false, true]) test(`queued known-unstarted Work preserves source and time gates: ${expiry ? "expired" : "current"}`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dac-task-work-queued-source-")))
  await Promise.all(["home", "config", "data", "cache", "state", "tmp", "project"].map((name) => mkdir(join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixture/task-work-queued-source.ts")], {
    cwd: join(root, "project"),
    env: {
      PATH: process.env.PATH, DAC_TASK_WORK_QUEUED_SOURCE_ROOT: root,
      DAC_TASK_WORK_QUEUED_EXPIRY: expiry ? "1" : "",
      HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TMPDIR: join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: join(root, "home"), DEEPAGENT_CODE_HOME: join(root, "data"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "", DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
    }, stdout: "pipe", stderr: "pipe",
  })
  const completed = { value: false }
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await writeFile(join(root, "child.log"), stdout + stderr, { mode: 0o600 })
    expect({ code, failure: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, failure: "" })
    expect(await Bun.file(join(root, "result.json")).json()).toEqual(expiry ? {
      providers: 0, counts: 0, dispatches: 0, activities: 0, actualDeadlineElapsed: true,
      expiredWorkDoesNotCaptureOrWake: true, originalSourceProofUnchanged: true,
      originalGrantAndWorkUnchanged: true, moduleNodeAssertions: 12, closed: true,
    } : {
      providers: 0, counts: 0, dispatches: 0, activities: 0, originalSourceProofUnchanged: true,
      expiredSlotRefreshedOutsideSQL: true, currentMembershipRefusalDoesNotWake: true, knownUnstartedCanRetry: true,
      claimedPromotedAndUnknownExcluded: true, changedControlDoesNotWake: true, advisoryWakeCount: 2, moduleNodeAssertions: 26, closed: true,
    })
    completed.value = true
  } finally {
    clearTimeout(deadline)
    child.kill()
    if (completed.value) await rm(root, { recursive: true, force: true })
    if (!completed.value) process.stderr.write(`QUEUED_SOURCE_PRIVATE_DIAG_ROOT ${root}\n`)
  }
}, 50_000)
