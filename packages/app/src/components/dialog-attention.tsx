import { batch, createEffect, createMemo, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { AttentionCapability, AttentionItem, AttentionList } from "@deepagent-code/sdk/client"
import { Button } from "@deepagent-code/ui/button"
import { Dialog } from "@deepagent-code/ui/dialog"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"

type Props = { onOpenSession: (session: AttentionItem["session"]) => void }

export function DialogAttention(props: Props) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("attention.title")} description={language.t("attention.description")} size="large">
      <AttentionInbox onOpenSession={props.onOpenSession} />
    </Dialog>
  )
}

// Export the rendered inbox for DOM verification with only the service boundary replaced.
export function AttentionInbox(props: Props) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const mountedServer = server.key
  const [state, setState] = createStore<{
    kind: AttentionItem["kind"] | "all"
    view: "all" | "unseen"
    capability?: AttentionCapability
    list?: AttentionList
    loading: boolean
    error: boolean
    notice?: "changed" | "actionError"
    selected?: AttentionItem
    detailLoading: boolean
    marking?: string
    switched: boolean
  }>({ kind: "all", view: "all", loading: false, error: false, detailLoading: false, switched: false })
  let epoch = 0
  let request = 0
  let detailRequest = 0
  let filterEpoch = 0
  let pages = 1
  let disposed = false

  const current = (generation: number) => !disposed && generation === epoch && server.key === mountedServer
  const date = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toLocaleString(language.intl())
      : language.t("attention.timeUnknown")

  async function refresh(append = false) {
    if (!state.capability?.enabled || state.switched) return
    const generation = epoch
    const run = ++request
    const filter = {
      kind: state.kind === "all" ? undefined : (state.kind as AttentionItem["kind"]),
      view: state.view,
      limit: "30",
    }
    const previous = state.list
    setState("loading", true)
    const result = await (async () => {
      // Refresh all loaded pages so a five-second poll does not collapse the user's list.
      const items: AttentionItem[] = append ? [...(previous?.data ?? [])] : []
      let cursor = append ? previous?.nextCursor : undefined
      let latest: AttentionList | undefined
      for (let page = 0; page < (append ? 1 : pages); page++) {
        const result = await sdk.client.v2.attention.list({ ...filter, cursor })
        if (!current(generation) || run !== request) return
        if (!result.data) throw new Error("attention_list_unavailable")
        latest = result.data
        items.push(...result.data.data)
        cursor = result.data.nextCursor
        if (!cursor) break
      }
      if (!latest) return
      return { ...latest, data: [...new Map(items.map((item) => [item.id, item])).values()] }
    })().catch(() => undefined)
    if (!current(generation) || run !== request) return
    batch(() => {
      setState("loading", false)
      setState("error", !result)
      if (!result) return
      setState("list", reconcile(result))
      setState("selected", (previous) => previous && result.data.find((item) => item.id === previous.id))
      if (append) pages++
    })
  }

  async function load() {
    const generation = epoch
    setState("loading", true)
    const result = await sdk.client.v2.attention.capability().catch(() => undefined)
    if (!current(generation)) return
    if (result?.response?.status === 404) {
      setState("capability", { enabled: false, scope: "implicit-local", actor: "server", reason: "unsupported_host" })
      setState("loading", false)
      setState("error", false)
      return
    }
    setState("capability", result?.data)
    setState("error", !result?.data)
    setState("loading", false)
    if (result?.data?.enabled) await refresh()
  }

  async function detail(item: AttentionItem, openSession = false) {
    const generation = epoch
    const run = ++detailRequest
    const revision = item.revision
    setState("detailLoading", true)
    setState("notice", undefined)
    const result = await sdk.client.v2.attention.get({ itemID: item.id }).catch(() => undefined)
    if (!current(generation) || run !== detailRequest) return
    setState("detailLoading", false)
    if (!result?.data) {
      setState("notice", result?.response?.status === 404 ? "changed" : "actionError")
      if (result?.response?.status === 404) {
        setState("selected", undefined)
        void refresh()
      }
      return
    }
    const visible = state.list?.data.find((entry) => entry.id === item.id)
    if (visible && visible.revision !== revision && visible.revision !== result.data.data.revision) {
      setState("selected", visible)
      setState("notice", "changed")
      return
    }
    if (openSession) {
      props.onOpenSession(result.data.data.session)
      return
    }
    setState("selected", result.data.data)
  }

  async function markSeen(item: AttentionItem) {
    if (state.marking) return
    const generation = epoch
    const filters = filterEpoch
    const revision = item.revision
    setState("marking", item.id)
    setState("notice", undefined)
    const result = await sdk.client.v2.attention
      .seen({ itemID: item.id, revision })
      .catch(() => undefined)
    if (!current(generation)) return
    setState("marking", undefined)
    if (result?.response?.status === 409 || result?.response?.status === 404) {
      if (filters === filterEpoch && state.selected?.id === item.id) await detail(item)
      if (!current(generation)) return
      if (filters === filterEpoch) setState("notice", "changed")
      await refresh()
      return
    }
    if (!result?.data) {
      if (filters === filterEpoch) setState("notice", "actionError")
      return
    }
    const visible = state.list?.data.find((entry) => entry.id === item.id)
    // A receipt acknowledges the requested revision, not a newer source or another filter's count.
    // Keep the currently rendered snapshot if the subsequent refetch is unavailable.
    if (
      filters !== filterEpoch ||
      !visible ||
      visible.revision !== revision ||
      result.data.data.revision !== revision
    ) {
      if (filters === filterEpoch && visible) setState("notice", "changed")
      await refresh()
      return
    }
    // Invalidate an earlier poll before installing the acknowledged receipt.
    request++
    setState("loading", false)
    setState(
      "list",
      (previous) =>
        previous && {
          ...previous,
          unseenCount:
            typeof previous.unseenCount === "number" && !visible.seen && result.data.data.seen
              ? Math.max(0, previous.unseenCount - 1)
              : previous.unseenCount,
          data: previous.data.flatMap((entry) =>
            entry.id !== item.id ? [entry] : state.view === "unseen" ? [] : [result.data.data],
          ),
        },
    )
    if (state.selected?.id === item.id) setState("selected", result.data.data)
    await refresh()
  }

  createEffect(() => {
    const changed = server.key !== mountedServer
    epoch++
    request++
    detailRequest++
    batch(() => {
      setState("switched", changed)
      setState("capability", undefined)
      setState("list", undefined)
      setState("selected", undefined)
      setState("marking", undefined)
      setState("notice", undefined)
      setState("error", false)
      setState("loading", false)
      setState("detailLoading", false)
    })
    if (!changed) untrack(() => void load())
  })

  createEffect(() => {
    state.kind
    state.view
    untrack(() => {
      filterEpoch++
      request++
      detailRequest++
      pages = 1
      setState("list", undefined)
      setState("selected", undefined)
      setState("notice", undefined)
      setState("detailLoading", false)
      if (state.capability?.enabled) void refresh()
    })
  })

  const poll = setInterval(() => {
    if (!state.loading && !state.marking) void refresh()
  }, 5000)
  onCleanup(() => {
    disposed = true
    epoch++
    clearInterval(poll)
  })

  return (
    <section
      aria-label={language.t("attention.title")}
      aria-busy={state.loading}
      class="w-full min-w-0 px-4 pb-4 flex flex-col gap-3 text-13-regular"
    >
      <Show when={state.switched}>
        <p role="status">{language.t("attention.serverChanged")}</p>
      </Show>
      <Show when={!state.switched}>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1 min-w-0">
            <span class="text-text-weak">{language.t("attention.filter.kind")}</span>
            <select
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5"
              value={state.kind}
              onChange={(event) => setState("kind", event.currentTarget.value as AttentionItem["kind"] | "all")}
            >
              <option value="all">{language.t("attention.kind.all")}</option>
              <option value="activity_failed">{language.t("attention.kind.activity_failed")}</option>
              <option value="execution_recovery">{language.t("attention.kind.execution_recovery")}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 min-w-0">
            <span class="text-text-weak">{language.t("attention.filter.view")}</span>
            <select
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5"
              value={state.view}
              onChange={(event) => setState("view", event.currentTarget.value as "all" | "unseen")}
            >
              <option value="all">{language.t("attention.view.all")}</option>
              <option value="unseen">{language.t("attention.view.unseen")}</option>
            </select>
          </label>
          <Button
            size="small"
            onClick={() => (state.capability ? void refresh() : void load())}
            disabled={state.loading || state.capability?.enabled === false}
          >
            {language.t("attention.refresh")}
          </Button>
        </div>
        <Show when={state.capability && !state.capability!.enabled}>
          <p role="status">
            {language.t(
              state.capability?.reason === "profile_disabled"
                ? "attention.disabled.profile"
                : "attention.disabled.host",
            )}
          </p>
        </Show>
        <Show when={state.loading && !state.list}>
          <p role="status">{language.t("attention.loading")}</p>
        </Show>
        <Show when={state.error}>
          <p role="alert" class="text-text-weak">
            {language.t(state.list ? "attention.stale" : "attention.loadError")}
          </p>
        </Show>
        <Show when={state.notice}>{(value) => <p role="alert">{language.t(`attention.${value()}`)}</p>}</Show>
        <Show when={state.list}>
          {(result) => (
            <>
              <p class="text-text-weak text-12-regular" role="status">
                {language.t("attention.summary", { count: result().unseenCount, time: date(result().asOf) })}
              </p>
              <Show when={result().data.length === 0}>
                <p class="py-6 text-center text-text-weak">{language.t("attention.empty")}</p>
              </Show>
              <ul class="flex flex-col gap-2 list-none m-0 p-0">
                <For each={result().data.map((item) => item.id)}>
                  {(id) => {
                    const initial = untrack(() => result().data.find((item) => item.id === id)!)
                    const item = createMemo(() => result().data.find((entry) => entry.id === id) ?? initial)
                    return (
                      <li class="rounded-lg border border-border-weak-base p-3 min-w-0" data-attention-id={item().id}>
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <div class="min-w-0 flex-1">
                            <p class="font-medium break-words">{item().session.title || item().session.id}</p>
                            <p class="text-text-weak text-12-regular break-all">{item().session.directory}</p>
                          </div>
                          <span class="text-12-regular text-text-weak">
                            {language.t(item().seen ? "attention.seen" : "attention.unseen")}
                          </span>
                        </div>
                        <p class="mt-2">{language.t(`attention.state.${item().state}`)}</p>
                        <p class="text-12-regular text-text-weak">{date(item().occurredAt)}</p>
                        <div class="flex flex-wrap gap-2 mt-2">
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.detailLoading}
                            onClick={() => void detail(item())}
                          >
                            {language.t("attention.details")}
                          </Button>
                          <Button size="small" disabled={state.detailLoading} onClick={() => void detail(item(), true)}>
                            {language.t("attention.openSession")}
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={item().seen || !!state.marking}
                            onClick={() => void markSeen(item())}
                          >
                            {language.t("attention.markSeen")}
                          </Button>
                        </div>
                        <Show when={state.selected?.id === item().id ? state.selected : undefined}>
                          {(detail) => (
                            <div
                              class="border-t border-border-weak-base mt-3 pt-3 break-words"
                              aria-label={language.t("attention.details")}
                            >
                              <p>{language.t(`attention.reason.${detail().reasonCode}`)}</p>
                              <p class="text-text-weak mt-1">{language.t("attention.seenHelp")}</p>
                              <dl class="text-12-regular text-text-weak mt-2 break-all">
                                <dt>{language.t("attention.session")}</dt>
                                <dd>{detail().session.id}</dd>
                                <Show when={detail().source.activityID}>
                                  <dt>{language.t("attention.activity")}</dt>
                                  <dd>{detail().source.activityID}</dd>
                                </Show>
                              </dl>
                            </div>
                          )}
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
              <Show when={result().nextCursor}>
                <Button disabled={state.loading} onClick={() => void refresh(true)}>
                  {language.t("attention.more")}
                </Button>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}
