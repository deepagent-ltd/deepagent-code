import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"
import { verifyEventRepository } from "../fixture/windows-event-repository"

const state: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const directory = path.join(process.env.RUNNER_TEMP ?? path.resolve(import.meta.dir, "../../.artifacts"), "windows-native-event-repository")
  await fs.mkdir(directory, { recursive: true })
  state.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "../fixture/windows-event-repository.ts"),
    extraSources: [path.join(import.meta.dir, "../fixture/windows-event-repository.ts")],
  })
}, 240_000)
afterAll(async () => { await state.cohort?.dispose() })

test("original held repository refuses child cwd and changed parent Git marker before object writes", async () => {
  if (process.platform !== "win32") return verifyEventRepository()
  const result = await state.cohort!.run({
    env: {
      HOME: state.cohort!.root,
      USERPROFILE: state.cohort!.root,
      APPDATA: path.join(state.cohort!.root, "appdata"),
      LOCALAPPDATA: path.join(state.cohort!.root, "localappdata"),
      TEMP: state.cohort!.root,
      TMP: state.cohort!.root,
      TMPDIR: state.cohort!.root,
      XDG_DATA_HOME: path.join(state.cohort!.root, "data"),
      XDG_CONFIG_HOME: path.join(state.cohort!.root, "config"),
      XDG_CACHE_HOME: path.join(state.cohort!.root, "cache"),
      XDG_STATE_HOME: path.join(state.cohort!.root, "state"),
      DEEPAGENT_CODE_HOME: path.join(state.cohort!.root, "data"),
      DEEPAGENT_CODE_TEST_HOME: state.cohort!.root,
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(state.cohort!.root, "managed"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    },
    inheritEnvironment: false,
    milliseconds: 60_000,
  })
  console.info("WINDOWS_EVENT_REPOSITORY_RESULT", JSON.stringify(result))
  expect(result.code).toBe(0)
}, 90_000)
