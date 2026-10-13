import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { AgentStatusChip } from "./agent-status-chip"
import { AgentReasoningCard } from "./agent-reasoning-card"
import { AttachmentCard } from "./attachment-card"
import { MediaBatch } from "@deepagent-code/core/im/media-batch"
import { MessageMetadataCard } from "./message-metadata-card"
import { IconButton } from "@deepagent-code/ui/icon-button"
import type { AgentProgressPart, LocalMessage } from "@/hooks/use-im-websocket"
import "./message-item.css"

interface MessageItemProps {
  message: LocalMessage
  agentStatus?: { agentID: string; status: string }
  /** Live reasoning/tool/text parts for the turn this message triggered. */
  agentProgress?: AgentProgressPart[]
  /** §B3 thread — open this message's reply chain. Hidden when undefined. */
  onOpenThread?: (message: LocalMessage) => void
  onOpenTaskResult?: (message: LocalMessage) => void
  onOpenConversationSession?: (message: LocalMessage) => void
  onUseDac?: (message: LocalMessage) => void
  mediaEnabled?: boolean
  protected?: boolean
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
      data-im-message-item
      aria-label={language.t("im.message.from", { name: senderLabel() })}
      class={`flex ${isSelf() ? "justify-end" : "justify-start"}`}
    >
      <div class={`min-w-0 max-w-[90%] ${isSelf() ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div class="max-w-full flex items-center gap-2 text-11-regular text-text-weak px-1">
          <span class="truncate" title={props.message.senderID}>
            {senderLabel()}
          </span>
          <time class="shrink-0" dateTime={new Date(props.message.createdAt).toISOString()}>
            {new Date(props.message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>

        <div
          class={`min-w-0 max-w-full rounded-lg border px-3 py-2 text-13-regular text-text-base ${
            isSelf()
              ? "bg-surface-raised-base-active border-border-weak-base"
              : "bg-surface-panel border-border-weaker-base"
          }`}
        >
          <div class="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{props.message.content}</div>

          <Show when={props.mediaEnabled && !props.message.remoteAttachments?.length}>
            <For each={MediaBatch.references(props.message.metadata)}>
              {(id) => (
                <AttachmentCard
                  attachmentID={id}
                  local={{ groupID: props.message.groupID, messageID: props.message.id }}
                />
              )}
            </For>
          </Show>
          <Show when={props.mediaEnabled}>
            <For each={props.message.remoteAttachments}>
              {(attachment) => (
                <AttachmentCard
                  attachmentID={attachment.attachmentID}
                  remote={{
                    groupID: props.message.groupID,
                    messageID: props.message.id,
                    attachmentID: attachment.attachmentID,
                  }}
                />
              )}
            </For>
          </Show>
          <Show
            when={
              props.message.metadata &&
              !Array.isArray(props.message.metadata) &&
              props.message.metadata.type !== "attachment_ref"
            }
          >
            <div class="mt-2">
              <MessageMetadataCard
                metadata={props.message.metadata!}
                onOpenTaskResult={props.onOpenTaskResult ? () => props.onOpenTaskResult!(props.message) : undefined}
                onOpenConversationSession={
                  props.onOpenConversationSession ? () => props.onOpenConversationSession!(props.message) : undefined
                }
              />
            </div>
          </Show>
        </div>

        <Show when={props.message.transport}>
          {(transport) => (
            <div
              class="max-w-full px-1 text-11-regular text-text-weak [overflow-wrap:anywhere]"
              data-im-transport={transport().state}
            >
              <div>{language.t(`im.transport.${transport().state}`)}</div>
              <Show when={transport().state === "acknowledged"}>
                <div>{language.t("im.transport.acknowledgedHint")}</div>
              </Show>
              <Show when={transport().state === "unknown"}>
                <div>
                  {language.t(
                    transport().reason === "legacy_missing_receipt"
                      ? "im.transport.reason.legacy"
                      : transport().reason === "delivery_identity_or_expiry_changed"
                        ? "im.transport.reason.identity"
                        : transport().reason === "receipt_mismatch"
                          ? "im.transport.reason.mismatch"
                          : "im.transport.reason.unknown",
                  )}
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={props.onUseDac && isUser()}>
          <IconButton
            icon="prompt"
            size="small"
            variant="ghost"
            class="im-task-proposal-action"
            aria-label={language.t("im.dac.action")}
            title={language.t("im.dac.action")}
            onClick={() => props.onUseDac?.(props.message)}
          />
        </Show>
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
        <Show
          when={
            props.protected &&
            props.message.type === "text" &&
            props.message.metadata?.type !== "agent_run" &&
            props.message.metadata?.type !== "task_status_notice" &&
            props.onOpenTaskResult
          }
        >
          <button
            type="button"
            class="px-2 text-xs text-text-link hover:underline text-left"
            onClick={() => props.onOpenTaskResult?.(props.message)}
          >
            {language.t("im.taskResult.view")}
          </button>
        </Show>
      </div>
    </article>
  )
}
