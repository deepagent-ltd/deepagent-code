import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Global } from "@deepagent-code/core/global"
import * as Log from "@deepagent-code/core/util/log"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

function files(dir: string) {
  return Effect.gen(function* () {
    let last = ""
    let same = 0

    for (let i = 0; i < 50; i++) {
      const list = yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
      const next = JSON.stringify(list)
      same = next === last ? same + 1 : 0
      if (same >= 2 && list.length === 11) return list
      last = next
      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
  })
}

it.live("init cleanup keeps the newest timestamped logs", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))

    const next = yield* files(dir)

    expect(next).not.toContain(list[0]!)
    expect(next).toContain(list.at(-1)!)
  }),
)

it.live("local dev log is not truncated twice for the same run", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    const runID = process.env.DEEPAGENT_CODE_RUN_ID
    const initialized = process.env.DEEPAGENT_CODE_LOG_INITIALIZED_RUN_ID
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Global.Path.log = log
        if (runID === undefined) delete process.env.DEEPAGENT_CODE_RUN_ID
        else process.env.DEEPAGENT_CODE_RUN_ID = runID
        if (initialized === undefined) delete process.env.DEEPAGENT_CODE_LOG_INITIALIZED_RUN_ID
        else process.env.DEEPAGENT_CODE_LOG_INITIALIZED_RUN_ID = initialized
      }),
    )

    const dir = yield* tmpdirScoped()
    Global.Path.log = dir
    process.env.DEEPAGENT_CODE_RUN_ID = "run-1"
    delete process.env.DEEPAGENT_CODE_LOG_INITIALIZED_RUN_ID

    yield* Effect.promise(() => Log.init({ print: false, dev: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "dev.log"), "main startup\n"))
    yield* Effect.promise(() => Log.init({ print: false, dev: true }))

    expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "dev.log"), "utf8"))).toContain("main startup")
  }),
)

it.live("serializes concurrent sink reconfiguration and closes the superseded writer", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Log.init({ print: true })
        Global.Path.log = log
      }),
    )
    Global.Path.log = yield* tmpdirScoped()

    yield* Effect.promise(() => Log.init({ print: false, dev: true }))
    const logger = Log.create({ service: "log-reconfiguration-test" })
    Array.from({ length: 128 }, (_, index) => logger.info(`pending write ${index}`))
    yield* Effect.promise(() => Promise.all([Log.init({ print: false, dev: true }), Log.init({ print: true })]))

    expect(Log.file()).toBe("")
  }),
)

it.live("falls back when an asynchronous log open fails and recovers on re-init", () =>
  Effect.gen(function* () {
    const previous = Global.Path.log
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Log.init({ print: true })
        Global.Path.log = previous
      }),
    )
    const dir = yield* tmpdirScoped()
    Global.Path.log = path.join(dir, "removed")

    yield* Effect.promise(() => Log.init({ print: false, dev: true }))
    const logger = Log.create({ service: "log-open-failure-test" })
    logger.info("write before open fails")
    yield* Effect.sleep("30 millis")
    logger.info("write after stream is destroyed")

    Global.Path.log = dir
    yield* Effect.promise(() => Log.init({ print: false, dev: true }))
    logger.info("write after recovery")
    yield* Effect.promise(() => Log.init({ print: true }))

    expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "dev.log"), "utf8"))).toContain("write after recovery")
  }),
)
