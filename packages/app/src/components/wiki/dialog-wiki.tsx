import { Component, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Dialog } from "@deepagent-code/ui/v2/dialog-v2"
import { Button } from "@deepagent-code/ui/button"
import { Collapsible } from "@deepagent-code/ui/collapsible"
import { Icon } from "@deepagent-code/ui/icon"
import { Markdown } from "@deepagent-code/ui/markdown"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import {
  listWikiPages,
  getWikiPage,
  searchWiki,
  editWikiKnowledge,
  type WikiPageSummary,
  type WikiPage,
  type WikiClient,
} from "./wiki.api"
import "../settings-v2/settings-v2.css"

// Re-export the pure client API (UI-import-free, for the route-contract test) for back-compat.
export {
  listWikiPages,
  getWikiPage,
  searchWiki,
  editWikiKnowledge,
  type WikiPageSummary,
  type WikiPage,
  type WikiClient,
} from "./wiki.api"

// §B.2 governance grouping: two governable (Knowledge/Memory), two monitor-only (Document/Code).
export type WikiGroup = "knowledge" | "memory" | "code" | "document"

const TYPE_GROUP: Record<string, WikiGroup> = {
  knowledge: "knowledge",
  strategy: "knowledge",
  methodology: "knowledge",
  memory: "memory",
  code_symbol: "code",
}
const groupOf = (type: string): WikiGroup => TYPE_GROUP[type] ?? "document"

const GROUP_ORDER: readonly WikiGroup[] = ["knowledge", "memory", "code", "document"]
const GROUP_ICON = {
  knowledge: "knowledge-check",
  memory: "brain",
  code: "code-lines",
  document: "open-file",
} as const

export const resolveWikiExpandedGroup = (
  groups: readonly { group: WikiGroup; items: readonly unknown[] }[],
  expanded: WikiGroup | undefined,
  searching: boolean,
) => (searching ? groups.find((group) => group.items.length > 0)?.group : expanded)

export const DialogWiki: Component<{ client: WikiClient }> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [selectedId, setSelectedId] = createSignal<{ docId: string; scope: string } | undefined>(undefined)
  const [editing, setEditing] = createSignal(false)
  const [editBody, setEditBody] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  // The full page list (project projection). Refetched after a governed edit bumps a version.
  const [pages, { refetch: refetchPages }] = createResource(async () => listWikiPages(props.client))

  // Search hits (only when the query is non-empty) — the FTS index over the projection.
  const [hits] = createResource(
    () => query().trim() || undefined,
    async (text) => searchWiki(props.client, { text }),
  )

  // The set of doc ids matching the current search (used to filter the list). Empty query ⇒ show all.
  const matchIds = createMemo(() => {
    const q = query().trim()
    if (!q) return undefined
    return new Set((hits() ?? []).map((h) => h.docId))
  })

  const visiblePages = createMemo(() => {
    const all = pages() ?? []
    const ids = matchIds()
    return ids ? all.filter((p) => ids.has(p.docId)) : all
  })

  const groups = createMemo(() => {
    const byGroup = new Map<string, WikiPageSummary[]>()
    for (const p of visiblePages()) {
      const g = groupOf(p.type)
      const list = byGroup.get(g) ?? []
      list.push(p)
      byGroup.set(g, list)
    }
    return GROUP_ORDER.map((group) => ({ group, items: byGroup.get(group) ?? [] }))
  })

  // The rendered detail page for the current selection.
  const [page, { refetch: refetchPage }] = createResource(
    () => selectedId(),
    async (sel) => getWikiPage(props.client, sel.docId, sel.scope),
  )

  const select = (p: WikiPageSummary) => {
    setEditing(false)
    setSelectedId({ docId: p.docId, scope: p.scope })
  }

  const startEdit = (pg: WikiPage) => {
    setEditBody(pg.markdown)
    setEditing(true)
  }

  const saveEdit = async (pg: WikiPage) => {
    const sel = selectedId()
    if (!sel || busy()) return
    setBusy(true)
    try {
      const updated = await editWikiKnowledge(props.client, {
        docId: pg.docId,
        scope: sel.scope,
        body: editBody(),
        // The human provenance identity. The desktop app is single-user; the server stamps this id
        // on the new version and the real evidence-gate requires it to be present.
        editor: { id: "desktop-user" },
      })
      if (updated) {
        setEditing(false)
        await refetchPage()
        await refetchPages()
        showToast({ variant: "success", title: language.t("wiki.edit.saved") })
      }
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("wiki.edit.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog size="x-large" variant="settings" title={language.t("wiki.title")}>
      <div class="settings-v2-panel" data-component="wiki-dialog">
        <div class="settings-v2-tab-body deepagent-dialog-body">
          <p class="text-12-regular text-v2-text-text-faint">{language.t("wiki.description")}</p>

          {/* Search over the FTS projection. */}
          <div class="flex min-w-0 items-center gap-2 rounded-lg border border-v2-border-border-muted px-3 py-2">
            <Icon name="magnifying-glass" size="small" class="text-v2-text-text-faint" />
            <input
              type="text"
              data-action="wiki-search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={language.t("wiki.search")}
              aria-label={language.t("wiki.search")}
              class="min-w-0 flex-1 bg-transparent text-13-regular text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            />
          </div>

          {/* Two-column list + detail. */}
          <div class="flex min-h-0 flex-1 gap-3">
            <WikiList
              groups={groups()}
              loading={pages.loading}
              searchKey={query().trim()}
              empty={query().trim() ? language.t("wiki.searchEmpty") : language.t("wiki.empty")}
              selectedId={selectedId()?.docId}
              onSelect={select}
              typeLabel={(group) => language.t(`wiki.type.${group}`)}
            />
            <WikiDetail
              page={page()}
              loading={page.loading}
              hasSelection={!!selectedId()}
              editing={editing()}
              editBody={editBody()}
              busy={busy()}
              onEditBody={setEditBody}
              onStartEdit={startEdit}
              onCancelEdit={() => setEditing(false)}
              onSave={saveEdit}
            />
          </div>
        </div>
      </div>
    </Dialog>
  )
}

const WikiList: Component<{
  groups: { group: WikiGroup; items: WikiPageSummary[] }[]
  loading: boolean
  searchKey: string
  empty: string
  selectedId: string | undefined
  onSelect: (p: WikiPageSummary) => void
  typeLabel: (group: WikiGroup) => string
}> = (props) => {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal<WikiGroup>()
  createEffect(() => {
    const searchKey = props.searchKey
    const groups = props.groups
    if (!searchKey) return
    setExpanded(resolveWikiExpandedGroup(groups, undefined, true))
  })
  return (
    <div class="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-lg border border-v2-border-border-muted p-2">
      <Show
        when={!props.loading}
        fallback={<div class="p-2 text-13-regular text-v2-text-text-faint">{language.t("wiki.loading")}</div>}
      >
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <For each={props.groups}>
            {(group) => (
              <Collapsible
                open={expanded() === group.group}
                onOpenChange={(open) => setExpanded(open ? group.group : undefined)}
                class="flex flex-col border-b border-v2-border-border-muted last:border-b-0"
                classList={{
                  "min-h-0": expanded() === group.group,
                  "flex-1": expanded() === group.group,
                  "shrink-0": expanded() !== group.group,
                }}
              >
                <Collapsible.Trigger
                  data-action="wiki-graph-toggle"
                  data-graph={group.group}
                  class="rounded-md px-2 hover:bg-v2-background-bg-hover"
                  classList={{ "bg-v2-background-bg-hover": expanded() === group.group }}
                >
                  <span class="flex w-full min-w-0 items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-2">
                      <Icon name={GROUP_ICON[group.group]} size="small" class="shrink-0 text-v2-text-text-faint" />
                      <span class="truncate">{props.typeLabel(group.group)}</span>
                    </span>
                    <span class="flex shrink-0 items-center gap-2">
                      <span class="text-11-regular text-v2-text-text-faint">{group.items.length}</span>
                      <Icon
                        name="chevron-down"
                        size="small"
                        class="text-v2-text-text-faint transition-transform"
                        classList={{ "rotate-180": expanded() === group.group }}
                      />
                    </span>
                  </span>
                </Collapsible.Trigger>
                <Collapsible.Content class="min-h-0 flex-1 overflow-y-auto">
                  <div class="flex flex-col gap-1 p-1.5">
                    <Show
                      when={group.items.length > 0}
                      fallback={<div class="px-2 py-1.5 text-12-regular text-v2-text-text-faint">{props.empty}</div>}
                    >
                      <For each={group.items}>
                        {(p) => (
                          <button
                            type="button"
                            data-action="wiki-page-select"
                            onClick={() => props.onSelect(p)}
                            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-13-regular outline-none hover:bg-v2-background-bg-hover"
                            classList={{ "bg-v2-background-bg-hover": props.selectedId === p.docId }}
                          >
                            <span class="min-w-0 flex-1 truncate text-v2-text-text-base">{p.title}</span>
                            <Show when={p.editable}>
                              <Icon name="pencil-line" size="small" class="shrink-0 text-v2-text-text-faint" />
                            </Show>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </Collapsible.Content>
              </Collapsible>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const WikiDetail: Component<{
  page: WikiPage | undefined
  loading: boolean
  hasSelection: boolean
  editing: boolean
  editBody: string
  busy: boolean
  onEditBody: (v: string) => void
  onStartEdit: (pg: WikiPage) => void
  onCancelEdit: () => void
  onSave: (pg: WikiPage) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="deepagent-dialog-scroll flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-v2-border-border-muted p-3">
      <Show
        when={props.hasSelection}
        fallback={<div class="text-13-regular text-v2-text-text-faint">{language.t("wiki.selectPrompt")}</div>}
      >
        <Show
          when={!props.loading && props.page}
          fallback={<div class="text-13-regular text-v2-text-text-faint">{language.t("wiki.loading")}</div>}
        >
          {(pg) => (
            <>
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-14-medium text-v2-text-text-base">{pg().title}</span>
                <span class="shrink-0 text-11-regular text-v2-text-text-faint">
                  {language.t("wiki.version", { version: pg().version })}
                </span>
                <Show when={pg().editable && !props.editing}>
                  <Button
                    variant="secondary"
                    size="small"
                    data-action="wiki-edit"
                    onClick={() => props.onStartEdit(pg())}
                  >
                    {language.t("wiki.edit.button")}
                  </Button>
                </Show>
                <Show when={!pg().editable}>
                  <span class="shrink-0 rounded bg-v2-background-bg-hover px-1.5 py-0.5 text-11-regular text-v2-text-text-faint">
                    {language.t("wiki.readOnly")}
                  </span>
                </Show>
              </div>

              <Show
                when={props.editing}
                fallback={
                  <>
                    <Markdown text={pg().markdown} cacheKey={`${pg().docId}@${pg().version}`} class="min-w-0" />
                    <WikiCrossLinks page={pg()} />
                  </>
                }
              >
                <textarea
                  data-action="wiki-edit-body"
                  value={props.editBody}
                  onInput={(e) => props.onEditBody(e.currentTarget.value)}
                  class="min-h-[240px] w-full resize-y rounded-md border border-v2-border-border-muted bg-transparent p-2 text-13-regular text-v2-text-text-base outline-none"
                />
                <div class="flex items-center justify-end gap-2">
                  <Button variant="secondary" size="small" disabled={props.busy} onClick={props.onCancelEdit}>
                    {language.t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    size="small"
                    data-action="wiki-edit-save"
                    disabled={props.busy}
                    onClick={() => props.onSave(pg())}
                  >
                    {language.t("wiki.edit.save")}
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

// docs↔code cross-links (§B.5). Stale links render greyed with a hint, never silently dropped.
const WikiCrossLinks: Component<{ page: WikiPage }> = (props) => {
  const language = useLanguage()
  const hasLinks = createMemo(() => props.page.crossLinks.toCode.length > 0 || props.page.crossLinks.toDocs.length > 0)
  return (
    <Show when={hasLinks()}>
      <div class="flex flex-col gap-1 border-t border-v2-border-border-muted pt-2">
        <span class="text-11-medium uppercase tracking-wide text-v2-text-text-faint">{language.t("wiki.links")}</span>
        <For each={props.page.crossLinks.toCode}>
          {(ref) => (
            <div class="flex items-center gap-2 text-12-regular" classList={{ "opacity-50": ref.stale }}>
              <Icon name="code-lines" size="small" class="shrink-0 text-v2-text-text-faint" />
              <span class="min-w-0 flex-1 truncate text-v2-text-text-base">
                {ref.path ?? ref.symbolPath ?? ref.docId}
                {ref.line != null ? `:${ref.line}` : ""}
              </span>
              <Show when={ref.stale}>
                <span class="shrink-0 text-11-regular text-v2-text-text-faint">{language.t("wiki.stale")}</span>
              </Show>
            </div>
          )}
        </For>
        <For each={props.page.crossLinks.toDocs}>
          {(ref) => (
            <div class="flex items-center gap-2 text-12-regular" classList={{ "opacity-50": ref.stale }}>
              <Icon name="open-file" size="small" class="shrink-0 text-v2-text-text-faint" />
              <span class="min-w-0 flex-1 truncate text-v2-text-text-base">{ref.title}</span>
              <Show when={ref.stale}>
                <span class="shrink-0 text-11-regular text-v2-text-text-faint">{language.t("wiki.stale")}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
