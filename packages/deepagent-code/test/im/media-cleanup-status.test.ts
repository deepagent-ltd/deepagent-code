import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("cleanup continuation cannot report complete while earlier failed files retain reservations", async () => {
  await using root = await tmpdir()
  const home = path.join(root.path, "home")
  await fs.mkdir(home, { mode: 0o700 })
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixture/media-cleanup-status-process.ts"), root.path],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      DEEPAGENT_CODE_TEST_HOME: home,
      DEEPAGENT_CODE_HOME: path.join(root.path, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(root.path, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 15_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    const line = stdout.split("\n").findLast((value) => value.startsWith('{"fixture":"media-cleanup-status",'))
    expect(line).toBeDefined()
    expect(JSON.parse(line!)).toMatchObject({ failedReservationsHeld: 32, tombstones: 33, falseComplete: false, actualFiles: true, physicalUserFilePreserved: true })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 20_000)
