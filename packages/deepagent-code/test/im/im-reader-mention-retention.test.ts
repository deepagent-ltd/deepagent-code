import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const run = async (root: string, stage: string, label = stage) => {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dirname, "im-reader-mention-retention.fixture.ts"), stage], {
    cwd: path.join(import.meta.dirname, "../.."),
    env: {
      ...process.env, IM_RETENTION_ROOT: root, DEEPAGENT_IM_AGENT_RESPONDER: "on", DEEPAGENT_CODE_TEST_HOME: root,
      XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_CACHE_HOME: `${root}/cache`, XDG_STATE_HOME: `${root}/state`,
    },
    stdout: "pipe", stderr: "pipe",
  })
  const output = stage === "kill-seed" ? await (async () => {
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      while (!(await Bun.file(path.join(root, "kill-ready.json")).exists())) {
        if (child.exitCode !== null) throw new Error("Owned kill fixture exited before committed JSON")
        await Bun.sleep(10)
      }
      const committed = await Bun.file(path.join(root, "kill-ready.json")).text()
      child.kill("SIGKILL")
      await new Response(child.stdout).text()
      return committed
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  })() : await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  if (stage === "kill-seed") {
    expect(await child.exited).toBe(137)
    expect(child.signalCode).toBe("SIGKILL")
  }
  if (stage !== "kill-seed") expect(await child.exited, `${stage}\n${output}\n${errors}`).toBe(0)
  const result = JSON.parse(output.trim().split("\n").at(-1)!)
  if (process.env.IM_RETENTION_RESULTS) await Bun.write(path.join(process.env.IM_RETENTION_RESULTS, `${label}.json`), JSON.stringify(result, null, 2))
  expect(result.foreignKeys).toBe(1)
  expect(result.foreignKeyViolations).toBe(0)
  return result
}

const isolated = async (body: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), "dac-im-reader-mention-retention-db-"))
  try { await body(root) }
  finally {
    await rm(root, { recursive: true, force: true })
    expect(await Bun.file(path.join(root, "retention.sqlite")).exists()).toBe(false)
  }
}

test("current legacy mention admission keeps Work authority refusal and creates no inbox work", () => isolated(async (root) => {
  const result = await run(root, "refusal")
  expect(result.admissionRefused).toBe(true)
  expect(result.before).toMatchObject({ messages: 1, intents: 1, admitted: 0, inputs: 0, activities: 0, replies: 0 })
}), 30_000)

test("historically admitted mention is collectable before expiry and its pending effect survives body retirement", () => isolated(async (root) => {
  const result = await run(root, "early")
  expect(result.admissionRefused).toBe(true)
  expect(result.historicalReplay).toBe(true)
  expect(result.admittedBinding).toBe(true)
  expect(result.before).toMatchObject({ messages: 1, intents: 1, admitted: 1, inputs: 1, activities: 1, members: 1, replies: 0, ownsMessage: 1, ledgerState: "present" })
  expect(result.first).toEqual({ finalPresent: true, metadataBound: true, appended: true })
  expect(result.duplicate.appended).toBe(false)
  expect(result.afterCleanup.appended).toBe(false)
  expect(result.after).toMatchObject({ messages: 1, intents: 1, admitted: 1, inputs: 1, settled: 1, replies: 1, pendingReplies: 1, bodyBytes: 0, ownsMessage: 1, ledgerState: "expired_obligation", localMessage: result.before.localMessage })
  expect(result.after.readerRecords).toBe(result.before.readerRecords)
  expect(result.after.readerBytes).toBeLessThan(result.before.readerBytes)
}), 30_000)

test("reader history without an admitted intent expires without inventing Session work or reply effects", () => isolated(async (root) => {
  const result = await run(root, "history")
  expect(result.before).toMatchObject({ messages: 1, intents: 0, inputs: 0, activities: 0, replies: 0, ownsMessage: 1 })
  expect(result.after).toMatchObject({ messages: 0, intents: 0, inputs: 0, activities: 0, replies: 0, bodyBytes: 0, ownsMessage: 0, ledgerState: "expired", localMessage: null })
  expect(result.after.readerRecords).toBe(result.before.readerRecords - 1)
  expect(result.after.readerBytes).toBeLessThan(result.before.readerBytes)
}), 30_000)

test("chat body expiry must preserve the original historical Work authority denial", () => isolated(async (root) => {
  const result = await run(root, "denial")
  expect(result.admissionRefused).toBe(true)
  expect(result.historicalReplay).toBe(true)
  expect(result.admittedBinding).toBe(true)
  expect(result.beforeAuthority).toEqual({ kind: "legacy_unbound", executionPreflightAllowed: false, denialCode: "WORK_AUTHORITY_MISSING" })
  expect(result.sourceIdentityPreserved).toBe(true)
  expect(result.afterAuthority).toEqual(result.beforeAuthority)
}), 30_000)

test("a bound pending intent keeps its original denial after expiry without inventing admitted work", () => isolated(async (root) => {
  const result = await run(root, "pending")
  expect(result.admissionRefused).toBe(true)
  expect(result.before).toMatchObject({ intents: 1, admitted: 0, inputs: 0, activities: 0, replies: 0 })
  expect(result.afterCleanup).toMatchObject({ messages: 1, intents: 1, admitted: 0, inputs: 0, activities: 0, replies: 0, ownsMessage: 1, bodyBytes: 0, contentBytes: 0, ledgerState: "expired_obligation" })
  expect(result.afterAuthority).toEqual(result.beforeAuthority)
  expect(result.afterAuthority.executionPreflightAllowed).toBe(false)
}), 30_000)

test("all UTF8 multi-agent obligations remain metered through FTS retirement, repeat cleanup and FK custody", () => isolated(async (root) => {
  const result = await run(root, "multi")
  expect(result.actualIntentCount).toBe(3)
  expect(result.before.obligationRecords).toBe(3)
  expect(result.before.obligationBytes).toBe(result.expectedObligationBytes)
  expect(result.after.obligationBytes).toBe(result.expectedObligationBytes)
  expect(result.after).toMatchObject({ messages: 1, intents: 3, ownsMessage: 1, bodyBytes: 0, contentBytes: 0, ledgerState: "expired_obligation" })
  expect(result.originalExpiryMatched).toBe(true)
  expect(result.meterExact).toBe(true)
  expect(result.repeatUnchanged).toBe(true)
  expect(result.ftsAvailable).toBe(true)
  expect(result.ftsBodies).toBe(0)
  expect(result.groupDeleteRejected).toBe(true)
  expect(result.scopeDeleteRejected).toBe(true)
  expect(result.messageDeleteRejected).toBe(true)
  expect(result.deleteAttemptsUnchanged).toBe(true)
}), 30_000)

test("every original intent writer rolls its binding and meter back at the global byte boundary", () => isolated(async (root) => {
  const result = await run(root, "quota")
  expect(result.bindRejected).toBe(true)
  expect(result.bindRollback).toBe(true)
  expect(result.settleRejected).toBe(true)
  expect(result.settleRollback).toBe(true)
  expect(result.admissionRejected).toBe(true)
  expect(result.admissionRollback).toBe(true)
  expect(result.createRejected).toBe(true)
  expect(result.createRollback).toBe(true)
}), 30_000)

test.each(["late-member", "late-scope"])("retirement rolls back every body and custody write after a late %s SQL change", (stage) => isolated(async (root) => {
  const result = await run(root, stage)
  expect(result.admittedBinding).toBe(true)
  expect(result.cleanupRejected).toBe(true)
  expect(result.completeRollback).toBe(true)
  expect(result.meterExact).toBe(true)
}), 30_000)

test("a historically admitted activity must retain its reply obligation when it settles after reader expiry", () => isolated(async (root) => {
  const result = await run(root, "late")
  expect(result.admissionRefused).toBe(true)
  expect(result.historicalReplay).toBe(true)
  expect(result.admittedBinding).toBe(true)
  expect(result.before).toMatchObject({ messages: 1, intents: 1, admitted: 1, inputs: 1, activities: 1, members: 1, replies: 0 })
  expect(result.sourceIdentityPreserved).toBe(true)
  expect(result.afterCleanup).toMatchObject({ messages: 1, intents: 1, admitted: 1, inputs: 1, activities: 1, members: 1, replies: 0, bodyBytes: 0, ownsMessage: 1, ledgerState: "expired_obligation", localMessage: result.before.localMessage })
  expect(result.after).toMatchObject({ inputs: 1, settled: 1, members: 1 })
  expect(result.collection.finalPresent).toBe(true)
  expect(result.collection.metadataBound).toBe(true)
  // Business oracle: an admitted task's final reply cannot disappear with its chat body.
  expect(result.collection.appended).toBe(true)
  expect(result.after).toMatchObject({ replies: 1, pendingReplies: 1 })
}), 30_000)

test("cold original collector must recover an uncollected settled reply after reader expiry", () => isolated(async (root) => {
  const seeded = await run(root, "cold-seed")
  expect(seeded.admissionRefused).toBe(true)
  expect(seeded.historicalReplay).toBe(true)
  expect(seeded.admittedBinding).toBe(true)
  expect(seeded.sourceIdentityPreserved).toBe(true)
  expect(seeded.afterCleanup).toMatchObject({ messages: 1, intents: 1, admitted: 1, inputs: 1, settled: 1, members: 1, replies: 0, bodyBytes: 0, ownsMessage: 1, ledgerState: "expired_obligation", localMessage: seeded.before.localMessage })
  const recovered = await run(root, "cold-collect")
  expect(recovered.before).toEqual(seeded.afterCleanup)
  expect(recovered.collection.finalPresent).toBe(true)
  expect(recovered.collection.metadataBound).toBe(true)
  expect(recovered.collection.appended).toBe(true)
  expect(recovered.after).toMatchObject({ replies: 1, pendingReplies: 1 })
}), 30_000)

test("an owned post-commit SIGKILL retains original custody, denial and exactly one cold reply", () => isolated(async (root) => {
  const seeded = await run(root, "kill-seed")
  expect(seeded.afterAuthority.executionPreflightAllowed).toBe(false)
  expect(seeded.afterCleanup).toMatchObject({ intents: 1, inputs: 1, settled: 1, bodyBytes: 0, contentBytes: 0, replies: 0 })
  const recovered = await run(root, "cold-collect", "kill-cold-recovery")
  expect(recovered.before).toEqual(seeded.afterCleanup)
  expect(recovered.authority).toEqual(seeded.beforeAuthority)
  expect(recovered.collection.appended).toBe(true)
  expect(recovered.after).toMatchObject({ replies: 1, pendingReplies: 1 })
  const duplicate = await run(root, "cold-collect", "kill-cold-duplicate")
  expect(duplicate.collection.appended).toBe(false)
  expect(duplicate.after).toMatchObject({ replies: 1, pendingReplies: 1 })
}), 30_000)
