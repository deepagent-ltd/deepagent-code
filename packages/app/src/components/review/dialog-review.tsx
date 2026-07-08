import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import "../settings-v2/settings-v2.css"

type KnowledgeItem = {
  id: string
  type: "knowledge" | "strategy" | "methodology" | "memory" | "skill" | "failure_dossier"
  summary: string
  evidence_strength: "strong" | "medium" | "weak" | "none"
  evidence_refs: string[]
  approval_status: "pending" | "approved" | "rejected"
}

type RawSdkClient = {
  client: {
    request<TData>(options: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: TData }>
  }
}

type ReviewClient = RawSdkClient

export const listPending = async (client: ReviewClient): Promise<KnowledgeItem[]> => {
  const response = await client.client.request<{ items: KnowledgeItem[] }>({
    method: "GET",
    url: "/deepagent/knowledge/pending",
  })
  return response.data?.items ?? []
}

export const setStatus = async (
  client: ReviewClient,
  action: "approve" | "reject-ids",
  ids: string[],
): Promise<void> => {
  await client.client.request<{ updated: string[] }>({
    method: "POST",
    url: `/deepagent/knowledge/${action}`,
    body: { ids },
    headers: { "Content-Type": "application/json" },
  })
}

export const DialogReview: Component<{ client: ReviewClient }> = (props) => {
  const language = useLanguage()
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = createSignal(false)
  const [showApproved, setShowApproved] = createSignal(false)
  const [items, { refetch }] = createResource(async () => listPending(props.client))

  // Rejected (and superseded, which the backend already excludes) are noise —
  // hide them. Approved collapses into a single expandable row so the list is
  // dominated by what actually needs attention (pending).
  const pending = createMemo(() => (items() ?? []).filter((i) => i.approval_status === "pending"))
  const approved = createMemo(() => (items() ?? []).filter((i) => i.approval_status === "approved"))

  const toggle = (id: string) => {
    const next = new Set<string>(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const selectAll = () => setSelected(new Set(pending().map((i) => i.id)))
  const invert = () => {
    const cur = selected()
    setSelected(
      new Set(
        pending()
          .map((i) => i.id)
          .filter((id) => !cur.has(id)),
      ),
    )
  }

  const apply = async (action: "approve" | "reject-ids") => {
    const ids = [...selected()]
    if (ids.length === 0 || busy()) return
    setBusy(true)
    try {
      await setStatus(props.client, action, ids)
      setSelected(new Set<string>())
      await refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("review.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const Row = (item: KnowledgeItem) => {
    const checked = createMemo(() => selected().has(item.id))
    return (
      <label
        data-action="review-item"
        data-status={item.approval_status}
        class="flex cursor-pointer items-start gap-3 border-b border-v2-border-border-muted px-3 py-2.5 last:border-b-0 hover:bg-v2-background-bg-layer-01"
      >
        <input type="checkbox" class="mt-0.5" checked={checked()} onChange={() => toggle(item.id)} />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="break-words text-13-medium text-v2-text-text-base">{item.summary}</span>
          <span class="break-words text-11-regular text-v2-text-text-faint">
            {item.type}
            {" · "}
            {language.t("review.strength", { value: language.t(`review.strength.${item.evidence_strength}`) })}
            <Show when={item.evidence_refs.length > 0}>
              {" · "}
              {language.t("review.evidence", { count: item.evidence_refs.length })}
            </Show>
          </span>
        </div>
      </label>
    )
  }

  return (
    <Dialog size="x-large" variant="settings" title={language.t("review.title")}>
      <div class="settings-v2-panel" data-component="review-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <p class="text-12-regular text-v2-text-text-faint">{language.t("review.description")}</p>

          <div class="deepagent-dialog-scroll rounded-lg border border-v2-border-border-muted">
            <Show
              when={!items.loading}
              fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.loading")}</div>}
            >
              <Show
                when={pending().length > 0 || approved().length > 0}
                fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.empty")}</div>}
              >
                {/* Pending: laid out flat — this is what needs attention. */}
                <For each={pending()}>{(item) => Row(item)}</For>

                {/* Approved: collapsed into one expandable row. */}
                <Show when={approved().length > 0}>
                  <button
                    type="button"
                    data-action="review-approved-toggle"
                    class="flex w-full items-center gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 py-2.5 text-left hover:bg-v2-background-bg-layer-02"
                    onClick={() => setShowApproved(!showApproved())}
                  >
                    <Icon name={showApproved() ? "chevron-down" : "chevron-right"} size="small" />
                    <span class="text-13-medium text-v2-text-text-base">
                      {language.t("review.status.approved")} ({approved().length})
                    </span>
                  </button>
                  <Show when={showApproved()}>
                    <For each={approved()}>{(item) => Row(item)}</For>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>

          <div class="deepagent-dialog-actions flex items-center justify-between">
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="small" onClick={selectAll} disabled={pending().length === 0}>
                {language.t("review.selectAll")}
              </Button>
              <Button variant="secondary" size="small" onClick={invert} disabled={pending().length === 0}>
                {language.t("review.invertSelection")}
              </Button>
              <Show when={selected().size > 0}>
                <span class="text-11-regular text-v2-text-text-faint">
                  {language.t("review.selected", { count: selected().size })}
                </span>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="small"
                data-action="review-reject"
                onClick={() => void apply("reject-ids")}
                disabled={selected().size === 0 || busy()}
              >
                {language.t("review.reject")}
              </Button>
              <Button
                variant="primary"
                size="small"
                data-action="review-approve"
                onClick={() => void apply("approve")}
                disabled={selected().size === 0 || busy()}
              >
                {language.t("review.approve")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
