import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Effect, Layer } from "effect"
import { DiffLimits, Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Snapshot.defaultLayer, FSUtil.defaultLayer, testInstanceStoreLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const write = (file: string, content: string | Uint8Array) =>
  FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

describe("Snapshot degraded attribution (BUG-407-012 gap C)", () => {
  it.instance(
    "trackOutcome attributes a total-size budget overrun with session identity and budget numbers",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      // Oversized single files (> 2MB capture exclusion) are DROPPED from capture instead
      // of degrading it, so a degraded outcome requires in-budget files whose TOTAL
      // crosses captureTotalBytes: 33 files of exactly 2MB = 66MB > 64MB.
      yield* write(`${tmp.directory}/small.txt`, "within budget")
      const chunk = "x".repeat(2 * 1024 * 1024)
      const fileCount = Math.floor(DiffLimits.captureTotalBytes / (2 * 1024 * 1024)) + 1
      for (const index of Array.from({ length: fileCount }, (_, value) => value)) {
        yield* write(`${tmp.directory}/bulk-${index}.bin`, chunk)
      }

      const outcome = yield* snapshot.trackOutcome({ sessionId: "ses_attribution", activityId: "act_attribution" })
      expect(outcome.hash).toBeUndefined()
      expect(outcome.degraded).toMatchObject({
        reason: "snapshot_source_budget_exceeded",
        sessionId: "ses_attribution",
        activityId: "act_attribution",
        totalLimit: DiffLimits.captureTotalBytes,
        fileLimit: DiffLimits.captureFileBytes,
      })
      expect(typeof outcome.degraded?.totalBytes).toBe("number")

      // track() degrades to undefined (callers keep their legacy behavior).
      expect(yield* snapshot.track({ sessionId: "ses_attribution" })).toBeUndefined()
    }),
    { git: true },
  )

  it.instance(
    "trackOutcome still returns a hash and no degradation within budget",
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const snapshot = yield* Snapshot.Service
      yield* write(`${tmp.directory}/small.txt`, "within budget")

      const outcome = yield* snapshot.trackOutcome({ sessionId: "ses_ok", activityId: "act_ok" })
      expect(outcome.degraded).toBeUndefined()
      expect(outcome.hash).toBeTruthy()
    }),
    { git: true },
  )
})
