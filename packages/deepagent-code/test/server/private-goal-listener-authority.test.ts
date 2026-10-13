import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { seedRipgrep } from "../lib/seed-ripgrep"

for (const mode of ["matrix", "shared", "restore", "restore-fallback"]) {
  test(`private Goal listener authority: ${mode}`, async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-listener-")))
    await seedRipgrep(directory)
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/private-goal-listener-authority.ts"), mode],
      {
        cwd: directory,
        env: {
          HOME: directory,
          PATH: process.env.PATH,
          TMPDIR: os.tmpdir(),
          NO_COLOR: "1",
          DEEPAGENT_CODE_DB: path.join(directory, "fixture.db"),
          DEEPAGENT_CODE_TEST_HOME: directory,
          DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
          DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "true",
          DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 55_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    await fs.writeFile(path.join(directory, "fixture.log"), stdout + stderr)
    expect(code, `Fixture evidence: ${directory}\n${(stdout + stderr).slice(-6000)}`).toBe(0)
    const result = await Bun.file(path.join(directory, "result.json")).json()
    expect(result.mode).toBe(mode)
    expect(result.observations.length).toBeGreaterThan(4)
    expect(result.observations.some((entry: { available: boolean }) => !entry.available)).toBe(true)
  }, 60_000)
}
