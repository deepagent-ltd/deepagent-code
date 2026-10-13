import { For, Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { MessageItem } from "./message-item"
import type { AgentProgressPart, LocalMessage } from "@/hooks/use-im-websocket"

interface MessageListProps {
  messages: LocalMessage[]
  agentStatuses: Map<string, { agentID: string; status: string }>
  agentProgress: Map<string, AgentProgressPart[]>
  // §B3 thread — when provided, each message shows a "Reply in thread" affordance.
  onOpenThread?: (message: LocalMessage) => void
  onOpenConversationSession?: (message: LocalMessage) => void
  onUseDac?: (message: LocalMessage) => void
  mediaEnabled?: boolean
  selfMemberIDs?: readonly string[]
  senderNames?: ReadonlyMap<string, string>
  onLoadOlder?: () => void
  loadingOlder?: boolean
}

export function MessageList(props: MessageListProps) {
  const language = useLanguage()
  const [state, setState] = createStore({ unseen: 0 })
  let containerRef: HTMLDivElement | undefined
  let following = true
  let previousIDs: string[] = []
  let anchor: { id: string; offset: number } | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  // Auto-scroll to bottom on new messages AND as live reasoning streams in, so
  // the agent's in-progress thinking stays in view without manual scrolling.
  createEffect(() => {
    // Track both signals so streaming progress updates also trigger a scroll.
    const ids = props.messages.map((message) => message.id)
    props.agentProgress
    const last = ids.indexOf(previousIDs.at(-1) ?? "")
    const added = last < 0 ? [] : ids.slice(last + 1).filter((id) => !previousIDs.includes(id))
    if (!following && added.length > 0) setState("unseen", (value) => value + added.length)
    previousIDs = ids
    const loadingOlder = props.loadingOlder
    // Restore the visible message after Solid has prepended the older page. A
    // message anchor also works when a newer message arrives in the same batch.
    queueMicrotask(() => {
      if (disposed || !containerRef) return
      if (anchor) {
        const node = Array.from(containerRef.querySelectorAll<HTMLElement>("[data-im-message]")).find(
          (element) => element.dataset.imMessage === anchor?.id,
        )
        if (node)
          containerRef.scrollTop +=
            node.getBoundingClientRect().top - containerRef.getBoundingClientRect().top - anchor.offset
        if (!loadingOlder) anchor = undefined
        return
      }
      if (following && ids.length > 0) containerRef.scrollTop = containerRef.scrollHeight
    })
  })

  return (
    <div
      ref={containerRef}
      role="log"
      aria-label={language.t("im.message.history")}
      aria-live="off"
      class="relative flex-1 min-h-0 overflow-y-auto p-3 space-y-4"
      onScroll={() => {
        if (!containerRef) return
        following = containerRef.scrollHeight - containerRef.scrollTop - containerRef.clientHeight < 64
        if (following) setState("unseen", 0)
      }}
    >
      <Show when={props.onLoadOlder}>
        <div class="flex justify-center">
          <Button
            size="small"
            variant="ghost"
            disabled={props.loadingOlder}
            onClick={() => {
              if (!containerRef) return
              following = false
              const top = containerRef.getBoundingClientRect().top
              const visible = Array.from(containerRef.querySelectorAll<HTMLElement>("[data-im-message]")).find(
                (element) => element.getBoundingClientRect().bottom > top,
              )
              anchor = visible
                ? { id: visible.dataset.imMessage!, offset: visible.getBoundingClientRect().top - top }
                : undefined
              props.onLoadOlder?.()
            }}
          >
            {props.loadingOlder ? language.t("im.loading") : language.t("im.message.older")}
          </Button>
        </div>
      </Show>
      <Show
        when={props.messages.length > 0}
        fallback={
          <div class="flex items-center justify-center h-full text-12-regular text-text-weak text-center px-4">
            {language.t("im.message.empty")}
          </div>
        }
      >
        <For each={props.messages}>
          {(message) => (
            <div data-im-message={message.id}>
              <MessageItem
                mediaEnabled={props.mediaEnabled}
                message={message}
                agentStatus={props.agentStatuses.get(message.id)}
                agentProgress={props.agentProgress.get(message.id)}
                onOpenThread={props.onOpenThread}
                onOpenConversationSession={props.onOpenConversationSession}
                onUseDac={props.onUseDac}
                selfMemberIDs={props.selfMemberIDs}
                senderNames={props.senderNames}
              />
            </div>
          )}
        </For>
      </Show>
      <Show when={state.unseen > 0}>
        <div class="sticky bottom-0 flex justify-center">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              following = true
              setState("unseen", 0)
              containerRef?.scrollTo({ top: containerRef.scrollHeight, behavior: "smooth" })
            }}
          >
            {language.t("im.message.new", { count: state.unseen })}
          </Button>
        </div>
      </Show>
    </div>
  )
}
