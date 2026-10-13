import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, lstat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

test("file DB exerciser disposes its exact root on success and failure without creating a global owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "httpapi-cleanup-"))
  await Promise.all(["home", "tmp"].map((name) => mkdir(path.join(root, name))))
  const child = Bun.spawn({
    cmd: [process.execPath, "test/server/fixture/httpapi-exercise-cleanup-process.ts"],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_HTTPAPI_EXERCISE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_HTTPAPI_EXERCISE_GLOBAL: path.join(root, "global"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 85000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    console.log(stdout)
    expect({ code, stderr }).toMatchObject({ code: 0 })
    const proof = stdout.split("\n").find((line) => line.startsWith("HTTPAPI_CLEANUP_PROOF "))
    expect(proof).toBeDefined()
    expect(JSON.parse(proof!.slice("HTTPAPI_CLEANUP_PROOF ".length))).toMatchObject({
      selected: 7,
      pass: 7,
      globalRootBuilt: false,
      ownerReleased: true,
      failurePreserved: true,
      ownedDatabasePreservedOnRefusal: true,
      reopened: [{ quick_check: "ok" }],
    })
    await expect(lstat(path.join(root, "authority.sqlite.runtime.lock"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
