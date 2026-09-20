import { createMemo, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useTuiI18n } from "../context/i18n"

// W4-4b — the TUI agent-system overview. Like the GUI page, this reads the already-synced
// store (agents + providers); no new endpoints.
export function DialogAgentSystem() {
  const dialog = useDialog()
  const sync = useSync()
  const i18n = useTuiI18n()

  const options = createMemo(() =>
    sync.data.agent.map((agent) => ({
      title: agent.name,
      value: agent.name,
      category: "Agents",
      footer: [agent.mode, agent.native ? "built-in" : "custom"].filter(Boolean).join(" · "),
    })),
  )

  const providerOptions = createMemo(() =>
    sync.data.provider.slice(0, 50).map((provider) => ({
      title: provider.id,
      value: provider.id,
      category: "Providers",
      footer: `${sync.data.provider_default[provider.id] ?? ""}`,
    })),
  )

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.agentSystem.title")}
      options={[...options(), ...providerOptions()]}
      current={undefined}
      onSelect={() => {}}
    />
  )
}
