import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeCliCohort } from "./windows-native-cli-cohort"

type File = "config" | "httpapi-config"
const repository = path.resolve(import.meta.dir, "../../../..")
const shim = path.join(import.meta.dir, "compiled-test-registry.ts")
const state: { file?: File; cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>>; counter: number } = { counter: 0 }

export async function prepare(file: File) {
  if (process.platform !== "win32" || process.env.DAC_CONFIG_NATIVE_CASES === "1") return
  if (state.cohort) {
    if (state.file !== file) throw new Error("One process cannot mix compiled config fixture files")
    return
  }
  state.file = file
  const directory = path.join(process.env.RUNNER_TEMP ?? path.join(repository, ".artifacts"), `windows-native-${file}`)
  await fs.mkdir(directory, { recursive: true })
  const target = path.join(import.meta.dir, file === "config" ? "../config/config.test.ts" : "../server/httpapi-config.test.ts")
  const registrations = new Set([target, path.join(import.meta.dir, "../lib/effect.ts"), path.join(import.meta.dir, "fixture.ts")]
    .map((filename) => path.resolve(filename)))
  state.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "windows-config-host.ts"),
    extraSources: [
      shim,
      path.join(import.meta.dir, "windows-config.ts"),
      target,
      path.join(import.meta.dir, "../fake/account.ts"),
      path.join(import.meta.dir, "../fake/auth.ts"),
      path.join(import.meta.dir, "../fake/npm.ts"),
      path.join(import.meta.dir, "../server/global-bus.ts"),
    ],
    plugins: [{
      name: `original-${file}-case-registration`,
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async (input) => {
          if (!registrations.has(path.resolve(input.path))) return
          const source = await fs.readFile(input.path, "utf8")
          if ([...source.matchAll(/from (["'])bun:test\1/g)].length !== 1)
            throw new Error("Original config registration import inventory changed")
          return { contents: source.replace(/from (["'])bun:test\1/g, `from ${JSON.stringify(shim)}`), loader: "ts" }
        })
      },
    }],
  })
}

export function register(name: string, source: () => unknown) {
  if (process.platform !== "win32" || process.env.DAC_CONFIG_NATIVE_CASES === "1") return source()
  return test(name, async () => {
    const cohort = state.cohort!
    const home = path.join(cohort.root, `case-${++state.counter}`)
    const result = await cohort.run({
      env: {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "appdata"),
        LOCALAPPDATA: path.join(home, "localappdata"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        TEMP: path.join(home, "tmp"),
        TMP: path.join(home, "tmp"),
        TMPDIR: path.join(home, "tmp"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, "bun-cache"),
        DAC_WINDOWS_CONFIG_ROOT: cohort.root,
        DAC_WINDOWS_CONFIG_FILE: state.file!,
        DAC_CONFIG_NATIVE_CASES: "1",
        DAC_COMPILED_TEST_NAME_PATTERN: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        DEEPAGENT_CODE_HOME: path.join(home, "data"),
        DEEPAGENT_CODE_TEST_HOME: home,
        DEEPAGENT_CODE_DB: ":memory:",
        DEEPAGENT_CODE_MODELS_PATH: path.join(repository, "packages/deepagent-code/test/tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
      },
      milliseconds: 120_000,
    })
    const coverage = await Bun.file(path.join(cohort.root, `windows-config-${state.file}-cases.json`)).json() as {
      expected: number
      registered: number
      executed: number
      pass: boolean
      currentBeforeRetirement: boolean
      retiredReadRejected: boolean
      rows: unknown[]
    }
    console.info("WINDOWS_CONFIG_RESULT", JSON.stringify({
      name,
      code: result.code,
      timedOut: result.timedOut,
      stdoutFile: result.stdoutFile,
      stderrFile: result.stderrFile,
    }))
    expect({ code: result.code, timedOut: result.timedOut, coverage }).toMatchObject({
      code: 0,
      timedOut: false,
      coverage: { expected: 1, registered: 1, executed: 1, pass: true, currentBeforeRetirement: true, retiredReadRejected: true },
    })
    expect(coverage.rows).toHaveLength(1)
  }, 150_000)
}

export async function dispose() {
  await state.cohort?.dispose()
}
