import { createSignal, createEffect, For, Show, type Component } from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Button } from "@deepagent-code/ui/button"
import { MessageItem } from "./message-item"
import { MessageComposer } from "./message-composer"
import { useIMClient } from "@/utils/im-client"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import type { AgentDescriptor } from "./types"

// V4.0 §B3 — a message's reply thread. Overlays the group chat: shows the root message + its replies
// (listThread, keyset paginated via nextCursor), and posts new replies with `replyToID = root.id`.
// The thread endpoint is `GET /groups/:groupId/messages/:messageId/thread`.
export const ThreadView: Component<{
  groupID: string
  root: LocalMessage
  agents: AgentDescriptor[]
  onClose: () => void
}> = (props) => {
  const client = useIMClient()
  const [replies, setReplies] = createSignal<LocalMessage[]>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  const [loading, setLoading] = createSignal(true)

  const load = (append: boolean) => {
    setLoading(true)
    client
      .listThread(props.groupID, props.root.id, 50, append ? cursor() ?? undefined : undefined)
      .then((page) => {
        const incoming = page.messages ?? []
        setReplies((prev) => (append ? [...prev, ...incoming] : incoming))
        setCursor(page.nextCursor)
        setHasMore(page.hasMore)
        setLoading(false)
      })
      .catch((error) => {
        console.error("Failed to load thread:", error)
        setLoading(false)
      })
  }

  // Reload whenever the root message changes.
  createEffect(() => {
    props.root.id
    setReplies([])
    setCursor(null)
    load(false)
  })

  const sendReply = async (content: string) => {
    try {
      const created = await client.createMessage(props.groupID, {
        content,
        type: "text",
        replyToID: props.root.id,
      })
      setReplies((prev) => [...prev, created as LocalMessage])
    } catch (error) {
      console.error("Failed to send reply:", error)
      const { showToast } = await import("@/utils/toast")
      showToast({
        variant: "error",
        title: "Failed to send reply",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div class="absolute inset-0 z-20 flex flex-col bg-background-base">
      <div class="sticky top-0 z-10 h-10 shrink-0 flex items-center justify-between px-2 bg-background-base border-b border-border-weaker-base">
        <span class="text-13-medium text-text-strong pl-1">Thread</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label="Close thread"
        />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* root message */}
        <div class="rounded-lg border border-border-weak-base bg-surface-base p-2">
          <MessageItem message={props.root} />
        </div>
        <div class="text-11-regular text-text-weak">
          {replies().length} {replies().length === 1 ? "reply" : "replies"}
        </div>

        <Show
          when={!loading() || replies().length > 0}
          fallback={<div class="text-12-regular text-text-weak">Loading thread…</div>}
        >
          <For each={replies()}>{(reply) => <MessageItem message={reply} />}</For>
          <Show when={hasMore()}>
            <div class="flex justify-center">
              <Button variant="ghost" size="small" onClick={() => load(true)} disabled={loading()}>
                {loading() ? "Loading…" : "Load more"}
              </Button>
            </div>
          </Show>
        </Show>
      </div>

      <MessageComposer
        onSend={sendReply}
        agents={props.agents}
        placeholder="Reply in thread…"
      />
    </div>
  )
}
