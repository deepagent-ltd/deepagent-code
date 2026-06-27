import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import "../settings-v2/settings-v2.css"

type Pack = {
  id: string
  name: string
  description?: string
  version: string
  risk: "low" | "medium" | "high" | "regulated"
  domains: string[]
  builtin: boolean
  pinned: boolean
}

type PacksResponse = {
  packs: Pack[]
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

const RISK_CLASSES: Record<Pack["risk"], string> = {
  low: "text-green-600 bg-green-100",
  medium: "text-yellow-700 bg-yellow-100",
  high: "text-red-600 bg-red-100",
  regulated: "text-purple-600 bg-purple-100",
}

export const DialogPacks: Component<{ client: RawSdkClient }> = (props) => {
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const [data, { refetch }] = createResource(async (): Promise<PacksResponse> => {
    const res = await props.client.client.request<PacksResponse>({
      method: "GET",
      url: "/deepagent/packs/all",
    })
    return res.data ?? { packs: [] }
  })

  const sortPacks = (list: Pack[]) => list.slice().sort((a, b) => a.id.localeCompare(b.id))
  const builtinPacks = createMemo(() => sortPacks((data()?.packs ?? []).filter((p) => p.builtin)))
  const externalPacks = createMemo(() => sortPacks((data()?.packs ?? []).filter((p) => !p.builtin)))

  const riskKey = (risk: Pack["risk"]) =>
    risk === "low"
      ? "packs.riskLow"
      : risk === "medium"
        ? "packs.riskMedium"
        : risk === "high"
          ? "packs.riskHigh"
          : "packs.riskRegulated"

  const callPack = async (action: "pin" | "unpin", packId: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await props.client.client.request({
        method: "POST",
        url: `/deepagent/packs/${action}`,
        body: { packId },
        headers: { "Content-Type": "application/json" },
      })
      await refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("packs.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const PackRow = (p: Pack) => (
    <div class="flex items-start gap-3 border-b border-v2-border-border-muted px-3 py-2.5 last:border-b-0 hover:bg-v2-background-bg-layer-01">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="min-w-0 break-words text-13-medium text-v2-text-text-base">{p.name}</span>
          <span class={`rounded px-1.5 py-0.5 text-11-medium ${RISK_CLASSES[p.risk]}`}>
            {language.t(riskKey(p.risk))}
          </span>
          <Show when={p.pinned}>
            <span class="rounded bg-v2-background-bg-layer-01 border border-v2-border-border-muted px-1.5 py-0.5 text-11-medium text-v2-text-text-faint">
              {language.t("packs.pinnedTag")}
            </span>
          </Show>
        </div>
        <Show when={p.description}>
          <span class="break-words text-12-regular text-v2-text-text-weak">{p.description}</span>
        </Show>
        <span class="break-all text-11-regular text-v2-text-text-faint">{p.id}</span>
      </div>
      <Button
        class="shrink-0"
        variant="secondary"
        size="small"
        onClick={() => void callPack(p.pinned ? "unpin" : "pin", p.id)}
        disabled={busy()}
      >
        {language.t(p.pinned ? "packs.unpin" : "packs.pinButton")}
      </Button>
    </div>
  )

  const Section = (props: { label: string; count: number; packs: Pack[] }) => (
    <Show when={props.packs.length > 0}>
      <div class="flex flex-col gap-1">
        <span class="px-3 text-11-medium text-v2-text-text-faint uppercase tracking-wide">
          {props.label} ({props.count})
        </span>
        <div class="rounded-lg border border-v2-border-border-muted overflow-hidden">
          <For each={props.packs}>{(p) => <PackRow {...p} />}</For>
        </div>
      </div>
    </Show>
  )

  return (
    <Dialog size="x-large" variant="settings" title={language.t("packs.title")}>
      <div class="settings-v2-panel" data-component="packs-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <div class="deepagent-dialog-scroll flex flex-col gap-3">
            <Show
              when={!data.loading}
              fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.loading")}</div>}
            >
              <Show
                when={!data.error}
                fallback={<div class="p-4 text-13-regular text-red-600">{String(data.error)}</div>}
              >
                <Show
                  when={(data()?.packs.length ?? 0) > 0}
                  fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("packs.empty")}</div>}
                >
                  <Section
                    label={language.t("packs.builtin")}
                    count={builtinPacks().length}
                    packs={builtinPacks()}
                  />
                  <Section
                    label={language.t("packs.external")}
                    count={externalPacks().length}
                    packs={externalPacks()}
                  />
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
