import { createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useSDK } from "../context/sdk"
import { useTuiI18n } from "../context/i18n"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { createIMClient, openIMGroupSocket, type IMGroup, type IMMessage } from "./im-client"

// W4-3 — the TUI IM face: group list → chat view. History loads over HTTP (the server page is
// newest-first; reversed here to ascending), live messages arrive over the group WebSocket with
// backoff reconnect and a 30s ping heartbeat, and sends POST through the same client. The "@"
// prefix convention for direct groups (GUI parity): a new group named "@agent-x" creates a
// direct chat with that agent.
export function DialogIM() {
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const client = createIMClient(sdk)

  const [groups, setGroups] = createSignal<IMGroup[] | undefined>(undefined)

  const reload = () =>
    client
      .listGroups()
      .then((result) => {
        if (result.error) throw result.error
        setGroups(result.data ?? [])
      })
      .catch((error: unknown) => {
        toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
        dialog.clear()
      })

  onMount(() => {
    dialog.setSize("large")
    void reload()
  })

  const createGroup = async () => {
    const name = await DialogPrompt.show(dialog, i18n.t("tui.im.newGroupTitle"), {
      placeholder: i18n.t("tui.im.newGroupPlaceholder"),
    })
    if (!name || !name.trim()) return
    const isDirect = name.startsWith("@")
    try {
      const result = await client.createGroup(
        isDirect
          ? { name: name.trim().slice(1), type: "direct", member: { memberID: name.trim().slice(1), memberType: "agent" } }
          : { name: name.trim(), type: "project" },
      )
      if (result.error) throw result.error
      await reload()
      toast.show({ variant: "success", message: i18n.t("tui.im.groupCreated"), duration: 3000 })
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    }
  }

  const options = () =>
    (groups() ?? []).map((group) => ({
      title: `${group.type === "direct" ? "@ " : "# "}${group.name}`,
      value: group.id,
      category: "IM",
      footer: Locale.time(group.updatedAt),
    }))

  const byId = () => new Map((groups() ?? []).map((group) => [group.id, group]))

  return (
    <DialogSelect
      title={i18n.t("tui.im.title")}
      options={options()}
      current={undefined}
      onSelect={(option) => {
        const group = byId().get(String(option.value))
        if (group) openChat(group)
      }}
      actions={[
        {
          command: "im.group.new",
          title: i18n.t("tui.im.newGroup"),
          onTrigger: () => {
            void createGroup()
          },
        },
      ]}
    />
  )
}

function openChat(group: IMGroup) {
  // Chat view replaces the dialog with a rolling message list + a send prompt. Enter opens the
  // send input; every render pass re-reads the live signal so WS arrivals repaint.
  const dialog = useDialog()
  const sdk = useSDK()
  const i18n = useTuiI18n()
  const toast = useToast()
  const client = createIMClient(sdk)
  const [messages, setMessages] = createSignal<IMMessage[]>([])
  const [render, setRender] = createSignal(0)

  const socket = openIMGroupSocket(sdk, group.id, {
    onMessage: (message) => {
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]))
      setRender((n) => n + 1)
    },
    onFailed: (payload) => {
      toast.show({ variant: "error", message: `${payload.code}: ${payload.message}`, duration: 5000 })
    },
  })

  onCleanup(() => socket.close())

  void client
    .listMessages(group.id, 50)
    .then((result) => {
      if (result.error) throw result.error
      // Server page is newest-first; chronological for the terminal.
      setMessages((result.data?.messages ?? []).slice().reverse())
      setRender((n) => n + 1)
      void client.markRead(group.id).catch(() => undefined)
    })
    .catch((error: unknown) => {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    })

  const back = () => {
    dialog.replace(() => <DialogIM />)
  }

  const send = async () => {
    const content = await DialogPrompt.show(dialog, `${group.name}`, {
      placeholder: i18n.t("tui.im.messagePlaceholder"),
    })
    if (!content || !content.trim()) return
    try {
      const result = await client.createMessage(group.id, { content: content.trim() })
      if (result.error) throw result.error
      const message = result.data
      if (message) {
        setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, message]))
        setRender((n) => n + 1)
        void client.markRead(group.id).catch(() => undefined)
      }
    } catch (error) {
      toast.show({ variant: "error", message: errorMessage(error), duration: 5000 })
    }
    repaint()
  }

  const chatOptions = () => {
    void render()
    return messages()
      .slice(-40)
      .map((message) => ({
        title: `${senderLabel(message)} ${message.content}`.slice(0, 200),
        value: message.id,
        category: Locale.time(message.createdAt),
        footer: message.metadata ? message.metadata.type : "",
      }))
  }

  const senderLabel = (message: IMMessage) =>
    message.senderType === "user" ? i18n.t("tui.im.you") : `${message.senderID.slice(0, 12)}`

  const repaint = () => {
    dialog.replace(() => <ChatView />)
  }

  const ChatView = () => (
    <DialogSelect
      title={`${group.type === "direct" ? "@ " : "# "}${group.name}`}
      options={chatOptions()}
      current={undefined}
      onSelect={() => {}}
      actions={[
        {
          command: "im.chat.back",
          title: i18n.t("tui.reviews.back"),
          onTrigger: () => back(),
        },
        {
          command: "im.chat.send",
          title: i18n.t("tui.im.send"),
          onTrigger: () => {
            void send()
          },
        },
      ]}
    />
  )

  repaint()
}
