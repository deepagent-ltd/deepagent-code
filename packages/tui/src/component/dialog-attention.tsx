import type {
  AttentionCapability,
  AttentionItem,
  AttentionList,
  SessionMessage,
  SessionMessagesResponse,
  SessionV2Info,
} from "@deepagent-code/sdk"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "../keymap"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTuiI18n, type TuiI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

type Kind = AttentionItem["kind"] | undefined
type View = "all" | "unseen"
type Screen =
  | { type: "list" }
  | { type: "detail"; item: AttentionItem }
  | {
      type: "session"
      item: AttentionItem
      session: SessionV2Info
      messages: SessionMessagesResponse
      cursor?: string
    }
  | { type: "message"; message: SessionMessage; parent: Extract<Screen, { type: "session" }> }

class AttentionRequestError extends Error {
  constructor(readonly status: number) {
    super("Attention request failed")
  }
}

function resultData<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error || !result.data) throw new AttentionRequestError(result.response?.status ?? 0)
  return result.data
}

export function attentionCommand(dialog: DialogContext, i18n: TuiI18n) {
  return {
    name: "attention.list",
    title: i18n.t("tui.attention.title"),
    slashName: "attention",
    run: () => dialog.replace(() => <DialogAttention />),
    category: i18n.t("tui.category.system"),
  }
}

export function DialogAttention() {
  const sdk = useSDK()
  const dialog = useDialog()
  const i18n = useTuiI18n()
  const { theme } = useTheme()
  const [capability, setCapability] = createSignal<AttentionCapability>()
  const [list, setList] = createSignal<AttentionList>()
  const [kind, setKind] = createSignal<Kind>()
  const [view, setView] = createSignal<View>("unseen")
  const [cursors, setCursors] = createSignal<(string | undefined)[]>([undefined])
  const [page, setPage] = createSignal(0)
  const [screen, setScreen] = createSignal<Screen>({ type: "list" })
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal("")
  const [stale, setStale] = createSignal(false)
  let transcript: ScrollBoxRenderable | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  async function run(work: () => Promise<void>) {
    if (busy() || disposed) return
    setBusy(true)
    setFailure("")
    await work()
      .catch((error: unknown) => {
        if (disposed) return
        const conflict = error instanceof AttentionRequestError && error.status === 409
        if (conflict) setStale(true)
        setFailure(i18n.t(conflict ? "tui.attention.stale" : "tui.attention.error"))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
  }

  async function load(cursor?: string, index = 0, nextKind = kind(), nextView = view()) {
    const enabled = resultData(await sdk.client.v2.attention.capability())
    if (disposed) return
    setCapability(enabled)
    if (!enabled.enabled) {
      setList(undefined)
      setScreen({ type: "list" })
      return
    }
    const rows = resultData(await sdk.client.v2.attention.list({ kind: nextKind, view: nextView, cursor, limit: "20" }))
    if (disposed) return
    if (rows.nextCursor && [...cursors().slice(0, index), cursor].includes(rows.nextCursor))
      throw new AttentionRequestError(400)
    setKind(nextKind)
    setView(nextView)
    setPage(index)
    setCursors((previous) => [...previous.slice(0, index), cursor])
    setList(rows)
    setStale(false)
    setScreen({ type: "list" })
  }

  async function detail(itemID: string) {
    const item = resultData(await sdk.client.v2.attention.get({ itemID })).data
    if (disposed) return
    setStale(false)
    setScreen({ type: "detail", item })
  }

  async function seen(item: AttentionItem) {
    if (stale() || item.seen) return
    const updated = resultData(await sdk.client.v2.attention.seen({ itemID: item.id, revision: item.revision })).data
    if (disposed) return
    // Viewing is only acknowledgement. Recovery state remains server-owned.
    setScreen({ type: "detail", item: updated })
    setList(undefined)
  }

  async function session(item: AttentionItem, cursor?: string) {
    const target = resultData(await sdk.client.v2.session.get({ sessionID: item.session.id })).data
    if (disposed) return
    // Session placement, not the current TUI directory, is authoritative. Do not
    // enter the editable route until all project/config/prompt contexts can switch atomically.
    if (
      target.id !== item.session.id ||
      target.projectID !== item.session.projectID ||
      target.location.workspaceID ||
      target.location.directory !== item.session.directory
    )
      throw new AttentionRequestError(409)
    const messages = resultData(
      await sdk.forDirectory(target.location.directory).v2.session.messages({
        sessionID: target.id,
        limit: 20,
        order: "asc",
        cursor,
      }),
    )
    if (disposed) return
    if (messages.data.length && cursor && (messages.cursor.next === cursor || messages.cursor.previous === cursor))
      throw new AttentionRequestError(400)
    setScreen({ type: "session", item, session: target, messages, cursor })
  }

  const label = (item: AttentionItem) => i18n.t(`tui.attention.kind.${item.kind}`)
  const stateLabel = (item: AttentionItem) => i18n.t(`tui.attention.state.${item.state}`)
  const control = (title: string, action: () => void, disabled = false): DialogSelectOption<string> => ({
    title,
    value: `action:${title}`,
    onSelect: action,
    category: i18n.t("tui.attention.actions"),
    disabled,
  })
  const options = (current: Screen): DialogSelectOption<string>[] => {
    if (current.type === "message") return [control(i18n.t("tui.attention.back"), () => setScreen(current.parent))]
    if (current.type === "session")
      return [
        control(i18n.t("tui.attention.back"), () => setScreen({ type: "detail", item: current.item })),
        control(i18n.t("tui.attention.refresh"), () => void run(() => session(current.item, current.cursor))),
        control(
          i18n.t("tui.attention.previous"),
          () => void run(() => session(current.item, current.messages.cursor.previous)),
          !current.messages.cursor.previous,
        ),
        control(
          i18n.t("tui.attention.next"),
          () => void run(() => session(current.item, current.messages.cursor.next)),
          !current.messages.cursor.next,
        ),
        ...current.messages.data.map((message) => ({
          title: messageText(message).replace(/\s+/g, " ").slice(0, 100) || message.type,
          value: `message:${message.id}`,
          onSelect: () => setScreen({ type: "message", message, parent: current }),
          category: message.type,
          description: message.id,
        })),
      ]
    if (current.type === "detail")
      return [
        control(i18n.t("tui.attention.back"), () => void run(() => load())),
        control(i18n.t("tui.attention.refresh"), () => void run(() => detail(current.item.id))),
        control(
          i18n.t("tui.attention.markSeen"),
          () => void run(() => seen(current.item)),
          current.item.seen || stale(),
        ),
        control(i18n.t("tui.attention.session"), () => void run(() => session(current.item)), stale()),
      ]
    return [
      control(i18n.t("tui.attention.refresh"), () => void run(() => load())),
      control(
        i18n.t("tui.attention.filter", { value: i18n.t(`tui.attention.${view()}`) }),
        () => void run(() => load(undefined, 0, kind(), view() === "unseen" ? "all" : "unseen")),
        !capability()?.enabled,
      ),
      control(
        i18n.t("tui.attention.type", {
          value: kind() ? i18n.t(`tui.attention.kind.${kind()!}`) : i18n.t("tui.attention.allTypes"),
        }),
        () =>
          void run(() =>
            load(
              undefined,
              0,
              kind() === undefined
                ? "activity_failed"
                : kind() === "activity_failed"
                  ? "execution_recovery"
                  : undefined,
            ),
          ),
        !capability()?.enabled,
      ),
      control(
        i18n.t("tui.attention.previous"),
        () => void run(() => load(cursors()[page() - 1], page() - 1)),
        page() === 0,
      ),
      control(
        i18n.t("tui.attention.next"),
        () => void run(() => load(list()?.nextCursor, page() + 1)),
        !list()?.nextCursor,
      ),
      ...(list()?.data ?? []).map((item) => ({
        title: item.session.title,
        value: `item:${item.id}`,
        onSelect: () => void run(() => detail(item.id)),
        category: label(item),
        description: `${stateLabel(item)} · ${i18n.t(item.seen ? "tui.attention.seen" : "tui.attention.unseen")} · ${item.session.directory}`,
      })),
    ]
  }

  const description = (current: Screen) => {
    if (current.type === "message") return messageText(current.message)
    if (current.type === "session")
      return [
        current.session.title,
        current.session.location.directory,
        current.session.id,
        i18n.t("tui.attention.readonlySession"),
        current.messages.data.length ? "" : i18n.t("tui.attention.noMessages"),
      ]
        .filter(Boolean)
        .join("\n")
    if (current.type === "detail")
      return [
        current.item.session.title,
        `${label(current.item)} · ${stateLabel(current.item)} · ${i18n.t(current.item.seen ? "tui.attention.seen" : "tui.attention.unseen")}`,
        current.item.session.directory,
        `${current.item.session.id} · ${current.item.session.projectID}`,
        current.item.reasonCode,
        current.item.source.activityID ?? "",
        i18n.t("tui.attention.seenHint"),
      ]
        .filter(Boolean)
        .join("\n")
    if (capability() && !capability()!.enabled) return i18n.t(`tui.attention.disabled.${capability()!.reason}`)
    return [
      i18n.t("tui.attention.summary", { page: page() + 1, unseen: list()?.unseenCount ?? 0 }),
      i18n.t("tui.attention.seenHint"),
      list() && list()!.data.length === 0 ? i18n.t("tui.attention.empty") : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  useBindings(() => ({
    bindings:
      screen().type === "message"
        ? [
            {
              key: "ctrl+d",
              desc: i18n.t("tui.attention.scrollDown"),
              group: "Attention",
              cmd: () => transcript?.scrollBy(6),
            },
            {
              key: "ctrl+u",
              desc: i18n.t("tui.attention.scrollUp"),
              group: "Attention",
              cmd: () => transcript?.scrollBy(-6),
            },
          ]
        : [],
  }))
  onMount(() => {
    dialog.setSize("large")
    void run(() => load())
  })
  return (
    <box>
      <Show when={screen()} keyed>
        {(current) => (
          <box>
            <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
              <Show
                when={current.type === "message"}
                fallback={<text fg={theme.textMuted}>{description(current)}</text>}
              >
                <scrollbox
                  ref={(value) => {
                    transcript = value
                  }}
                  height={10}
                >
                  <text fg={theme.text}>{description(current)}</text>
                </scrollbox>
                <text fg={theme.textMuted}>{i18n.t("tui.attention.scrollHint")}</text>
              </Show>
              <Show when={busy()}>
                <text fg={theme.textMuted}>{i18n.t("tui.attention.loading")}</text>
              </Show>
              <Show when={failure()}>
                <text fg={theme.error}>{failure()}</text>
              </Show>
            </box>
            <DialogSelect
              title={i18n.t(
                current.type === "session" || current.type === "message"
                  ? "tui.attention.session"
                  : "tui.attention.title",
              )}
              locked={busy()}
              options={options(current)}
            />
          </box>
        )}
      </Show>
    </box>
  )
}

function messageText(message: SessionMessage) {
  if ("text" in message) return message.text
  if (message.type === "assistant")
    return message.content.map((part) => ("text" in part ? part.text : `[${part.name}]`)).join("\n")
  if (message.type === "shell") return `${message.command}\n${message.output}`
  if (message.type === "compaction") return message.summary
  if (message.type === "agent-switched") return message.agent
  return `${message.model.providerID}/${message.model.id}`
}
