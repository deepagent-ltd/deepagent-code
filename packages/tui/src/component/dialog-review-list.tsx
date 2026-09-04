import { createResource, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"

type RunReview = {
  runId: string
  agentMode?: string | null
  status?: string | null
  nextAction?: string | null
  candidates?: unknown[]
  diagnosis?: {
    status?: string | null
    rootCause?: string | null
    nextAction?: string | null
  } | null
}

// W4-1 — the TUI review list. The full flow (candidate lineage, promote/reject) is being built
// out on this surface per the 2026-09-05 full-parity ruling; the list is the entry face.
// GET /deepagent/reviews is served by path and not in the generated SDK, hence the low-level
// request helper (same escape hatch as the /goal commands).
export function DialogReviewList() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()

  const [items] = createResource(async () => {
    const result = await (
      sdk.client as unknown as {
        client: { request<D>(o: { method: string; url: string }): Promise<{ data?: D; error?: unknown }> }
      }
    ).client.request<{ reviews: RunReview[] }>({
      method: "GET",
      url: "/deepagent/reviews",
    })
    if (result.error) throw result.error
    return result.data?.reviews ?? []
  })

  const options = () =>
    (items.latest ?? []).map((x) => ({
      title: x.runId,
      value: x.runId,
      category: "Reviews",
      footer: [
        x.status ?? i18n.t("tui.reviews.statusUnknown"),
        x.diagnosis?.rootCause ?? x.nextAction ?? "",
        x.candidates ? `${x.candidates.length} ${i18n.t("tui.reviews.candidates")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    }))

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={`${i18n.t("tui.reviews.title")}${items.latest ? ` (${items.latest.length})` : ""}`}
      options={options()}
      current={undefined}
      onSelect={() => {
        // Read-only surface: selecting a run shows its details in the footer; the promote/reject
        // flow lives in the GUI review page by ruling.
      }}
    />
  )
}
