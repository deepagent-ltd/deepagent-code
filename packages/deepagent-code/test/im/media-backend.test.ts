import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { tmpdir } from "../fixture/fixture"

async function run(root: string, mode: string) {
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixture/media-backend-process.ts"), root, mode],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DEEPAGENT_CODE_TEST_HOME: home,
      DEEPAGENT_CODE_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      DEEPAGENT_CODE_DB: path.join(root, "media.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const line = stdout.split("\n").findLast((value) => value.startsWith('{"fixture":"media-backend",'))
    expect(line).toBeDefined()
    return JSON.parse(line!)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}

test("actual private fileDB/native files and HTTP streaming enforce revoke/expiry/cancel/private modes", async () => {
  await using root = await tmpdir()
  expect(await run(root.path, "stream")).toMatchObject({
    hashMatched: true,
    revokeChunks: 1,
    closedFD: true,
    unsafeFileRejected: true,
    sourceReplacementRejected: true,
    canceledCopyRemoved: true,
    failedCopyReservationHeld: true,
    expiredRejected: true,
    thirdUploadZeroWork: true,
    windowsCodecOnly: true,
  })
}, 25_000)

test("stable 32-row cleanup resumes in a real cold process beyond unsafe records without deleting user files", async () => {
  await using root = await tmpdir()
  expect(await run(root.path, "cleanup-first")).toMatchObject({ scanned: 32, released: 0, userFilePreserved: true })
  expect(await run(root.path, "cleanup-next")).toMatchObject({
    coldCursorPreserved: true,
    scanned: 1,
    tombstones: 1,
    userFilePreserved: true,
  })
}, 45_000)


// This proves a POSIX O_NOFOLLOW/ELOOP syscall; Windows reparse/identity uses its independent qualification.
test.skipIf(process.platform === "win32")("real filesystem rejection after attachment reserve preserves unbound quota until original TTL cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-reserve-fs-"))
  const result = await run(root, "fs-after-reserve")
  expect(result).toMatchObject({
    mode: "fs-after-reserve", syscall: { code: "ELOOP" }, copiedError: "ATTACHMENT_UNAVAILABLE",
    partialInventory: [], originalRowHeld: true, unboundOwner: "server", messageID: null,
    ttlMs: 86_400_000, sourceOriginalBytesPreserved: true, partialRemoved: true, sameIDTombstone: true,
  })
  expect(result.before.records).toBe(1)
  expect(result.after.records).toBe(1)
  expect(result.before.payload).toBeGreaterThan(0)
  expect(result.after.payload).toBe(0)
  expect(result.payloadBytesReleased).toBe(result.before.payload)
  expect(result.before.bytes - result.after.bytes).toBe(result.before.payload)
  expect(result.phases.map((item: { stage: string }) => item.stage)).toEqual([
    "original_staged_source_validated", "actual_sql_reserve_committed", "owned_source_replaced_after_reserve",
    "real_owned_nofollow_open_probe_eloop", "original_staged_copy_rejected", "pre_expiry_cleanup_preserved_reserve",
    "qa_only_original_ttl_predicate_backdated", "original_cleanup_released_payload_preserved_metadata",
  ])
  console.log("IM_MEDIA_FS_AFTER_RESERVE_EVIDENCE", root)
}, 25_000)
