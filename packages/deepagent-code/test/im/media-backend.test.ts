import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
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
