import { For, Show, createEffect } from "solid-js"
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
  selfMemberIDs?: readonly string[]
  onLoadOlder?: () => void
  loadingOlder?: boolean
}

export function MessageList(props: MessageListProps) {
  const language = useLanguage()
  const [state, setState] = createStore({ unseen: 0 })
  let containerRef: HTMLDivElement | undefined
  let bottomRef: HTMLDivElement | undefined
  let following = true
  let previousCount = 0
  let previousLastID = ""

  // Auto-scroll to bottom on new messages AND as live reasoning streams in, so
  // the agent's in-progress thinking stays in view without manual scrolling.
  createEffect(() => {
    // Track both signals so streaming progress updates also trigger a scroll.
    const count = props.messages.length
    props.agentProgress
    const lastID = props.messages.at(-1)?.id ?? ""
    if (!following && lastID !== previousLastID && count > previousCount)
      setState("unseen", (value) => value + count - previousCount)
    previousCount = count
    previousLastID = lastID
    if (following && count > 0 && bottomRef) {
      bottomRef.scrollIntoView({ behavior: "smooth" })
    }
  })

  return (
    <div
      ref={containerRef}
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
              following = false
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
            <MessageItem
              message={message}
              agentStatus={props.agentStatuses.get(message.id)}
              agentProgress={props.agentProgress.get(message.id)}
              onOpenThread={props.onOpenThread}
              selfMemberIDs={props.selfMemberIDs}
            />
          )}
        </For>
        <div ref={bottomRef} />
      </Show>
      <Show when={state.unseen > 0}>
        <div class="sticky bottom-0 flex justify-center">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              following = true
              setState("unseen", 0)
              bottomRef?.scrollIntoView({ behavior: "smooth" })
            }}
          >
            {language.t("im.message.new", { count: state.unseen })}
          </Button>
        </div>
      </Show>
    </div>
  )
}
