import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { Marker } from "./fixture/personal-dac-cold-process"

async function run(cut: "admission" | "collector") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dac-personal-physical-${cut}-`))
  const home = path.join(root, "home")
  await fs.mkdir(home, { mode: 0o700 })
  const filename = path.join(root, "personal.sqlite")
  const spawn = (mode: "warm" | "cold") => Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixture/personal-dac-cold-process.ts"), root, cut, mode],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { PATH: process.env.PATH, HOME: home, DEEPAGENT_CODE_TEST_HOME: home,
      DEEPAGENT_CODE_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"), DEEPAGENT_CODE_DB: filename,
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"), DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1" },
    stdout: "pipe", stderr: "pipe",
  })
  const warm = spawn("warm")
  const warmStdout = new Response(warm.stdout).text()
  const warmStderr = new Response(warm.stderr).text()
  const warmExit = warm.exited
  const safety = setTimeout(() => warm.kill(), 20_000)
  try {
    const started = Date.now()
    while (!(await Bun.file(path.join(root, "warm-marker-safe.json")).exists())) {
      if (warm.exitCode !== null) throw new Error(`Warm ${cut} exited ${warm.exitCode}: ${await warmStderr}`)
      if (Date.now() - started > 18_000) throw new Error(`Warm ${cut} marker deadline`)
      await Bun.sleep(20)
    }
    const marker = await Bun.file(path.join(root, "warm-marker-safe.json")).json() as Marker
    expect(marker.cut).toBe(cut)
    expect(marker.originalPromptResume).toBe(true)
    expect(marker.warmWakeCalls).toBe(1)
    const before = await fs.stat(filename, { bigint: true })
    expect({ dev: String(before.dev), ino: String(before.ino) }).toEqual(marker.DBIdentity)
    const readonly = new Database(filename, { readonly: true })
    const input = readonly.query("SELECT id,session_id,admitted_seq,promoted_seq FROM session_input").all()
    const command = readonly.query("SELECT state,admitted_at FROM im_dac_command").all()
    const outbox = readonly.query("SELECT count(*) AS count FROM im_reply_outbox").get()
    const activities = readonly.query("SELECT activity_id,state,final_message_id FROM session_activity").all()
    readonly.close()
    expect(input).toEqual([{ id: marker.inputID, session_id: marker.sessionID, admitted_seq: marker.admittedSeq, promoted_seq: null }])
    expect(command).toHaveLength(1)
    expect(command[0]).toMatchObject({ state: cut === "admission" ? "pending" : "admitted" })
    expect(outbox).toEqual({ count: 0 })
    if (cut === "admission") {
      expect(command[0]).toMatchObject({ admitted_at: null })
      expect(activities).toHaveLength(0)
    }
    if (cut === "collector") expect(activities).toEqual([{ activity_id: marker.activityID, state: "settled", final_message_id: marker.finalMessageID }])
    expect(warm.exitCode).toBeNull()
    warm.kill("SIGKILL")
    const killedExit = await warmExit
    clearTimeout(safety)
    expect(killedExit).not.toBe(0)
    await fs.writeFile(path.join(root, "warm-stdout-private.log"), await warmStdout, { mode: 0o600 })
    await fs.writeFile(path.join(root, "warm-stderr-private.log"), await warmStderr, { mode: 0o600 })
    const afterKill = await fs.stat(filename, { bigint: true })
    expect({ dev: String(afterKill.dev), ino: String(afterKill.ino) }).toEqual(marker.DBIdentity)
    const cold = spawn("cold")
    const coldTimer = setTimeout(() => cold.kill(), 20_000)
    const result = await Promise.all([cold.exited, new Response(cold.stdout).text(), new Response(cold.stderr).text()])
    clearTimeout(coldTimer)
    await fs.writeFile(path.join(root, "cold-stdout-private.log"), result[1], { mode: 0o600 })
    await fs.writeFile(path.join(root, "cold-stderr-private.log"), result[2], { mode: 0o600 })
    expect(result[0], result[2]).toBe(0)
    const reopened = await fs.stat(filename, { bigint: true })
    expect({ dev: String(reopened.dev), ino: String(reopened.ino) }).toEqual(marker.DBIdentity)
    const proof = { cut, root, DBIdentity: marker.DBIdentity, marker,
      parentBeforeKill: { input, command, outbox, activities }, warmPID: warm.pid, warmKilledExit: killedExit,
      ownedPhysicalSIGKILLs: 1, warmJoined: true, coldPID: cold.pid, coldExit: result[0], coldJoined: true,
      sameDBInodeAtOriginalCommitAfterKillAndCold: true, extraForcedCleanup: false,
      productionEdits: 0, SDKDecorators: 0, models: 0, publicSends: 0, payments: 0 }
    await fs.writeFile(path.join(root, "physical-cut-resource-safe.json"), JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 })
    console.log("IM_PERSONAL_PHYSICAL_CUT_EVIDENCE", cut, root)
    return { proof, result: await Bun.file(path.join(root, "cold-result-safe.json")).json() }
  } finally {
    clearTimeout(safety)
    if (warm.exitCode === null) warm.kill("SIGTERM")
    await warmExit
  }
}

test("personal DAC physical crash after original prompt admission before command UPDATE reconciles one input without wake", async () => {
  const value = await run("admission")
  expect(value.result).toMatchObject({ cut: "admission", sameDBIdentity: true, commandState: "admitted",
    sessionID: value.proof.marker.sessionID, inputID: value.proof.marker.inputID,
    sessionCount: 1, inputCount: 1, commandCount: 1, promoted: false, promptResumes: [false], additionalWakeCalls: 0, outboxCount: 0 })
}, 45_000)

test("personal DAC physical crash after fixture durable final pointer before original collector cold-appends one exact reply", async () => {
  const value = await run("collector")
  expect(value.result).toMatchObject({ cut: "collector", sameDBIdentity: true, sessionID: value.proof.marker.sessionID,
    inputID: value.proof.marker.inputID, activityID: value.proof.marker.activityID, finalMessageID: value.proof.marker.finalMessageID,
    firstCollect: true, secondCollect: false, outboxCount: 1, replySHA256: value.proof.marker.finalSHA256,
    replyBytes: value.proof.marker.finalBytes, privateCommandExcluded: true, custodyKind: "dac_session",
    custodyBindingExact: true, attempts: 0, status: "pending", additionalWakeCalls: 0, transportCreated: false })
}, 45_000)
