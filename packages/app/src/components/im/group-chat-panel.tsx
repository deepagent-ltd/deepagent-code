import { createSignal, createEffect, onMount, Show, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { MessageList } from "./message-list"
import { MessageComposer } from "./message-composer"
import { ThreadView } from "./thread-view"
import { useIMWebSocket } from "@/hooks/use-im-websocket"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import { useIMClient } from "@/utils/im-client"
import type { AgentDescriptor } from "./types"

interface GroupChatPanelProps {
  groupID: string
  name?: string
  selfMemberIDs?: readonly string[]
  // §B3 thread — when true, clicking a message opens its reply thread. Gated by the caller on the
  // server's v4ThreadEnabled capability so the affordance only appears where the route is live.
  threadsEnabled?: boolean
  // §B3 file upload — when true, the composer shows the Attach button. Gated on the server's
  // v4FileUploadEnabled capability so we don't render an affordance the route fails-closed on
  // (a click would otherwise 404 FILE_UPLOAD_DISABLED and toast an error).
  fileUploadEnabled?: boolean
}

export function GroupChatPanel(props: GroupChatPanelProps) {
  const language = useLanguage()
  const client = useIMClient()
  const [state, setState] = createStore({
    failed: false,
    cursor: null as string | null,
    hasMore: false,
    loadingOlder: false,
  })
  const [historicalMessages, setHistoricalMessages] = createSignal<LocalMessage[]>([])
  const [agents, setAgents] = createSignal<AgentDescriptor[]>([])
  const [loading, setLoading] = createSignal(true)
  const [threadRoot, setThreadRoot] = createSignal<LocalMessage | null>(null)
  const history = { generation: 0, active: false, pending: false, anchor: "", disposed: false }

  const {
    connected,
    messages: realtimeMessages,
    agentStatuses,
    agentProgress,
    typingMembers,
    send,
    reconnect,
  } = useIMWebSocket(client, () => props.groupID)

  // The single desktop user identity, as the server assigns it. Used to exclude
  // our own echoed typing/read events from the UI.
  const selfMemberID = () => props.selfMemberIDs?.[0] ?? "server"

  const othersTyping = () =>
    Array.from(typingMembers()).filter((id) => !(props.selfMemberIDs ?? ["server"]).includes(id))

  // Load historical messages
  const load = (background = false) => {
    if (history.disposed) return
    if (history.active) {
      history.pending = true
      return
    }
    history.active = true
    const groupID = props.groupID
    const generation = history.generation
    const current = () => !history.disposed && history.generation === generation
    const anchor = history.anchor
    if (!background) setLoading(true)
    return client
      .listMessages(groupID, 50)
      .then(async (data) => {
        if (!current()) return
        const historical = [...data.messages]
        // A reconnect can span more than the newest page. Walk back to a known message
        // before merging, so realtime gaps do not become holes in the visible conversation.
        let page = data
        for (
          let count = 0;
          background && anchor && page.hasMore && !page.messages.some((message) => message.id === anchor);
          count++
        ) {
          if (count >= 100 || !page.nextCursor) throw new Error("IM history catch-up exceeded its page budget")
          const cursor = page.nextCursor
          page = await client.listMessages(groupID, 50, cursor)
          if (!current()) return
          if (page.hasMore && page.nextCursor === cursor) throw new Error("IM history cursor did not advance")
          historical.push(...page.messages)
        }
        setHistoricalMessages((previous) =>
          Array.from(new Map([...previous, ...historical].map((message) => [message.id, message])).values()),
        )
        setState("failed", false)
        if (!background || !anchor) setState({ cursor: data.nextCursor, hasMore: data.hasMore })
        history.anchor = data.messages.at(-1)?.id ?? anchor
        setLoading(false)
      })
      .catch(() => {
        if (!current()) return
        setState("failed", true)
        setLoading(false)
      })
      .finally(() => {
        if (!current()) return
        history.active = false
        if (!history.pending) return
        history.pending = false
        void load(true)
      })
  }
  const loadOlder = async () => {
    if (state.loadingOlder || !state.cursor) return
    const groupID = props.groupID
    const generation = history.generation
    setState("loadingOlder", true)
    try {
      const page = await client.listMessages(groupID, 50, state.cursor)
      if (history.disposed || history.generation !== generation) return
      setHistoricalMessages((previous) =>
        Array.from(new Map([...page.messages, ...previous].map((message) => [message.id, message])).values()),
      )
      setState({ cursor: page.nextCursor, hasMore: page.hasMore, failed: false })
    } catch {
      if (!history.disposed && history.generation === generation) setState("failed", true)
    } finally {
      if (!history.disposed && history.generation === generation) setState("loadingOlder", false)
    }
  }
  createEffect(() => {
    props.groupID
    history.generation++
    history.active = false
    history.pending = false
    history.anchor = ""
    setHistoricalMessages([])
    setThreadRoot(null)
    setState({ cursor: null, hasMore: false, loadingOlder: false, failed: false })
    void untrack(() => load())
  })
  createEffect(() => {
    if (connected()) void untrack(() => load(true))
  })
  const refresh = setInterval(() => {
    if (document.visibilityState !== "hidden") void load(true)
  }, 15_000)
  onCleanup(() => {
    history.disposed = true
    clearInterval(refresh)
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
    send({ type: "read_receipt", data: { groupID: props.groupID, memberID: selfMemberID(), readAt } })
  })

  const handleTyping = (typing: boolean) => {
    send({ type: "typing", data: { groupID: props.groupID, memberID: selfMemberID(), typing } })
  }

  const handleSendMessage = async (content: string, clientRequestID: string) => {
    const groupID = props.groupID
    const created = await client.createMessage(groupID, { content, type: "text", clientRequestID })
    if (props.groupID !== groupID) return
    // The HTTP receipt is authoritative even when the broadcast is delayed or dropped.
    setHistoricalMessages((previous) => [...previous.filter((message) => message.id !== created.id), created])
  }

  // §B3 file attachment — upload the file scoped to this group, then post a `file` message so it
  // surfaces in the timeline (the metadata carries the uploaded path).
  const handleAttach = async (file: File) => {
    try {
      const attachment = await client.uploadAttachment(file, { groupId: props.groupID })
      await client.createMessage(props.groupID, {
        content: attachment.filename,
        type: "file",
      })
    } catch (error) {
      console.error("Failed to upload attachment:", error)
      const { showToast } = await import("@/utils/toast")
      showToast({
        variant: "error",
        title: "Failed to upload attachment",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex-1 flex items-center justify-center">
          <div class="text-12-regular text-text-weak">{language.t("im.loading")}</div>
        </div>
      }
    >
      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div class="shrink-0 border-b border-border-weaker-base px-3 py-2">
          <h2 class="text-13-medium text-text-strong truncate" title={props.name}>
            {props.name ?? language.t("session.tab.im")}
          </h2>
          <div class="text-11-regular text-text-weak" role="status">
            {connected() ? language.t("im.connection.live") : language.t("im.connection.reconnecting")}
          </div>
          <Show when={!connected()}>
            <Button size="small" variant="ghost" onClick={() => reconnect()}>
              {language.t("im.connection.retry")}
            </Button>
          </Show>
        </div>
        <Show when={state.failed}>
          <div class="px-3 py-2 flex items-center gap-2" role="alert">
            <span class="text-12-regular text-text-critical">{language.t("im.message.load.failed")}</span>
            <Button variant="secondary" size="small" onClick={() => void load(true)}>
              {language.t("im.facade.retry")}
            </Button>
          </div>
        </Show>

        <MessageList
          messages={allMessages()}
          agentStatuses={agentStatuses()}
          agentProgress={agentProgress()}
          onOpenThread={props.threadsEnabled ? (m) => setThreadRoot(m) : undefined}
          selfMemberIDs={props.selfMemberIDs}
          onLoadOlder={state.hasMore ? loadOlder : undefined}
          loadingOlder={state.loadingOlder}
        />

        <Show when={othersTyping().length > 0}>
          <div class="px-3 py-1 text-11-regular text-text-weak">{language.t("im.message.typing")}</div>
        </Show>

        <MessageComposer
          onSend={handleSendMessage}
          onTyping={handleTyping}
          agents={agents()}
          onAttach={props.fileUploadEnabled ? handleAttach : undefined}
        />
      </div>

      {/* §B3 thread — an overlay panel for the selected message's reply chain. */}
      <Show when={threadRoot()}>
        {(root) => (
          <ThreadView
            groupID={props.groupID}
            root={root()}
            agents={agents()}
            selfMemberIDs={props.selfMemberIDs}
            onClose={() => setThreadRoot(null)}
          />
        )}
      </Show>
    </Show>
  )
}
