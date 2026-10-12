import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

for (const mode of ["file", "print"])
  test(`actual instrumentation uses the configured ${mode} sink without changing its prefixes`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-instrumentation-log-"))
    await fs.chmod(root, 0o700)
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/instrumentation-logging.ts"), mode],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          DEEPAGENT_CODE_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    )
    const result = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(result[0]).toBe(0)
    const file: unknown = JSON.parse(result[1])
    if (!file || typeof file !== "object" || !("file" in file) || typeof file.file !== "string")
      throw new Error("Instrumentation fixture did not return its original log sink")
    const output = mode === "file" ? await Bun.file(file.file).text() : result[2]
    if (mode === "file") expect(result[2]).toBe("")
    if (mode === "print") expect(file.file).toBe("")
    expect(
      output
        .split("\n")
        .filter(Boolean)
        .map((line) => line.match(/^\[(beacon|turn)\] (startup|engage|summary)/)?.[0]),
    ).toEqual(["[beacon] startup", "[beacon] engage", "[beacon] summary", "[turn] summary"])
    expect(JSON.parse(output.split("[turn] summary ")[1]!.trim()).usage).toEqual({
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    await fs.rm(root, { recursive: true, force: true })
  })
