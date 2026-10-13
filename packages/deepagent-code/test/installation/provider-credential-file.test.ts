import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("installation key reads are bounded and reject actual grow/replacement races after first fstat", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-credential-file-")))
  const host = path.resolve(import.meta.dir, "../..")
  try {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/provider-credential-file.ts")],
      target: "bun",
      tsconfig: path.join(host, "tsconfig.json"),
      outdir: root,
      plugins: process.env.DAC_ROUTE_AUTHORITY_BEFORE
        ? [
            {
              name: "controlled-before-source",
              setup(builder) {
                builder.onLoad({ filter: /\/installation\/local-authority\.ts$/ }, async () => ({
                  contents: await fs.readFile(process.env.DAC_ROUTE_AUTHORITY_BEFORE!, "utf8"),
                  loader: "ts",
                }))
              },
            },
          ]
        : [],
    })
    expect(build.success).toBe(true)
    for (const mode of ["ordinary", "grow", "replace"]) {
      const home = path.join(root, mode)
      await fs.mkdir(home, { mode: 0o700 })
      const child = Bun.spawn([process.execPath, path.join(root, "provider-credential-file.js"), mode], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          XDG_DATA_HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          DEEPAGENT_CODE_HOME: home,
          DEEPAGENT_CODE_TEST_HOME: home,
          DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timeout))
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
      const result = JSON.parse(stdout)
      expect(result.accepted).toBe(mode === "ordinary")
      if (mode !== "ordinary") expect(result).toMatchObject({ changed: true, error: "LOCAL_OPERATOR_UNAVAILABLE" })
      if (mode === "grow") expect(result.bytes).toBeGreaterThan(262_144)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 35_000)
