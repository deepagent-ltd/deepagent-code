import { test, expect, describe, afterAll, afterEach, beforeAll, beforeEach } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SettingsStore } from "@/settings/store"
import type { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"
import { registerSettingsStoreCases } from "./store.cases"

const native: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  const directory = path.resolve(import.meta.dir, "../../.artifacts/windows-native-settings-store")
  await fs.mkdir(directory, { recursive: true })
  native.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "store-process.ts"),
    extraSources: [import.meta.path, path.join(import.meta.dir, "store.cases.ts")],
  })
}, 240_000)
afterAll(async () => { await native.cohort?.dispose() })

// SettingsStore resolves its file under Global.Path.data. BOTH variables are required to point it at
// a throwaway dir: `resolveDataPath` (global-path.ts) honours DEEPAGENT_CODE_HOME only alongside the
// explicit DEEPAGENT_CODE_TEST_HOME boundary. Setting DEEPAGENT_CODE_HOME alone left the path at the
// real ~/.deepagent/code — the opposite of the isolation this fixture claims.
let home: string
const prevHome = process.env.DEEPAGENT_CODE_HOME
const prevTestHome = process.env.DEEPAGENT_CODE_TEST_HOME

beforeEach(async () => {
  if (process.platform === "win32") return
  const { tmpRootAsync } = await import("../fixture/fixture")
  home = await tmpRootAsync()
  process.env.DEEPAGENT_CODE_TEST_HOME = home
  process.env.DEEPAGENT_CODE_HOME = home
  SettingsStore.invalidate()
})

afterEach(async () => {
  if (process.platform === "win32") return
  if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = prevHome
  if (prevTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = prevTestHome
  SettingsStore.invalidate()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

describe("SettingsStore", () => {
  registerSettingsStoreCases((name, run) => {
    test(name, async () => {
      if (process.platform !== "win32") {
        const file = path.join(home, "settings.json")
        return run({ store: SettingsStore, file, writeFixture: (text) => fs.writeFile(file, text, { mode: 0o600 }) })
      }
      const cohort = native.cohort!
      const root = await fs.mkdtemp(path.join(cohort.root, "settings-case-"))
      try {
        const result = await cohort.run({
          args: [name],
          env: { DEEPAGENT_CODE_TEST_HOME: root, DEEPAGENT_CODE_HOME: path.join(root, "config") },
          inheritEnvironment: false,
          milliseconds: 20_000,
        })
        expect(result.timedOut, result.stderrFile).toBe(false)
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe(JSON.stringify({ name, native: true }))
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  })
})
