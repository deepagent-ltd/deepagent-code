import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test.skipIf(process.platform === "win32")(
  "SIGKILL with a published unreceipted file tree: fresh process observes zero writes and explicit cancel settles the same inode",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "import-file-restart-")))
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
    await fs.mkdir(environment.HOME, { recursive: true })
    const run = async (mode: string) => {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../fixture/import-file-set-process.ts"), root, mode],
        { cwd: path.resolve(import.meta.dir, "../.."), env: environment, stdout: "pipe", stderr: "pipe" },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 25_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0 && mode !== "crash") throw new Error(`File restart child ${code}: ${stdout}\n${stderr}`)
        return { code, stdout }
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill("SIGKILL")
      }
    }
    try {
      expect((await run("crash")).code).not.toBe(0)
      expect(await Bun.file(path.join(root, "file-crash.json")).exists()).toBe(true)
      const resumed = await run("observe")
      expect(resumed.code).toBe(0)
      expect(resumed.stdout).toContain("IMPORT_FILE_PROCESS_PASS")
      const proof = await Bun.file(path.join(root, "file-recovered.json")).json()
      expect(proof.stopped.committedBatches).toBe(1)
      expect(proof.stopped.stopConfirmedAt).toBeGreaterThan(0)
    } finally {
      if (await Bun.file(path.join(root, "file-recovered.json")).exists())
        await fs.rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
