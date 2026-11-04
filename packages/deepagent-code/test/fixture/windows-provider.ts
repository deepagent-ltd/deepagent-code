import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeCliCohort } from "./windows-native-cli-cohort"

const repository = path.resolve(import.meta.dir, "../../../..")
const shim = path.join(import.meta.dir, "compiled-test-registry.ts")
const registrations = new Set([
  path.join(import.meta.dir, "../provider/provider.test.ts"),
  path.join(import.meta.dir, "../lib/effect.ts"),
  path.join(import.meta.dir, "fixture.ts"),
].map((filename) => path.resolve(filename)))
const state: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}

export async function prepare() {
  if (process.platform !== "win32" || process.env.DAC_PROVIDER_NATIVE_CASES === "1" || state.cohort) return
  const directory = path.join(process.env.RUNNER_TEMP ?? path.join(repository, ".artifacts"), "windows-native-provider")
  await fs.mkdir(directory, { recursive: true })
  state.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "windows-provider-host.ts"),
    extraSources: [
      shim,
      path.join(import.meta.dir, "windows-provider.ts"),
      path.join(import.meta.dir, "../provider/provider.test.ts"),
      path.join(import.meta.dir, "deepagent-auth-provider.js"),
    ],
    plugins: [{
      name: "original-provider-case-registration",
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async (input) => {
          if (!registrations.has(path.resolve(input.path))) return
          const source = await fs.readFile(input.path, "utf8")
          if ([...source.matchAll(/from (["'])bun:test\1/g)].length !== 1)
            throw new Error("Original provider registration import inventory changed")
          return { contents: source.replace(/from (["'])bun:test\1/g, `from ${JSON.stringify(shim)}`), loader: "ts" }
        })
      },
    }],
  })
}

export async function run(name: string) {
  const cohort = state.cohort!
  const result = await cohort.run({
    env: {
      DAC_WINDOWS_PROVIDER_ROOT: cohort.root,
      DAC_PROVIDER_NATIVE_CASES: "1",
      DAC_COMPILED_TEST_NAME_PATTERN: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      DEEPAGENT_CODE_DB: ":memory:",
      DEEPAGENT_CODE_MODELS_PATH: path.join(repository, "packages/deepagent-code/test/tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(cohort.root, "managed"),
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
    },
    milliseconds: 120_000,
  })
  const coverage = await Bun.file(path.join(cohort.root, "windows-provider-cases.json")).json() as {
    expected: number
    registered: number
    executed: number
    pass: boolean
    currentBeforeRetirement: boolean
    retiredReadRejected: boolean
    rows: unknown[]
  }
  return { result, coverage }
}

export async function dispose() {
  await state.cohort?.dispose()
}
