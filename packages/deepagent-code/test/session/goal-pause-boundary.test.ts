import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function isolatedRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-pause-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  return root
}

function fixture(root: string, phase?: string) {
  return Bun.spawn(
    [
      process.execPath,
      ...(process.platform === "win32"
        ? ["--preload", path.resolve(import.meta.dir, "../fixture/source-empty-settings-preload.ts")]
        : []),
      path.resolve(import.meta.dir, "../fixture/goal-pause-boundary.ts"),
      root,
      ...(phase ? [phase] : []),
    ],
    {
      cwd: path.join(root, "project"),
      stdin: phase === "crash-after-cas" || phase === "cold-after-cas" ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_CODE_TEST_HOME: process.platform === "win32" ? root : path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_SERVER_PASSWORD: "pause-boundary-fixture",
        NO_COLOR: "1",
      },
    },
  )
}

async function preparedFixture(root: string, phase: "crash-after-cas" | "cold-after-cas") {
  const child = fixture(root, phase)
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000)
  try {
    const marker = path.join(root, `startup-${phase}-${child.pid}.json`)
    const deadline = Date.now() + 45000
    while (!(await Bun.file(marker).exists())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
        throw new Error(`Goal pause fixture setup did not become ready: ${phase}; ${root}`)
      await Bun.sleep(25)
    }
    const ready: unknown = await Bun.file(marker).json()
    if (
      !ready || typeof ready !== "object" || !("phase" in ready) || !("pid" in ready) ||
      ready.phase !== phase || ready.pid !== child.pid || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline
    )
      throw new Error(`Goal pause fixture setup identity did not match: ${phase}; ${root}`)
    const release = { sent: false }
    return {
      child,
      output,
      async start() {
        if (release.sent || child.exitCode !== null || child.signalCode !== null)
          throw new Error("Goal pause fixture start is unavailable")
        if (!child.stdin) throw new Error("Goal pause fixture setup has no private start channel")
        release.sent = true
        child.stdin.write("GO\n")
        await child.stdin.flush()
        await child.stdin.end()
      },
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await child.exited
    await Promise.resolve().then(() => child.stdin?.end()).catch(() => undefined)
    await Bun.write(path.join(root, `startup-${phase}-output.log`), (await output).join("\n"))
    throw error
  } finally {
    clearTimeout(timer)
  }
}

test("Goal HTTP pause settles only a real quiescent never-dispatched frame and preserves old inputs", async () => {
  const root = await isolatedRoot()
  const child = fixture(root)
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, root, log }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.providerReceipts).toBe(0)
    expect(result.neverDispatched.receipt).toBe("committed")
    expect(result.newTick).toEqual({ freshUnit: true, freshSession: true, freshInput: true, oldResumeRejected: true })
    expect(result.race).toEqual({ stopped: true, noBoundary: true })
    expect(result.fileCAS).toEqual({ preparedNotSettled: true, samePauseCannotRemint: true, resumeRefused: true })
    expect(result.budget).toEqual({ tickConsumedOnce: true, resumeCannotReset: true })
    expect(result.cleanup).toEqual({ server: true, runtime: true })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 50000)

test("Goal pause real post-CAS SIGKILL cold replay only acknowledges existing bytes and remains blocked", async () => {
  const root = await isolatedRoot()
  const prepared = await preparedFixture(root, "crash-after-cas")
  const child = prepared.child
  const output = prepared.output
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  try {
    const marker = path.join(root, "cas-complete-before-ack.json")
    const deadline = Date.now() + 25000
    await prepared.start()
    while (!(await Bun.file(marker).exists())) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`Post-CAS marker missing: ${root}; ${(await output).join("\n")}`)
      }
      await Bun.sleep(25)
    }
    const observed = await Bun.file(marker).json()
    expect(observed.originalMethodReturned).toBe(true)
    expect(observed.pid).toBe(child.pid)
    child.kill("SIGKILL")
    await child.exited
    clearTimeout(timer)
    expect(child.signalCode).toBe("SIGKILL")
    await Bun.write(path.join(root, "crashed-child-output.log"), (await output).join("\n"))
    const coldPrepared = await preparedFixture(root, "cold-after-cas")
    const cold = coldPrepared.child
    const coldOutput = coldPrepared.output
    const coldTimer = setTimeout(() => cold.kill("SIGKILL"), 30000)
    try {
      await coldPrepared.start()
      const status = await cold.exited
      const log = (await coldOutput).join("\n")
      await Bun.write(path.join(root, "cold-output.log"), log)
      expect({ status, root, log }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result).toMatchObject({
        actualCASKill: true,
        originalProjectionAcknowledged: true,
        unstartedProjectionStillPending: true,
        documentsUnchanged: true,
        permitUnchanged: true,
        checkpointUnchanged: true,
        cursorUnchanged: true,
        exactRetryIdempotent: true,
        noAuthorityReminted: true,
        ordinaryResumeRefused: true,
        providerReceipts: 0,
        providerAttempts: 0,
        toolAdmissions: 0,
        inputs: 1,
        cleanup: { server: true, runtime: true },
      })
      await Bun.write(
        path.join(root, "process-cleanup.json"),
        JSON.stringify({
          crashedPID: child.pid,
          crashedSignal: child.signalCode,
          crashedExit: child.exitCode,
          coldPID: cold.pid,
          coldExit: status,
          originalKilledAfterCAS: true,
        }),
      )
    } finally {
      clearTimeout(coldTimer)
      if (cold.exitCode === null) cold.kill("SIGKILL")
      await cold.exited
    }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
  // Each real child has a separate 45s setup limit; the original 25s/30s business limits stay above.
}, 155000)

test("Goal pause live frame is rejected by a second real Root registry without retiring the original", async () => {
  const root = await isolatedRoot()
  const child = fixture(root, "foreign-live-root")
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, root, log }).toMatchObject({ status: 0 })
    expect(await Bun.file(path.join(root, "result.json")).json()).toMatchObject({
      foreignCurrentRefused: true,
      foreignPolicyAbsent: true,
      foreignControlNoSettlement: true,
      ownerStillLive: true,
      originalRootSettled: true,
      providerReceipts: 0,
      cleanup: { server: true, runtime: true },
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}, 35000)
