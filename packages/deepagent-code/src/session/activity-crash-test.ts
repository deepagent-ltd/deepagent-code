import { realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"

export type Point =
  | "after_admit_and_bind"
  | "after_provider_streaming"
  | "after_provider_receipt_terminal"
  | "after_progress_settled"

export function pause(point: Point) {
  if (process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT !== point) return Effect.void
  return Effect.promise(async () => {
    const root = process.env.DEEPAGENT_CODE_TEST_ROOT
    const marker = process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER
    if (!root || !marker) throw new Error("Activity crash injection requires an isolated test root and marker")
    const resolvedRoot = await realpath(root)
    const resolvedMarker = path.join(await realpath(path.dirname(marker)), path.basename(marker))
    if (resolvedMarker !== resolvedRoot && !resolvedMarker.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Activity crash marker must stay inside DEEPAGENT_CODE_TEST_ROOT")
    }
    await writeFile(resolvedMarker, `${JSON.stringify({ point, pid: process.pid, reachedAt: Date.now() })}\n`)
    await new Promise<never>(() => {})
  })
}
