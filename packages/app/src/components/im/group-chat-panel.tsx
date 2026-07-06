import { createSignal, createEffect, onMount, Show } from "solid-js"
import { MessageList } from "./message-list"
import { MessageComposer } from "./message-composer"
import { useIMWebSocket } from "@/hooks/use-im-websocket"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { useIMClient } from "@/utils/im-client"
import type { AgentDescriptor } from "./types"

interface GroupChatPanelProps {
  groupID: string
}

export function GroupChatPanel(props: GroupChatPanelProps) {
  const client = useIMClient()
  const [historicalMessages, setHistoricalMessages] = createSignal<LocalMessage[]>([])
  const [agents, setAgents] = createSignal<AgentDescriptor[]>([])
  const [loading, setLoading] = createSignal(true)

  const { connected, messages: realtimeMessages, agentStatuses, agentProgress, typingMembers, send } =
    useIMWebSocket(client, () => props.groupID)

  // The single desktop user identity, as the server assigns it. Used to exclude
  // our own echoed typing/read events from the UI.
  const SELF_MEMBER_ID = "server"

  const othersTyping = () => Array.from(typingMembers()).filter((id) => id !== SELF_MEMBER_ID)

  // Load historical messages
  createEffect(() => {
    const groupID = props.groupID
    setLoading(true)
    client
      .listMessages(groupID, 50)
      .then((data) => {
        // Server returns messages newest-first (desc). Reverse to ascending so
        // they render oldest→newest in the list.
        const historical: LocalMessage[] = (data.messages || []).slice().reverse()
        setHistoricalMessages(historical)
        setLoading(false)
      })
      .catch((error) => {
        console.error("Failed to load messages:", error)
        setLoading(false)
      })
  })

  // Load available agents
  onMount(() => {
    client
      .listAgents()
      .then((data) => {
        setAgents(data || [])
      })
      .catch((error) => {
        console.error("Failed to load agents:", error)
      })
  })

  // Merge historical and realtime messages, de-duplicating by id (a message the
  // user sent appears both in the historical fetch and the realtime broadcast)
  // and sorting ascending by creation time.
  const allMessages = () => {
    const byId = new Map<string, LocalMessage>()
    for (const m of historicalMessages()) byId.set(m.id, m)
    for (const m of realtimeMessages()) byId.set(m.id, m)
    return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  // Mark the group read whenever new messages land (and on first load). Sends
  // both the HTTP mark-read (persisted last_read_at) and a realtime receipt.
  createEffect(() => {
    const msgs = allMessages()
    if (loading() || msgs.length === 0) return
    const readAt = Date.now()
    client.markRead(props.groupID, readAt).catch((error) => {
      console.error("Failed to mark read:", error)
    })
    send({ type: "read_receipt", data: { groupID: props.groupID, memberID: SELF_MEMBER_ID, readAt } })
  })

  const handleTyping = (typing: boolean) => {
    send({ type: "typing", data: { groupID: props.groupID, memberID: SELF_MEMBER_ID, typing } })
  }

  const handleSendMessage = async (content: string) => {
    // Send via HTTP API; the created message arrives back over the WebSocket.
    try {
      await client.createMessage(props.groupID, { content, type: "text" })
    } catch (error) {
      console.error("Failed to send message:", error)
      alert("Failed to send message")
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex-1 flex items-center justify-center">
          <div class="text-sm text-muted-foreground">Loading messages...</div>
        </div>
      }
    >
      <div class="flex-1 flex flex-col overflow-hidden">
        <div class="border-b border-border p-4 bg-muted/50">
          <h2 class="font-semibold">Group Chat</h2>
          <div class="text-xs text-muted-foreground">
            {connected() ? "Connected" : "Disconnected"}
          </div>
        </div>

        <MessageList messages={allMessages()} agentStatuses={agentStatuses()} agentProgress={agentProgress()} />

        <Show when={othersTyping().length > 0}>
          <div class="px-4 py-1 text-xs text-muted-foreground italic">
            {othersTyping().length === 1 ? "Someone is typing…" : "Several people are typing…"}
          </div>
        </Show>

        <MessageComposer onSend={handleSendMessage} onTyping={handleTyping} agents={agents()} />
      </div>
    </Show>
  )
}
