import { createEffect, createMemo, Show } from "solid-js"
import { Icon } from "@deepagent-code/ui/icon"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { imNavigationState, sameIMConnection } from "./navigation-state"
import { imSummaryOwner } from "./summary-owner"

export function IMNavigationEntry(props: { onOpen: () => void; active?: boolean }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useServerSync()
  createEffect(() => imSummaryOwner.activate(server.scope(), server.current?.http, sync.data.config.im?.url))
  const text = (key: string) => language.t(`workPanel.${key}` as Parameters<typeof language.t>[0])
  const state = createMemo(() => {
    const value = imNavigationState()
    const connection = server.current?.http
    return value && value.scope === server.scope() && connection && sameIMConnection(value.connection, connection)
      ? value
      : undefined
  })
  const status = () =>
    !state()?.current
      ? text("summaryUnknown")
      : !state()?.connected
        ? text("connectionUnknown")
        : state()?.unread
          ? text("unread")
          : text("messages")
  return (
    <button
      type="button"
      class="titlebar-icon relative flex h-6 w-8 shrink-0 items-center justify-center rounded-md text-text-weak hover:bg-surface-raised-base-hover"
      classList={{ "bg-surface-raised-base text-text-strong": props.active === true }}
      aria-label={`${text("messages")} · ${status()}`}
      title={status()}
      aria-pressed={props.active === true}
      onClick={props.onOpen}
      data-slot="im-navigation-entry"
    >
      <Icon name="bubble-5" size="small" />
      <Show when={state()?.current && state()?.unread}>
        <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-text-info" aria-hidden="true" />
      </Show>
      <Show when={state()?.current && !state()?.connected}>
        <span class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-text-warning" aria-hidden="true" />
      </Show>
    </button>
  )
}
