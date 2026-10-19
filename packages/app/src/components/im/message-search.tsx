import { createEffect, createMemo, onCleanup, untrack, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Button } from "@deepagent-code/ui/button"
import { useIMClient } from "@/utils/im-client"
import type { IMMessage } from "./types"

// V4.0 §B3 — full-text message search (FTS + metadata) across the caller's group memberships.
// Backed by `GET /api/v1/im/search?q=…`. Results are keyset-paginated (nextCursor). Clicking a result
// hands the group + message id back to the panel so it can open the conversation.
export const MessageSearch: Component<{
  onSelect?: (result: { groupID: string; messageID: string }) => void
  localGroupIDs?: readonly string[]
  displayEpoch?: string
  invalidation?: number
}> = (props) => {
  const client = useIMClient()
  const language = useLanguage()
  const [state, setState] = createStore({
    query: "",
    results: [] as IMMessage[],
    cursor: null as string | null,
    hasMore: false,
    loading: false,
    searched: false,
    partial: false,
    unavailable: false,
    failed: false,
  })
  const lifecycle = {
    disposed: false,
    generation: 0,
    active: false,
    appended: false,
    deadline: Infinity,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const clearProtected = () => {
    lifecycle.generation++
    lifecycle.appended = false
    lifecycle.deadline = Infinity
    if (lifecycle.timer) clearTimeout(lifecycle.timer)
    setState({
      results: state.results.filter((row) => props.localGroupIDs?.includes(row.groupID)),
      cursor: null,
      hasMore: false,
      partial: state.searched || state.results.length > 0,
      unavailable: true,
    })
  }
  // Fresh status objects do not retire an unchanged reader authority.
  const authority = createMemo(() => [client.scope(), props.displayEpoch, props.invalidation] as const, undefined, {
    equals: (prior, next) => prior?.[0] === next[0] && prior?.[1] === next[1] && prior?.[2] === next[2],
  })
  createEffect(() => {
    authority()
    untrack(clearProtected)
  })
  onCleanup(() => {
    lifecycle.disposed = true
    if (lifecycle.timer) clearTimeout(lifecycle.timer)
  })
  const run = async (append: boolean) => {
    const q = state.query.trim()
    if (!q || lifecycle.active || lifecycle.disposed) return
    lifecycle.active = true
    if (!append) lifecycle.appended = false
    const generation = lifecycle.generation
    const scope = client.scope()
    const started = performance.now()
    setState({ loading: true, failed: false })
    try {
      const page = await client.searchMessages({
        q,
        limit: 30,
        cursor: append ? (state.cursor ?? undefined) : undefined,
      })
      if (
        lifecycle.disposed ||
        generation !== lifecycle.generation ||
        scope !== client.scope() ||
        q !== state.query.trim()
      )
        return
      if (page.reader) {
        const remaining =
          page.reader.nextExpiryAt === null ? Infinity : page.reader.nextExpiryAt - page.reader.validatedServerNow
        if (
          (props.displayEpoch && props.displayEpoch !== page.reader.displayEpoch) ||
          !Number.isSafeInteger(page.reader.validatedServerNow) ||
          (page.reader.nextExpiryAt !== null && !Number.isSafeInteger(page.reader.nextExpiryAt)) ||
          started + remaining <= performance.now()
        ) {
          clearProtected()
          return
        }
        lifecycle.deadline = append ? Math.min(lifecycle.deadline, started + remaining) : started + remaining
      }
      if (!append && !page.reader) lifecycle.deadline = Infinity
      if (lifecycle.timer) clearTimeout(lifecycle.timer)
      if (Number.isFinite(lifecycle.deadline))
        lifecycle.timer = setTimeout(clearProtected, Math.max(0, lifecycle.deadline - performance.now()))
      // A loaded result window stays put until a new search or its authority expires.
      // Refreshing only page one would silently discard the appended pages.
      if (append) lifecycle.appended = true
      setState({
        results: append
          ? Array.from(new Map([...state.results, ...page.messages].map((row) => [row.id, row])).values())
          : page.messages,
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        searched: true,
        unavailable: false,
        partial: !!page.protectedUnavailable || page.reader?.state === "partial",
      })
    } catch {
      if (!lifecycle.disposed && generation === lifecycle.generation) {
        clearProtected()
        setState("failed", true)
      }
    } finally {
      lifecycle.active = false
      if (!lifecycle.disposed) setState("loading", false)
    }
  }
  const timer = setInterval(() => {
    if (!lifecycle.appended && state.searched && state.query.trim()) void run(false)
  }, 5000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="flex flex-col gap-2 p-2">
      <div class="flex items-center gap-2">
        <input
          class="flex-1 min-w-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-13-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base"
          placeholder={`${language.t("im.search.messages")}…`}
          value={state.query}
          onInput={(e) => {
            lifecycle.generation++
            lifecycle.appended = false
            lifecycle.deadline = Infinity
            if (lifecycle.timer) clearTimeout(lifecycle.timer)
            setState({
              query: e.currentTarget.value,
              results: [],
              searched: false,
              cursor: null,
              hasMore: false,
              failed: false,
            })
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") void run(false)
          }}
        />
        <Button
          variant="secondary"
          size="small"
          onClick={() => run(false)}
          disabled={!state.query.trim() || state.loading}
        >
          {state.loading ? language.t("common.loading.ellipsis") : language.t("common.search.placeholder")}
        </Button>
      </div>

      <Show when={state.partial}>
        <p role="status" class="text-12-regular text-text-weak">
          {language.t(state.unavailable ? "im.reader.unavailable" : "im.reader.partialResults")}
        </p>
      </Show>
      <Show when={state.failed}>
        <p role="alert" class="text-12-regular text-text-danger-base">
          {language.t("im.search.failed")}
        </p>
      </Show>
      <Show when={state.searched}>
        <Show
          when={state.results.length > 0}
          fallback={
            <Show when={!state.failed}>
              <div class="px-1 py-2 text-12-regular text-text-weak">{language.t("im.search.empty")}</div>
            </Show>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={state.results}>
              {(msg) => (
                <button
                  type="button"
                  class="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-raised-base-hover"
                  onClick={() => props.onSelect?.({ groupID: msg.groupID, messageID: msg.id })}
                >
                  <div class="text-12-regular text-text-strong line-clamp-2">{msg.content}</div>
                  <div class="mt-0.5 text-11-regular text-text-weak">
                    {msg.senderType} · {new Date(msg.createdAt).toLocaleString()}
                  </div>
                </button>
              )}
            </For>
            <Show when={state.hasMore}>
              <div class="flex justify-center py-1">
                <Button variant="ghost" size="small" onClick={() => run(true)} disabled={state.loading}>
                  {state.loading ? `${language.t("common.loading")}…` : language.t("common.loadMore")}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
