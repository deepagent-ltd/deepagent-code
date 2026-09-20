import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"

type ProfileRun = { runId: string; status: "running" | "done" | "error"; artifactPath?: string; error?: string }

// W4-4b — the TUI profile face: run history with per-run hotspots. Starting new profiles is
// deliberately GUI-side (program picker); here the TUI observes runs and their hotspots.
export function DialogProfile() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()

  const [runs, { refetch }] = createResource(async () => {
    const result = await sdk.client.profile.runs().catch(() => undefined)
    return ((result?.data ?? []) as ProfileRun[]) ?? []
  })

  const [hotspots, setHotspots] = createSignal<{ name: string; fileLine: string; selfPct: number; cumulPct: number; calls: number }[]>([])
  const [selectedRun, setSelectedRun] = createSignal<string | undefined>(undefined)

  const loadHotspots = async (runId: string) => {
    setSelectedRun(runId)
    try {
      const result = await sdk.client.profile.hotspots({ runId, limit: "15" })
      if (result.error) throw result.error
      setHotspots(
        (result.data ?? []).map((spot) => ({
          name: spot.name,
          fileLine: spot.fileLine,
          selfPct: Number(spot.selfPct),
          cumulPct: Number(spot.cumulPct),
          calls: Number(spot.calls),
        })),
      )
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    }
  }

  const options = () => [
    ...(selectedRun() && hotspots().length > 0
      ? hotspots().map((spot) => ({
          title: `${spot.selfPct.toFixed(1)}% ${spot.name}`,
          value: `${selectedRun()}:${spot.name}`,
          category: i18n.t("tui.profile.hotspots"),
          footer: `${spot.fileLine} · cumul ${spot.cumulPct.toFixed(1)}% · ${spot.calls} calls`,
        }))
      : []),
    ...(runs.latest ?? []).map((run) => ({
      title: run.runId,
      value: run.runId,
      category: run.status,
      footer: run.error ?? run.artifactPath ?? Locale.time(Date.now()),
    })),
  ]

  const knownRuns = () => new Set((runs.latest ?? []).map((run) => run.runId))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={i18n.t("tui.profile.title")}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        if (knownRuns().has(String(option.value))) void loadHotspots(String(option.value))
      }}
      actions={[
        {
          command: "profile.back",
          title: i18n.t("tui.reviews.back"),
          onTrigger: () => {
            setSelectedRun(undefined)
            setHotspots([])
            void refetch()
          },
        },
      ]}
    />
  )
}
