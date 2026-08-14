import { ToolFailure } from "@deepagent-code/llm"
import { Effect } from "effect"
import { PlatformError } from "effect/PlatformError"

export function recoverReadDefect(path: string, defect: unknown) {
  if (defect instanceof PlatformError && defect.reason._tag === "NotFound")
    return Effect.fail(new ToolFailure({ message: `Unable to read ${path}` }))
  return Effect.die(defect)
}
