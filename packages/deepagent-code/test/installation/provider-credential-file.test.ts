import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"

const state: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const directory = path.join(process.env.RUNNER_TEMP ?? path.resolve(import.meta.dir, "../../.artifacts"), "windows-native-credential-file")
  await fs.mkdir(directory, { recursive: true })
  state.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "fixture/provider-credential-file.ts"),
    extraSources: [path.join(import.meta.dir, "fixture/provider-credential-file.ts")],
  })
}, 240_000)
afterAll(async () => { await state.cohort?.dispose() })

test("installation key reads are bounded and reject concurrent writes while preserving valid snapshots", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-credential-file-")))
  const host = path.resolve(import.meta.dir, "../..")
  try {
    if (process.platform !== "win32") {
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
    }
    for (const mode of ["ordinary", "grow", "replace"]) {
      const home = process.platform === "win32" ? path.join(state.cohort!.root, mode) : path.join(root, mode)
      await fs.mkdir(home, { mode: 0o700 })
      const executed = process.platform === "win32"
        ? await state.cohort!.run({
            args: [mode],
            env: {
              HOME: home,
              USERPROFILE: home,
              APPDATA: path.join(home, "appdata"),
              LOCALAPPDATA: path.join(home, "localappdata"),
              TEMP: home,
              TMP: home,
              TMPDIR: home,
              XDG_DATA_HOME: home,
              XDG_CONFIG_HOME: home,
              XDG_CACHE_HOME: home,
              XDG_STATE_HOME: home,
              DEEPAGENT_CODE_HOME: home,
              DEEPAGENT_CODE_TEST_HOME: home,
              DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
              DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
            },
            inheritEnvironment: false,
            milliseconds: 30_000,
          })
        : await (async () => {
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
            const [code, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]).finally(() => clearTimeout(timeout))
            return { code, stdout, stderr }
          })()
      expect({ status: executed.code, stderr: executed.stderr }).toEqual({ status: 0, stderr: "" })
      const result = JSON.parse(executed.stdout)
      expect(result.accepted).toBe(process.platform === "win32" || mode === "ordinary")
      if (mode !== "ordinary" && process.platform === "win32")
        expect(result).toMatchObject({ changed: true, heldMutationRejected: true })
      if (mode !== "ordinary" && process.platform !== "win32")
        expect(result).toMatchObject({ changed: true, error: "LOCAL_OPERATOR_UNAVAILABLE" })
      if (mode === "grow") expect(result.bytes).toBeGreaterThan(262_144)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 35_000)
