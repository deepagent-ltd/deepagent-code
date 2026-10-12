import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test.skipIf(process.platform === "win32")(
  "SIGKILL mid-batch: fresh HTTP runtime observes without replay, then explicitly confirms partial stop",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-job-restart-"))
    const environment = {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_DB: path.join(root, "live.db"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
    }
    console.log("IMPORT_RESTART_ROOT", root)
    await fs.mkdir(environment.HOME, { recursive: true })
    const run = async (mode: string) => {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../fixture/import-job-process.ts"), root, mode],
        { cwd: path.resolve(import.meta.dir, "../.."), env: environment, stdout: "pipe", stderr: "pipe" },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 95_000)
      try {
        const result = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        console.log(JSON.stringify({ mode, exit: result[0], stdout: result[1], stderr: result[2] }))
        return result
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
      }
    }
    try {
      expect((await run("crash"))[0]).not.toBe(0)
      expect(await Bun.file(path.join(root, "crash.json")).exists()).toBe(true)
      const resumed = await run("observe")
      expect(resumed[0]).toBe(0)
      expect(resumed[1]).toContain("IMPORT_PROCESS_RESTART_PASS")
      const proof = await Bun.file(path.join(root, "recovered.json")).json()
      expect(proof.stopped.committedBatches).toBe(proof.proof.count)
      expect(proof.stopped.stopConfirmedAt).toBeGreaterThan(proof.killed.createdAt)
    } finally {
      if (await Bun.file(path.join(root, "recovered.json")).exists())
        await fs.rm(root, { recursive: true, force: true })
    }
  },
  110_000,
)
