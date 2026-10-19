import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@deepagent-code/ui/tooltip"
import { ProgressCircle } from "@deepagent-code/ui/progress-circle"
import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import type { Part } from "@deepagent-code/sdk/client"

import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const providers = useProviders()
  const { params } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const metrics = createMemo(() =>
    getSessionContextMetrics(
      messages(),
      [...providers.all().values()],
      sync.data.part as Record<string, Part[] | undefined>,
    ),
  )
  const context = createMemo(() => metrics().context)
  const usageLabel = () => {
    const current = context()
    if (!current) return language.t("context.usage.noData")
    if (current.usage === null) return language.t("context.usage.unknown")
    return `${current.source === "compaction" ? "≈ " : ""}${current.usage.toLocaleString(language.intl())}%`
  }

  const openContext = () => {
    if (!params.id) return
    // Lazy: keeps the tab contents (ui/file → @pierre/diffs worker) out of the timeline's module graph.
    void import("@/components/session-context-dialog").then((x) => {
      dialog.show(() => <x.SessionContextUsageDialog />)
    })
  }

  const circle = () => (
    <div
      class="flex items-center justify-center"
      role="img"
      aria-label={`${language.t("context.usage.window")}: ${usageLabel()}`}
    >
      <Show
        when={context()?.usage !== null && context()?.usage !== undefined}
        fallback={
          <div class="size-4 rounded-full border-2 border-border-strong-base" data-slot="context-usage-unknown" />
        }
      >
        <ProgressCircle size={16} strokeWidth={2} percentage={context()!.usage!} />
      </Show>
    </div>
  )

  const tooltipValue = () => (
    <div class="flex flex-col gap-1" data-component="context-usage-tooltip">
      <div class="flex items-center gap-2">
        <span class="text-text-invert-base">{language.t("context.usage.window")}</span>
        <span class="text-text-invert-strong">{usageLabel()}</span>
      </div>
      <Show when={context()} fallback={<div class="text-text-invert-base">{language.t("context.usage.pending")}</div>}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-base">{language.t("context.usage.used")}</span>
              <span class="text-text-invert-strong">
                {ctx().source === "compaction" ? "≈ " : ""}
                {ctx().total.toLocaleString(language.intl())}
              </span>
              <span class="text-text-invert-base">/ {language.t("context.usage.capacity")}</span>
              <span class="text-text-invert-strong">
                {ctx().limit ? ctx().limit!.toLocaleString(language.intl()) : language.t("context.usage.unknown")}
              </span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="max-w-64 text-text-invert-base">
              {language.t(
                ctx().source === "compaction" ? "context.usage.compactionEstimate" : "context.usage.lastRequest",
              )}
            </div>
          </>
        )}
      </Show>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
