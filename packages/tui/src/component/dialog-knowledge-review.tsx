import { createResource, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

type KnowledgeItem = {
  sourceStore: "user_global" | "project"
  id: string
  version: number
  hash: string
  candidateId: string
  fingerprint: string
  governanceRevision: number
  type: string
  summary: string
  evidence_strength: string
  evidence_refs: string[]
  approval_status: "pending" | "approved" | "rejected"
  scope?: string
}

// W4-1 companion face — durable knowledge pending review (the GUI DialogReview). Approve and
// reject are exact-authority CAS: the full revision identity read from the pending list must be
// sent back verbatim; a mismatch is a 409 conflict the server surfaces as DeepAgentPromotionError.
export function DialogKnowledgeReview() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)

  const rawRequest = <T,>(options: { method: string; url: string; body?: unknown }) =>
    (sdk.client as unknown as { client: { request<D>(o: typeof options): Promise<{ data?: T; error?: unknown }> } }).client.request<T>(options)

  const [items, { refetch }] = createResource(async () => {
    const result = await rawRequest<{ items: KnowledgeItem[] }>({ method: "GET", url: "/deepagent/knowledge/pending" })
    if (result.error) throw result.error
    return (result.data?.items ?? []).filter((item) => item.approval_status === "pending")
  })

  const authority = (item: KnowledgeItem) => ({
    sourceStore: item.sourceStore,
    id: item.id,
    version: item.version,
    hash: item.hash,
    candidateId: item.candidateId,
    fingerprint: item.fingerprint,
    expectedGovernanceRevision: item.governanceRevision,
  })

  const decide = async (item: KnowledgeItem, action: "approve" | "reject-ids") => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await rawRequest<unknown>({
        method: "POST",
        url: `/deepagent/knowledge/${action === "approve" ? "approve" : "reject-ids"}`,
        body: authority(item),
      })
      if (result.error) throw result.error
      toast.show({
        variant: "success",
        message: i18n.t(action === "approve" ? "tui.review.pending.approved" : "tui.review.pending.rejected"),
        duration: 4000,
      })
      await refetch()
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const showDetail = (item: KnowledgeItem) => {
    const lines = [
      `${i18n.t("tui.reviews.type")}: ${item.type}`,
      `strength: ${item.evidence_strength}`,
      `store: ${item.sourceStore}`,
      `v${item.version} · gov r${item.governanceRevision}`,
      `${i18n.t("tui.reviews.evidence")}: ${item.evidence_refs.join(", ") || "—"}`,
      "",
      item.summary,
    ]
    dialog.replace(() => (
      <DialogAlert title={item.id} message={lines.join("\n")} />
    ))
  }

  const options = () =>
    (items.latest ?? []).map((item) => ({
      title: item.summary.length > 80 ? `${item.summary.slice(0, 80)}…` : item.summary,
      value: item.id,
      category: item.type,
      footer: [item.evidence_strength, item.sourceStore, `v${item.version}`].join(" · "),
    }))

  const byId = () => new Map((items.latest ?? []).map((item) => [item.id, item]))

  onMount(() => {
    dialog.setSize("large")
  })

  const pendingCount = () => (items.latest ?? []).length

  return (
    <DialogSelect
      title={`${i18n.t("tui.review.pending.title")} (${i18n.t("tui.review.pending.count", { count: pendingCount() })})`}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const item = byId().get(String(option.value))
        if (item) showDetail(item)
      }}
      actions={[
        {
          command: "review.pending.approve",
          title: i18n.t("tui.review.pending.approve"),
          onTrigger: (option: { value: string }) => {
            const item = byId().get(String(option.value))
            if (item) void decide(item, "approve")
          },
        },
        {
          command: "review.pending.reject",
          title: i18n.t("tui.review.pending.reject"),
          onTrigger: (option: { value: string }) => {
            const item = byId().get(String(option.value))
            if (item) void decide(item, "reject-ids")
          },
        },
      ]}
    />
  )
}
