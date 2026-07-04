import { Show } from "solid-js"
import { AgentStatusChip } from "./agent-status-chip"
import { MessageMetadataCard } from "./message-metadata-card"
import type { LocalMessage } from "@/hooks/use-im-websocket"

interface MessageItemProps {
  message: LocalMessage
  agentStatus?: { agentID: string; status: string }
}

export function MessageItem(props: MessageItemProps) {
  const isUser = () => props.message.senderType === "user"
  const isAgent = () => props.message.senderType === "agent"
  const isSystem = () => props.message.senderType === "system"

  const senderLabel = () => isUser() ? "You" : isAgent() ? "Agent" : "System"

  return (
    <div class={`flex ${isUser() ? "justify-end" : "justify-start"}`}>
      <div class={`max-w-[70%] ${isUser() ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div class="text-xs text-muted-foreground px-2">
          {senderLabel()}
        </div>

        <div
          class={`rounded-lg px-4 py-2 ${
            isUser()
              ? "bg-primary text-primary-foreground"
              : isAgent()
                ? "bg-muted border border-border"
                : "bg-yellow-100 dark:bg-yellow-900 border border-yellow-300 dark:border-yellow-700"
          }`}
        >
          <div class="whitespace-pre-wrap break-words">{props.message.content}</div>

          <Show when={props.message.metadata}>
            <div class="mt-2">
              <MessageMetadataCard metadata={props.message.metadata!} />
            </div>
          </Show>
        </div>

        <Show when={props.agentStatus}>
          <div class="px-2">
            <AgentStatusChip agentID={props.agentStatus!.agentID} status={props.agentStatus!.status} />
          </div>
        </Show>

      </div>
    </div>
  )
}
