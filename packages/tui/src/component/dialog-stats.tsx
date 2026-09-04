import { createMemo, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useTuiI18n } from "../context/i18n"

type StatsTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

// W4-4a — the TUI stats face. Pure client-side aggregation over the synced session list (same
// as the GUI's side-panel-stats: events keep the list live, so the memo re-aggregates).
export function DialogStats() {
  const dialog = useDialog()
  const sync = useSync()
  const i18n = useTuiI18n()

  const stats = createMemo(() => {
    let totalCost = 0
    const total: StatsTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const modelUsage = new Map<string, { sessions: number; cost: number; tokens: StatsTokens }>()
    for (const session of sync.data.session) {
      const cost = typeof session.cost === "number" && Number.isFinite(session.cost) ? session.cost : 0
      const tokens = session.tokens
      totalCost += cost
      if (tokens) {
        total.input += tokens.input || 0
        total.output += tokens.output || 0
        total.reasoning += tokens.reasoning || 0
        total.cache.read += tokens.cache?.read || 0
        total.cache.write += tokens.cache?.write || 0
      }
      if (session.model) {
        const key = `${session.model.providerID}/${session.model.id}`
        const existing = modelUsage.get(key) ?? { sessions: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
        existing.sessions += 1
        existing.cost += cost
        if (tokens) {
          existing.tokens.input += tokens.input || 0
          existing.tokens.output += tokens.output || 0
          existing.tokens.reasoning += tokens.reasoning || 0
          existing.tokens.cache.read += tokens.cache?.read || 0
          existing.tokens.cache.write += tokens.cache?.write || 0
        }
        modelUsage.set(key, existing)
      }
    }
    const models = [...modelUsage.entries()].toSorted((a, b) => b[1].cost - a[1].cost)
    return { totalCost, total, sessions: sync.data.session.length, models }
  })

  const formatTokens = (value: number) =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)

  onMount(() => {
    dialog.setSize("large")
  })

  const options = () => {
    const s = stats()
    return [
      { title: i18n.t("tui.stats.sessions"), value: String(s.sessions), category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.cost"), value: `$${s.totalCost.toFixed(2)}`, category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.input"), value: formatTokens(s.total.input), category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.output"), value: formatTokens(s.total.output), category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.reasoning"), value: formatTokens(s.total.reasoning), category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.cacheRead"), value: formatTokens(s.total.cache.read), category: i18n.t("tui.stats.overview") },
      { title: i18n.t("tui.stats.cacheWrite"), value: formatTokens(s.total.cache.write), category: i18n.t("tui.stats.overview") },
      ...s.models.map(([key, usage]) => ({
        title: key,
        value: `${usage.sessions}`,
        category: i18n.t("tui.stats.models"),
        footer: `${usage.sessions} · $${usage.cost.toFixed(2)} · in ${formatTokens(usage.tokens.input)} out ${formatTokens(usage.tokens.output)}`,
      })),
    ]
  }

  return (
    <DialogSelect
      title={i18n.t("tui.stats.title")}
      options={options()}
      current={undefined}
      onSelect={() => {
        // Read-only aggregation surface.
      }}
    />
  )
}
