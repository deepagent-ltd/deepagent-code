import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// NO-DUAL-OWNER (migration #28): the app layer has exactly ONE durable task execution owner —
// the Core V2 TaskRunAuthority + TaskRunDispatcher/TaskOutbox runtime. The legacy app-layer
// execution chain (LegacySubagentExecutor / LegacyTaskInput / app TaskDispatcher / TaskDelivery
// loops and the deleted task-run lib functions) must never return. Static source scan over
// packages/deepagent-code/src, mirroring the LEGACY-EXECUTION-ZERO gate style.

const srcRoot = path.resolve(import.meta.dirname, "../../src")

function collect(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? collect(full) : full.endsWith(".ts") ? [full] : []
    })
    .map((file) => path.relative(srcRoot, file))
    // Bun's readdir reports symlinked directories as directories; the walk can escape src
    // through them (src symlinks into sibling package roots), so clamp to files inside src.
    .filter((rel) => !rel.startsWith(".."))
}

describe("no-dual-owner: single V2 durable task execution chain", () => {
  test("the legacy executor/input/dispatcher/delivery modules are absent and unreferenced", () => {
    const files = collect(srcRoot)
    for (const banned of [
      "session/task-input.ts",
      "session/task-dispatcher.ts",
      "session/task-executor.ts",
      "session/task-delivery.ts",
    ])
      expect(files).not.toContain(banned)

    const offenders: string[] = []
    for (const rel of files) {
      const body = fs.readFileSync(path.join(srcRoot, rel), "utf8")
      if (/LegacySubagentExecutor|LegacyTaskInput|session\/task-input|session\/task-dispatcher|session\/task-executor|session\/task-delivery/.test(body))
        offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  test("no src caller links the deleted v1 execution functions from the task-run lib", () => {
    const files = collect(srcRoot)
    const banned = [
      "admitTaskRun",
      "claimTaskProvisioning",
      "settleTaskRun",
      "startTaskRun",
      "renewTaskRunLease",
      "markTaskFinalizing",
      "markTaskFinalized",
      "markTaskResearchCompleted",
      "transitionToAdmitting",
      "classifyOnStartup",
      "orderedShutdown",
      "recoverExpiredTaskRuns",
      "deliverTaskNotifications",
      "claimTaskNotifications",
    ]
    const offenders: string[] = []
    for (const rel of files) {
      const body = fs.readFileSync(path.join(srcRoot, rel), "utf8")
      for (const fn of banned) if (body.includes(fn)) offenders.push(`${rel}: ${fn}`)
    }
    expect(offenders).toEqual([])
  })

  test("the app TaskTool and the facade submit through the Core V2 authority", () => {
    const task = fs.readFileSync(path.join(srcRoot, "tool/task.ts"), "utf8")
    expect(task).toContain("TaskRunAuthority.submit")
    expect(task).toContain("TaskRunAuthority.execute")
    const facade = fs.readFileSync(path.join(srcRoot, "session/facade-activity.ts"), "utf8")
    expect(facade).toContain("TaskRunAuthority.submit")
  })
})
