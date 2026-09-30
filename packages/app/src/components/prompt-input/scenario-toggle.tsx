import { createMemo, createSignal, onCleanup } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { ScopedKey } from "@/utils/server-scope"
import { deepAgentPromptModeFromConfig } from "@/utils/deepagent-settings"
import { getScenarioOverride, setScenarioOverride, subscribeScenarioOverride } from "./scenario-override"

// D1: the per-turn scenario-mode toggle that sits to the left of the send button. It flips the
// scenario between `direct` (the user owns the prompt) and `intelligence` (DeepAgent prepares the prompt
// and proposes next-round suggestions). It writes a DIRECTORY-scoped override (stable before a
// session exists) that submit.ts resolves session-then-directory, so a toggle made on the
// new-session composer still applies to the first turn. It defaults to the configured promptMode
// when no override is set.
export function ScenarioToggle() {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const language = useLanguage()
  const [version, setVersion] = createSignal(0)

  const dirKey = createMemo(() => ScopedKey.from(sdk.scope, sdk.directory) as unknown as string)
  onCleanup(subscribeScenarioOverride(() => setVersion((value) => value + 1)))

  // Effective scenario = directory override if set, else the configured default.
  const scenario = createMemo<"direct" | "intelligence">(() => {
    version()
    return getScenarioOverride(dirKey()) ?? deepAgentPromptModeFromConfig(serverSync.data.config)
  })

  const toggle = () => setScenarioOverride(dirKey(), scenario() === "intelligence" ? "direct" : "intelligence")

  return (
    <Tooltip
      placement="top"
      value={language.t(
        scenario() === "intelligence" ? "prompt.scenario.disable.tooltip" : "prompt.scenario.enable.tooltip",
      )}
    >
      <button
        data-action="prompt-scenario-toggle"
        data-scenario={scenario()}
        type="button"
        aria-pressed={scenario() === "intelligence"}
        class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-[520] leading-none transition-colors"
        onClick={toggle}
      >
        <Icon name="intelligence" class="size-3.5 shrink-0" />
        <span>{language.t("prompt.scenario.intelligence")}</span>
      </button>
    </Tooltip>
  )
}
