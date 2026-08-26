import type { GlobalSession } from "@deepagent-code/sdk/v2/client"
import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Icon } from "@deepagent-code/ui/icon"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { getFilename } from "@deepagent-code/core/util/path"
import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"
import { formatSessionTime } from "@/utils/session-time"
import { showToast } from "@/utils/toast"
import "../settings-v2/settings-v2.css"

// The archived list carries an optional `preview` (first user-message snippet) that the backend is
// still landing. Widen the generated GlobalSession locally so the UI can render it the moment it
// arrives without waiting on an SDK regen. TODO: drop once GlobalSession gains `preview`.
type ArchivedSession = GlobalSession & { preview?: string }

// Minimal shape of the serverSDK client this dialog needs. Kept structural so the caller can pass
// the shared serverSDK.client without a cast fight.
type ArchivedClient = {
  experimental: {
    session: {
      list(input: {
        archived: boolean | "true" | "false"
        roots?: boolean | "true" | "false"
        limit?: number
      }): Promise<{ data?: GlobalSession[] }>
    }
  }
  session: {
    update(input: {
      directory: string
      sessionID: string
      time: { archived: number | null }
    }): Promise<unknown>
    delete(input: { directory: string; sessionID: string }): Promise<unknown>
  }
}

const ARCHIVED_FETCH_LIMIT = 200

export const listArchivedSessions = async (client: ArchivedClient): Promise<ArchivedSession[]> => {
  try {
    const response = await client.experimental.session.list({
      archived: true,
      // Only top-level sessions — hide subagent child sessions (parentID set) from the drawer.
      roots: true,
      limit: ARCHIVED_FETCH_LIMIT,
    })
    return (response.data ?? []) as ArchivedSession[]
  } catch {
    // Endpoint missing (stale sidecar build) or transient error — surface via the error state below.
    throw new Error("archived-list-failed")
  }
}

export const DialogArchivedSessions: Component<{ client: ArchivedClient }> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  // Locally removed ids (restored or deleted) — so the row disappears without a refetch.
  const [removed, setRemoved] = createSignal<ReadonlySet<string>>(new Set())
  const [confirmId, setConfirmId] = createSignal<string | undefined>(undefined)

  const [items, { mutate }] = createResource(async () => listArchivedSessions(props.client))

  const drop = (id: string) => {
    setRemoved((prev) => new Set(prev).add(id))
    // Keep the backing resource in sync so a later re-render / refetch stays consistent.
    mutate((prev) => (prev ?? []).filter((s) => s.id !== id))
  }

  const sorted = createMemo(() => {
    const all = (items() ?? []).filter((s) => !removed().has(s.id))
    return all.slice().sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return sorted()
    return sorted().filter((s) => {
      const title = (sessionTitle(s.title) ?? "").toLowerCase()
      const preview = (s.preview ?? "").toLowerCase()
      const dir = s.directory.toLowerCase()
      const project = (s.project?.name ?? "").toLowerCase()
      return title.includes(q) || preview.includes(q) || dir.includes(q) || project.includes(q)
    })
  })

  const rowTitle = (s: ArchivedSession) => sessionTitle(s.title) ?? language.t("command.session.new")

  const projectLabel = (s: ArchivedSession) =>
    s.project?.name ?? (s.project?.worktree ? getFilename(s.project.worktree) : getFilename(s.directory))

  const secondaryLine = (s: ArchivedSession) => {
    if (s.preview && s.preview.trim()) return s.preview.trim()
    return formatSessionTime(s.time.updated ?? s.time.created, language.intl())
  }

  const handleRestore = async (s: ArchivedSession) => {
    drop(s.id)
    await props.client.session
      .update({ directory: s.directory, sessionID: s.id, time: { archived: null } })
      .then(() => {
        showToast({
          title: language.t("session.archived.restored", { name: rowTitle(s) }),
          variant: "success",
        })
      })
      .catch((err: unknown) => {
        // Restore failed — put the row back so the user can retry.
        setRemoved((prev) => {
          const next = new Set(prev)
          next.delete(s.id)
          return next
        })
        mutate((prev) => {
          const list = prev ?? []
          return list.some((x) => x.id === s.id) ? list : [...list, s]
        })
        showToast({
          title: language.t("session.archived.restore.failed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }

  const handleDelete = async (s: ArchivedSession) => {
    setConfirmId(undefined)
    drop(s.id)
    await props.client.session.delete({ directory: s.directory, sessionID: s.id }).catch((err: unknown) => {
      setRemoved((prev) => {
        const next = new Set(prev)
        next.delete(s.id)
        return next
      })
      mutate((prev) => {
        const list = prev ?? []
        return list.some((x) => x.id === s.id) ? list : [...list, s]
      })
      showToast({
        title: language.t("session.delete.failed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
  }

  return (
    <Dialog size="x-large" variant="settings" title={language.t("session.archived.title")}>
      <div class="settings-v2-panel" data-component="archived-sessions-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <div class="flex items-center gap-2 rounded-lg border border-v2-border-border-muted px-3 py-2">
            <Icon name="magnifying-glass" size="small" class="text-icon-weak" />
            <input
              type="text"
              autofocus
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={language.t("session.archived.search")}
              class="min-w-0 flex-1 bg-transparent text-13-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              aria-label={language.t("session.archived.search")}
            />
          </div>

          <div class="deepagent-dialog-scroll rounded-lg border border-v2-border-border-muted">
            <Show
              when={!items.loading}
              fallback={<div class="p-4 text-13-regular text-v2-text-text-faint">{language.t("review.loading")}</div>}
            >
              <Show
                when={!items.error}
                fallback={
                  <div class="p-4 text-13-regular text-v2-text-text-faint">
                    {language.t("session.archived.error")}
                  </div>
                }
              >
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <div class="p-4 text-13-regular text-v2-text-text-faint">
                      {query().trim() ? language.t("review.empty") : language.t("session.archived.empty")}
                    </div>
                  }
                >
                  <For each={filtered()}>
                    {(session) => (
                      <div class="flex items-center gap-3 border-b border-v2-border-border-muted px-3 py-2.5 last:border-b-0 hover:bg-v2-background-bg-layer-01">
                        <Icon name="archive" size="small" class="shrink-0 text-icon-weak" />
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span class="truncate text-13-medium text-v2-text-text-base">{rowTitle(session)}</span>
                          <span class="truncate text-11-regular text-v2-text-text-faint">{secondaryLine(session)}</span>
                          <span class="truncate text-11-regular text-v2-text-text-faint">{projectLabel(session)}</span>
                        </div>
                        <Show
                          when={confirmId() === session.id}
                          fallback={
                            <div class="flex shrink-0 items-center gap-1">
                              <IconButton
                                icon="arrow-undo-down"
                                variant="ghost"
                                size="small"
                                onClick={() => void handleRestore(session)}
                                aria-label={language.t("session.archived.restore")}
                                title={language.t("session.archived.restore")}
                              />
                              <IconButton
                                icon="trash"
                                variant="ghost"
                                size="small"
                                onClick={() => setConfirmId(session.id)}
                                aria-label={language.t("common.delete")}
                                title={language.t("common.delete")}
                              />
                            </div>
                          }
                        >
                          <div class="flex shrink-0 flex-col items-end gap-1">
                            <span class="text-11-regular text-v2-text-text-base">
                              {language.t("session.delete.confirm", { name: rowTitle(session) })}
                            </span>
                            <div class="flex items-center gap-2">
                              <button
                                type="button"
                                class="text-11-medium text-v2-text-text-faint hover:text-v2-text-text-base"
                                onClick={() => setConfirmId(undefined)}
                              >
                                {language.t("common.cancel")}
                              </button>
                              <button
                                type="button"
                                class="text-11-medium text-v2-text-text-danger hover:opacity-80"
                                onClick={() => void handleDelete(session)}
                              >
                                {language.t("session.delete.button")}
                              </button>
                            </div>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
