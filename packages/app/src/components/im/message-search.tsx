import { createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { useIMClient } from "@/utils/im-client"
import type { IMMessage } from "./types"

// V4.0 §B3 — full-text message search (FTS + metadata) across the caller's group memberships.
// Backed by `GET /api/v1/im/search?q=…`. Results are keyset-paginated (nextCursor). Clicking a result
// hands the group + message id back to the panel so it can open the conversation.
export const MessageSearch: Component<{
  onSelect?: (result: { groupID: string; messageID: string }) => void
}> = (props) => {
  const client = useIMClient()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<IMMessage[]>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [hasMore, setHasMore] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [searched, setSearched] = createSignal(false)

  const run = async (append: boolean) => {
    const q = query().trim()
    if (!q) return
    setLoading(true)
    try {
      const page = await client.searchMessages({
        q,
        limit: 30,
        cursor: append ? cursor() ?? undefined : undefined,
      })
      const incoming = page.messages ?? []
      setResults((prev) => (append ? [...prev, ...incoming] : incoming))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setSearched(true)
    } catch (error) {
      console.error("Search failed:", error)
      const { showToast } = await import("@/utils/toast")
      showToast({
        variant: "error",
        title: "Search failed",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="flex flex-col gap-2 p-2">
      <div class="flex items-center gap-2">
        <input
          class="flex-1 min-w-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-13-regular text-text-strong outline-none focus:ring-2 focus:ring-accent-base"
          placeholder="Search messages…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") void run(false)
          }}
        />
        <Button variant="secondary" size="small" onClick={() => run(false)} disabled={!query().trim() || loading()}>
          {loading() ? "…" : "Search"}
        </Button>
      </div>

      <Show when={searched()}>
        <Show
          when={results().length > 0}
          fallback={<div class="px-1 py-2 text-12-regular text-text-weak">No matching messages.</div>}
        >
          <div class="flex flex-col gap-1">
            <For each={results()}>
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
            <Show when={hasMore()}>
              <div class="flex justify-center py-1">
                <Button variant="ghost" size="small" onClick={() => run(true)} disabled={loading()}>
                  {loading() ? "Loading…" : "Load more"}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
