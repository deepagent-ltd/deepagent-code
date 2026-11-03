import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const fixture = path.join(import.meta.dir, "fixture/windows-native-worker-host.ts")
const repository = path.resolve(import.meta.dir, "../../../..")
const state: {
  cohort?: Awaited<ReturnType<typeof import("../fixture/windows-native-node-cohort").build>>
  preserve?: boolean
} = {}

beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native worker tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  const { build } = await import("../fixture/windows-native-node-cohort")
  state.cohort = await build({
    directory: await fs.mkdtemp(path.join(runner, "dac-native-worker-build-")),
    nodeEntry: fixture,
  })
}, 240_000)

afterAll(async () => {
  if (!state.preserve) await state.cohort?.dispose()
})

test("an original preloaded parent issues a one-shot receipt to its actual Node worker", async () => {
  if (process.platform !== "win32") {
    const { build } = await import("../fixture/windows-native-node-cohort")
    await expect(build({ directory: repository, nodeEntry: fixture })).rejects.toThrow(
      "requires its actual Windows target",
    )
    return
  }
  const result = await state.cohort!.run("worker-receipt")
  if (result.code !== 0) state.preserve = true
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0 })
  expect(await Bun.file(path.join(result.root, "worker-receipt.json")).json()).toEqual({
    parentPreloaded: true,
    parentCurrent: true,
    workerPreloaded: true,
    workerCurrent: true,
    sameProcess: true,
    realWorker: true,
    workerMarkerConsumed: true,
  })
}, 60_000)
