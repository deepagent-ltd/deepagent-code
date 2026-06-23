import { Flag } from "@deepagent-code/core/flag/flag"
import { createBuiltinPlugins, type BuiltinTuiPlugin } from "@deepagent-code/tui/builtins"
import type { RuntimeFlags } from "@/effect/runtime-flags"

export type InternalTuiPlugin = BuiltinTuiPlugin

export function internalTuiPlugins(flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">): InternalTuiPlugin[] {
  return createBuiltinPlugins({
    experimentalEventSystem: flags.experimentalEventSystem,
    experimentalSessionSwitcher: Flag.DEEPAGENT_CODE_EXPERIMENTAL_SESSION_SWITCHER,
  })
}
