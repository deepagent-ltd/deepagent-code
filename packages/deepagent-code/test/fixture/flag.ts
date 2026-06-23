import type { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Effect, Scope } from "effect"

/**
 * Scoped override for `Flag.DEEPAGENT_CODE_WORKSPACE_ID`. Saves the previous value
 * on entry and restores it via finalizer when the surrounding scope closes —
 * preserves the original try/finally semantics regardless of test outcome.
 */
export function withFixedWorkspaceID(id: WorkspaceV2.ID): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const previous = Flag.DEEPAGENT_CODE_WORKSPACE_ID
    Flag.DEEPAGENT_CODE_WORKSPACE_ID = id
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.DEEPAGENT_CODE_WORKSPACE_ID = previous
      }),
    )
  })
}
