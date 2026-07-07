import { createMemo, createSignal, onCleanup, For } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import { Tooltip } from "@deepagent-code/ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { ScopedKey } from "@/utils/server-scope"
import { deepAgentPromptModeFromConfig } from "@/utils/deepagent-settings"
import { getScenarioOverride, setScenarioOverride, subscribeScenarioOverride } from "./scenario-override"

const scenarios = [
  {
    mode: "direct" as const,
    icon: "pencil-line" as const,
    label: "prompt.scenario.direct" as const,
    tooltip: "prompt.scenario.direct.tooltip" as const,
  },
  {
    mode: "intelligence" as const,
    icon: "speech-bubble" as const,
    label: "prompt.scenario.intelligence" as const,
    tooltip: "prompt.scenario.intelligence.tooltip" as const,
  },
]

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

  const select = (mode: "direct" | "intelligence") => setScenarioOverride(dirKey(), mode)

  return (
    <div
      data-action="prompt-scenario-toggle"
      data-scenario={scenario()}
      class="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border-weak-base bg-surface-base p-0.5"
      role="radiogroup"
      aria-label={language.t("prompt.scenario.label")}
    >
      <For each={scenarios}>
        {(item) => {
          const active = createMemo(() => scenario() === item.mode)
          const label = createMemo(() => language.t(item.label))
          return (
            <Tooltip placement="top" value={language.t(item.tooltip)}>
              <button
                data-action={`prompt-scenario-${item.mode}`}
                data-active={active() ? "true" : "false"}
                type="button"
                class="flex h-6 min-w-[48px] items-center justify-center gap-1 rounded-[4px] px-1.5 text-[12px] font-[520] leading-none text-text-weak transition-colors hover:text-text-base data-[active=true]:bg-surface-raised-strong data-[active=true]:text-text-strong data-[active=true]:shadow-xs-border-base"
                onClick={() => select(item.mode)}
                role="radio"
                aria-checked={active()}
                aria-label={language.t(item.tooltip)}
              >
                <Icon name={item.icon} class="size-3.5 shrink-0" />
                <span>{label()}</span>
              </button>
            </Tooltip>
          )
        }}
      </For>
    </div>
  )
}
