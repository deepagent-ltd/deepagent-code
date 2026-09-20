import { createMemo, createResource, createSignal, onMount } from "solid-js"
import type { Config } from "@deepagent-code/sdk"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// DeepAgent settings face — the agentMode / self-learning / subagent-intensity / prompt-mode
// selectors the GUI settings-v2 General tab owns. Writes go through config.update with the same
// merge shape as the GUI updateDeepAgentOptions (options spread, models preserved); the server
// recomputes routing from the next config read.

type DeepAgentMode = "general" | "high" | "xhigh" | "max" | "ultra"
type SelfLearning = "manual" | "auto"
type SubagentIntensity = "inherit" | "downgrade"
type PromptMode = "direct" | "intelligence"

const MODES: DeepAgentMode[] = ["general", "high", "xhigh", "max", "ultra"]

const isMode = (value: unknown): value is DeepAgentMode => MODES.includes(value as DeepAgentMode)
const isLearning = (value: unknown): value is SelfLearning => value === "manual" || value === "auto"
const isIntensity = (value: unknown): value is SubagentIntensity => value === "inherit" || value === "downgrade"
const isPromptMode = (value: unknown): value is PromptMode => value === "direct" || value === "intelligence"

export function DialogDeepAgentSettings() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const [config, { refetch }] = createResource(async () => {
    const result = await sdk.client.config.get(undefined, { throwOnError: true })
    return result.data
  })

  const current = createMemo<Config>(() => config.latest ?? sync.data.config)
  const deepagent = createMemo(() => current().provider?.deepagent ?? {})
  const options = createMemo(() => deepagent().options ?? {})

  const agentMode = createMemo<DeepAgentMode>(() => {
    const value = options().agentMode
    return isMode(value) ? value : "high"
  })
  const selfLearning = createMemo<SelfLearning>(() => {
    const value = options().selfLearning
    return isLearning(value) ? value : "manual"
  })
  const subagentIntensity = createMemo<SubagentIntensity>(() => {
    const value = options().subagentIntensity
    return isIntensity(value) ? value : "inherit"
  })
  // Legacy-compat: "wish" is the pre-rename value for "intelligence" (same normalization as the GUI).
  const promptMode = createMemo<PromptMode>(() => {
    const raw = options().promptMode === "wish" ? "intelligence" : options().promptMode
    return isPromptMode(raw) ? raw : "intelligence"
  })

  const patch = async (update: Partial<Record<"agentMode" | "selfLearning" | "subagentIntensity" | "promptMode", string>>) => {
    if (busy()) return
    setBusy(true)
    try {
      const { enabled: _legacyEnabled, ...existing } = options()
      const result = await sdk.client.config.update({
        config: {
          ...current(),
          provider: {
            ...current().provider,
            deepagent: {
              name: "DeepAgent",
              ...deepagent(),
              options: { ...existing, ...update },
              models: deepagent().models ?? {},
            },
          },
        },
      })
      if (result.error) throw result.error
      toast.show({ variant: "success", message: i18n.t("tui.deepagent.updated"), duration: 4000 })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const cycle = {
    agentMode: (): string => MODES[(MODES.indexOf(agentMode()) + 1) % MODES.length],
    selfLearning: (): string => (selfLearning() === "manual" ? "auto" : "manual"),
    subagentIntensity: (): string => (subagentIntensity() === "inherit" ? "downgrade" : "inherit"),
    promptMode: (): string => (promptMode() === "direct" ? "intelligence" : "direct"),
  }

  const entries = () => [
    {
      title: i18n.t("tui.deepagent.agentMode"),
      value: "agentMode",
      category: "DeepAgent",
      footer: agentMode(),
    },
    {
      title: i18n.t("tui.deepagent.selfLearning"),
      value: "selfLearning",
      category: "DeepAgent",
      footer: selfLearning(),
    },
    {
      title: i18n.t("tui.deepagent.subagentIntensity"),
      value: "subagentIntensity",
      category: "DeepAgent",
      footer: subagentIntensity(),
    },
    {
      title: i18n.t("tui.deepagent.promptMode"),
      value: "promptMode",
      category: "DeepAgent",
      footer: promptMode(),
    },
  ]

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.deepagent.title")}
      options={entries()}
      current={undefined}
      onSelect={(option) => void patch({ [String(option.value)]: cycle[option.value as keyof typeof cycle]() })}
    />
  )
}
