import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { AgentStatusChip } from "./agent-status-chip"
import { AgentReasoningCard } from "./agent-reasoning-card"
import { MessageMetadataCard } from "./message-metadata-card"
import type { AgentProgressPart, LocalMessage } from "@/hooks/use-im-websocket"

interface MessageItemProps {
  message: LocalMessage
  agentStatus?: { agentID: string; status: string }
  /** Live reasoning/tool/text parts for the turn this message triggered. */
  agentProgress?: AgentProgressPart[]
  /** §B3 thread — open this message's reply chain. Hidden when undefined. */
  onOpenThread?: (message: LocalMessage) => void
  selfMemberIDs?: readonly string[]
  senderNames?: ReadonlyMap<string, string>
}

export function MessageItem(props: MessageItemProps) {
  const language = useLanguage()
  const isUser = () => props.message.senderType === "user"
  const isSelf = () => isUser() && (props.selfMemberIDs ?? ["server"]).includes(props.message.senderID)
  const isAgent = () => props.message.senderType === "agent"
  const senderLabel = () =>
    isSelf()
      ? language.t("im.sender.you")
      : isUser()
        ? (props.senderNames?.get(props.message.senderID) ?? props.message.senderID)
        : isAgent()
          ? props.message.senderID
          : language.t("im.sender.system")

  return (
    <article
      aria-label={language.t("im.message.from", { name: senderLabel() })}
      class={`flex ${isSelf() ? "justify-end" : "justify-start"}`}
    >
      <div class={`min-w-0 max-w-[90%] ${isSelf() ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div class="max-w-full flex gap-2 text-11-regular text-text-weak px-1">
          <span class="truncate" title={props.message.senderID}>
            {senderLabel()}
          </span>
          <time class="shrink-0" dateTime={new Date(props.message.createdAt).toISOString()}>
            {new Date(props.message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>

        <div
          class={`min-w-0 rounded-lg border px-3 py-2 text-13-regular text-text-base ${
            isSelf()
              ? "bg-surface-raised-base-active border-border-weak-base"
              : "bg-surface-panel border-border-weaker-base"
          }`}
        >
          <div class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{props.message.content}</div>

          <Show when={props.message.metadata}>
            <div class="mt-2">
              <MessageMetadataCard metadata={props.message.metadata!} />
            </div>
          </Show>
        </div>

        <Show when={props.agentProgress && props.agentProgress.length > 0}>
          <div class="w-full px-2">
            <AgentReasoningCard
              parts={props.agentProgress!}
              active={props.agentStatus?.status === "started" || props.agentStatus?.status === "running"}
            />
          </div>
        </Show>

        <Show when={props.agentStatus}>
          <div class="px-2">
            <AgentStatusChip agentID={props.agentStatus!.agentID} status={props.agentStatus!.status} />
          </div>
        </Show>

        <Show when={props.onOpenThread}>
          <button
            type="button"
            class="px-2 text-xs text-text-link hover:underline text-left"
            onClick={() => props.onOpenThread!(props.message)}
          >
            {language.t("im.thread.reply")}
          </button>
        </Show>
      </div>
    </article>
  )
}
