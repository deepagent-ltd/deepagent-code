import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WindowsNativeNodeCohort } from "../fixture/windows-native-node-cohort"

const repository = path.resolve(import.meta.dir, "../../../..")
const state: { cohort?: Awaited<ReturnType<typeof WindowsNativeNodeCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  const directory = runner && path.win32.parse(runner).root.toUpperCase() === "D:\\"
    ? await fs.realpath(runner)
    : path.join(repository, ".artifacts", "windows-native-node")
  await fs.mkdir(directory, { recursive: true })
  state.cohort = await WindowsNativeNodeCohort.build({ directory: await fs.realpath(directory),
    nodeEntry: path.join(import.meta.dir, "fixture/windows-native-mcp-host.ts") })
}, 240_000)

afterAll(async () => {
  await state.cohort?.dispose()
})

test(process.platform === "win32"
  ? "the original Windows Native Node cohort sets and reads MCP credentials and refuses its retired custody"
  : "the Windows Native Node cohort refuses a non-Windows publisher before issuing any capture", async () => {
  if (process.platform !== "win32") {
    await expect(WindowsNativeNodeCohort.build({ directory: repository,
      nodeEntry: path.join(import.meta.dir, "fixture/windows-native-mcp-host.ts") }))
      .rejects.toThrow("requires its actual Windows target")
    return
  }
  const cohort = state.cohort!
  console.info("WINDOWS_NATIVE_COHORT_EVIDENCE", cohort.root)
  console.info("WINDOWS_NATIVE_COHORT_PUBLIC", await Bun.file(path.join(cohort.root, "cohort.json")).json())
  const result = await cohort.run()
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
  expect(await Bun.file(path.join(cohort.root, "mcp-probe.json")).json()).toEqual({
    nativeInstallation: true, originalPreload: true, originalPrivateWitness: true,
    setGet: true, dpapiRoundTrip: true, retiredReadRejected: true, nativeRegisteredInjected: false, nativeCurrentInjected: false,
    codecInjected: false, windowsExecution: true, processRuntime: "electron-utility", fileExists: true,
  })
}, 60_000)
