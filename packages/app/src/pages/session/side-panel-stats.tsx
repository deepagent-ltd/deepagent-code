// PARITY-001: GUI cross-session cost/token overview.
//
// The CLI `stats` command aggregates the whole database in-process; the GUI only had per-session
// context diagnostics (side-panel-context.tsx). This panel aggregates the sessions already synced
// into the directory store (sync.data.session — the same list the session drawer renders) into a
// per-session cost/token/model overview. Zero new API endpoints: the SDK Session type carries
// `cost`, `tokens` and `model` rollups.
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { For, Show, createMemo, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import {
  aggregateSessionStats,
  formatCost,
  formatTokenCount,
  sortModelUsage,
} from "@/utils/session-stats"

export const SidePanelStats: Component<{ onClose: () => void }> = (props) => {
  const sync = useSync()
  const language = useLanguage()

  // The synced session list for the current directory; events keep it live, so the memo
  // re-aggregates automatically as session cost/tokens rollups update.
  const stats = createMemo(() => aggregateSessionStats(sync.data.session))
  const models = createMemo(() => sortModelUsage(stats().modelUsage))

  const Row = (row: { label: string; value: string }) => (
    <div class="py-1 flex items-center gap-2 text-11-regular">
      <span class="flex-1 min-w-0 text-text-weak truncate">{row.label}</span>
      <span class="shrink-0 text-text-strong font-mono">{row.value}</span>
    </div>
  )

  const Section = (section: { title: string; children?: JSX.Element }) => (
    <div class="px-3 py-2.5 border-b border-border-weaker-base">
      <div class="text-11-medium text-text-weak uppercase">{section.title}</div>
      <div class="mt-1.5">{section.children}</div>
    </div>
  )

  return (
    <section class="size-full min-w-0 flex flex-col overflow-hidden bg-background-base" data-testid="side-panel-stats">
      <header class="h-10 shrink-0 px-2 flex items-center gap-2 border-b border-border-weaker-base">
        <Icon name="dash" size="small" class="text-icon-base" />
        <div class="min-w-0 flex-1 text-13-medium text-text-strong truncate">
          {language.t("session.stats.title")}
        </div>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("common.close")}
        />
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show
          when={stats().totalSessions > 0}
          fallback={<div class="p-3 text-13-regular text-text-weak">{language.t("session.stats.noData")}</div>}
        >
          <Section title={language.t("session.stats.overview")}>
            <Row label={language.t("session.stats.sessions")} value={stats().totalSessions.toLocaleString()} />
            <Row label={language.t("session.stats.days")} value={String(stats().days)} />
          </Section>

          <Section title={language.t("session.stats.costTokens")}>
            <Row label={language.t("session.stats.totalCost")} value={formatCost(stats().totalCost)} />
            <Row label={language.t("session.stats.costPerDay")} value={formatCost(stats().costPerDay)} />
            <Row
              label={language.t("session.stats.tokensPerSession")}
              value={formatTokenCount(stats().tokensPerSession)}
            />
            <Row
              label={language.t("session.stats.medianTokens")}
              value={formatTokenCount(stats().medianTokensPerSession)}
            />
            <Row label={language.t("session.stats.input")} value={formatTokenCount(stats().totalTokens.input)} />
            <Row label={language.t("session.stats.output")} value={formatTokenCount(stats().totalTokens.output)} />
            <Row
              label={language.t("session.stats.reasoning")}
              value={formatTokenCount(stats().totalTokens.reasoning)}
            />
            <Row
              label={language.t("session.stats.cacheRead")}
              value={formatTokenCount(stats().totalTokens.cache.read)}
            />
            <Row
              label={language.t("session.stats.cacheWrite")}
              value={formatTokenCount(stats().totalTokens.cache.write)}
            />
          </Section>

          <Show when={models().length > 0}>
            <Section title={`${language.t("session.stats.modelUsage")} · ${models().length}`}>
              <For each={models()}>
                {([model, usage]) => (
                  <div class="py-1.5 border-t border-border-weaker-base first:border-t-0 first:pt-0">
                    <div class="flex items-center gap-2">
                      <span class="flex-1 min-w-0 text-11-medium text-text-strong truncate" title={model}>
                        {model}
                      </span>
                      <span class="shrink-0 text-10-regular text-text-weaker font-mono">
                        {formatCost(usage.cost, 4)}
                      </span>
                    </div>
                    <div class="mt-0.5 flex items-center gap-2 text-10-regular text-text-weaker">
                      <span>
                        {language.t("session.stats.sessions")}: {usage.sessions.toLocaleString()}
                      </span>
                      <span class="font-mono">
                        {formatTokenCount(usage.tokens.input)}↑ {formatTokenCount(usage.tokens.output)}↓
                      </span>
                      <span class="ml-auto font-mono">
                        {language.t("session.stats.cacheRead")} {formatTokenCount(usage.tokens.cache.read)}
                      </span>
                    </div>
                  </div>
                )}
              </For>
            </Section>
          </Show>
        </Show>
      </div>
    </section>
  )
}
