import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@deepagent-code/ui/tooltip"
import { ProgressCircle } from "@deepagent-code/ui/progress-circle"
import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import type { Part } from "@deepagent-code/sdk/client"

import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics, getConversationTokens } from "@/components/session/session-context-metrics"
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
  // Cumulative tokens across the whole conversation (all turns + subagent child sessions). Distinct
  // from `context()` which is the current retained-window occupancy. Cost is intentionally not shown
  // yet — the billing figure is not aligned with our agent system, so it is hidden until it is.
  const conversationTokens = createMemo(() => getConversationTokens(sync.data.session ?? [], params.id))

  const openContext = () => {
    if (!params.id) return
    // Lazy: keeps the tab contents (ui/file → @pierre/diffs worker) out of the timeline's module graph.
    void import("@/components/session-context-dialog").then((x) => {
      dialog.show(() => <x.SessionContextUsageDialog />)
    })
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().total.toLocaleString(language.intl())}</span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().usage ?? 0}%</span>
              <span class="text-text-invert-base">{language.t("context.usage.usage")}</span>
            </div>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{conversationTokens().toLocaleString(language.intl())}</span>
        <span class="text-text-invert-base">{language.t("context.usage.totalTokens")}</span>
      </div>
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
