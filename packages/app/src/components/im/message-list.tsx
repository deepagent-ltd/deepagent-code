import { For, Show, createEffect } from "solid-js"
import { MessageItem } from "./message-item"
import type { AgentProgressPart, LocalMessage } from "@/hooks/use-im-websocket"

interface MessageListProps {
  messages: LocalMessage[]
  agentStatuses: Map<string, { agentID: string; status: string }>
  agentProgress: Map<string, AgentProgressPart[]>
}

export function MessageList(props: MessageListProps) {
  let containerRef: HTMLDivElement | undefined
  let bottomRef: HTMLDivElement | undefined

  // Auto-scroll to bottom on new messages AND as live reasoning streams in, so
  // the agent's in-progress thinking stays in view without manual scrolling.
  createEffect(() => {
    // Track both signals so streaming progress updates also trigger a scroll.
    const count = props.messages.length
    props.agentProgress
    if (count > 0 && bottomRef) {
      bottomRef.scrollIntoView({ behavior: "smooth" })
    }
  })

  return (
    <div ref={containerRef} class="flex-1 overflow-y-auto p-4 space-y-4">
      <Show
        when={props.messages.length > 0}
        fallback={
          <div class="flex items-center justify-center h-full text-muted-foreground">
            No messages yet. Send a message to start the conversation.
          </div>
        }
      >
        <For each={props.messages}>
          {(message, index) => (
            <MessageItem
              message={message}
              agentStatus={props.agentStatuses.get(message.id)}
              agentProgress={props.agentProgress.get(message.id)}
            />
          )}
        </For>
        <div ref={bottomRef} />
      </Show>
    </div>
  )
}
