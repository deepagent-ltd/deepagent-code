import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("history CLI uses the durable private file job and exact retry without reopening the original source", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-import-history-cli-")))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project"].map(name =>
    fs.mkdir(path.join(root, name))))
  const source = path.join(root, "claude")
  await Bun.write(path.join(source, "skills", "fixture", "SKILL.md"), "# Fixture\nUse the packaged asset.\n")
  await Bun.write(path.join(source, "skills", "fixture", "assets", "bytes.bin"), new Uint8Array([0, 128, 255]))
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
    DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", NO_COLOR: "1",
  }
  const run = async (label: string, ...options: string[]) => {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../src/index.ts"), "import-history",
      "--from", "claude", "--path", source, "--scope", "skill", "--request-id", "cli-files", ...options], {
      cwd: path.join(root, "project"), env, stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()])
      await Bun.write(path.join(root, `run-${label}.log`), stdout + stderr)
      return { status, stdout, stderr }
    } finally { clearTimeout(timer); child.kill() }
  }
  const first = await run("first")
  expect({ status: first.status, failure: first.status ? first.stdout + first.stderr : "" }).toEqual({ status: 0, failure: "" })
  expect(first.stdout).toContain("state=completed")
  expect(first.stdout).toContain("skills=1")
  const { Database } = await import("bun:sqlite")
  const control = new Database(env.DEEPAGENT_CODE_DB, { readonly: true })
  const row = control.query("SELECT job_id,state,target FROM import_job").get() as { job_id: string; state: string; target: string }
  const target = JSON.parse(row.target) as { dbPath: string; configDir: string }
  control.close()
  expect(first.stdout).toContain(`job=${row.job_id}`)
  expect([...(await Bun.file(path.join(target.configDir, "skills/fixture/assets/bytes.bin")).bytes())]).toEqual([0, 128, 255])
  expect(await Bun.file(path.join(root, "data/skills/fixture/SKILL.md")).exists()).toBe(false)
  await fs.rename(source, source + "-removed")
  const retry = await run("retry")
  expect(retry.status).toBe(0)
  expect(retry.stdout).toContain(`job=${row.job_id}`)
  const denied = await run("denied", "--copy-live-db=false", "--confirm-live-merge")
  expect(denied.status).toBe(1)
  expect(denied.stdout + denied.stderr).toContain("IMPORT_LIVE_SCOPE_UNSUPPORTED")
  const after = new Database(env.DEEPAGENT_CODE_DB, { readonly: true })
  expect(after.query("SELECT count(*) jobs,(SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_provider_attempt) providers FROM import_job").get())
    .toEqual({ jobs: 1, sessions: 0, inputs: 0, providers: 0 })
  after.close()
  const receipt = new Database(target.dbPath, { readonly: true })
  expect(receipt.query("SELECT count(*) receipts FROM import_batch_receipt").get()).toEqual({ receipts: 1 })
  receipt.close()
  console.info("IMPORT_HISTORY_CLI_EVIDENCE", root)
}, 100_000)
