import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

export async function waitForImportFixtureReady(input: {
  root: string
  startedAt: number
  ended: () => boolean
}) {
  for (;;) {
    if (input.ended()) throw new Error("Private import fixture ended before readiness")
    const startup = await readIfPresent(path.join(input.root, "startup.jsonl"))
    // Only complete records count: the child may be appending its next phase during this read.
    const acquisition = (startup ?? "").split("\n").slice(0, -1).map((line): unknown => JSON.parse(line)).find(
      (value): value is { phase: "acquiring-http-and-database"; at: number } =>
        typeof value === "object" && value !== null && "phase" in value &&
        value.phase === "acquiring-http-and-database" && "at" in value &&
        typeof value.at === "number" && Number.isFinite(value.at),
    )
    // Module preparation shares the original child budget; it cannot extend runtime readiness.
    const deadline = Math.min(input.startedAt + 25_000, acquisition ? acquisition.at + 15_000 : Infinity)
    const ready = await readIfPresent(path.join(input.root, "ready.json"))
    if (Date.now() >= deadline)
      throw new Error(`Private import fixture readiness deadline: ${JSON.stringify({
        elapsedMs: Date.now() - input.startedAt,
        stage: acquisition ? "http-and-database" : "module-preparation",
        runtimeElapsedMs: acquisition ? Date.now() - acquisition.at : undefined,
        startupBudgetMs: 25_000,
        runtimeBudgetMs: 15_000,
      })}`)
    if (ready !== undefined) return JSON.parse(ready) as unknown
    await sleep(Math.max(0, Math.min(50, deadline - Date.now())))
  }
}

async function readIfPresent(file: string) {
  return fs.readFile(file, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
}
