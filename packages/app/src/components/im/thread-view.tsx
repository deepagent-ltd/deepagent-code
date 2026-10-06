import { createEffect, For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { MessageItem } from "./message-item"
import { MessageComposer } from "./message-composer"
import { createComposerDrafts } from "./composer-draft"
import { useIMClient } from "@/utils/im-client"
import type { LocalMessage } from "@/hooks/use-im-websocket"
import type { AgentDescriptor } from "./types"

type ThreadViewProps = {
  groupID: string
  root: LocalMessage
  agents: AgentDescriptor[]
  selfMemberIDs?: readonly string[]
  senderNames?: ReadonlyMap<string, string>
  drafts?: ReturnType<typeof createComposerDrafts>
  onClose: () => void
}

export function ThreadView(props: ThreadViewProps) {
  const drafts = props.drafts ?? createComposerDrafts()
  return (
    <Show when={props.root} keyed>
      {(root) => <ThreadConversation {...props} root={root} drafts={drafts} />}
    </Show>
  )
}

function ThreadConversation(props: ThreadViewProps & { drafts: ReturnType<typeof createComposerDrafts> }) {
  const language = useLanguage()
  const client = useIMClient()
  const groupID = props.groupID
  const rootID = props.root.id
  const [state, setState] = createStore({
    replies: [] as LocalMessage[],
    cursor: null as string | null,
    hasMore: false,
    loading: false,
    failedLoad: null as "initial" | "more" | null,
  })
  const lifecycle = { disposed: false, active: false }
  onCleanup(() => {
    lifecycle.disposed = true
  })

  const load = async (append: boolean) => {
    if (lifecycle.active || lifecycle.disposed) return
    lifecycle.active = true
    setState({ loading: true, failedLoad: null })
    try {
      const page = await client.listThread(groupID, rootID, 50, append ? (state.cursor ?? undefined) : undefined)
      if (lifecycle.disposed) return
      // Keep HTTP send receipts received while this snapshot was in flight.
      setState("replies", (previous) =>
        Array.from(new Map([...page.messages, ...previous].map((reply) => [reply.id, reply])).values()).sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        ),
      )
      setState({ cursor: page.nextCursor, hasMore: page.hasMore })
    } catch {
      if (!lifecycle.disposed) setState("failedLoad", append ? "more" : "initial")
    } finally {
      lifecycle.active = false
      if (!lifecycle.disposed) setState("loading", false)
    }
  }
  createEffect(() => {
    void load(false)
  })

  const sendReply = async (content: string, clientRequestID: string) => {
    const created = await client.createMessage(groupID, { content, type: "text", replyToID: rootID, clientRequestID })
    if (lifecycle.disposed) return
    setState("replies", (previous) =>
      [...previous.filter((reply) => reply.id !== created.id), created].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      ),
    )
  }

  return (
    <section
      class="absolute inset-0 z-20 min-w-0 flex flex-col bg-background-base"
      aria-label={language.t("im.thread.title")}
    >
      <div class="sticky top-0 z-10 h-10 shrink-0 flex items-center justify-between px-2 bg-background-base border-b border-border-weaker-base">
        <span class="text-13-medium text-text-strong pl-1">{language.t("im.thread.title")}</span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label={language.t("im.thread.close")}
        />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        <div class="rounded-lg border border-border-weak-base bg-surface-base p-2">
          <MessageItem message={props.root} selfMemberIDs={props.selfMemberIDs} senderNames={props.senderNames} />
        </div>
        <div class="text-11-regular text-text-weak">
          {language.t("im.thread.count", { count: state.replies.length })}
        </div>
        <Show when={state.failedLoad}>
          <div role="alert" class="flex flex-wrap items-center gap-2 text-12-regular text-text-critical">
            <span>{language.t("im.thread.load.failed")}</span>
            <Button variant="secondary" size="small" onClick={() => void load(state.failedLoad === "more")}>
              {language.t("im.facade.retry")}
            </Button>
          </div>
        </Show>
        <Show
          when={!state.loading || state.replies.length > 0}
          fallback={<div class="text-12-regular text-text-weak">{language.t("im.loading")}</div>}
        >
          <For each={state.replies}>
            {(reply) => (
              <MessageItem message={reply} selfMemberIDs={props.selfMemberIDs} senderNames={props.senderNames} />
            )}
          </For>
          <Show when={state.hasMore && !state.failedLoad}>
            <div class="flex justify-center">
              <Button variant="ghost" size="small" onClick={() => void load(true)} disabled={state.loading}>
                {state.loading ? language.t("im.loading") : language.t("im.thread.more")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>

      <MessageComposer
        draft={props.drafts(groupID, rootID)}
        onSend={sendReply}
        agents={props.agents}
        placeholder={language.t("im.thread.placeholder")}
      />
    </section>
  )
}
